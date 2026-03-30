# Portfolio Dashboard

Live stocks, crypto & currency tracker with email alerts, auto-refresh, and historical charts. All values displayed in your configured currency.

## APIs (all free, no auth)
- **Stocks** → Finnhub (quotes) + Yahoo Finance (historical charts)
- **Crypto** → CoinGecko
- **Forex**  → Frankfurter (ECB rates)
- **Indexes & Commodities** → Yahoo Finance

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Configure — edit config.json
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
  },
  "display": {
    "currency": "SEK"
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
- Network: http://192.168.x.x:5173 (use the Pi's hostname or IP)

## Display currency
Set `display.currency` in `config.json` to show all values in any currency. Restart the server after changing.

| Value | Description |
|-------|-------------|
| `"SEK"` | Swedish krona (default) |
| `"USD"` | US dollar |
| `"EUR"` | Euro |
| `"JPY"` | Japanese yen |
| `"BTC"` | Bitcoin — small values shown in satoshis, larger in ₿ |
| `"GBP"`, `"NOK"`, `"DKK"` etc. | Any currency supported by Frankfurter |

When a non-SEK currency is active, a badge appears in the header showing which currency is in use. Conversion uses live exchange rates already fetched from Frankfurter and CoinGecko — no extra API calls.

## Exchange rate pairs
The fiat currency pairs shown in the Exchange Rates panel are configurable in `config.json`. Add or remove pairs as needed — any two currencies supported by Frankfurter work:

```json
"exchangeRates": [
  { "from": "USD", "to": "SEK" },
  { "from": "EUR", "to": "SEK" },
  { "from": "SEK", "to": "JPY" },
  { "from": "GBP", "to": "SEK" }
]
```

BTC/USD, BTC/GOLD, and 🍔 Big Mac are always shown and are not configurable here. The Big Mac price is set via `"bigMacSEK"` (default: 54).

## Auto-refresh
The dashboard refreshes every 5 minutes automatically. A countdown timer in the header shows when the next refresh is due. When you return to a tab that was in the background, it refreshes immediately if a refresh was overdue.

## Email alerts
An email is sent when any asset changes more than `changeThresholdPct`% in a day. Each asset only triggers one alert per day (resets at midnight). Alerts are silently skipped if the alert server isn't running.

## Historical charts
Click any row in the Stocks, Crypto, or Currencies tables to open a chart. Click any row in the Exchange Rates panel for a rate chart. Timeframes: 1W, 1M, YTD, 1Y (plus 1D and 5Y for stocks). Data is cached per session so switching timeframes is instant after the first load.

## Allocation panel
Assets are grouped into categories. Click a category to expand and see individual positions. Override the default category for any holding by adding `"category"` to its entry in `holdings.json`:

```json
{ "symbol": "MSTR", "category": "Crypto", ... }
{ "symbol": "GLD",  "category": "Commodities", ... }
```

Default category mapping: `stock` → Stocks, `crypto` → Crypto, `forex` → Cash, `realestate` → Real Estate.

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
| `category`          | —        | Override allocation category (Stocks, Crypto, Cash, Real Estate, Commodities, Other) |
| `dividendPerShare`  | —        | Manual dividend amount in USD (for stocks Finnhub doesn't cover yet) |
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

### Manual / Other assets
For anything that has a value but no live price feed — private equity, collectibles, loans receivable, pension accounts, etc. You set the value manually in `holdings.json` and update it whenever you like.

```json
{ "type": "manual", "name": "Private equity fund", "valueSEK": 500000,
  "account": "Privat", "category": "Other", "notes": "Estimated NAV" }
```

Fields: `name` and `valueSEK` are required. `account`, `notes`, and `category` are optional. The `category` field controls which allocation bucket the asset falls into (defaults to "Other").

## Running on Raspberry Pi
Install Node.js 20 via NodeSource:
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

To keep the dashboard running after closing SSH, use PM2:
```bash
sudo npm install -g pm2
pm2 start "npm run dev" --name portfolio-frontend
pm2 start server.js --name portfolio-server
pm2 save
pm2 startup   # follow the printed command to auto-start on boot
```

Access from other devices using the Pi's hostname or IP, e.g. `http://wayneserver1:5173`.
