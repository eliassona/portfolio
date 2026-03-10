import { useState, useEffect, useCallback, useRef } from "react";
import holdingsData from "../holdings.json";

const FINNHUB_KEY      = "cvt0nk1r01qhup0ti100cvt0nk1r01qhup0ti10g";
const REFRESH_MS       = 5 * 60 * 1000; // 5 minutes
const ALERT_SERVER     = `${window.location.protocol}//${window.location.hostname}:3001`;
const ALERT_THRESHOLD  = 5; // percent — also set in config.json on the server
const COLORS = ["#22d3a5", "#6366f1", "#f59e0b", "#ec4899", "#38bdf8", "#a78bfa", "#fb923c", "#34d399"];

// Market indexes & commodities — fetched via Finnhub quote endpoint
const INDEXES = [
  { symbol: "^DJI",    name: "Dow Jones",      group: "US" },
  { symbol: "^IXIC",   name: "Nasdaq",         group: "US" },
  { symbol: "^GSPC",   name: "S&P 500",        group: "US" },
  { symbol: "^OMX",    name: "OMX Stockholm",  group: "Nordic" },
  { symbol: "^OMXC25", name: "OMX Copenhagen", group: "Nordic" },
  { symbol: "^FTSE",   name: "FTSE 100",       group: "Europe" },
  { symbol: "^GDAXI",  name: "DAX",            group: "Europe" },
  { symbol: "GC=F",    name: "Gold",           group: "Commodities" },
  { symbol: "CL=F",    name: "Oil (WTI)",      group: "Commodities" },
  { symbol: "SI=F",    name: "Silver",         group: "Commodities" },
];

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

// Category for allocation panel.
// Use h.category to override, otherwise derive from type.
const CATEGORY_COLORS = {
  "Stocks":      "#6366f1",
  "Crypto":      "#f59e0b",
  "Real Estate": "#22d3a5",
  "Cash":        "#38bdf8",
  "Commodities": "#fb923c",
  "Other":       "#a78bfa",
};
function getCategory(h) {
  if (h.category) return h.category;
  if (h.type === "crypto")      return "Crypto";
  if (h.type === "forex")       return "Cash";
  if (h.type === "realestate")  return "Real Estate";
  if (h.type === "debt")        return null; // excluded from allocation
  return "Stocks";
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
    <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 16, padding: "18px 22px", position: "relative", overflow: "hidden" }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: accent }} />
      <p style={{ margin: 0, fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: "#6b7280", fontWeight: 600 }}>{label}</p>
      {loading
        ? <div style={{ margin: "10px 0 4px", height: 28, width: "60%", borderRadius: 6, background: "rgba(255,255,255,0.06)",  }} />
        : <p className="metric-value" style={{ margin: "8px 0 4px", fontWeight: 700, fontFamily: "'DM Mono', monospace", color: "#f1f5f9", letterSpacing: "-0.02em" }}>{value}</p>
      }
      {sub && <p style={{ margin: 0, fontSize: 11, color: "#6b7280" }}>{sub}</p>}
    </div>
  );
}


