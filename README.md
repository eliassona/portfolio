# Portfolio Dashboard

Live stocks, crypto & currency tracker in SEK.

## APIs (all free, no auth)
- **Stocks** → Finnhub
- **Crypto** → CoinGecko (returns SEK directly, includes 30-day history)
- **Forex**  → Frankfurter (ECB rates)

## Setup
```bash
npm install && npm run dev
```

## holdings.json fields

| Field           | Required | Description |
|-----------------|----------|-------------|
| `symbol`        | ✅       | Ticker / currency code (see below) |
| `name`          | ✅       | Display name |
| `shares`        | ✅       | Quantity held |
| `avgCost`       | ✅       | Average purchase price in SEK |
| `type`          | ✅       | `"stock"`, `"crypto"`, or `"forex"` |
| `account`       | —        | Optional label shown in the table (e.g. "ISK", "Coinbase") |
| `priceSymbol`   | —        | Override which symbol is used to fetch the price (see BTC clash below) |
| `displaySymbol` | —        | Override the symbol shown in the UI |

## Multiple entries of the same symbol
Just add multiple rows — the holdings table shows each row individually (with account),
and the allocation panel on the right automatically sums them by display symbol.

```json
{ "symbol": "AAPL", "shares": 25, "avgCost": 1540, "type": "stock", "account": "ISK" },
{ "symbol": "AAPL", "shares": 10, "avgCost": 1620, "type": "stock", "account": "KF"  }
```

## Resolving symbol clashes (e.g. BTC the ETF vs BTC the crypto)
Use `priceSymbol` and `displaySymbol` to disambiguate:

```json
{ "symbol": "BTC",  "name": "Bitcoin",                   "type": "crypto" },
{ "symbol": "BTC2", "name": "Grayscale BTC Mini Trust",  "type": "stock",
  "priceSymbol": "BTC", "displaySymbol": "BTC2" }
```
The ETF entry uses `"BTC"` as its Finnhub ticker (`priceSymbol`) but shows as `"BTC2"` in the UI,
so it won't collide with real Bitcoin in the allocation panel.

## Supported crypto symbols
BTC, ETH, SOL, BNB, XRP, ADA, DOGE
To add more, edit `COINGECKO_IDS` in `src/App.jsx` — find the ID at coingecko.com.
