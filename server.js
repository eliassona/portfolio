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

app.listen(PORT, () => {
  console.log(`Alert server running on http://localhost:${PORT}`);
});
