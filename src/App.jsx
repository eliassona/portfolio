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

// What key is used to look up the price? Uses h.priceSymbol if set, else h.symbol
function getPriceKey(h) {
  return h.priceSymbol ?? h.symbol;
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

  // ── Fetch all, deduplicating by priceKey ───────────────────────────────────
  const fetchAll = useCallback(async () => {
    setFetchStatus("loading");
    try {
      const stockHoldings  = holdings.filter(h => h.type === "stock");
      const cryptoHoldings = holdings.filter(h => h.type === "crypto");
      const forexHoldings  = holdings.filter(h => h.type === "forex");

      // Deduplicate symbols so we don't fetch the same price twice
      const uniqueStocks  = [...new Set(stockHoldings.map(getPriceKey))];
      const uniqueCryptos = [...new Set(cryptoHoldings.map(getPriceKey))];
      const uniqueForex   = [...new Set(forexHoldings.map(getPriceKey))];

      const [usdSek, forexResults] = await Promise.all([
        fetchUsdSek(),
        fetchAllForex(uniqueForex),
      ]);

      const results = {};

      for (const sym of uniqueStocks) {
        try {
          const { priceUSD, change, historyUSD } = await fetchStock(sym);
          results[sym] = {
            priceSEK:   priceUSD   != null ? priceUSD   * usdSek : null,
            historySEK: historyUSD != null ? historyUSD.map(v => v * usdSek) : null,
            change,
          };
        } catch {
          results[sym] = { priceSEK: null, change: null, historySEK: null };
        }
        await new Promise(r => setTimeout(r, 250));
      }

      for (const sym of uniqueCryptos) {
        try {
          results[sym] = await fetchCrypto(sym);
        } catch {
          results[sym] = { priceSEK: null, change: null, historySEK: null };
        }
        await new Promise(r => setTimeout(r, 500));
      }

      for (const sym of uniqueForex) {
        results[sym] = forexResults[sym] ?? { priceSEK: null, change: null, historySEK: null };
      }

      setPrices(results);
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
    const costSEK    = h.shares * h.avgCost;
    const gainSEK    = valueSEK != null ? valueSEK - costSEK : null;
    const gainPct    = gainSEK != null && costSEK !== 0 ? (gainSEK / costSEK) * 100 : null;
    return { ...h, priceSEK, change, historySEK, valueSEK, costSEK, gainSEK, gainPct };
  });

  // ── Allocation: group by displaySymbol and sum valueSEK ───────────────────
  const allocationGroups = (() => {
    const map = new Map();
    for (const h of enriched) {
      const key = getDisplaySymbol(h);
      if (!map.has(key)) {
        map.set(key, { label: key, valueSEK: 0, costSEK: 0, color: h.color });
      }
      const g = map.get(key);
      g.valueSEK += h.valueSEK ?? h.costSEK; // fall back to cost if no price yet
      g.costSEK  += h.costSEK;
    }
    return [...map.values()].sort((a, b) => b.valueSEK - a.valueSEK);
  })();

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

  const stockRows  = enriched.filter(h => h.type === "stock");
  const cryptoRows = enriched.filter(h => h.type === "crypto");
  const forexRows  = enriched.filter(h => h.type === "forex");

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
          <MetricCard label="Total Value"  value={totalValue > 0 ? fmtSEK(totalValue) : "—"} sub={`${holdings.length} positions`} accent="linear-gradient(90deg,#22d3a5,#6366f1)" loading={isLoading && totalValue === 0} />
          <MetricCard label="Total Return" value={fmtSEK(totalGain)}  sub={fmtPct(totalGainPct) + " all time"} accent={totalGain >= 0 ? "#22d3a5" : "#f87171"} loading={isLoading} />
          <MetricCard label="Day's P&L"    value={fmtSEK(dayChange)}  sub={fmtPct(totalValue > 0 ? dayChange / totalValue * 100 : 0) + " today"} accent={dayChange >= 0 ? "#22d3a5" : "#f87171"} loading={isLoading} />
          <MetricCard label="Cost Basis"   value={fmtSEK(totalCost)}  sub="Total invested" accent="#6366f1" />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: 18 }}>
          <div className={`fade-in ${animated ? "visible" : ""}`} style={{ transitionDelay: "80ms" }}>
            {stockRows.length  > 0 && <HoldingsTable rows={stockRows}  title="Stocks"     sourceLabel="via Finnhub" />}
            {cryptoRows.length > 0 && <HoldingsTable rows={cryptoRows} title="Crypto"     sourceLabel="via CoinGecko" />}
            {forexRows.length  > 0 && <HoldingsTable rows={forexRows}  title="Currencies" sourceLabel="via Frankfurter" />}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {/* Allocation — grouped by display symbol */}
            <div className={`fade-in ${animated ? "visible" : ""}`} style={{ background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 20, padding: "18px 22px", transitionDelay: "120ms" }}>
              <h2 style={{ margin: "0 0 18px", fontSize: 13, fontWeight: 600 }}>Allocation</h2>
              <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
                {allocationGroups.map((g, i) => {
                  const pct = totalValue > 0 ? (g.valueSEK / totalValue) * 100 : 0;
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
