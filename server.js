import express from 'express';
import nodemailer from 'nodemailer';
import cors from 'cors';
import { readFileSync } from 'fs';

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

app.listen(PORT, () => {
  console.log(`Alert server running on http://localhost:${PORT}`);
});
