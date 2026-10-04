import express from 'express';
import nodemailer from 'nodemailer';
import cors from 'cors';
import { readFileSync } from 'fs';
import https from 'https';

const app  = express();
const PORT = Number(process.env.API_PORT) || 3001;
const HOLDINGS_FILE = process.env.HOLDINGS_FILE || './holdings.json';
const CONFIG_FILE   = process.env.CONFIG_FILE   || './config.json';

app.use(cors());
app.use(express.json());

// ── Shared upstream cache ───────────────────────────────────────────────────
// Every market-data proxy goes through here: identical requests are de-duplicated while in flight,
// cached for a short TTL, time out after 8s, and fall back to the last good response (up to 6h old)
// when the upstream errors or rate-limits (e.g. Yahoo 429) — instead of handing the UI garbage.
const upstreamCache = new Map();   // url → { status, body, at }
const upstreamInflight = new Map(); // url → Promise
const STALE_MS = 6 * 3600 * 1000;

function fetchUpstream(url, headers = {}, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', 'Accept': 'application/json,text/plain,*/*', 'Accept-Language': 'en-US,en;q=0.9', ...headers } }, (r) => {
      let body = '';
      r.on('data', c => { body += c; });
      r.on('end', () => resolve({ status: r.statusCode, body }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on('error', reject);
  });
}

async function cachedUpstream(url, ttlMs, headers) {
  const hit = upstreamCache.get(url);
  if (hit && Date.now() - hit.at < ttlMs) return hit;
  if (upstreamInflight.has(url)) return upstreamInflight.get(url);
  const job = (async () => {
    try {
      const r = await fetchUpstream(url, headers);
      if (r.status === 200) {
        upstreamCache.set(url, { ...r, at: Date.now() });
        if (upstreamCache.size > 600) upstreamCache.delete(upstreamCache.keys().next().value);
        return r;
      }
      if (hit && Date.now() - hit.at < STALE_MS) { console.warn(`upstream ${r.status} for ${url} — serving cached copy`); return { ...hit, stale: true }; }
      console.error(`upstream ${r.status} for ${url}: ${r.body.slice(0, 120)}`);
      return r;
    } catch (err) {
      if (hit && Date.now() - hit.at < STALE_MS) { console.warn(`upstream error for ${url} (${err.message}) — serving cached copy`); return { ...hit, stale: true }; }
      throw err;
    } finally {
      upstreamInflight.delete(url);
    }
  })();
  upstreamInflight.set(url, job);
  return job;
}

async function proxyUpstream(res, url, ttlMs, headers, altUrl) {
  try {
    let r = null;
    try { r = await cachedUpstream(url, ttlMs, headers); } catch (e) { if (!altUrl) throw e; }
    if ((!r || r.status !== 200) && altUrl) { // e.g. Yahoo query2 blocked → try query1
      try { const r2 = await cachedUpstream(altUrl, ttlMs, headers); if (!r || r2.status === 200) r = r2; } catch (e) { if (!r) throw e; }
    }
    res.setHeader('Content-Type', 'application/json');
    if (r.stale) res.setHeader('X-Cache', 'stale');
    res.status(r.status).send(r.body);
  } catch (err) {
    console.error('proxy error:', url, err.message);
    res.status(502).json({ error: err.message });
  }
}

function yahooTtl(range, interval, events) {
  if (events) return 6 * 3600 * 1000;                         // dividend history
  if (['1d', '5d'].includes(range)) return 30 * 1000;         // live-ish quotes
  if (['1mo', '3mo', 'ytd'].includes(range)) return 60 * 1000;
  if (['6mo', '1y'].includes(range)) return 5 * 60 * 1000;
  return 15 * 60 * 1000;                                      // 2y / 5y / max (moving averages)
}

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    console.error('Failed to load ' + CONFIG_FILE + ':', err.message);
    process.exit(1);
  }
}

app.post('/api/alert', async (req, res) => {
  const { alerts } = req.body; // [{ symbol, name, change, priceSEK }]
  if (!alerts?.length) return res.json({ ok: true });

  const config = loadConfig(); // reload on each request so changes take effect without restart
  if (!config.email?.smtp) {
    console.warn('Alert skipped: no email config in config.json');
    return res.json({ ok: true, skipped: true });
  }
  const { smtp } = config.email;

  const transporter = nodemailer.createTransport({
    host:   smtp.host,
    port:   smtp.port,
    secure: smtp.secure,
    auth:   { user: smtp.user, pass: smtp.password },
  });

  const threshold = config.alerts?.changeThresholdPct ?? 5;
  const fmt = n => new Intl.NumberFormat('sv-SE', { style: 'currency', currency: 'SEK', maximumFractionDigits: 0 }).format(n);
  const fmtPct = n => (n >= 0 ? '+' : '') + n.toFixed(2) + '%';

  const rows = alerts.map(a =>
    `<tr style="border-bottom:1px solid #2d2d2d">
      <td style="padding:10px 14px;font-weight:600">${a.symbol}</td>
      <td style="padding:10px 14px;color:#9ca3af">${a.name}</td>
      <td style="padding:10px 14px;font-family:monospace">${fmt(a.priceSEK)}</td>
      <td style="padding:10px 14px;font-weight:700;color:${a.change >= 0 ? '#22d3a5' : '#f87171'}">${fmtPct(a.change)}</td>
    </tr>`
  ).join('');

  const html = `
    <div style="background:#080c14;color:#e2e8f0;font-family:sans-serif;padding:32px;border-radius:12px;max-width:600px">
      <h2 style="margin:0 0 6px;color:#f1f5f9">⚠️ Portfolio Alert</h2>
      <p style="margin:0 0 24px;color:#6b7280">
        The following assets moved more than ${threshold}% today:
      </p>
      <table style="width:100%;border-collapse:collapse;background:#0f1623;border-radius:8px;overflow:hidden">
        <thead>
          <tr style="background:#1a2235">
            <th style="padding:10px 14px;text-align:left;font-size:11px;color:#4b5563;letter-spacing:.1em;text-transform:uppercase">Symbol</th>
            <th style="padding:10px 14px;text-align:left;font-size:11px;color:#4b5563;letter-spacing:.1em;text-transform:uppercase">Name</th>
            <th style="padding:10px 14px;text-align:left;font-size:11px;color:#4b5563;letter-spacing:.1em;text-transform:uppercase">Price</th>
            <th style="padding:10px 14px;text-align:left;font-size:11px;color:#4b5563;letter-spacing:.1em;text-transform:uppercase">Change</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="margin:24px 0 0;font-size:11px;color:#374151">
        Sent by Portfolio Dashboard · ${new Date().toLocaleString('sv-SE')}
      </p>
    </div>`;

  try {
    await transporter.sendMail({
      from:    config.email.from,
      to:      config.email.to,
      subject: `Portfolio Alert — ${alerts.length} asset${alerts.length > 1 ? 's' : ''} moved >${threshold}%`,
      html,
    });
    console.log(`Alert sent for: ${alerts.map(a => a.symbol).join(', ')}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to send email:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});


// Yahoo Finance proxy — avoids CORS when called from the browser
// Symbol passed as query param (?symbol=GC=F) to avoid Express routing issues with special chars
app.get('/api/yahoo', (req, res) => {
  const { symbol, range = '1mo', interval = '1d', events = '' } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  const eventsParam = events ? `&events=${events}` : '';
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false${eventsParam}`;
  proxyUpstream(res, url, yahooTtl(range, interval, events), undefined, url.replace('query2.', 'query1.'));
});

app.get('/api/config', (req, res) => {
  const config = loadConfig();
  res.json({
    bigMacSEK:        config.bigMacSEK        ?? 54,
    exchangeRates:    config.exchangeRates    ?? [],
    finnhubKey:       config.finnhubKey       ?? '',
    allocationLimits: config.allocationLimits ?? {},
  });
});

// Frankfurter proxy — avoids CORS issues from browser (ECB rates change once a day → 1h cache)
app.get('/api/frankfurter', (req, res) => {
  // "endpoint" = latest/currencies, "range" = date range like 2026-01-01..2026-04-04
  const { endpoint, range, path: _path, ...params } = req.query;
  const fPath = (range ?? endpoint ?? 'latest').replace(/__/g, '..');
  const qs = Object.entries(params).map(([k,v]) => `${k}=${v}`).join('&');
  proxyUpstream(res, `https://api.frankfurter.app/${fPath}${qs ? '?' + qs : ''}`, 3600 * 1000);
});

// CoinGecko proxy — avoids CORS and rate limit issues from browser
app.get('/api/coingecko', (req, res) => {
  const path = req.query.path;
  if (!path) return res.status(400).json({ error: 'path required' });
  const qs = Object.entries(req.query)
    .filter(([k]) => k !== 'path')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  proxyUpstream(res, `https://api.coingecko.com/api/v3/${path}${qs ? '?' + qs : ''}`, path.includes('market_chart') ? 10 * 60 * 1000 : 60 * 1000);
});

// mempool.space proxy — same pattern. Usage: /api/mempool?path=v1/prices
app.get('/api/mempool', (req, res) => {
  const path = req.query.path;
  if (!path) return res.status(400).json({ error: 'path required' });
  const qs = Object.entries(req.query)
    .filter(([k]) => k !== 'path')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  proxyUpstream(res, `https://mempool.space/api/${path}${qs ? '?' + qs : ''}`, path.includes('historical') ? 10 * 60 * 1000 : 30 * 1000);
});

// Elprisetjustnu proxy — fetches Nord Pool spot prices for SE3 (or any area), no auth required
// Usage: GET /api/elpriset?date=2026/04-22&area=SE3
// Caches the result in memory for the day so the Pi only makes one outbound request per day.
const elprisetCache = {};
app.get('/api/elpriset', (req, res) => {
  const { date, area = 'SE3' } = req.query;
  if (!date) return res.status(400).json({ error: 'date required (YYYY/MM-DD)' });
  const cacheKey = `${date}_${area}`;
  if (elprisetCache[cacheKey]) {
    return res.json(elprisetCache[cacheKey]);
  }
  const url = `https://www.elprisetjustnu.se/api/v1/prices/${date}_${area}.json`;
  const options = { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } };
  https.get(url, options, (epRes) => {
    let body = '';
    epRes.on('data', chunk => { body += chunk; });
    epRes.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (Array.isArray(data) && data.length) elprisetCache[cacheKey] = data;
        res.setHeader('Content-Type', 'application/json');
        res.status(epRes.statusCode).send(body);
      } catch {
        res.status(epRes.statusCode).send(body);
      }
    });
  }).on('error', err => {
    console.error('elpriset proxy error:', err.message);
    res.status(500).json({ error: err.message });
  });
});

// Riksbank SWEA proxy — fetches Swedish government bond yields (and other series) directly
// from Sveriges Riksbank's free public statistics API, no auth required.
// Series SEGVB10YC = 10-year Swedish government bond yield (daily, %).
// Usage: GET /api/riksbank?series=SEGVB10YC
// Docs: https://developer.api.riksbank.se/
app.get('/api/riksbank', (req, res) => {
  const { series = 'SEGVB10YC' } = req.query;
  const to = new Date();
  const from = new Date(to.getTime() - 10 * 24 * 60 * 60 * 1000);
  const fmt = d => d.toISOString().slice(0, 10); // YYYY-MM-DD
  const url = `https://api.riksbank.se/swea/v1/Observations/${encodeURIComponent(series)}/${fmt(from)}/${fmt(to)}`;
  // Cached for 30 min (the series only changes once per day) and served stale on 429 — Riksbank rate-limits hard
  proxyUpstream(res, url, 30 * 60 * 1000, { 'Accept': 'application/json' });
});

// Big Mac Index proxy — fetches the latest local SEK price for Sweden from The Economist's
// official dataset on GitHub (updated ~twice a year, the authoritative source).
// Returns: { local_price: <SEK>, date: <YYYY-MM-DD>, source: "TheEconomist/big-mac-data" }
app.get('/api/bigmac', (req, res) => {
  const url = 'https://raw.githubusercontent.com/TheEconomist/big-mac-data/master/source-data/big-mac-source-data.csv';
  const options = { headers: { 'Accept': 'text/plain', 'User-Agent': 'Mozilla/5.0' } };
  https.get(url, options, (ghRes) => {
    let body = '';
    ghRes.on('data', chunk => { body += chunk; });
    ghRes.on('end', () => {
      try {
        // Parse CSV — columns: name,iso_a3,currency_code,local_price,dollar_ex,gdp_dollar,date
        const lines = body.trim().split('\n').filter(l => l.trim());
        const header = lines[0].split(',');
        const isoIdx   = header.indexOf('iso_a3');
        const priceIdx = header.indexOf('local_price');
        const dateIdx  = header.indexOf('date');
        // Find the last SWE row (CSV is chronological, last = most recent)
        let latest = null;
        for (let i = 1; i < lines.length; i++) {
          const cols = lines[i].split(',');
          if (cols[isoIdx] === 'SWE') latest = cols;
        }
        if (!latest) return res.status(404).json({ error: 'Sweden not found in dataset' });
        res.json({
          local_price: parseFloat(latest[priceIdx]),
          date: latest[dateIdx],
          source: 'TheEconomist/big-mac-data',
        });
      } catch (err) {
        console.error('bigmac parse error:', err.message);
        res.status(500).json({ error: err.message });
      }
    });
  }).on('error', err => {
    console.error('bigmac proxy error:', err.message);
    res.status(500).json({ error: err.message });
  });
});

// ── Crypto price helpers ─────────────────────────────────────────────────────
// Primary source: mempool.space (BTC only, USD). SEK = USD × usdSek.
// Fallback (and other coins): CoinGecko.
function getJson(url) {
  return new Promise(resolve => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }, r => {
      let b = ''; r.on('data', c => b += c); r.on('end', () => {
        if (r.statusCode !== 200) {
          console.error(`getJson ${r.statusCode} for ${url}: ${b.slice(0, 200)}`);
          return resolve(null);
        }
        try { resolve(JSON.parse(b)); } catch (e) { console.error('getJson parse error:', url, e.message); resolve(null); }
      });
    }).on('error', err => { console.error('getJson error:', url, err.message); resolve(null); });
  });
}

async function fetchBtcMempool(usdSek) {
  const now = await getJson('https://mempool.space/api/v1/prices');
  if (!now?.USD) return null;
  const dayAgo = Math.floor(Date.now() / 1000) - 86400;
  const hist = await getJson(`https://mempool.space/api/v1/historical-price?currency=USD&timestamp=${dayAgo}`);
  const prev = hist?.prices?.[0]?.USD;
  const change = prev > 0 ? ((now.USD - prev) / prev) * 100 : null;
  return { priceUSD: now.USD, priceSEK: now.USD * usdSek, change };
}

const COINGECKO_IDS = { BTC: 'bitcoin' }; // extend as needed
async function fetchCoinGeckoQuotes(syms) {
  const ids = [...new Set(syms.map(s => COINGECKO_IDS[s]).filter(Boolean))].join(',');
  if (!ids) return {};
  const data = await getJson(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=sek,usd&include_24hr_change=true`);
  const out = {};
  for (const sym of syms) {
    const id = COINGECKO_IDS[sym];
    if (id && data?.[id]) out[sym] = { priceSEK: data[id].sek ?? null, priceUSD: data[id].usd ?? null, change: data[id].sek_24h_change ?? null };
  }
  return out;
}

// Returns { [symbol]: { priceSEK, priceUSD, change } }
async function fetchCryptoQuotes(cryptoHoldings, usdSek) {
  const syms = [...new Set(cryptoHoldings.map(h => h.priceSymbol ?? h.symbol))];
  const quotes = {};
  if (syms.includes('BTC')) {
    const q = await fetchBtcMempool(usdSek);
    if (q) quotes.BTC = q; else console.warn('mempool.space BTC failed, falling back to CoinGecko');
  }
  const missing = syms.filter(s => !quotes[s]);
  if (missing.length) Object.assign(quotes, await fetchCoinGeckoQuotes(missing));
  return quotes;
}

// Net Worth endpoint — replicates the frontend calculation server-side for the Apple Watch widget.
// Fetches live prices for stocks (Yahoo), crypto (CoinGecko), and forex (Frankfurter),
// then combines with static holdings.json values for real estate, manual assets, and debt.
app.get('/api/networth', async (req, res) => {
  try {
    const config   = loadConfig();
    const holdings = JSON.parse(readFileSync(HOLDINGS_FILE, 'utf8'));

    // ── 1. USD/SEK rate via Yahoo ──────────────────────────────────────────────
    const usdSek = await new Promise((resolve) => {
      const url = 'https://query2.finance.yahoo.com/v8/finance/chart/SEK%3DX?range=5d&interval=1d';
      https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, r => {
        let b = ''; r.on('data', c => b += c); r.on('end', () => {
          try {
            const closes = JSON.parse(b)?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(v => v != null) ?? [];
            resolve(closes.at(-1) ?? 10.5);
          } catch { resolve(10.5); }
        });
      }).on('error', () => resolve(10.5));
    });

    // ── 2. Stock prices via Yahoo (deduplicated) ───────────────────────────────
    const stockHoldings = holdings.filter(h => h.type === 'stock');
    const uniqueStockSyms = [...new Set(stockHoldings.map(h => h.priceSymbol ?? h.symbol))];
    const stockPrices = {}; // symbol → priceUSD
    await Promise.all(uniqueStockSyms.map(sym => new Promise(resolve => {
      const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`;
      https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, r => {
        let b = ''; r.on('data', c => b += c); r.on('end', () => {
          try {
            const closes = JSON.parse(b)?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(v => v != null) ?? [];
            stockPrices[sym] = closes.at(-1) ?? null;
          } catch { stockPrices[sym] = null; }
          resolve();
        });
      }).on('error', () => { stockPrices[sym] = null; resolve(); });
    })));

    // ── 3. Crypto via mempool.space (CoinGecko fallback) ──────────────────────
    const cryptoHoldings = holdings.filter(h => h.type === 'crypto');
    const cryptoQuotes = await fetchCryptoQuotes(cryptoHoldings, usdSek);
    const cryptoPrices = Object.fromEntries(Object.entries(cryptoQuotes).map(([sym, q]) => [sym, q.priceSEK])); // symbol → priceSEK

    // ── 4. Forex via Frankfurter ───────────────────────────────────────────────
    const forexHoldings = holdings.filter(h => h.type === 'forex');
    const forexPrices = {}; // symbol → priceSEK (1 unit of symbol in SEK)
    if (forexHoldings.length) {
      const syms = [...new Set(forexHoldings.map(h => h.priceSymbol ?? h.symbol))];
      await new Promise(resolve => {
        const url = `https://api.frankfurter.app/latest?from=SEK&to=${syms.join(',')}`;
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }, r => {
          let b = ''; r.on('data', c => b += c); r.on('end', () => {
            try {
              const rates = JSON.parse(b)?.rates ?? {};
              for (const sym of syms) {
                if (rates[sym]) forexPrices[sym] = 1 / rates[sym]; // convert to SEK per unit
              }
            } catch { /* ignore */ }
            resolve();
          });
        }).on('error', () => resolve());
      });
    }

    // ── 5. Calculate net worth ─────────────────────────────────────────────────
    let totalPortfolio = 0;
    for (const h of holdings.filter(h => ['stock','crypto','forex'].includes(h.type))) {
      const sym = h.priceSymbol ?? h.symbol;
      let priceSEK = null;
      if (h.type === 'stock')  priceSEK = stockPrices[sym] != null ? stockPrices[sym] * usdSek : null;
      if (h.type === 'crypto') priceSEK = cryptoPrices[sym] ?? null;
      if (h.type === 'forex')  priceSEK = forexPrices[sym] ?? null;
      if (priceSEK != null) totalPortfolio += h.shares * priceSEK;
    }

    const totalRealEstate = holdings.filter(h => h.type === 'realestate').reduce((s, h) => s + (h.valueSEK ?? 0), 0);
    const totalManual     = holdings.filter(h => h.type === 'manual').reduce((s, h) => s + (h.valueSEK ?? 0), 0);
    const totalDebt       = holdings.filter(h => h.type === 'debt').reduce((s, h) => s + (h.balanceSEK ?? 0), 0);
    const netWorth        = totalPortfolio + totalRealEstate + totalManual - totalDebt;

    res.json({
      netWorth:       Math.round(netWorth),
      totalPortfolio: Math.round(totalPortfolio),
      totalRealEstate,
      totalManual,
      totalDebt:      Math.round(totalDebt),
      usdSek:         Math.round(usdSek * 100) / 100,
      updatedAt:      new Date().toISOString(),
    });
  } catch (err) {
    console.error('networth error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Category for allocation grouping — mirrors getCategory() in App.jsx
function getCategory(h) {
  if (h.category) return h.category;
  if (h.type === 'crypto')     return 'Crypto';
  if (h.type === 'forex')      return 'Cash';
  if (h.type === 'realestate') return 'Real Estate';
  if (h.type === 'debt')       return null; // excluded from allocation
  return 'Stocks';
}

// Portfolio endpoint — full breakdown of every value shown in the dashboard UI:
// per-holding price/value/gain, category totals, allocation %, and the same
// top-level metrics as the metric cards (net worth, portfolio, day P&L, debt).
app.get('/api/portfolio', async (req, res) => {
  try {
    const config   = loadConfig();
    const holdings = JSON.parse(readFileSync(HOLDINGS_FILE, 'utf8'));
    const finnhubKey = config.finnhubKey ?? '';

    // ── 1. USD/SEK rate via Yahoo ──────────────────────────────────────────────
    const usdSek = await new Promise((resolve) => {
      const url = 'https://query2.finance.yahoo.com/v8/finance/chart/SEK%3DX?range=5d&interval=1d';
      https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, r => {
        let b = ''; r.on('data', c => b += c); r.on('end', () => {
          try {
            const closes = JSON.parse(b)?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(v => v != null) ?? [];
            resolve(closes.at(-1) ?? 10.5);
          } catch { resolve(10.5); }
        });
      }).on('error', () => resolve(10.5));
    });

    // ── 2. Stock quotes via Finnhub (price + prev close, like the frontend) ────
    const stockHoldings   = holdings.filter(h => h.type === 'stock');
    const uniqueStockSyms = [...new Set(stockHoldings.map(h => h.priceSymbol ?? h.symbol))];
    const stockQuotes = {}; // symbol → { priceUSD, prevUSD, change }
    if (finnhubKey) {
      await Promise.all(uniqueStockSyms.map(sym => new Promise(resolve => {
        const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${finnhubKey}`;
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, r => {
          let b = ''; r.on('data', c => b += c); r.on('end', () => {
            try {
              const q = JSON.parse(b);
              const priceUSD = q.c ?? null;
              const prevUSD  = q.pc ?? null;
              const change   = priceUSD != null && prevUSD != null && prevUSD !== 0 ? ((priceUSD - prevUSD) / prevUSD) * 100 : null;
              stockQuotes[sym] = { priceUSD, prevUSD, change };
            } catch { stockQuotes[sym] = { priceUSD: null, prevUSD: null, change: null }; }
            resolve();
          });
        }).on('error', () => { stockQuotes[sym] = { priceUSD: null, prevUSD: null, change: null }; resolve(); });
      })));
    }

    // ── 3. Crypto via mempool.space (CoinGecko fallback) ──────────────────────
    const cryptoHoldings = holdings.filter(h => h.type === 'crypto');
    const cryptoQuotes = await fetchCryptoQuotes(cryptoHoldings, usdSek); // symbol → { priceSEK, priceUSD, change }

    // ── 4. Forex via Frankfurter (no day-change data, mirrors frontend) ────────
    const forexHoldings = holdings.filter(h => h.type === 'forex');
    const forexQuotes = {}; // symbol → { priceSEK, change }
    if (forexHoldings.length) {
      const syms = [...new Set(forexHoldings.map(h => h.priceSymbol ?? h.symbol))];
      forexQuotes['SEK'] = { priceSEK: 1, change: null };
      const toFetch = syms.filter(s => s !== 'SEK');
      if (toFetch.length) await new Promise(resolve => {
        const url = `https://api.frankfurter.app/latest?from=SEK&to=${toFetch.join(',')}`;
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }, r => {
          let b = ''; r.on('data', c => b += c); r.on('end', () => {
            try {
              const rates = JSON.parse(b)?.rates ?? {};
              for (const sym of toFetch) {
                forexQuotes[sym] = { priceSEK: rates[sym] ? 1 / rates[sym] : null, change: null };
              }
            } catch { /* ignore */ }
            resolve();
          });
        }).on('error', () => resolve());
      });
    }

    // ── 5. Enrich every priced holding (stock/crypto/forex) ────────────────────
    const enriched = holdings
      .filter(h => ['stock', 'crypto', 'forex'].includes(h.type))
      .map(h => {
        const sym = h.priceSymbol ?? h.symbol;
        let priceUSD = null, prevUSD = null, priceSEK = null, change = null;
        if (h.type === 'stock') {
          const q = stockQuotes[sym] ?? {};
          priceUSD = q.priceUSD ?? null;
          prevUSD  = q.prevUSD  ?? null;
          change   = q.change   ?? null;
          priceSEK = priceUSD != null ? priceUSD * usdSek : null;
        } else if (h.type === 'crypto') {
          const q = cryptoQuotes[sym] ?? {};
          priceUSD = q.priceUSD ?? null;
          priceSEK = q.priceSEK ?? null;
          change   = q.change   ?? null;
        } else if (h.type === 'forex') {
          const q = forexQuotes[sym] ?? {};
          priceSEK = q.priceSEK ?? null;
          change   = q.change   ?? null;
        }
        const valueSEK   = priceSEK != null ? h.shares * priceSEK : null;
        const avgCostSEK = h.avgCost != null ? (h.currency === 'USD' ? h.avgCost * usdSek : h.avgCost) : null;
        const costSEK    = avgCostSEK != null ? h.shares * avgCostSEK : null;
        const gainSEK    = valueSEK != null && costSEK != null ? valueSEK - costSEK : null;
        const gainPct    = gainSEK != null && costSEK ? (gainSEK / costSEK) * 100 : null;
        // Day change contribution in SEK — stocks use USD move × FX rate, crypto/forex use % change directly
        let dayChangeSEK = null;
        if (h.type === 'stock' && priceUSD != null && prevUSD != null) {
          dayChangeSEK = (priceUSD - prevUSD) * usdSek * h.shares;
        } else if (change != null && priceSEK != null) {
          dayChangeSEK = (priceSEK * change / 100) * h.shares;
        }
        return {
          symbol: sym, displaySymbol: h.displaySymbol ?? sym, name: h.name ?? null,
          type: h.type, category: getCategory(h), account: h.account ?? null,
          shares: h.shares, avgCost: h.avgCost ?? null, currency: h.currency ?? null,
          priceSEK, priceUSD, changePct: change, dayChangeSEK,
          valueSEK, costSEK, gainSEK, gainPct,
        };
      });

    // ── 6. Static holdings: real estate, manual assets, debt ───────────────────
    const realEstate = holdings.filter(h => h.type === 'realestate').map(h => ({
      symbol: h.symbol ?? h.name, name: h.name ?? null, category: getCategory(h),
      account: h.account ?? null, valueSEK: h.valueSEK ?? 0,
    }));
    const manual = holdings.filter(h => h.type === 'manual').map(h => ({
      symbol: h.symbol ?? h.name, name: h.name ?? null, category: getCategory(h),
      account: h.account ?? null, valueSEK: h.valueSEK ?? 0,
    }));
    const debt = holdings.filter(h => h.type === 'debt').map(h => ({
      symbol: h.symbol ?? h.name, name: h.name ?? null,
      account: h.account ?? null, balanceSEK: h.balanceSEK ?? 0, interestRate: h.interestRate ?? null,
    }));

    // ── 7. Totals — mirrors the metric cards + allocation panel on the frontend ─
    const totalValue      = enriched.reduce((s, h) => s + (h.valueSEK ?? 0), 0);
    const totalCost       = enriched.reduce((s, h) => s + (h.costSEK ?? 0), 0);
    const totalGain       = totalValue - totalCost;
    const totalGainPct    = totalCost > 0 ? (totalGain / totalCost) * 100 : null;
    const dayChange       = enriched.reduce((s, h) => s + (h.dayChangeSEK ?? 0), 0);
    const totalRealEstate = realEstate.reduce((s, h) => s + h.valueSEK, 0);
    const totalManual     = manual.reduce((s, h) => s + h.valueSEK, 0);
    const totalDebt       = debt.reduce((s, h) => s + h.balanceSEK, 0);
    const netWorth         = totalValue + totalRealEstate + totalManual - totalDebt;
    const missingPrices    = enriched.filter(h => h.priceSEK == null).length;

    // Allocation by category — uses live value, falling back to cost basis when a price is missing
    const allocationTotal = enriched.reduce((s, h) => s + (h.valueSEK ?? h.costSEK ?? 0), 0) + totalRealEstate + totalManual;
    const byCategory = {};
    for (const h of [...enriched, ...realEstate, ...manual]) {
      if (!h.category) continue;
      const v = h.valueSEK ?? h.costSEK ?? 0;
      byCategory[h.category] = (byCategory[h.category] ?? 0) + v;
    }
    const allocation = Object.entries(byCategory).map(([category, valueSEK]) => ({
      category, valueSEK, pct: allocationTotal > 0 ? (valueSEK / allocationTotal) * 100 : 0,
    })).sort((a, b) => b.valueSEK - a.valueSEK);

    res.json({
      summary: {
        netWorth: Math.round(netWorth),
        totalValue: Math.round(totalValue),
        totalCost: Math.round(totalCost),
        totalGain: Math.round(totalGain),
        totalGainPct,
        dayChangeSEK: Math.round(dayChange),
        dayChangePct: totalValue > 0 ? (dayChange / totalValue) * 100 : null,
        totalRealEstate: Math.round(totalRealEstate),
        totalManual: Math.round(totalManual),
        totalDebt: Math.round(totalDebt),
        usdSek: Math.round(usdSek * 100) / 100,
        missingPrices,
      },
      holdings: enriched,
      realEstate,
      manual,
      debt,
      allocation,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('portfolio error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Alert server running on http://localhost:${PORT} (holdings: ${HOLDINGS_FILE}, config: ${CONFIG_FILE})`);
});
