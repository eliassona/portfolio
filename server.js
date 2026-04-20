import express from 'express';
import nodemailer from 'nodemailer';
import cors from 'cors';
import { readFileSync } from 'fs';
import https from 'https';

const app  = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

function loadConfig() {
  try {
    return JSON.parse(readFileSync('./config.json', 'utf8'));
  } catch (err) {
    console.error('Failed to load config.json:', err.message);
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
  const options = {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'application/json',
    }
  };
  https.get(url, options, (yahooRes) => {
    let body = '';
    yahooRes.on('data', chunk => { body += chunk; });
    yahooRes.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.status(yahooRes.statusCode).send(body);
    });
  }).on('error', err => {
    console.error('Yahoo proxy error:', err.message);
    res.status(500).json({ error: err.message });
  });
});

// Config endpoint — exposes non-sensitive display settings to the frontend
app.get('/api/config', (req, res) => {
  const config = loadConfig();
  res.json({
    bigMacSEK:     config.bigMacSEK     ?? 54,
    exchangeRates: config.exchangeRates ?? [],
    finnhubKey:    config.finnhubKey    ?? '',
  });
});

// Frankfurter proxy — avoids CORS issues from browser
app.get('/api/frankfurter', (req, res) => {
  // "endpoint" = latest/currencies, "range" = date range like 2026-01-01..2026-04-04
  const { endpoint, range, path: _path, ...params } = req.query;
  const fPath = (range ?? endpoint ?? 'latest').replace(/__/g, '..');
  const qs = Object.entries(params).map(([k,v]) => `${k}=${v}`).join('&');
  const url = `https://api.frankfurter.app/${fPath}${qs ? '?' + qs : ''}`;
  console.log('Frankfurter URL:', url);
  const options = { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } };
  https.get(url, options, (fRes) => {
    let body = '';
    fRes.on('data', chunk => { body += chunk; });
    fRes.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.status(fRes.statusCode).send(body);
    });
  }).on('error', err => res.status(500).json({ error: err.message }));
});

// CoinGecko proxy — avoids CORS and rate limit issues from browser
app.get('/api/coingecko', (req, res) => {
  const path = req.query.path;
  if (!path) return res.status(400).json({ error: 'path required' });
  const qs = Object.entries(req.query)
    .filter(([k]) => k !== 'path')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const url = `https://api.coingecko.com/api/v3/${path}${qs ? '?' + qs : ''}`;
  const options = { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } };
  https.get(url, options, (cgRes) => {
    let body = '';
    cgRes.on('data', chunk => { body += chunk; });
    cgRes.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.status(cgRes.statusCode).send(body);
    });
  }).on('error', err => {
    res.status(500).json({ error: err.message });
  });
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

// Net Worth endpoint — replicates the frontend calculation server-side for the Apple Watch widget.
// Fetches live prices for stocks (Yahoo), crypto (CoinGecko), and forex (Frankfurter),
// then combines with static holdings.json values for real estate, manual assets, and debt.
app.get('/api/networth', async (req, res) => {
  try {
    const config   = loadConfig();
    const holdings = JSON.parse(readFileSync('./holdings.json', 'utf8'));

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

    // ── 3. Crypto via CoinGecko (single request) ──────────────────────────────
    const COINGECKO_IDS = { BTC: 'bitcoin' }; // extend as needed
    const cryptoHoldings = holdings.filter(h => h.type === 'crypto');
    const cryptoPrices = {}; // symbol → priceSEK
    if (cryptoHoldings.length) {
      const ids = [...new Set(cryptoHoldings.map(h => COINGECKO_IDS[h.priceSymbol ?? h.symbol]).filter(Boolean))].join(',');
      if (ids) await new Promise(resolve => {
        const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=sek`;
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }, r => {
          let b = ''; r.on('data', c => b += c); r.on('end', () => {
            try {
              const data = JSON.parse(b);
              for (const h of cryptoHoldings) {
                const id = COINGECKO_IDS[h.priceSymbol ?? h.symbol];
                if (id && data[id]?.sek) cryptoPrices[h.priceSymbol ?? h.symbol] = data[id].sek;
              }
            } catch { /* ignore */ }
            resolve();
          });
        }).on('error', () => resolve());
      });
    }

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

app.listen(PORT, () => {
  console.log(`Alert server running on http://localhost:${PORT}`);
});
