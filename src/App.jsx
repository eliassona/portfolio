import { useState, useEffect, useCallback } from "react";
import holdingsData from "../holdings.json";

const FINNHUB_KEY = "cvt0nk1r01qhup0ti100cvt0nk1r01qhup0ti10g";
const COLORS = ["#22d3a5", "#6366f1", "#f59e0b", "#ec4899", "#38bdf8", "#a78bfa", "#fb923c", "#34d399"];

// CoinGecko ID map — add coins here as needed
const COINGECKO_IDS = {
  BTC: "bitcoin", ETH: "ethereum", SOL: "solana",
  BNB: "binancecoin", XRP: "ripple", ADA: "cardano", DOGE: "dogecoin",
};

// For each holding, what symbol should be shown in the UI?
// Uses h.displaySymbol if set, otherwise derives from symbol+type
function getDisplaySymbol(h) {
  if (h.displaySymbol) return h.displaySymbol;
  if (h.type === "forex")  return h.symbol.replace("_", "/");
  if (h.type === "crypto") return h.symbol.replace(/^[^:]+:/, "").replace(/USDT$|USD$/, "");
  return h.symbol;
}

// Price lookup key — includes type so "stock:BTC" and "crypto:BTC" never collide
function getPriceKey(h) {
  return `${h.type}:${h.priceSymbol ?? h.symbol}`;
}

