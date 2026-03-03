# Portfolio Dashboard

Live stocks, crypto & currency tracker in SEK, with email alerts and auto-refresh.

## APIs (all free, no auth)
- **Stocks** → Finnhub
- **Crypto** → CoinGecko (returns SEK directly, includes 30-day history)
- **Forex**  → Frankfurter (ECB rates)

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Configure email alerts — edit config.json
```json
{
  "email": {
    "smtp": {
      "host": "smtp.gmail.com",
      "port": 587,
      "secure": false,
      "user": "your@gmail.com",
      "password": "your-app-password"
    },
    "from": "Portfolio Alert <your@gmail.com>",
    "to": "your@gmail.com"
  },
  "alerts": {
    "changeThresholdPct": 5
  }
}
```
For Gmail, use an App Password (Google Account → Security → 2-Step Verification → App passwords).

### 3. Start both servers
```bash
npm start
```
This runs the Vite frontend (port 5173) and the alert server (port 3001) concurrently.

Or run them separately:
```bash
npm run dev     # frontend only
npm run server  # alert server only
```

- Local:   http://localhost:5173
- Network: http://192.168.x.x:5173

## Auto-refresh
The dashboard refreshes every 5 minutes automatically. A countdown timer in the header shows when the next refresh is due.

## Email alerts
An email is sent when any asset changes more than `changeThresholdPct`% in a day.
Each asset only triggers one alert per day (resets at midnight).
Alerts are silently skipped if the alert server isn't running.

## holdings.json fields

| Field               | Required | Description |
|---------------------|----------|-------------|
| `symbol`            | ✅       | Ticker / currency code |
| `name`              | ✅       | Display name |
| `shares`            | ✅       | Quantity held |
| `avgCost`           | ✅       | Average purchase price (SEK by default) |
| `type`              | ✅       | `stock`, `crypto`, `forex`, `realestate`, `debt` |
| `currency`          | —        | `"USD"` to denominate avgCost in USD |
| `account`           | —        | Account label (e.g. "ISK", "Coinbase") |
| `priceSymbol`       | —        | Override fetch symbol (e.g. BTC ETF → `"BTC"`) |
| `displaySymbol`     | —        | Override symbol shown in UI |
| `dividendPerShare`  | —        | Manual dividend amount in USD (for stocks Finnhub doesn't cover) |
| `dividendFrequency` | —        | `"monthly"` or `"quarterly"` |

### Real estate
```json
{ "type": "realestate", "name": "Storgatan 12", "address": "...",
  "purchasePriceSEK": 2800000, "valueSEK": 3500000, "account": "Privat", "notes": "Bostadsrätt" }
```

### Debt
```json
{ "type": "debt", "name": "Bolån", "lender": "Swedbank",
  "balanceSEK": 1900000, "interestRate": 3.45, "notes": "Rörlig ränta" }
```
