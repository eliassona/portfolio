# Portfolio Dashboard

Live stocks, crypto & currency tracker in SEK.

## APIs used (all free, no auth required)
- **Stocks** → Finnhub (`/quote` + `/stock/candle`)
- **Crypto** → CoinGecko (`/simple/price` + `/coins/{id}/market_chart`)
- **Forex**  → Frankfurter (`/latest`) — ECB exchange rates

## Setup
```bash
npm install && npm run dev
```
- Local:   http://localhost:5173
- Network: http://192.168.x.x:5173

## holdings.json format

### Stocks — use standard ticker
```json
{ "symbol": "AAPL",      "name": "Apple",   "shares": 10,  "avgCost": 1540, "type": "stock" }
{ "symbol": "VOLV-B.ST", "name": "Volvo B", "shares": 100, "avgCost": 280,  "type": "stock" }
```

### Crypto — use ticker symbol (BTC, ETH, SOL, BNB, XRP, ADA, DOGE supported)
```json
{ "symbol": "BTC", "name": "Bitcoin",  "shares": 0.5, "avgCost": 350000, "type": "crypto" }
{ "symbol": "ETH", "name": "Ethereum", "shares": 2.0, "avgCost": 28000,  "type": "crypto" }
```

### Forex — use ISO 4217 currency code
```json
{ "symbol": "USD", "name": "US Dollar",    "shares": 10000,  "avgCost": 10.20, "type": "forex" }
{ "symbol": "JPY", "name": "Japanese Yen", "shares": 500000, "avgCost": 0.068, "type": "forex" }
{ "symbol": "EUR", "name": "Euro",         "shares": 5000,   "avgCost": 11.30, "type": "forex" }
```
`shares` = units of currency held · `avgCost` = SEK paid per unit

## To add more crypto
Edit the `COINGECKO_IDS` map in `src/App.jsx` to add new coins:
```js
const COINGECKO_IDS = { BTC: "bitcoin", ETH: "ethereum", SOL: "solana", ... }
```
Find the CoinGecko ID at coingecko.com (it's in the URL of the coin page).