// ── Chart modal (standalone component — avoids re-render flicker from parent) ──
function ChartModal({ holding, onClose, usdSekRate, prices }) {
  const [tf, setTf]               = useState(holding.type === "forex" ? "1W" : "1M");
  const [chartData, setChartData] = useState(null);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState(null);
  const cache   = useRef({});
  const rateRef = useRef(usdSekRate);
  useEffect(() => { rateRef.current = usdSekRate; }, [usdSekRate]);

  const sym      = holding.priceSymbol ?? holding.symbol;
  const type     = holding.type;
  const priceKey = getPriceKey(holding);

  const timeframes = type === "forex"
    ? ["1W","1M","YTD","1Y"]
    : type === "crypto"
      ? ["1D","1W","1M","YTD","1Y"]
      : ["1D","1W","1M","YTD","1Y","5Y"];

  // stable: priceKey is derived from symbol+type, never changes for a given holding
  const fetchChartData = useCallback(async (timeframe) => {
    const cacheKey = `${priceKey}-${timeframe}`;
    if (cache.current[cacheKey]) { setChartData(cache.current[cacheKey]); return; }
    setLoading(true); setError(null); setChartData(null);
    try {
      const now  = new Date();
      const toTs = Math.floor(now.getTime() / 1000);
      let data   = null;

      if (type === "stock") {
        // Yahoo Finance — free, no key, reliable historical data
        let range, interval;
        if      (timeframe === "1D")  { range = "5d";  interval = "1d";  }
        else if (timeframe === "1W")  { range = "1mo"; interval = "1d";  }
        else if (timeframe === "1M")  { range = "3mo"; interval = "1d";  }
        else if (timeframe === "YTD") { range = "ytd"; interval = "1d";  }
        else if (timeframe === "1Y")  { range = "1y";  interval = "1wk"; }
        else                          { range = "5y";  interval = "1wk"; }
        const url  = `${ALERT_SERVER}/api/yahoo?symbol=${encodeURIComponent(sym)}&range=${range}&interval=${interval}`;
        const res  = await fetch(url);
        const json = await res.json();
        const result = json?.chart?.result?.[0];
        const timestamps = result?.timestamp;
        const closes     = result?.indicators?.quote?.[0]?.close;
        if (timestamps?.length && closes?.length) {
          data = timestamps
            .map((t, i) => ({ t: t * 1000, v: closes[i] == null ? null : closes[i] * rateRef.current }))
            .filter(d => d.v != null);
        }
      } else if (type === "crypto") {
        const id = COINGECKO_IDS[sym];
        if (!id) throw new Error("Unknown coin");
        let days;
        if      (timeframe === "1D")  days = 1;
        else if (timeframe === "1W")  days = 7;
        else if (timeframe === "1M")  days = 30;
        else if (timeframe === "YTD") days = Math.ceil((Date.now() - new Date(now.getFullYear(),0,1)) / 86400000);
        else                          days = 365;
        const res  = await fetch(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=sek&days=${days}`);
        const json = await res.json();
        if (json.prices?.length) data = json.prices.map(([t, v]) => ({ t, v }));
      } else if (type === "forex") {
        let startDate;
        if      (timeframe === "1W")  startDate = new Date(now - 7*86400000);
        else if (timeframe === "1M")  startDate = new Date(now - 30*86400000);
        else if (timeframe === "YTD") startDate = new Date(now.getFullYear(), 0, 1);
        else                          startDate = new Date(now - 365*86400000);
        const from = startDate.toISOString().slice(0,10);
        const to   = now.toISOString().slice(0,10);
        const res  = await fetch(`https://api.frankfurter.app/${from}..${to}?from=${sym}&to=SEK`);
        const json = await res.json();
        if (json.rates) {
          data = Object.entries(json.rates)
            .sort(([a],[b]) => a.localeCompare(b))
            .map(([date, r]) => ({ t: new Date(date).getTime(), v: r.SEK ?? null }))
            .filter(d => d.v != null);
        }
      }

      if (!data || data.length < 2) throw new Error("No data — market may be closed or data unavailable for this period");
      cache.current[cacheKey] = data;
      setChartData(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [priceKey, type, sym]); // eslint-disable-line

  useEffect(() => { fetchChartData(tf); }, [tf]); // eslint-disable-line

  useEffect(() => {
    const handler = e => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const label = getDisplaySymbol(holding);
  const p     = prices[priceKey];
  const isPos = (p?.change ?? 0) >= 0;
  const fmtSEKFull = n => n == null ? "—" : new Intl.NumberFormat("sv-SE", { style: "currency", currency: "SEK", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
  const fmtPct     = n => n == null ? "—" : (n >= 0 ? "+" : "") + n.toFixed(2) + "%";

  const renderChart = () => {
    if (loading) return (
      <div style={{ height: 220, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ width: 32, height: 32, borderRadius: "50%", border: "2px solid rgba(255,255,255,0.1)", borderTop: "2px solid #22d3a5", animation: "spin 0.8s linear infinite", WebkitAnimation: "spin 0.8s linear infinite" }} />
      </div>
    );
    if (error) return (
      <div style={{ height: 220, display: "flex", alignItems: "center", justifyContent: "center", color: "#f87171", fontSize: 12, textAlign: "center", padding: "0 16px" }}>
        {error}
      </div>
    );
    if (!chartData) return null;

    const W = 520, H = 200, PAD = { t: 10, r: 10, b: 28, l: 62 };
    const cW = W - PAD.l - PAD.r, cH = H - PAD.t - PAD.b;
    const vals = chartData.map(d => d.v);
    const minV = Math.min(...vals), maxV = Math.max(...vals);
    const range = maxV - minV || 1;
    const xi = i => PAD.l + (i / (chartData.length - 1)) * cW;
    const yi = v => PAD.t + cH - ((v - minV) / range) * cH;
    const pts     = chartData.map((d, i) => `${xi(i)},${yi(d.v)}`).join(" ");
    const fillPts = `${xi(0)},${PAD.t+cH} ${pts} ${xi(chartData.length-1)},${PAD.t+cH}`;
    const color   = chartData[chartData.length-1].v >= chartData[0].v ? "#22d3a5" : "#f87171";
    const yTicks  = [0, 0.33, 0.67, 1].map(pct => ({ v: minV + pct*range, y: PAD.t+cH - pct*cH }));
    const xIdxs   = [0, Math.floor(chartData.length/3), Math.floor(2*chartData.length/3), chartData.length-1];
    const fmtDate = ts => {
      const d = new Date(ts);
      return d.toLocaleDateString("sv-SE", { month: "short", day: "numeric" });
    };
    const changePct = ((chartData[chartData.length-1].v - chartData[0].v) / chartData[0].v) * 100;

    return (
      <>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
          <span style={{ fontSize: 11, color: "#4b5563" }}>{fmtDate(chartData[0].t)} — {fmtDate(chartData[chartData.length-1].t)}</span>
          <span style={{ fontFamily: "'DM Mono',monospace", fontSize: 13, fontWeight: 700, color }}>{changePct >= 0 ? "+" : ""}{changePct.toFixed(2)}%</span>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
          <defs>
            <linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.18" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          {yTicks.map((t, i) => <line key={i} x1={PAD.l} x2={W-PAD.r} y1={t.y} y2={t.y} stroke="rgba(255,255,255,0.06)" strokeWidth="1" />)}
          <polygon points={fillPts} fill="url(#chartFill)" />
          <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
          {yTicks.map((t, i) => (
            <text key={i} x={PAD.l-6} y={t.y+4} textAnchor="end" fontSize="9" fill="#4b5563">
              {new Intl.NumberFormat("sv-SE", { maximumFractionDigits: t.v >= 1000 ? 0 : 2 }).format(t.v)}
            </text>
          ))}
          {xIdxs.map(i => (
            <text key={i} x={xi(i)} y={H-6} textAnchor="middle" fontSize="9" fill="#4b5563">{fmtDate(chartData[i].t)}</text>
          ))}
        </svg>
      </>
    );
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#0f1623", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 20, padding: 24, width: "100%", maxWidth: 600, maxHeight: "90vh", overflowY: "auto", WebkitOverflowScrolling: "touch" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 40, height: 40, borderRadius: 10, fontSize: 14, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", background: `${holding.color}22`, color: holding.color }}>{label[0]}</div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 16 }}>{label}</div>
              <div style={{ fontSize: 11, color: "#4b5563", marginTop: 2 }}>{holding.name}</div>
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontFamily: "'DM Mono',monospace", fontSize: 18, fontWeight: 700 }}>{fmtSEKFull(p?.priceSEK)}</div>
            {p?.change != null && <div style={{ fontSize: 12, color: isPos ? "#22d3a5" : "#f87171", marginTop: 2 }}>{fmtPct(p.change)} today</div>}
            <button onClick={onClose} style={{ marginTop: 6, background: "rgba(255,255,255,0.06)", border: "none", borderRadius: 8, padding: "4px 10px", color: "#6b7280", fontSize: 11, cursor: "pointer" }}>✕ Close</button>
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, marginBottom: 18 }}>
          {timeframes.map(t => (
            <button key={t} onClick={() => setTf(t)} style={{ flex: 1, padding: "6px 0", borderRadius: 8, border: "none", fontSize: 11, fontWeight: 600, cursor: "pointer", background: tf === t ? "#22d3a5" : "rgba(255,255,255,0.06)", color: tf === t ? "#080c14" : "#6b7280", fontFamily: "'DM Sans',sans-serif", WebkitTapHighlightColor: "transparent" }}>
              {t}
            </button>
          ))}
        </div>
        {renderChart()}
      </div>
    </div>
  );
}


// ── Rate chart modal ──────────────────────────────────────────────────────────
function RateChartModal({ rate, onClose, goldUsd, prices, usdSekRate, bigMacSEK = 54 }) {
  const [tf, setTf]               = useState("1M");
  const [chartData, setChartData] = useState(null);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState(null);
  const cache = useRef({});
  const timeframes = ["1W", "1M", "YTD", "1Y"];

  const fetchData = useCallback(async (timeframe) => {
    const cacheKey = `rate-${rate.chartId}-${timeframe}`;
    if (cache.current[cacheKey]) { setChartData(cache.current[cacheKey]); return; }
    setLoading(true); setError(null); setChartData(null);
    try {
      const now = new Date();
      let data  = null;

      // Detect dynamic fiat pair: chartId looks like "USD_SEK", "EUR_JPY" etc — two 3-letter codes
      const fiatMatch = rate.chartId.match(/^([A-Z]{3})_([A-Z]{3})$/);
      if (fiatMatch && rate.chartId !== "BTC_USD") {
        const fromSym = fiatMatch[1];
        const toSym   = fiatMatch[2];
        // Frankfurter uses EUR as base; fetch both sides vs EUR then compute ratio
        const baseFetch = fromSym === "EUR" ? "EUR" : fromSym === "SEK" ? "SEK" : fromSym;
        let startDate;
        if      (timeframe === "1W")  startDate = new Date(now - 7*86400000);
        else if (timeframe === "1M")  startDate = new Date(now - 30*86400000);
        else if (timeframe === "YTD") startDate = new Date(now.getFullYear(), 0, 1);
        else                          startDate = new Date(now - 365*86400000);
        const fromDate = startDate.toISOString().slice(0,10);
        const toDate   = now.toISOString().slice(0,10);
        const res  = await fetch(`https://api.frankfurter.app/${fromDate}..${toDate}?from=${fromSym}&to=${toSym}`);
        const json = await res.json();
        if (json.rates) {
          data = Object.entries(json.rates)
            .sort(([a],[b]) => a.localeCompare(b))
            .map(([date, r]) => ({ t: new Date(date).getTime(), v: r[toSym] ?? null }))
            .filter(d => d.v != null);
        }
      } else if (rate.chartId === "BTC_USD" || rate.chartId === "BTC_GOLD") {
        // CoinGecko BTC in USD
        let days;
        if      (timeframe === "1W")  days = 7;
        else if (timeframe === "1M")  days = 30;
        else if (timeframe === "YTD") days = Math.ceil((Date.now() - new Date(now.getFullYear(),0,1)) / 86400000);
        else                          days = 365;
        const res  = await fetch(`https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=${days}`);
        const json = await res.json();
        if (json.prices?.length) {
          if (rate.chartId === "BTC_USD") {
            data = json.prices.map(([t, v]) => ({ t, v }));
          } else {
            // BTC/GOLD: need gold history too — use Yahoo proxy
            const gRes  = await fetch(`${ALERT_SERVER}/api/yahoo?symbol=GC%3DF&range=${days <= 7 ? "1mo" : days <= 30 ? "3mo" : days <= 100 ? "ytd" : "1y"}&interval=1d`);
            const gJson = await gRes.json();
            const gResult = gJson?.chart?.result?.[0];
            const gTs     = gResult?.timestamp ?? [];
            const gClose  = gResult?.indicators?.quote?.[0]?.close ?? [];
            // Build a date->goldPrice map
            const goldMap = {};
            gTs.forEach((t, i) => { if (gClose[i] != null) goldMap[new Date(t*1000).toISOString().slice(0,10)] = gClose[i]; });
            // Match BTC daily prices to gold prices by date
            data = json.prices
              .map(([t, btcUsd]) => {
                const dateStr = new Date(t).toISOString().slice(0,10);
                const gPrice  = goldMap[dateStr];
                return gPrice != null ? { t, v: btcUsd / gPrice } : null;
              })
              .filter(Boolean);
          }
        }
      }

      if (rate.chartId === "BIGMAC_SATS") {
        // Derive from BTC/SEK history — sats = (bigMacSEK / btcPriceSEK) * 1e8
        let days;
        if      (timeframe === "1W")  days = 7;
        else if (timeframe === "1M")  days = 30;
        else if (timeframe === "YTD") days = Math.ceil((Date.now() - new Date(now.getFullYear(),0,1)) / 86400000);
        else                          days = 365;
        const res  = await fetch(`https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=sek&days=${days}`);
        const json = await res.json();
        if (json.prices?.length) {
          data = json.prices.map(([t, btcSek]) => ({
            t,
            v: btcSek > 0 ? Math.round((bigMacSEK / btcSek) * 1e8) : null,
          })).filter(d => d.v != null);
        }
      }

      if (!data || data.length < 2) throw new Error("No data available");
      cache.current[cacheKey] = data;
      setChartData(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [rate.chartId]);

  useEffect(() => { fetchData(tf); }, [tf]); // eslint-disable-line

  useEffect(() => {
    const handler = e => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const renderChart = () => {
    if (loading) return (
      <div style={{ height: 220, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ width: 32, height: 32, borderRadius: "50%", border: "2px solid rgba(255,255,255,0.1)", borderTop: "2px solid #22d3a5", animation: "spin 0.8s linear infinite", WebkitAnimation: "spin 0.8s linear infinite" }} />
      </div>
    );
    if (error) return (
      <div style={{ height: 220, display: "flex", alignItems: "center", justifyContent: "center", color: "#f87171", fontSize: 12, textAlign: "center", padding: "0 16px" }}>{error}</div>
    );
    if (!chartData) return null;

    const W = 520, H = 200, PAD = { t: 10, r: 10, b: 28, l: 72 };
    const cW = W - PAD.l - PAD.r, cH = H - PAD.t - PAD.b;
    const vals = chartData.map(d => d.v);
    const minV = Math.min(...vals), maxV = Math.max(...vals);
    const range = maxV - minV || 1;
    const xi = i => PAD.l + (i / (chartData.length - 1)) * cW;
    const yi = v => PAD.t + cH - ((v - minV) / range) * cH;
    const pts     = chartData.map((d, i) => `${xi(i)},${yi(d.v)}`).join(" ");
    const fillPts = `${xi(0)},${PAD.t+cH} ${pts} ${xi(chartData.length-1)},${PAD.t+cH}`;
    const color   = chartData[chartData.length-1].v >= chartData[0].v ? "#22d3a5" : "#f87171";
    const yTicks  = [0, 0.33, 0.67, 1].map(p => ({ v: minV + p*range, y: PAD.t+cH - p*cH }));
    const xIdxs   = [0, Math.floor(chartData.length/3), Math.floor(2*chartData.length/3), chartData.length-1];
    const fmtDate = ts => new Date(ts).toLocaleDateString("sv-SE", { month: "short", day: "numeric" });
    const changePct = ((chartData[chartData.length-1].v - chartData[0].v) / chartData[0].v) * 100;
    const fmtY = v => {
      if (rate.chartId === "BTC_USD")      return new Intl.NumberFormat("sv-SE", { maximumFractionDigits: 0 }).format(v);
      if (rate.chartId === "BTC_GOLD")     return v.toFixed(2);
      if (rate.chartId === "BIGMAC_SATS")  return Math.round(v).toLocaleString("sv-SE") + " sats";
      return v.toFixed(rate.chartId.includes("JPY") ? 3 : 2);
    };

    return (
      <>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
          <span style={{ fontSize: 11, color: "#4b5563" }}>{fmtDate(chartData[0].t)} — {fmtDate(chartData[chartData.length-1].t)}</span>
          <span style={{ fontFamily: "'DM Mono',monospace", fontSize: 13, fontWeight: 700, color }}>{changePct >= 0 ? "+" : ""}{changePct.toFixed(2)}%</span>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
          <defs>
            <linearGradient id="rateChartFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.18" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          {yTicks.map((t, i) => <line key={i} x1={PAD.l} x2={W-PAD.r} y1={t.y} y2={t.y} stroke="rgba(255,255,255,0.06)" strokeWidth="1" />)}
          <polygon points={fillPts} fill="url(#rateChartFill)" />
          <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
          {yTicks.map((t, i) => (
            <text key={i} x={PAD.l-6} y={t.y+4} textAnchor="end" fontSize="9" fill="#4b5563">{fmtY(t.v)}</text>
          ))}
          {xIdxs.map(i => (
            <text key={i} x={xi(i)} y={H-6} textAnchor="middle" fontSize="9" fill="#4b5563">{fmtDate(chartData[i].t)}</text>
          ))}
        </svg>
      </>
    );
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#0f1623", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 20, padding: 24, width: "100%", maxWidth: 600, maxHeight: "90vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 40, height: 40, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", background: `${rate.color}22`, fontSize: 16 }}>⇄</div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 18 }}>{rate.label}</div>
              <div style={{ fontSize: 11, color: "#4b5563", marginTop: 2 }}>{rate.value}</div>
            </div>
          </div>
          <button onClick={onClose} style={{ background: "rgba(255,255,255,0.06)", border: "none", borderRadius: 8, padding: "4px 10px", color: "#6b7280", fontSize: 11, cursor: "pointer" }}>✕ Close</button>
        </div>
        <div style={{ display: "flex", gap: 6, marginBottom: 18 }}>
          {timeframes.map(t => (
            <button key={t} onClick={() => setTf(t)} style={{ flex: 1, padding: "6px 0", borderRadius: 8, border: "none", fontSize: 11, fontWeight: 600, cursor: "pointer", background: tf === t ? "#22d3a5" : "rgba(255,255,255,0.06)", color: tf === t ? "#080c14" : "#6b7280", fontFamily: "'DM Sans',sans-serif" }}>
              {t}
            </button>
          ))}
        </div>
        {renderChart()}
      </div>
    </div>
  );
}

export default function App() {
  const holdings = holdingsData
    .filter(h => h.type !== "realestate" && h.type !== "debt")
    .map((h, i) => ({ ...h, id: i, color: COLORS[i % COLORS.length] }));

  const [prices, setPrices]           = useState({});
  const [dividends, setDividends]     = useState([]);
  const [usdSekRate, setUsdSekRate]   = useState(10.35);
  const [fetchStatus, setFetchStatus] = useState("idle");
  const [lastFetched, setLastFetched] = useState(null);
  const [animated, setAnimated]       = useState(false);
  const [countdown, setCountdown]     = useState(REFRESH_MS / 1000);
  const [selectedHolding, setSelectedHolding] = useState(null); // for chart modal
  const [indexes, setIndexes]                 = useState([]);
  const [goldUsd, setGoldUsd]                 = useState(null);
  const goldUsdRef                            = useRef(null); // ref so fetchAll closure always reads latest value
  const [displayCurrency, setDisplayCurrency] = useState("SEK"); // loaded from config.json
  const [bigMacSEK, setBigMacSEK]             = useState(54);    // Swedish Big Mac price in SEK
  const [fiatRates, setFiatRates]             = useState([]); // configurable via config.json
  const [expandedCat, setExpandedCat]         = useState(null); // for allocation panel
  const [selectedRate, setSelectedRate]       = useState(null); // for exchange rate chart modal

  useEffect(() => { setTimeout(() => setAnimated(true), 100); }, []);

  // Keep goldUsdRef in sync with goldUsd state
  useEffect(() => { goldUsdRef.current = goldUsd; }, [goldUsd]);

  // Countdown ticker (no dependency on fetchAll)
  useEffect(() => {
    const id = setInterval(() => setCountdown(c => Math.max(0, c - 1)), 1000);
    return () => clearInterval(id);
  }, []);

  // Track which symbols we've already alerted on today so we don't spam
  const alertedToday = useRef(new Set());
  useEffect(() => {
    // Reset alerted set at midnight
    const now   = new Date();
    const msUntilMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1) - now;
    const id = setTimeout(() => { alertedToday.current = new Set(); }, msUntilMidnight);
    return () => clearTimeout(id);
  }, []);

  // ── Stock via Finnhub (quote) + Yahoo (30d history) ──────────────────────
  const fetchStock = async (symbol) => {
    const alertServer = `${window.location.protocol}//${window.location.hostname}:3001`;
    const [quoteRes, historyRes] = await Promise.all([
      fetch(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${FINNHUB_KEY}`),
      fetch(`${alertServer}/api/yahoo?symbol=${encodeURIComponent(symbol)}&range=1mo&interval=1d`),
    ]);
    const quote = await quoteRes.json();
    const priceUSD = quote.c ?? null;
    const prevUSD  = quote.pc ?? null;
    const change   = priceUSD != null && prevUSD != null && prevUSD !== 0 ? ((priceUSD - prevUSD) / prevUSD) * 100 : null;
    let historyUSD = null;
    try {
      const hJson  = await historyRes.json();
      const closes = hJson?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
      const filtered = closes.filter(v => v != null);
      if (filtered.length > 1) historyUSD = filtered;
    } catch { /* history unavailable */ }
    return { priceUSD, change, historyUSD };
  };

  // ── Crypto via CoinGecko ───────────────────────────────────────────────────
  const fetchCrypto = async (symbol) => {
    const id = COINGECKO_IDS[symbol];
    if (!id) return { priceSEK: null, priceUSD: null, change: null, historySEK: null };
    const [priceRes, historyRes] = await Promise.all([
      fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=sek,usd&include_24hr_change=true`),
      fetch(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=sek&days=30&interval=daily`)
    ]);
    const priceData   = await priceRes.json();
    const historyData = await historyRes.json();
    return {
      priceSEK:   priceData?.[id]?.sek ?? null,
      priceUSD:   priceData?.[id]?.usd ?? null,
      change:     priceData?.[id]?.sek_24h_change ?? null,
      historySEK: historyData?.prices ? historyData.prices.map(([, p]) => p) : null,
    };
  };

  // ── Forex via Frankfurter ──────────────────────────────────────────────────
  const fetchAllForex = async (symbols) => {
    if (!symbols.length) return {};
    const allSyms = [...new Set([...symbols, "SEK"])].join(",");
    try {
      const now      = new Date();
      const from     = new Date(now - 30 * 86400000).toISOString().slice(0, 10);
      const to       = now.toISOString().slice(0, 10);
      const [latestRes, historyRes] = await Promise.all([
        fetch(`https://api.frankfurter.app/latest?to=${allSyms}`),
        fetch(`https://api.frankfurter.app/${from}..${to}?from=EUR&to=SEK`),
      ]);
      const latest  = await latestRes.json();
      const history = await historyRes.json();
      // Build SEK history array from EUR→SEK daily rates
      const sekHistory = history.rates
        ? Object.entries(history.rates).sort(([a],[b]) => a.localeCompare(b)).map(([,r]) => r.SEK).filter(Boolean)
        : null;
      const rates  = { ...(latest.rates ?? {}), EUR: 1 };
      const sekPerEur = rates["SEK"] ?? 1;
      return Object.fromEntries(symbols.map(sym => {
        const rateToEur = rates[sym] ?? null;
        // History: derive per-symbol SEK history from EUR/SEK history ÷ their EUR rate
        // (Frankfurter-based, daily — acceptable for slow-moving fiat pairs)
        const historySEK = (sekHistory && rateToEur != null && rateToEur !== 0)
          ? sekHistory.map(s => s / rateToEur)
          : null;
        return [sym, { priceSEK: rateToEur != null ? sekPerEur / rateToEur : null, change: null, historySEK }];
      }));
    } catch {
      return Object.fromEntries(symbols.map(s => [s, { priceSEK: null, change: null, historySEK: null }]));
    }
  };

  // ── USD/SEK via Yahoo Finance (real-time) ────────────────────────────────
  const fetchUsdSek = async () => {
    try {
      const alertServer = `${window.location.protocol}//${window.location.hostname}:3001`;
      const res  = await fetch(`${alertServer}/api/yahoo?symbol=SEK%3DX&range=5d&interval=1d`);
      const json = await res.json();
      const closes = json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(v => v != null) ?? [];
      if (closes.length > 0) return closes[closes.length - 1];
    } catch { /* fall through */ }
    // Fallback to Frankfurter if Yahoo fails
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
  const fetchAll = useCallback(async (extraForexSymbols = []) => {
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

      // Always fetch USD, EUR, JPY + any currencies in configured exchange rate pairs
      const uniqueForexSymbols = [...new Set([...forexHoldings.map(h => h.priceSymbol ?? h.symbol), "USD", "EUR", "JPY", ...extraForexSymbols])];

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
      // Always store USD, EUR, JPY + fiat pair currencies so the exchange rate strip always shows
      const alwaysStore = [...new Set(["USD", "EUR", "JPY", ...extraForexSymbols])];
      for (const sym of alwaysStore) {
        const key = `forex:${sym}`;
        if (!results[key]) {
          results[key] = forexResults[sym] ?? { priceSEK: null, change: null, historySEK: null };
        }
      }
      // Patch USD price with the real-time Yahoo rate (Frankfurter is ECB, updated once/day)
      if (results["forex:USD"]) results["forex:USD"].priceSEK = usdSek;

      setPrices(results);

      // Fetch market indexes via Yahoo proxy (same as chart, no CORS issues)
      const indexResults = await Promise.all(
        INDEXES.map(async idx => {
          try {
            const res  = await fetch(`${ALERT_SERVER}/api/yahoo?symbol=${encodeURIComponent(idx.symbol)}&range=5d&interval=1d`);
            const json = await res.json();
            const result = json?.chart?.result?.[0];
            const closes = result?.indicators?.quote?.[0]?.close?.filter(v => v != null) ?? [];
            const prev   = closes.length >= 2 ? closes[closes.length - 2] : null;
            const last   = closes.length >= 1 ? closes[closes.length - 1] : null;
            const change = last != null && prev != null && prev !== 0 ? ((last - prev) / prev) * 100 : null;
            const currency = result?.meta?.currency ?? "USD";
            return { ...idx, value: last, change, currency };
          } catch {
            return { ...idx, value: null, change: null, currency: "USD" };
          }
        })
      );
      setIndexes(indexResults);
      // Get gold price from indexResults — single source of truth
      const goldFromIndex = indexResults.find(r => r.symbol === "GC=F")?.value ?? null;
      setGoldUsd(goldFromIndex);
      goldUsdRef.current = goldFromIndex;

      // Check for large movers and send email alert for any not already alerted today
      const alertCandidates = Object.entries(results)
        .filter(([key, p]) => {
          if (p.change == null || Math.abs(p.change) < ALERT_THRESHOLD) return false;
          if (alertedToday.current.has(key)) return false;
          return true;
        })
        .map(([key, p]) => {
          const h = holdings.find(h => getPriceKey(h) === key);
          return h ? { symbol: getDisplaySymbol(h), name: h.name, change: p.change, priceSEK: p.priceSEK } : null;
        })
        .filter(Boolean);

      if (alertCandidates.length > 0) {
        try {
          await fetch(`${ALERT_SERVER}/api/alert`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alerts: alertCandidates }),
          });
          alertCandidates.forEach(a => alertedToday.current.add(
            // re-derive the key from holdings to mark as alerted
            getPriceKey(holdings.find(h => getDisplaySymbol(h) === a.symbol) ?? {type:'',symbol:''})
          ));
        } catch (err) {
          console.warn('Alert server unreachable:', err.message);
        }
      }

      // Fetch dividends for unique stock symbols (deduplicated, skip ETF aliases)
      const uniqueStockSymbols = [...new Set(stockHoldings.map(h => h.priceSymbol ?? h.symbol))];
      const divResults = await fetchDividends(uniqueStockSymbols);
      setDividends(divResults);

      setFetchStatus("done");
      setLastFetched(new Date());
      setCountdown(REFRESH_MS / 1000);
    } catch (err) {
      console.error("Fetch error:", err);
      setFetchStatus("error");
    }
  }, []); // eslint-disable-line

  // Load config first, then fetchAll so fiatRates is populated before forex symbols are resolved
  useEffect(() => {
    fetch(`${window.location.protocol}//${window.location.hostname}:3001/api/config`)
      .then(r => r.json())
      .then(cfg => {
        if (cfg.display?.currency) setDisplayCurrency(cfg.display.currency.toUpperCase());
        if (cfg.bigMacSEK)        setBigMacSEK(cfg.bigMacSEK);
        if (cfg.exchangeRates)    setFiatRates(cfg.exchangeRates);
        // Pass fiat symbols directly into fetchAll so we don't depend on state being set yet
        const fiatSymbols = (cfg.exchangeRates ?? []).flatMap(p => [p.from, p.to]).filter(s => s !== "BTC");
        fetchAll(fiatSymbols);
      })
      .catch(() => { fetchAll([]); }); // config unreachable — fetch anyway with no extras
  }, []); // eslint-disable-line

  // Auto-refresh every 5 minutes — placed after fetchAll is defined.
  // Also refreshes immediately on visibility change if the tab was hidden
  // long enough that a refresh was due (browsers throttle timers in bg tabs).
  useEffect(() => {
    const id = setInterval(fetchAll, REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        const secsSinceFetch = lastFetched ? (Date.now() - lastFetched.getTime()) / 1000 : Infinity;
        if (secsSinceFetch >= REFRESH_MS / 1000) fetchAll();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [fetchAll, lastFetched]);

  // ── Display currency conversion ───────────────────────────────────────────
  // All internal values are in SEK. Convert to displayCurrency for rendering.
  const sekToDisplay = (() => {
    if (displayCurrency === "SEK") return 1;
    if (displayCurrency === "USD") return prices["forex:USD"]?.priceSEK ? 1 / prices["forex:USD"].priceSEK : null;
    if (displayCurrency === "EUR") return prices["forex:EUR"]?.priceSEK ? 1 / prices["forex:EUR"].priceSEK : null;
    if (displayCurrency === "JPY") return prices["forex:JPY"]?.priceSEK ? 1 / prices["forex:JPY"].priceSEK : null;
    if (displayCurrency === "BTC") {
      const btcSek = prices["crypto:BTC"]?.priceSEK;
      return btcSek ? 1 / btcSek : null;
    }
    // Generic forex — try to find the rate
    const fKey = `forex:${displayCurrency}`;
    return prices[fKey]?.priceSEK ? 1 / prices[fKey].priceSEK : null;
  })();

  const convertSEK = n => (n == null || sekToDisplay == null) ? null : n * sekToDisplay;

  const fmtDisplay = (n, decimals = 0) => {
    const v = convertSEK(n);
    if (v == null) return "—";
    if (displayCurrency === "BTC") {
      // Show in sats or BTC depending on size
      if (Math.abs(v) < 0.001) return (v * 1e8).toFixed(0) + " sats";
      return v.toFixed(6) + " ₿";
    }
    return new Intl.NumberFormat("sv-SE", { style: "currency", currency: displayCurrency, maximumFractionDigits: decimals }).format(v);
  };

  const fmtSEK     = n => fmtDisplay(n, 0);
  const fmtSEKFull = n => fmtDisplay(n, 2);
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

  // ── Allocation: grouped by category, with positions inside each ─────────────
  // Use costSEK as fallback when live prices haven't loaded yet
  const investedValue   = enriched.reduce((s, h) => s + (h.valueSEK ?? h.costSEK ?? 0), 0);
  const allocationTotal = investedValue + totalRealEstate;

  const categoryGroups = (() => {
    const cats = new Map();
    const addToCategory = (cat, label, valueSEK, color) => {
      if (!cat) return;
      if (!cats.has(cat)) cats.set(cat, { label: cat, valueSEK: 0, color: CATEGORY_COLORS[cat] ?? "#a78bfa", positions: [] });
      const g = cats.get(cat);
      g.valueSEK += valueSEK;
      // Merge positions with same label
      const existing = g.positions.find(p => p.label === label);
      if (existing) existing.valueSEK += valueSEK;
      else g.positions.push({ label, valueSEK, color });
    };
    for (const h of enriched) {
      const val = h.valueSEK ?? h.costSEK ?? 0;
      if (val > 0) addToCategory(getCategory(h), getDisplaySymbol(h), val, h.color);
    }
    for (const h of realEstateRows) {
      addToCategory("Real Estate", h.name, h.valueSEK ?? 0, h.color);
    }
    // Sort positions within each category by value
    for (const g of cats.values()) g.positions.sort((a, b) => b.valueSEK - a.valueSEK);
    return [...cats.values()].sort((a, b) => b.valueSEK - a.valueSEK);
  })();

  // ── Real estate table ─────────────────────────────────────────────────────
  const RealEstateTable = ({ rows }) => (
    <div style={{ background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 20, overflow: "hidden", marginBottom: 18 }}>
      <div style={{ padding: "16px 24px 13px", borderBottom: "1px solid rgba(255,255,255,0.06)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>Real Estate</h2>
        <span style={{ fontSize: 10, color: "#374151" }}>{fmtSEK(totalRealEstate)} total</span>
      </div>
      <div className="table-wrap"><table style={{ width: "100%", borderCollapse: "collapse", minWidth: 600 }}>
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
              <tr key={h.id} className="row-hover" onClick={() => setSelectedHolding(h)} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)", transition: "background 0.15s", cursor: "pointer" }}>
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
      </table></div>
    </div>
  );

  // ── Debt table ─────────────────────────────────────────────────────────────
  const DebtTable = ({ rows }) => (
    <div style={{ background: "rgba(255,255,255,0.025)", border: "1px solid rgba(248,113,113,0.15)", borderRadius: 20, overflow: "hidden", marginBottom: 18 }}>
      <div style={{ padding: "16px 24px 13px", borderBottom: "1px solid rgba(255,255,255,0.06)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>Debt</h2>
        <span style={{ fontSize: 10, color: "#f87171" }}>{fmtSEK(totalDebt)} total</span>
      </div>
      <div className="table-wrap"><table style={{ width: "100%", borderCollapse: "collapse", minWidth: 600 }}>
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
              <tr key={h.id} className="row-hover" onClick={() => setSelectedHolding(h)} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)", transition: "background 0.15s", cursor: "pointer" }}>
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
      </table></div>
    </div>
  );


  // ── Indexes table ─────────────────────────────────────────────────────────
  const IndexesTable = () => {
    // Group by group field
    const groups = INDEXES.reduce((acc, idx) => {
      if (!acc[idx.group]) acc[idx.group] = [];
      acc[idx.group].push(indexes.find(r => r.symbol === idx.symbol) ?? { ...idx, value: null, change: null });
      return acc;
    }, {});

    return (
      <div style={{ background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 20, overflow: "hidden", marginBottom: 18 }}>
        <div style={{ padding: "16px 24px 13px", borderBottom: "1px solid rgba(255,255,255,0.06)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>Markets</h2>
          <span style={{ fontSize: 10, color: "#374151", letterSpacing: "0.06em" }}>via Yahoo Finance</span>
        </div>
        <div style={{ padding: "4px 0 8px" }}>
          {Object.entries(groups).map(([group, items]) => (
            <div key={group}>
              <div style={{ padding: "8px 24px 4px", fontSize: 9, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "#374151" }}>{group}</div>
              {items.map(idx => {
                const isPos = (idx.change ?? 0) >= 0;
                const needsSEK = idx.currency === "USD" || idx.currency == null;
                const displayVal = idx.value != null
                  ? (needsSEK
                      ? new Intl.NumberFormat("sv-SE", { maximumFractionDigits: 2 }).format(idx.value)
                      : new Intl.NumberFormat("sv-SE", { maximumFractionDigits: 2 }).format(idx.value))
                  : "—";
                return (
                  <div key={idx.symbol} className="row-hover" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 24px", borderBottom: "1px solid rgba(255,255,255,0.03)", transition: "background 0.15s" }}>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 600, fontFamily: "'DM Mono',monospace" }}>{idx.name}</div>
                      <div style={{ fontSize: 10, color: "#4b5563", marginTop: 1 }}>{idx.symbol}</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      {isLoading && idx.value == null
                        ? <div className="pulsing" style={{ height: 14, width: 80, borderRadius: 4, background: "rgba(255,255,255,0.06)" }} />
                        : <>
                            <div style={{ fontSize: 13, fontWeight: 700, fontFamily: "'DM Mono',monospace" }}>{displayVal}</div>
                            {idx.change != null && (
                              <div style={{ fontSize: 11, fontWeight: 600, color: isPos ? "#22d3a5" : "#f87171", marginTop: 1 }}>
                                {isPos ? "+" : ""}{idx.change.toFixed(2)}%
                              </div>
                            )}
                          </>
                      }
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    );
  };

  // ── Holdings table ─────────────────────────────────────────────────────────
  const HoldingsTable = ({ rows, title, sourceLabel, showSparkline = true }) => (
    <div style={{ background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 20, overflow: "hidden", marginBottom: 18 }}>
      <div style={{ padding: "16px 24px 13px", borderBottom: "1px solid rgba(255,255,255,0.06)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>{title}</h2>
        <span style={{ fontSize: 10, color: "#374151", letterSpacing: "0.06em" }}>{sourceLabel}</span>
      </div>
      <div className="table-wrap"><table style={{ width: "100%", borderCollapse: "collapse", minWidth: 600 }}>
        <thead>
          <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
            {["Asset", "Account", "Amount", "Avg Cost", "Live Price", "Market Value", "Gain / Loss", ...(showSparkline ? ["30D"] : [])].map(col => (
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
              <tr key={h.id} className="row-hover" onClick={() => setSelectedHolding(h)} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)", transition: "background 0.15s", cursor: "pointer" }}>
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
                    ? <div style={{ height: 14, width: 60, borderRadius: 4, background: "rgba(255,255,255,0.06)",  }} />
                    : <>
                        <div style={{ fontFamily: "'DM Mono',monospace", fontSize: 12 }}>{fmtSEKFull(h.priceSEK)}</div>
                        {h.change != null && <div style={{ fontSize: 10, color: isPos ? "#22d3a5" : "#f87171", marginTop: 1 }}>{fmtPct(h.change)}</div>}
                      </>
                  }
                </td>
                <td style={{ padding: "12px 14px", fontFamily: "'DM Mono',monospace", fontSize: 12, fontWeight: 600 }}>
                  {isLoading ? <div style={{ height: 14, width: 70, borderRadius: 4, background: "rgba(255,255,255,0.06)",  }} /> : fmtSEK(h.valueSEK)}
                </td>
                <td style={{ padding: "12px 14px" }}>
                  {isLoading
                    ? <div style={{ height: 20, width: 100, borderRadius: 6, background: "rgba(255,255,255,0.06)",  }} />
                    : h.gainSEK != null
                      ? <span style={{ fontFamily: "'DM Mono',monospace", fontSize: 11, fontWeight: 600, color: isGainPos ? "#22d3a5" : "#f87171", background: isGainPos ? "rgba(34,211,165,0.1)" : "rgba(248,113,113,0.1)", padding: "2px 7px", borderRadius: 5 }}>
                          {isGainPos ? "+" : ""}{fmtSEK(h.gainSEK)} ({fmtPct(h.gainPct)})
                        </span>
                      : <span style={{ fontSize: 11, color: "#374151" }}>—</span>
                  }
                </td>
                {showSparkline && <td style={{ padding: "12px 14px" }}>
                  {h.historySEK ? <Sparkline data={h.historySEK} positive={isPos} /> : <div style={{ width: 80 }} />}
                </td>}
              </tr>
            );
          })}
        </tbody>
      </table></div>
    </div>
  );

  return (
    <>
    <div className="app-root" style={{ fontFamily: "'DM Sans','Helvetica Neue',sans-serif", color: "#e2e8f0", background: "#080c14" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=DM+Mono:wght@400;500&display=swap');

        * { box-sizing: border-box; }
        body { margin: 0; background: #080c14; }

        /* Safari: 100vh includes browser chrome — use fill-available as fallback */
        .app-root {
          min-height: 100vh;
          min-height: -webkit-fill-available;
        }

        .row-hover:hover { background: rgba(255,255,255,0.04) !important; }

        .fade-in { opacity: 0; transform: translateY(14px); transition: opacity 0.5s ease, transform 0.5s ease; }
        .fade-in.visible { opacity: 1; transform: translateY(0); }

        @keyframes pulse { 0%,100%{opacity:.35} 50%{opacity:.7} }
        @keyframes spin  { to { transform: rotate(360deg); } }
        .spinning { -webkit-animation: spin 0.8s linear infinite; animation: spin 0.8s linear infinite; }
        .pulsing  { -webkit-animation: pulse 1.5s infinite;       animation: pulse 1.5s infinite; }

        /* Sticky header — Safari requires the header NOT be inside overflow:hidden */
        .sticky-header {
          position: -webkit-sticky;
          position: sticky;
          top: 0;
          z-index: 50;
          border-bottom: 1px solid rgba(255,255,255,0.06);
          background: rgba(8,12,20,0.92);  /* opaque fallback for Safari backdrop-filter */
          -webkit-backdrop-filter: blur(12px);
          backdrop-filter: blur(12px);
        }

        .metrics-grid { display: -webkit-box; display: -ms-flexbox; display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 26px; }
        .main-grid    { display: grid; grid-template-columns: 1fr 300px; gap: 18px; }

        /* Tables: horizontal scroll on mobile */
        .table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
        .table-wrap table { min-width: 580px; width: 100%; border-collapse: collapse; }

        /* Metric card value — fluid font size */
        .metric-value { font-size: clamp(15px, 4vw, 26px); }

        .header-inner { padding: 18px 48px; }
        .page-inner   { padding: 36px 48px; max-width: 1400px; margin: 0 auto; }

        @media (max-width: 900px) {
          .main-grid    { grid-template-columns: 1fr; }
          .metrics-grid { grid-template-columns: repeat(2, 1fr); }
          .header-inner { padding: 14px 20px; }
          .page-inner   { padding: 20px 16px; }
        }
        @media (max-width: 500px) {
          .metrics-grid { grid-template-columns: repeat(2, 1fr); gap: 10px; }
          .header-inner { padding: 12px 16px; }
          .page-inner   { padding: 16px 12px; }
          .header-title { display: none; }
        }

        /* Tap highlight removal for iOS */
        button { -webkit-tap-highlight-color: transparent; touch-action: manipulation; }
        a      { -webkit-tap-highlight-color: transparent; }
      `}</style>

      <div className="sticky-header">
        <div className="header-inner" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: "linear-gradient(135deg,#22d3a5,#6366f1)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ fontSize: 14, fontWeight: 800, color: "#fff" }}>P</span>
          </div>
          <span className="header-title" style={{ fontWeight: 700, fontSize: 16, letterSpacing: "-0.02em" }}>Portfolio</span>
          {fetchStatus === "done"    && <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.1em", background: "rgba(34,211,165,0.12)",  color: "#22d3a5", padding: "2px 8px", borderRadius: 20, textTransform: "uppercase" }}>Live</span>}
          {displayCurrency !== "SEK" && <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.1em", background: "rgba(245,158,11,0.15)", color: "#f59e0b", padding: "2px 8px", borderRadius: 20 }}>{displayCurrency}</span>}
          {fetchStatus === "loading" && <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.1em", background: "rgba(99,102,241,0.12)",  color: "#a5b4fc", padding: "2px 8px", borderRadius: 20, textTransform: "uppercase" }}>Fetching…</span>}
          {fetchStatus === "error"   && <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.1em", background: "rgba(248,113,113,0.12)", color: "#f87171", padding: "2px 8px", borderRadius: 20, textTransform: "uppercase" }}>Error</span>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {lastFetched && <span style={{ fontSize: 11, color: "#374151" }}>{lastFetched.toLocaleTimeString("sv-SE")}</span>}
          {!isLoading && <span style={{ fontSize: 10, color: "#374151" }}>next in {Math.floor(countdown/60)}:{String(countdown%60).padStart(2,'0')}</span>}
          <button onClick={fetchAll} disabled={isLoading} style={{ display: "flex", alignItems: "center", gap: 6, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.09)", borderRadius: 10, padding: "7px 14px", color: "#d1d5db", fontSize: 12, fontWeight: 600, cursor: isLoading ? "not-allowed" : "pointer", fontFamily: "'DM Sans',sans-serif", opacity: isLoading ? 0.6 : 1 }}>
            <span className={isLoading ? "spinning" : ""} style={{ display: "inline-block", fontSize: 14 }}>↻</span>
            {isLoading ? "Fetching…" : "Refresh"}
          </button>
        </div>
        </div>
      </div>

      <div className="page-inner">
        <div className={`metrics-grid fade-in ${animated ? "visible" : ""}`}>
          <MetricCard label="Net Worth"    value={fmtSEK(netWorth)}  sub="Assets minus debt" accent="linear-gradient(90deg,#22d3a5,#6366f1)" loading={isLoading && totalValue === 0} />
          <MetricCard label="Portfolio"    value={totalValue > 0 ? fmtSEK(totalValue) : "—"} sub={fmtPct(totalGainPct) + " return"} accent={totalGain >= 0 ? "#22d3a5" : "#f87171"} loading={isLoading && totalValue === 0} />
          <MetricCard label="Day's P&L"    value={fmtSEK(dayChange)}  sub={fmtPct(totalValue > 0 ? dayChange / totalValue * 100 : 0) + " today"} accent={dayChange >= 0 ? "#22d3a5" : "#f87171"} loading={isLoading} />
          <MetricCard label="Total Debt"   value={fmtSEK(totalDebt)}  sub={`${debtRows.length} liabilities`} accent="#f87171" />
        </div>

        <div className="main-grid">
          <div className={`fade-in ${animated ? "visible" : ""}`} style={{ transitionDelay: "80ms" }}>
            {stockRows.length     > 0 && <HoldingsTable rows={stockRows}  title="Stocks"     sourceLabel="via Finnhub" />}
            {cryptoRows.length    > 0 && <HoldingsTable rows={cryptoRows} title="Crypto"     sourceLabel="via CoinGecko" />}
            {forexRows.length     > 0 && <HoldingsTable rows={forexRows}  title="Cash" sourceLabel="via Frankfurter" showSparkline={false} />}
            {realEstateRows.length > 0 && <RealEstateTable rows={realEstateRows} />}
            {debtRows.length       > 0 && <DebtTable rows={debtRows} />}
            <IndexesTable />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {/* Allocation — by category */}
            <div className={`fade-in ${animated ? "visible" : ""}`} style={{ background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 20, padding: "18px 22px", transitionDelay: "120ms" }}>
              <h2 style={{ margin: "0 0 18px", fontSize: 13, fontWeight: 600 }}>Allocation</h2>
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {categoryGroups.map((g, i) => {
                  const pct      = allocationTotal > 0 ? (g.valueSEK / allocationTotal) * 100 : 0;
                  const expanded = expandedCat === g.label;
                  return (
                    <div key={g.label}>
                      <div onClick={() => setExpandedCat(expanded ? null : g.label)}
                        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5, cursor: "pointer" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <div style={{ width: 8, height: 8, borderRadius: 2, background: g.color, flexShrink: 0 }} />
                          <span style={{ fontSize: 12, fontWeight: 700, color: "#e2e8f0" }}>{g.label}</span>
                          <span style={{ fontSize: 9, color: "#4b5563", marginLeft: 2 }}>{expanded ? "▲" : "▼"}</span>
                        </div>
                        <div style={{ textAlign: "right" }}>
                          <span style={{ fontSize: 12, fontFamily: "'DM Mono',monospace", fontWeight: 700, color: g.color }}>{pct.toFixed(1)}%</span>
                          <span style={{ fontSize: 10, color: "#4b5563", marginLeft: 8 }}>{fmtSEK(g.valueSEK)}</span>
                        </div>
                      </div>
                      <div style={{ height: 6, background: "rgba(255,255,255,0.06)", borderRadius: 4, overflow: "hidden", marginBottom: expanded ? 10 : 0 }}>
                        <div style={{ height: "100%", width: animated ? `${pct}%` : "0%", background: g.color, borderRadius: 4, transition: `width 0.9s cubic-bezier(0.4,0,0.2,1) ${i * 80}ms` }} />
                      </div>
                      {expanded && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 5, paddingLeft: 14, borderLeft: `2px solid ${g.color}33` }}>
                          {g.positions.map(p => {
                            const posPct = allocationTotal > 0 ? (p.valueSEK / allocationTotal) * 100 : 0;
                            return (
                              <div key={p.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                                  <div style={{ width: 5, height: 5, borderRadius: "50%", background: p.color, flexShrink: 0 }} />
                                  <span style={{ fontSize: 11, color: "#9ca3af" }}>{p.label}</span>
                                </div>
                                <div style={{ textAlign: "right" }}>
                                  <span style={{ fontSize: 10, fontFamily: "'DM Mono',monospace", color: "#6b7280" }}>{posPct.toFixed(1)}%</span>
                                  <span style={{ fontSize: 10, color: "#374151", marginLeft: 6 }}>{fmtSEK(p.valueSEK)}</span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
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

            {/* Currency holdings — only if forex positions exist */}
            {forexRows.length > 0 && (
              <div className={`fade-in ${animated ? "visible" : ""}`} style={{ background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 20, padding: "18px 22px", transitionDelay: "180ms" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
                  <h2 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>Cash</h2>
                  <span style={{ fontSize: 11, fontFamily: "'DM Mono',monospace", color: "#22d3a5", fontWeight: 600 }}>{fmtSEK(forexRows.reduce((s, h) => s + (h.valueSEK ?? 0), 0))}</span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                  {Object.values(
                    forexRows.reduce((acc, h) => {
                      const key = h.symbol;
                      if (!acc[key]) acc[key] = { symbol: key, name: h.name, totalShares: 0, valueSEK: 0, priceSEK: h.priceSEK, color: h.color };
                      acc[key].totalShares += h.shares;
                      acc[key].valueSEK   += h.valueSEK ?? 0;
                      return acc;
                    }, {})
                  ).sort((a, b) => b.valueSEK - a.valueSEK).map(c => (
                    <div key={c.symbol} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                        <div style={{ width: 24, height: 24, borderRadius: 6, fontSize: 9, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", background: `${c.color}22`, color: c.color }}>{c.symbol.slice(0,3)}</div>
                        <div>
                          <div style={{ fontSize: 11, fontWeight: 600 }}>{c.symbol}</div>
                          <div style={{ fontSize: 9, color: "#4b5563" }}>{c.totalShares.toLocaleString("sv-SE")} units · {c.priceSEK != null ? fmtSEKFull(c.priceSEK) : "—"}/unit</div>
                        </div>
                      </div>
                      <span style={{ fontSize: 12, fontWeight: 600, fontFamily: "'DM Mono',monospace", color: "#d1d5db" }}>{fmtSEK(c.valueSEK)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Upcoming dividends */}
            <div className={`fade-in ${animated ? "visible" : ""}`} style={{ background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 20, padding: "18px 22px", transitionDelay: "200ms" }}>
              <h2 style={{ margin: "0 0 14px", fontSize: 13, fontWeight: 600 }}>Upcoming Dividends</h2>
              <p style={{ margin: "0 0 12px", fontSize: 10, color: "#4b5563" }}>Next 30 days</p>
              {isLoading ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {[1,2].map(i => <div key={i} style={{ height: 36, borderRadius: 8, background: "rgba(255,255,255,0.04)",  }} />)}
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
                    const rows = Object.values(bySymbol).sort((a, b) => new Date(a.exDate) - new Date(b.exDate));
                    const grandTotal = rows.reduce((s, d) => s + d.payoutSEK, 0);
                    return <>
                      {rows.map(d => (
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
                      ))}
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid rgba(255,255,255,0.07)", paddingTop: 8, marginTop: 2 }}>
                        <span style={{ fontSize: 11, fontWeight: 600, color: "#6b7280" }}>Total</span>
                        <span style={{ fontSize: 14, fontWeight: 700, fontFamily: "'DM Mono',monospace", color: "#22d3a5" }}>{fmtSEK(grandTotal)}</span>
                      </div>
                    </>;
                  })()}
                </div>
              )}
            </div>

            {/* Exchange Rates pane — below Upcoming Dividends */}
            <div className={`fade-in ${animated ? "visible" : ""}`} style={{ background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 20, padding: "18px 22px", transitionDelay: "210ms" }}>
              <h2 style={{ margin: "0 0 14px", fontSize: 13, fontWeight: 600 }}>Exchange Rates</h2>
              {(() => {
                const PAIR_COLORS = ["#38bdf8","#a78bfa","#f59e0b","#34d399","#f472b6","#60a5fa","#fb923c"];
                const btcSek  = prices["crypto:BTC"]?.priceSEK;
                const btcUsd  = prices["crypto:BTC"]?.priceUSD ?? null; // direct from CoinGecko, not derived
                const goldNow = goldUsd ?? goldUsdRef.current;
                const btcGold = btcUsd != null && goldNow != null && goldNow > 0 ? btcUsd / goldNow : null;
                const bigMacSats = btcSek != null && btcSek > 0 ? Math.round((bigMacSEK / btcSek) * 1e8) : null;

                // Dynamic fiat pairs from config
                const fiatRows = fiatRates.map((pair, i) => {
                  const { from, to } = pair;
                  // Invert if "to" is the base currency we price things in (SEK)
                  const resolveSek = sym => sym === "SEK" ? 1 : sym === "BTC" ? prices["crypto:BTC"]?.priceSEK : prices[`forex:${sym}`]?.priceSEK;
                  const fromSek = resolveSek(from);
                  const toSek   = resolveSek(to);
                  let value = "—";
                  if (fromSek != null && toSek != null && toSek > 0) {
                    const rate = fromSek / toSek; // e.g. USD/SEK: fromSek(~10.5) / toSek(1) = 10.5
                    const decimals = to === "JPY" || from === "JPY" ? 2 : 2;
                    value = rate.toFixed(decimals);
                  }
                  const chartId = `${from}_${to}`;
                  return { key: chartId.toLowerCase(), label: `${from} / ${to}`, value, chartId, color: PAIR_COLORS[i % PAIR_COLORS.length] };
                });

                const rateRows = [
                  ...fiatRows,
                  { key: "btc-usd",    label: "BTC / USD",       value: btcUsd     != null ? new Intl.NumberFormat("sv-SE", { maximumFractionDigits: 0 }).format(btcUsd) : "—", chartId: "BTC_USD",   color: "#f59e0b" },
                  { key: "btc-gold",   label: "BTC / GOLD",      value: btcGold    != null ? btcGold.toFixed(2) + " oz"  : "—", chartId: "BTC_GOLD",  color: "#fb923c" },
                  { key: "bigmac-sats",label: "🍔 Big Mac (SE)", value: bigMacSats != null ? bigMacSats.toLocaleString("sv-SE") + " sats" : "—", chartId: "BIGMAC_SATS", color: "#22d3a5" },
                ];
                return (
                  <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                    {rateRows.map(r => (
                      <div key={r.key} onClick={() => setSelectedRate(r)} className="row-hover"
                        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 10px", background: "rgba(255,255,255,0.03)", borderRadius: 8, cursor: "pointer", transition: "background 0.15s" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <div style={{ width: 6, height: 6, borderRadius: "50%", background: r.color, flexShrink: 0 }} />
                          <span style={{ fontSize: 11, color: "#6b7280", letterSpacing: "0.04em" }}>{r.label}</span>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontSize: 12, fontWeight: 700, fontFamily: "'DM Mono',monospace", color: isLoading && r.value === "—" ? "#374151" : "#d1d5db" }}>{r.value}</span>
                          <span style={{ fontSize: 10, color: "#374151" }}>↗</span>
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>

            <div style={{ background: "rgba(34,211,165,0.05)", border: "1px solid rgba(34,211,165,0.15)", borderRadius: 12, padding: "12px 16px" }}>
              <p style={{ margin: 0, fontSize: 10, color: "#22d3a5", lineHeight: 1.8 }}>
                ⚡ Stocks: Finnhub · Crypto: CoinGecko · Forex: Frankfurter<br/>
                All values in {displayCurrency}. Edit <strong>holdings.json</strong> to update positions.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>

      {/* Chart modal */}
      {selectedHolding && (
        <ChartModal holding={selectedHolding} onClose={() => setSelectedHolding(null)} usdSekRate={usdSekRate} prices={prices} />
      )}
      {selectedRate && (
        <RateChartModal rate={selectedRate} onClose={() => setSelectedRate(null)} goldUsd={goldUsd} prices={prices} usdSekRate={usdSekRate} bigMacSEK={bigMacSEK} />
      )}
    </>
  );
}