function Sparkline({ data, positive }) {
  if (!data || data.length < 2) return <div style={{ width: 80, height: 32 }} />;
  const w = 80, hh = 32;
  const min = Math.min(...data), max = Math.max(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${hh - ((v - min) / range) * (hh - 4) - 2}`).join(" ");
  return (
    <svg width={w} height={hh} viewBox={`0 0 ${w} ${hh}`}>
      <polyline points={pts} fill="none" stroke={positive ? "#22d3a5" : "#f87171"} strokeWidth="1.5" strokeLinejoin="round" opacity="0.85" />
    </svg>
  );
}

function MetricCard({ label, value, sub, accent, loading }) {
  return (
    <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 16, padding: "22px 26px", position: "relative", overflow: "hidden" }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: accent }} />
      <p style={{ margin: 0, fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: "#6b7280", fontWeight: 600 }}>{label}</p>
      {loading
        ? <div style={{ margin: "10px 0 4px", height: 28, width: "60%", borderRadius: 6, background: "rgba(255,255,255,0.06)", animation: "pulse 1.5s infinite" }} />
        : <p style={{ margin: "8px 0 4px", fontSize: 26, fontWeight: 700, fontFamily: "'DM Mono', monospace", color: "#f1f5f9", letterSpacing: "-0.02em" }}>{value}</p>
      }
      {sub && <p style={{ margin: 0, fontSize: 11, color: "#6b7280" }}>{sub}</p>}
    </div>
  );
}

export default function App() {
  const holdings = holdingsData.map((h, i) => ({ ...h, id: i, color: COLORS[i % COLORS.length] }));

  const [prices, setPrices]           = useState({});
  const [dividends, setDividends]     = useState([]);
  const [usdSekRate, setUsdSekRate]   = useState(10.35);
  const [fetchStatus, setFetchStatus] = useState("idle");
  const [lastFetched, setLastFetched] = useState(null);
  const [animated, setAnimated]       = useState(false);

  useEffect(() => { setTimeout(() => setAnimated(true), 100); }, []);

  // ── Stock via Finnhub ──────────────────────────────────────────────────────
  const fetchStock = async (symbol) => {
    const now = Math.floor(Date.now() / 1000);
    const from = now - 30 * 86400;
    const [quoteRes, candleRes] = await Promise.all([
      fetch(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${FINNHUB_KEY}`),
      fetch(`https://finnhub.io/api/v1/stock/candle?symbol=${symbol}&resolution=D&from=${from}&to=${now}&token=${FINNHUB_KEY}`)
    ]);
    const quote  = await quoteRes.json();
    const candle = await candleRes.json();
    const priceUSD   = quote.c ?? null;
    const prevUSD    = quote.pc ?? null;
    const change     = priceUSD != null && prevUSD != null && prevUSD !== 0 ? ((priceUSD - prevUSD) / prevUSD) * 100 : null;
    const historyUSD = candle.s === "ok" ? candle.c : null;
    return { priceUSD, change, historyUSD };
  };

  // ── Crypto via CoinGecko ───────────────────────────────────────────────────
  const fetchCrypto = async (symbol) => {
    const id = COINGECKO_IDS[symbol];
    if (!id) return { priceSEK: null, change: null, historySEK: null };
    const [priceRes, historyRes] = await Promise.all([
      fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=sek&include_24hr_change=true`),
      fetch(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=sek&days=30&interval=daily`)
    ]);
    const priceData   = await priceRes.json();
    const historyData = await historyRes.json();
    return {
      priceSEK:   priceData?.[id]?.sek ?? null,
      change:     priceData?.[id]?.sek_24h_change ?? null,
      historySEK: historyData?.prices ? historyData.prices.map(([, p]) => p) : null,
    };
  };

  // ── Forex via Frankfurter ──────────────────────────────────────────────────
  const fetchAllForex = async (symbols) => {
    if (!symbols.length) return {};
    const allSyms = [...new Set([...symbols, "SEK"])].join(",");
    try {
      const res    = await fetch(`https://api.frankfurter.app/latest?to=${allSyms}`);
      const latest = await res.json();
      const rates  = { ...(latest.rates ?? {}), EUR: 1 };
      const sekPerEur = rates["SEK"] ?? 1;
      return Object.fromEntries(symbols.map(sym => {
        const rateToEur = rates[sym] ?? null;
        return [sym, { priceSEK: rateToEur != null ? sekPerEur / rateToEur : null, change: null, historySEK: null }];
      }));
    } catch {
      return Object.fromEntries(symbols.map(s => [s, { priceSEK: null, change: null, historySEK: null }]));
    }
  };

  // ── USD/SEK via Frankfurter ────────────────────────────────────────────────
  const fetchUsdSek = async () => {
    try {
      const res  = await fetch("https://api.frankfurter.app/latest?from=USD&to=SEK");
      const data = await res.json();
      return data?.rates?.SEK ?? 10.35;
    } catch { return 10.35; }
  };

  // ── Dividends: Finnhub + manual fallback ─────────────────────────────────
  // Fetches upcoming dividends from Finnhub for each stock symbol.
  // For symbols where Finnhub has nothing (e.g. newly listed preferreds like STRC/STRD/STRF),
  // falls back to dividendPerShare + dividendFrequency fields on the holding in holdings.json.
  const fetchDividends = async (stockSymbols) => {
    const today    = new Date();
    const in30days = new Date(today.getTime() + 30 * 86400 * 1000);
    const from     = today.toISOString().slice(0, 10);
    const to       = in30days.toISOString().slice(0, 10);

    // Track which symbols Finnhub returned data for
    const symbolsWithFinnhubData = new Set();
    const results = [];

    for (const sym of stockSymbols) {
      try {
        const res  = await fetch(`https://finnhub.io/api/v1/stock/dividend2?symbol=${sym}&from=${from}&to=${to}&token=${FINNHUB_KEY}`);
        const data = await res.json();
        if (data?.data?.length) {
          symbolsWithFinnhubData.add(sym);
          for (const d of data.data) {
            results.push({ symbol: sym, source: "finnhub", ...d });
          }
        }
      } catch { /* skip */ }
      await new Promise(r => setTimeout(r, 250));
    }

    // For symbols with no Finnhub data, check if holdings.json has manual dividend info.
    // dividendFrequency: "monthly" | "quarterly" — we show it if a payment falls in the next 30 days.
    // For monthly: always show (payment is this month or next).
    // For quarterly: show if today is within 30 days of the next expected payment.
    const today0 = new Date(); today0.setHours(0,0,0,0);
    for (const h of holdings) {
      if (h.type !== "stock") continue;
      const sym = h.priceSymbol ?? h.symbol;
      if (symbolsWithFinnhubData.has(sym)) continue;
      if (!h.dividendPerShare) continue;

      const freq = h.dividendFrequency ?? "quarterly";
      let withinWindow = false;
      let approxDate = null;

      if (freq === "monthly") {
        // Monthly payers always have a payment within 30 days
        withinWindow = true;
        // Approximate: end of current month
        approxDate = new Date(today0.getFullYear(), today0.getMonth() + 1, 0).toISOString().slice(0, 10);
      } else if (freq === "quarterly") {
        // Quarterly: check if a quarter-end falls within 30 days
        // Quarter ends: Mar 31, Jun 30, Sep 30, Dec 31
        const quarterEnds = [
          new Date(today0.getFullYear(), 2,  31),
          new Date(today0.getFullYear(), 5,  30),
          new Date(today0.getFullYear(), 8,  30),
          new Date(today0.getFullYear(), 11, 31),
        ];
        for (const qe of quarterEnds) {
          const diff = (qe - today0) / 86400000;
          if (diff >= 0 && diff <= 30) { withinWindow = true; approxDate = qe.toISOString().slice(0, 10); break; }
        }
      }

      if (withinWindow) {
        // Only push one entry per symbol (multiple holdings of same symbol handled in render)
        if (!results.find(r => r.symbol === sym && r.source === "manual")) {
          results.push({ symbol: sym, source: "manual", amount: h.dividendPerShare, exDate: approxDate, frequency: freq });
        }
      }
    }

    return results;
  };

  // ── Fetch all, deduplicating by priceKey ───────────────────────────────────
  const fetchAll = useCallback(async () => {
    setFetchStatus("loading");
    try {
      const stockHoldings  = holdings.filter(h => h.type === "stock");
      const cryptoHoldings = holdings.filter(h => h.type === "crypto");
      const forexHoldings  = holdings.filter(h => h.type === "forex");

      // Keys are "type:symbol" so stock:BTC and crypto:BTC never collide.
      // Deduplicate within each type separately.
      const uniqueStockKeys  = [...new Set(stockHoldings.map(getPriceKey))];
      const uniqueCryptoKeys = [...new Set(cryptoHoldings.map(getPriceKey))];
      const uniqueForexKeys  = [...new Set(forexHoldings.map(getPriceKey))];

      const uniqueForexSymbols = [...new Set(forexHoldings.map(h => h.priceSymbol ?? h.symbol))];

      const [usdSek, forexResults] = await Promise.all([
        fetchUsdSek(),
        fetchAllForex(uniqueForexSymbols),
      ]);
      setUsdSekRate(usdSek);

      const results = {};

      for (const key of uniqueStockKeys) {
        const sym = key.replace(/^stock:/, "");
        try {
          const { priceUSD, change, historyUSD } = await fetchStock(sym);
          results[key] = {
            priceSEK:   priceUSD   != null ? priceUSD   * usdSek : null,
            historySEK: historyUSD != null ? historyUSD.map(v => v * usdSek) : null,
            change,
          };
        } catch {
          results[key] = { priceSEK: null, change: null, historySEK: null };
        }
        await new Promise(r => setTimeout(r, 250));
      }

      for (const key of uniqueCryptoKeys) {
        const sym = key.replace(/^crypto:/, "");
        try {
          results[key] = await fetchCrypto(sym);
        } catch {
          results[key] = { priceSEK: null, change: null, historySEK: null };
        }
        await new Promise(r => setTimeout(r, 500));
      }

      for (const key of uniqueForexKeys) {
        const sym = key.replace(/^forex:/, "");
        results[key] = forexResults[sym] ?? { priceSEK: null, change: null, historySEK: null };
      }

      setPrices(results);

      // Fetch dividends for unique stock symbols (deduplicated, skip ETF aliases)
      const uniqueStockSymbols = [...new Set(stockHoldings.map(h => h.priceSymbol ?? h.symbol))];
      const divResults = await fetchDividends(uniqueStockSymbols);
      setDividends(divResults);

      setFetchStatus("done");
      setLastFetched(new Date());
    } catch (err) {
      console.error("Fetch error:", err);
      setFetchStatus("error");
    }
  }, []); // eslint-disable-line

  useEffect(() => { fetchAll(); }, []); // eslint-disable-line

  const fmtSEK     = n => n == null ? "—" : new Intl.NumberFormat("sv-SE", { style: "currency", currency: "SEK", maximumFractionDigits: 0 }).format(n);
  const fmtSEKFull = n => n == null ? "—" : new Intl.NumberFormat("sv-SE", { style: "currency", currency: "SEK", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
  const fmtPct     = n => n == null ? "—" : (n >= 0 ? "+" : "") + n.toFixed(2) + "%";

  // ── Enrich each holding with live price data ───────────────────────────────
  const enriched = holdings.map(h => {
    const p          = prices[getPriceKey(h)];
    const priceSEK   = p?.priceSEK   ?? null;
    const change     = p?.change     ?? null;
    const historySEK = p?.historySEK ?? null;
    const valueSEK   = priceSEK != null ? h.shares * priceSEK : null;
    // avgCost may be in USD — convert to SEK if currency field says so
    const avgCostSEK = h.currency === "USD" ? h.avgCost * usdSekRate : h.avgCost;
    const costSEK    = h.shares * avgCostSEK;
    const gainSEK    = valueSEK != null ? valueSEK - costSEK : null;
    const gainPct    = gainSEK != null && costSEK !== 0 ? (gainSEK / costSEK) * 100 : null;
    return { ...h, priceSEK, change, historySEK, valueSEK, costSEK, gainSEK, gainPct };
  });

  const totalValue   = enriched.reduce((s, h) => s + (h.valueSEK ?? 0), 0);
  const totalCost    = enriched.reduce((s, h) => s + h.costSEK, 0);
  const totalGain    = totalValue - totalCost;
  const totalGainPct = totalCost > 0 ? (totalGain / totalCost) * 100 : 0;
  const dayChange    = enriched.reduce((s, h) =>
    h.priceSEK != null && h.change != null ? s + (h.priceSEK * h.change / 100) * h.shares : s, 0);
  const isLoading    = fetchStatus === "loading";

  const priced = enriched.filter(h => h.change != null);
  const best   = priced.length ? [...priced].sort((a, b) => b.change - a.change)[0] : null;
  const worst  = priced.length ? [...priced].sort((a, b) => a.change - b.change)[0] : null;

  const stockRows      = enriched.filter(h => h.type === "stock");
  const cryptoRows     = enriched.filter(h => h.type === "crypto");
  const forexRows      = enriched.filter(h => h.type === "forex");
  const realEstateRows = holdingsData.filter(h => h.type === "realestate").map((h, i) => ({ ...h, id: `re-${i}`, color: COLORS[(enriched.length + i) % COLORS.length] }));
  const debtRows       = holdingsData.filter(h => h.type === "debt").map((h, i) => ({ ...h, id: `debt-${i}`, color: "#f87171" }));

  const totalRealEstate = realEstateRows.reduce((s, h) => s + (h.valueSEK ?? 0), 0);
  const totalDebt       = debtRows.reduce((s, h) => s + (h.balanceSEK ?? 0), 0);
  const netWorth        = totalValue + totalRealEstate - totalDebt;

  // ── Allocation: group by displaySymbol and sum valueSEK ───────────────────
  const allocationTotal = totalValue + totalRealEstate;
  const allocationGroups = (() => {
    const map = new Map();
    for (const h of enriched) {
      const key = getDisplaySymbol(h);
      if (!map.has(key)) map.set(key, { label: key, valueSEK: 0, color: h.color });
      map.get(key).valueSEK += h.valueSEK ?? h.costSEK;
    }
    for (const h of realEstateRows) {
      const key = h.name;
      if (!map.has(key)) map.set(key, { label: key, valueSEK: 0, color: h.color });
      map.get(key).valueSEK += h.valueSEK ?? 0;
    }
    return [...map.values()].sort((a, b) => b.valueSEK - a.valueSEK);
  })();

  // ── Real estate table ─────────────────────────────────────────────────────
  const RealEstateTable = ({ rows }) => (
    <div style={{ background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 20, overflow: "hidden", marginBottom: 18 }}>
      <div style={{ padding: "16px 24px 13px", borderBottom: "1px solid rgba(255,255,255,0.06)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>Real Estate</h2>
        <span style={{ fontSize: 10, color: "#374151" }}>{fmtSEK(totalRealEstate)} total</span>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
            {["Property", "Account", "Purchase Price", "Est. Value", "Unrealised Gain", "Notes"].map(col => (
              <th key={col} style={{ padding: "9px 14px", textAlign: "left", fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", color: "#374151", fontWeight: 700 }}>{col}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(h => {
            const gain    = h.valueSEK != null && h.purchasePriceSEK != null ? h.valueSEK - h.purchasePriceSEK : null;
            const gainPct = gain != null && h.purchasePriceSEK ? (gain / h.purchasePriceSEK) * 100 : null;
            const isPos   = (gain ?? 0) >= 0;
            return (
              <tr key={h.id} className="row-hover" style={{ borderBottom: "1px solid rgba(255,255,255,0.04)", transition: "background 0.15s" }}>
                <td style={{ padding: "12px 14px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                    <div style={{ width: 30, height: 30, borderRadius: 8, fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", background: `${h.color}22`, flexShrink: 0 }}>🏠</div>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 12 }}>{h.name}</div>
                      {h.address && <div style={{ fontSize: 10, color: "#4b5563", marginTop: 1 }}>{h.address}</div>}
                    </div>
                  </div>
                </td>
                <td style={{ padding: "12px 14px" }}>
                  {h.account ? <span style={{ fontSize: 10, color: "#6b7280", background: "rgba(255,255,255,0.06)", padding: "2px 7px", borderRadius: 5 }}>{h.account}</span> : <span style={{ color: "#374151", fontSize: 11 }}>—</span>}
                </td>
                <td style={{ padding: "12px 14px", fontFamily: "'DM Mono',monospace", fontSize: 12, color: "#6b7280" }}>{fmtSEK(h.purchasePriceSEK)}</td>
                <td style={{ padding: "12px 14px", fontFamily: "'DM Mono',monospace", fontSize: 12, fontWeight: 600 }}>{fmtSEK(h.valueSEK)}</td>
                <td style={{ padding: "12px 14px" }}>
                  {gain != null
                    ? <span style={{ fontFamily: "'DM Mono',monospace", fontSize: 11, fontWeight: 600, color: isPos ? "#22d3a5" : "#f87171", background: isPos ? "rgba(34,211,165,0.1)" : "rgba(248,113,113,0.1)", padding: "2px 7px", borderRadius: 5 }}>
                        {isPos ? "+" : ""}{fmtSEK(gain)} ({fmtPct(gainPct)})
                      </span>
                    : <span style={{ fontSize: 11, color: "#374151" }}>—</span>
                  }
                </td>
                <td style={{ padding: "12px 14px", fontSize: 11, color: "#6b7280" }}>{h.notes ?? "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  // ── Debt table ─────────────────────────────────────────────────────────────
  const DebtTable = ({ rows }) => (
    <div style={{ background: "rgba(255,255,255,0.025)", border: "1px solid rgba(248,113,113,0.15)", borderRadius: 20, overflow: "hidden", marginBottom: 18 }}>
      <div style={{ padding: "16px 24px 13px", borderBottom: "1px solid rgba(255,255,255,0.06)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>Debt</h2>
        <span style={{ fontSize: 10, color: "#f87171" }}>{fmtSEK(totalDebt)} total</span>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
            {["Liability", "Lender", "Balance", "Interest Rate", "Monthly Cost", "Notes"].map(col => (
              <th key={col} style={{ padding: "9px 14px", textAlign: "left", fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", color: "#374151", fontWeight: 700 }}>{col}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(h => {
            const monthlyCost = h.balanceSEK != null && h.interestRate != null ? (h.balanceSEK * (h.interestRate / 100)) / 12 : null;
            return (
              <tr key={h.id} className="row-hover" style={{ borderBottom: "1px solid rgba(255,255,255,0.04)", transition: "background 0.15s" }}>
                <td style={{ padding: "12px 14px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                    <div style={{ width: 30, height: 30, borderRadius: 8, fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(248,113,113,0.1)", flexShrink: 0 }}>💳</div>
                    <div style={{ fontWeight: 600, fontSize: 12 }}>{h.name}</div>
                  </div>
                </td>
                <td style={{ padding: "12px 14px", fontSize: 11, color: "#6b7280" }}>{h.lender ?? "—"}</td>
                <td style={{ padding: "12px 14px", fontFamily: "'DM Mono',monospace", fontSize: 12, fontWeight: 600, color: "#f87171" }}>{fmtSEK(h.balanceSEK)}</td>
                <td style={{ padding: "12px 14px", fontFamily: "'DM Mono',monospace", fontSize: 12 }}>
                  {h.interestRate != null ? `${h.interestRate.toFixed(2)}%` : "—"}
                </td>
                <td style={{ padding: "12px 14px", fontFamily: "'DM Mono',monospace", fontSize: 12, color: "#f87171" }}>
                  {monthlyCost != null ? fmtSEK(monthlyCost) : "—"}
                </td>
                <td style={{ padding: "12px 14px", fontSize: 11, color: "#6b7280" }}>{h.notes ?? "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  // ── Holdings table ─────────────────────────────────────────────────────────
  const HoldingsTable = ({ rows, title, sourceLabel }) => (
    <div style={{ background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 20, overflow: "hidden", marginBottom: 18 }}>
      <div style={{ padding: "16px 24px 13px", borderBottom: "1px solid rgba(255,255,255,0.06)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>{title}</h2>
        <span style={{ fontSize: 10, color: "#374151", letterSpacing: "0.06em" }}>{sourceLabel}</span>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
            {["Asset", "Account", "Amount", "Avg Cost", "Live Price", "Market Value", "Gain / Loss", "30D"].map(col => (
              <th key={col} style={{ padding: "9px 14px", textAlign: "left", fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", color: "#374151", fontWeight: 700 }}>{col}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(h => {
            const isPos     = (h.change ?? 0) >= 0;
            const isGainPos = (h.gainPct ?? 0) >= 0;
            const label     = getDisplaySymbol(h);
            return (
              <tr key={h.id} className="row-hover" style={{ borderBottom: "1px solid rgba(255,255,255,0.04)", transition: "background 0.15s" }}>
                <td style={{ padding: "12px 14px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                    <div style={{ width: 30, height: 30, borderRadius: 8, fontSize: 11, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", background: `${h.color}22`, color: h.color, flexShrink: 0 }}>{label[0]}</div>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 12, fontFamily: "'DM Mono',monospace" }}>{label}</div>
                      <div style={{ fontSize: 10, color: "#4b5563", marginTop: 1, maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.name}</div>
                    </div>
                  </div>
                </td>
                <td style={{ padding: "12px 14px" }}>
                  {h.account
                    ? <span style={{ fontSize: 10, color: "#6b7280", background: "rgba(255,255,255,0.06)", padding: "2px 7px", borderRadius: 5 }}>{h.account}</span>
                    : <span style={{ fontSize: 10, color: "#374151" }}>—</span>
                  }
                </td>
                <td style={{ padding: "12px 14px", fontFamily: "'DM Mono',monospace", fontSize: 12 }}>{h.shares.toLocaleString("sv-SE")}</td>
                <td style={{ padding: "12px 14px", fontFamily: "'DM Mono',monospace", fontSize: 12, color: "#6b7280" }}>{fmtSEKFull(h.avgCost)}</td>
                <td style={{ padding: "12px 14px" }}>
                  {isLoading
                    ? <div style={{ height: 14, width: 60, borderRadius: 4, background: "rgba(255,255,255,0.06)", animation: "pulse 1.5s infinite" }} />
                    : <>
                        <div style={{ fontFamily: "'DM Mono',monospace", fontSize: 12 }}>{fmtSEKFull(h.priceSEK)}</div>
                        {h.change != null && <div style={{ fontSize: 10, color: isPos ? "#22d3a5" : "#f87171", marginTop: 1 }}>{fmtPct(h.change)}</div>}
                      </>
                  }
                </td>
                <td style={{ padding: "12px 14px", fontFamily: "'DM Mono',monospace", fontSize: 12, fontWeight: 600 }}>
                  {isLoading ? <div style={{ height: 14, width: 70, borderRadius: 4, background: "rgba(255,255,255,0.06)", animation: "pulse 1.5s infinite" }} /> : fmtSEK(h.valueSEK)}
                </td>
                <td style={{ padding: "12px 14px" }}>
                  {isLoading
                    ? <div style={{ height: 20, width: 100, borderRadius: 6, background: "rgba(255,255,255,0.06)", animation: "pulse 1.5s infinite" }} />
                    : h.gainSEK != null
                      ? <span style={{ fontFamily: "'DM Mono',monospace", fontSize: 11, fontWeight: 600, color: isGainPos ? "#22d3a5" : "#f87171", background: isGainPos ? "rgba(34,211,165,0.1)" : "rgba(248,113,113,0.1)", padding: "2px 7px", borderRadius: 5 }}>
                          {isGainPos ? "+" : ""}{fmtSEK(h.gainSEK)} ({fmtPct(h.gainPct)})
                        </span>
                      : <span style={{ fontSize: 11, color: "#374151" }}>—</span>
                  }
                </td>
                <td style={{ padding: "12px 14px" }}>
                  {h.historySEK ? <Sparkline data={h.historySEK} positive={isPos} /> : <div style={{ width: 80 }} />}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  return (
    <div style={{ minHeight: "100vh", background: "#080c14", fontFamily: "'DM Sans','Helvetica Neue',sans-serif", color: "#e2e8f0" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=DM+Mono:wght@400;500&display=swap');
        * { box-sizing: border-box; } body { margin: 0; }
        .row-hover:hover { background: rgba(255,255,255,0.04) !important; }
        .fade-in { opacity: 0; transform: translateY(14px); transition: opacity 0.5s ease, transform 0.5s ease; }
        .fade-in.visible { opacity: 1; transform: translateY(0); }
        @keyframes pulse { 0%,100%{opacity:.35} 50%{opacity:.7} }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>

      <div style={{ borderBottom: "1px solid rgba(255,255,255,0.06)", padding: "18px 48px", display: "flex", alignItems: "center", justifyContent: "space-between", background: "rgba(255,255,255,0.015)", backdropFilter: "blur(12px)", position: "sticky", top: 0, zIndex: 50 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: "linear-gradient(135deg,#22d3a5,#6366f1)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ fontSize: 14, fontWeight: 800, color: "#fff" }}>P</span>
          </div>
          <span style={{ fontWeight: 700, fontSize: 16, letterSpacing: "-0.02em" }}>Portfolio</span>
          {fetchStatus === "done"    && <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.1em", background: "rgba(34,211,165,0.12)",  color: "#22d3a5", padding: "2px 8px", borderRadius: 20, textTransform: "uppercase" }}>Live</span>}
          {fetchStatus === "loading" && <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.1em", background: "rgba(99,102,241,0.12)",  color: "#a5b4fc", padding: "2px 8px", borderRadius: 20, textTransform: "uppercase" }}>Fetching…</span>}
          {fetchStatus === "error"   && <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.1em", background: "rgba(248,113,113,0.12)", color: "#f87171", padding: "2px 8px", borderRadius: 20, textTransform: "uppercase" }}>Error</span>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {lastFetched && <span style={{ fontSize: 11, color: "#374151" }}>{lastFetched.toLocaleTimeString("sv-SE")}</span>}
          <button onClick={fetchAll} disabled={isLoading} style={{ display: "flex", alignItems: "center", gap: 6, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.09)", borderRadius: 10, padding: "7px 14px", color: "#d1d5db", fontSize: 12, fontWeight: 600, cursor: isLoading ? "not-allowed" : "pointer", fontFamily: "'DM Sans',sans-serif", opacity: isLoading ? 0.6 : 1 }}>
            <span style={{ display: "inline-block", animation: isLoading ? "spin 0.8s linear infinite" : "none", fontSize: 14 }}>↻</span>
            {isLoading ? "Fetching…" : "Refresh"}
          </button>
        </div>
      </div>

      <div style={{ padding: "36px 48px", maxWidth: 1400, margin: "0 auto" }}>
        <div className={`fade-in ${animated ? "visible" : ""}`} style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14, marginBottom: 26 }}>
          <MetricCard label="Net Worth"    value={fmtSEK(netWorth)}  sub="Assets minus debt" accent="linear-gradient(90deg,#22d3a5,#6366f1)" loading={isLoading && totalValue === 0} />
          <MetricCard label="Portfolio"    value={totalValue > 0 ? fmtSEK(totalValue) : "—"} sub={fmtPct(totalGainPct) + " return"} accent={totalGain >= 0 ? "#22d3a5" : "#f87171"} loading={isLoading && totalValue === 0} />
          <MetricCard label="Day's P&L"    value={fmtSEK(dayChange)}  sub={fmtPct(totalValue > 0 ? dayChange / totalValue * 100 : 0) + " today"} accent={dayChange >= 0 ? "#22d3a5" : "#f87171"} loading={isLoading} />
          <MetricCard label="Total Debt"   value={fmtSEK(totalDebt)}  sub={`${debtRows.length} liabilities`} accent="#f87171" />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: 18 }}>
          <div className={`fade-in ${animated ? "visible" : ""}`} style={{ transitionDelay: "80ms" }}>
            {stockRows.length     > 0 && <HoldingsTable rows={stockRows}  title="Stocks"     sourceLabel="via Finnhub" />}
            {cryptoRows.length    > 0 && <HoldingsTable rows={cryptoRows} title="Crypto"     sourceLabel="via CoinGecko" />}
            {forexRows.length     > 0 && <HoldingsTable rows={forexRows}  title="Currencies" sourceLabel="via Frankfurter" />}
            {realEstateRows.length > 0 && <RealEstateTable rows={realEstateRows} />}
            {debtRows.length       > 0 && <DebtTable rows={debtRows} />}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {/* Allocation — grouped by display symbol */}
            <div className={`fade-in ${animated ? "visible" : ""}`} style={{ background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 20, padding: "18px 22px", transitionDelay: "120ms" }}>
              <h2 style={{ margin: "0 0 18px", fontSize: 13, fontWeight: 600 }}>Allocation</h2>
              <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
                {allocationGroups.map((g, i) => {
                  const pct = allocationTotal > 0 ? (g.valueSEK / allocationTotal) * 100 : 0;
                  return (
                    <div key={g.label}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                        <span style={{ fontSize: 11, fontWeight: 600, color: "#d1d5db" }}>{g.label}</span>
                        <div style={{ textAlign: "right" }}>
                          <span style={{ fontSize: 11, fontFamily: "'DM Mono',monospace", color: "#6b7280" }}>{pct.toFixed(1)}%</span>
                          <span style={{ fontSize: 10, color: "#374151", marginLeft: 6 }}>{fmtSEK(g.valueSEK)}</span>
                        </div>
                      </div>
                      <div style={{ height: 5, background: "rgba(255,255,255,0.06)", borderRadius: 4, overflow: "hidden" }}>
                        <div style={{ height: "100%", width: animated ? `${pct}%` : "0%", background: g.color, borderRadius: 4, transition: `width 0.9s cubic-bezier(0.4,0,0.2,1) ${i * 60}ms` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Performance */}
            <div className={`fade-in ${animated ? "visible" : ""}`} style={{ background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 20, padding: "18px 22px", transitionDelay: "160ms" }}>
              <h2 style={{ margin: "0 0 16px", fontSize: 13, fontWeight: 600 }}>Performance</h2>
              {priced.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {[
                    { label: "Winners today",   value: priced.filter(h => h.change > 0).length, color: "#22d3a5" },
                    { label: "Losers today",    value: priced.filter(h => h.change < 0).length, color: "#f87171" },
                    { label: "Best performer",  value: best  ? getDisplaySymbol(best)  : "—", sub: best  ? fmtPct(best.change)  : "", color: "#22d3a5" },
                    { label: "Worst performer", value: worst ? getDisplaySymbol(worst) : "—", sub: worst ? fmtPct(worst.change) : "", color: "#f87171" },
                  ].map(item => (
                    <div key={item.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontSize: 11, color: "#6b7280" }}>{item.label}</span>
                      <div style={{ textAlign: "right" }}>
                        <span style={{ fontSize: 13, fontWeight: 700, fontFamily: "'DM Mono',monospace", color: item.color }}>{item.value}</span>
                        {item.sub && <span style={{ fontSize: 10, color: item.color, display: "block", opacity: 0.7 }}>{item.sub}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p style={{ color: "#374151", fontSize: 12, margin: 0, textAlign: "center" }}>{isLoading ? "Loading…" : "Refresh to load"}</p>
              )}
            </div>

            {/* Upcoming dividends */}
            <div className={`fade-in ${animated ? "visible" : ""}`} style={{ background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 20, padding: "18px 22px", transitionDelay: "200ms" }}>
              <h2 style={{ margin: "0 0 14px", fontSize: 13, fontWeight: 600 }}>Upcoming Dividends</h2>
              <p style={{ margin: "0 0 12px", fontSize: 10, color: "#4b5563" }}>Next 30 days</p>
              {isLoading ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {[1,2].map(i => <div key={i} style={{ height: 36, borderRadius: 8, background: "rgba(255,255,255,0.04)", animation: "pulse 1.5s infinite" }} />)}
                </div>
              ) : dividends.length === 0 ? (
                <p style={{ color: "#374151", fontSize: 12, margin: 0, textAlign: "center" }}>No dividends in next 30 days</p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {(() => {
                    // Group by symbol, sum payout across all holdings of that symbol
                    const bySymbol = {};
                    for (const div of dividends) {
                      const amountUSD = div.amount ?? 0;
                      const totalShares = holdings
                        .filter(h => h.type === "stock" && (h.priceSymbol ?? h.symbol) === div.symbol)
                        .reduce((s, h) => s + h.shares, 0);
                      const payoutSEK = amountUSD * totalShares * usdSekRate;
                      if (!bySymbol[div.symbol]) {
                        bySymbol[div.symbol] = { symbol: div.symbol, exDate: div.exDate, payoutSEK: 0, amountUSD, source: div.source, frequency: div.frequency };
                      }
                      bySymbol[div.symbol].payoutSEK += payoutSEK;
                    }
                    return Object.values(bySymbol).sort((a, b) => new Date(a.exDate) - new Date(b.exDate)).map(d => (
                      <div key={d.symbol} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "rgba(255,255,255,0.03)", borderRadius: 10, padding: "8px 12px" }}>
                        <div>
                          <div style={{ fontSize: 12, fontWeight: 600, fontFamily: "'DM Mono',monospace" }}>{d.symbol}</div>
                          <div style={{ fontSize: 10, color: "#4b5563", marginTop: 2 }}>
                            {d.source === "manual"
                              ? <>Est. · {d.frequency ?? "quarterly"}</>
                              : <>Ex-div {new Date(d.exDate).toLocaleDateString("sv-SE")}</>
                            }
                          </div>
                        </div>
                        <div style={{ textAlign: "right" }}>
                          <div style={{ fontSize: 13, fontWeight: 700, fontFamily: "'DM Mono',monospace", color: "#22d3a5" }}>{fmtSEK(d.payoutSEK)}</div>
                          <div style={{ fontSize: 10, color: "#4b5563", marginTop: 1 }}>${d.amountUSD?.toFixed(4)}/share</div>
                        </div>
                      </div>
                    ));
                  })()}
                </div>
              )}
            </div>

            <div style={{ background: "rgba(34,211,165,0.05)", border: "1px solid rgba(34,211,165,0.15)", borderRadius: 12, padding: "12px 16px" }}>
              <p style={{ margin: 0, fontSize: 10, color: "#22d3a5", lineHeight: 1.8 }}>
                ⚡ Stocks: Finnhub · Crypto: CoinGecko · Forex: Frankfurter<br/>
                All values in SEK. Edit <strong>holdings.json</strong> to update positions.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
