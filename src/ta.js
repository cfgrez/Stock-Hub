/**
 * Quant TA Worker v2 — Análisis técnico de acciones en Cloudflare Workers
 * -----------------------------------------------------------------------
 * Funciones:
 *   • Ficha técnica completa (SMA/EMA/RSI/MACD/Bollinger/ATR/Fibonacci/S-R)
 *   • Gráfico de velas (SVG nativo) con SMA50/200 y volumen
 *   • Comparador de varias acciones a la vez
 *   • Caché opcional con Cloudflare KV (binding "CACHE")
 *
 * En Stock Hub este archivo solo contiene el backend; la interfaz está en
 * public/tecnico/index.html.
 *
 * Datos (sin API key): Yahoo Finance (principal) + Stooq (respaldo).
 * AVISO: herramienta educativa, no es asesoría financiera.
 */

// Rutas de este módulo (montadas en /api/ta/ por src/index.js)
export async function handleTA(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/api/ta/analyze") return withCORS(await handleAnalyze(url, env));
  if (url.pathname === "/api/ta/compare") return withCORS(await handleCompare(url, env));
  return json({ error: "Ruta no encontrada. Usa /api/ta/analyze o /api/ta/compare." }, 404);
}

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

async function handleAnalyze(url, env) {
  const sym = cleanSymbol(url.searchParams.get("symbol"));
  if (!sym) return json({ error: "Símbolo inválido. Ej: PLTR, AAPL, NVDA." }, 400);
  let candles;
  try {
    candles = await fetchDailyCached(sym, env);
  } catch (e) {
    return json({ error: `No se pudieron obtener datos para ${sym}. ${e.message}` }, 502);
  }
  if (!candles || candles.length < 60) return json({ error: `Datos insuficientes para ${sym}.` }, 404);
  try {
    return json(analyze(sym, candles), 200);
  } catch (e) {
    return json({ error: `Error al analizar ${sym}: ${e.message}` }, 500);
  }
}

async function handleCompare(url, env) {
  const raw = (url.searchParams.get("symbols") || "")
    .split(",").map(cleanSymbol).filter(Boolean);
  const syms = [...new Set(raw)].slice(0, 6);
  if (!syms.length) return json({ error: "Indica símbolos separados por coma. Ej: PLTR,NVDA,AAPL" }, 400);

  const results = await Promise.all(
    syms.map(async (s) => {
      try {
        const c = await fetchDailyCached(s, env);
        if (!c || c.length < 60) return { symbol: s, error: "datos insuficientes" };
        return compact(analyze(s, c));
      } catch (e) {
        return { symbol: s, error: e.message };
      }
    })
  );
  return json({ results }, 200);
}

const cleanSymbol = (s) => {
  s = (s || "").trim().toUpperCase();
  return /^[A-Z0-9.\-]{1,12}$/.test(s) ? s : null;
};

function compact(a) {
  return {
    symbol: a.symbol, price: a.price, changePct: a.changePct,
    rating: a.rating, ratingClass: a.ratingClass, score: a.score,
    rsi: a.oscillators.rsi, trend: a.trend,
    sma50: a.movingAverages.sma50, sma200: a.movingAverages.sma200,
    riskReward: a.plan.riskReward, asOf: a.asOf,
  };
}

/* ------------------------------------------------------------------ */
/* Datos + caché KV                                                    */
/* ------------------------------------------------------------------ */

async function fetchDailyCached(symbol, env) {
  const key = `candles:${symbol}`;
  if (env && env.CACHE) {
    try {
      const hit = await env.CACHE.get(key, "json");
      if (hit && hit.length) return hit;
    } catch (_) {}
  }
  const data = await fetchDaily(symbol);
  if (env && env.CACHE && data && data.length) {
    try {
      await env.CACHE.put(key, JSON.stringify(data), { expirationTtl: 600 }); // 10 min
    } catch (_) {}
  }
  return data;
}

async function fetchDaily(symbol) {
  try {
    const c = await fetchYahoo(symbol);
    if (c && c.length >= 60) return c;
  } catch (_) {}
  return await fetchStooq(symbol);
}

async function fetchYahoo(symbol) {
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5y&interval=1d`;
  const r = await fetch(u, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; quant-ta-worker/2.0)" },
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!r.ok) throw new Error(`Yahoo HTTP ${r.status}`);
  const data = await r.json();
  const res = data?.chart?.result?.[0];
  if (!res) throw new Error("Yahoo: sin resultados");
  const ts = res.timestamp || [];
  const q = res.indicators?.quote?.[0] || {};
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
    if ([o, h, l, c].some((x) => x == null || !isFinite(x))) continue;
    out.push({ t: ts[i] * 1000, o, h, l, c, v: v || 0 });
  }
  return out;
}

async function fetchStooq(symbol) {
  const s = symbol.toLowerCase().includes(".") ? symbol.toLowerCase() : `${symbol.toLowerCase()}.us`;
  const u = `https://stooq.com/q/d/l/?s=${encodeURIComponent(s)}&i=d`;
  const r = await fetch(u, { cf: { cacheTtl: 300, cacheEverything: true } });
  if (!r.ok) throw new Error(`Stooq HTTP ${r.status}`);
  const text = await r.text();
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2 || !/^Date/i.test(lines[0])) throw new Error("Stooq: respuesta vacía");
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const [d, o, h, l, c, v] = lines[i].split(",");
    const oo = +o, hh = +h, ll = +l, cc = +c;
    if (![oo, hh, ll, cc].every(isFinite)) continue;
    out.push({ t: new Date(d).getTime(), o: oo, h: hh, l: ll, c: cc, v: +v || 0 });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Indicadores                                                         */
/* ------------------------------------------------------------------ */

const sma = (arr, p) => (arr.length < p ? null : arr.slice(-p).reduce((a, b) => a + b, 0) / p);

function smaSeries(arr, p) {
  const out = new Array(arr.length).fill(null);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= p) sum -= arr[i - p];
    if (i >= p - 1) out[i] = sum / p;
  }
  return out;
}

function emaSeries(arr, p) {
  if (arr.length < p) return [];
  const k = 2 / (p + 1);
  const out = [];
  let prev = arr.slice(0, p).reduce((a, b) => a + b, 0) / p;
  out[p - 1] = prev;
  for (let i = p; i < arr.length; i++) {
    prev = arr[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}
const ema = (arr, p) => {
  const s = emaSeries(arr, p);
  return s.length ? s[s.length - 1] : null;
};

function rsi(closes, p = 14) {
  if (closes.length < p + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= p; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let ag = gain / p, al = loss / p;
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (p - 1) + (d > 0 ? d : 0)) / p;
    al = (al * (p - 1) + (d < 0 ? -d : 0)) / p;
  }
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}

function macd(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return null;
  const ef = emaSeries(closes, fast);
  const es = emaSeries(closes, slow);
  const line = [];
  for (let i = slow - 1; i < closes.length; i++) {
    if (ef[i] != null && es[i] != null) line.push(ef[i] - es[i]);
  }
  const sig = emaSeries(line, signal);
  const macdLine = line[line.length - 1];
  const signalLine = sig[sig.length - 1];
  return { macd: macdLine, signal: signalLine, hist: macdLine - signalLine };
}

function bollinger(closes, p = 20, mult = 2) {
  if (closes.length < p) return null;
  const slice = closes.slice(-p);
  const mid = slice.reduce((a, b) => a + b, 0) / p;
  const variance = slice.reduce((a, b) => a + (b - mid) ** 2, 0) / p;
  const sd = Math.sqrt(variance);
  return { mid, upper: mid + mult * sd, lower: mid - mult * sd };
}

function atr(candles, p = 14) {
  if (candles.length < p + 1) return null;
  const tr = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], pc = candles[i - 1].c;
    tr.push(Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc)));
  }
  let a = tr.slice(0, p).reduce((x, y) => x + y, 0) / p;
  for (let i = p; i < tr.length; i++) a = (a * (p - 1) + tr[i]) / p;
  return a;
}

function resample(candles, mode) {
  const key = (t) => {
    const d = new Date(t);
    if (mode === "month") return `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    const jan1 = Date.UTC(d.getUTCFullYear(), 0, 1);
    return `${d.getUTCFullYear()}-W${Math.floor((t - jan1) / (7 * 864e5))}`;
  };
  const map = new Map();
  for (const c of candles) map.set(key(c.t), c);
  return [...map.values()];
}

function trendOf(candles, shortP, longP) {
  const closes = candles.map((c) => c.c);
  if (closes.length < longP) return { label: "—" };
  const price = closes[closes.length - 1];
  const s = sma(closes, shortP), l = sma(closes, longP);
  const slope = closes[closes.length - 1] - closes[Math.max(0, closes.length - shortP)];
  let bull = 0;
  if (price > s) bull++;
  if (price > l) bull++;
  if (s > l) bull++;
  if (slope > 0) bull++;
  return { label: bull >= 3 ? "Alcista" : bull <= 1 ? "Bajista" : "Lateral" };
}

/* ------------------------------------------------------------------ */
/* Motor de análisis                                                   */
/* ------------------------------------------------------------------ */

function analyze(symbol, candles) {
  const closes = candles.map((c) => c.c);
  const highs = candles.map((c) => c.h);
  const lows = candles.map((c) => c.l);
  const vols = candles.map((c) => c.v);
  const last = candles[candles.length - 1];
  const price = last.c;
  const prevClose = candles[candles.length - 2]?.c ?? price;
  const changePct = ((price - prevClose) / prevClose) * 100;

  const sma50 = sma(closes, 50), sma100 = sma(closes, 100), sma200 = sma(closes, 200);
  const r = rsi(closes, 14), m = macd(closes), bb = bollinger(closes, 20, 2), a = atr(candles, 14);

  const hi52 = Math.max(...highs.slice(-252));
  const lo52 = Math.min(...lows.slice(-252));
  const vol = last.v;
  const volAvg = vols.slice(-20).reduce((x, y) => x + y, 0) / Math.min(20, vols.length);

  const weekly = resample(candles, "week"), monthly = resample(candles, "month");
  const trendDaily = trendOf(candles, 50, 200);
  const trendWeekly = trendOf(weekly, 10, 40);
  const trendMonthly = trendOf(monthly, 6, 12);

  const lo20 = Math.min(...lows.slice(-20)), hi20 = Math.max(...highs.slice(-20));
  const levels = [
    { name: "Mín. 52 sem.", value: lo52 },
    { name: "Máx. 52 sem.", value: hi52 },
    { name: "Mín. 20 sesiones", value: lo20 },
    { name: "Máx. 20 sesiones", value: hi20 },
    { name: "SMA 50", value: sma50 },
    { name: "SMA 100", value: sma100 },
    { name: "SMA 200", value: sma200 },
  ].filter((x) => x.value != null && isFinite(x.value));
  const supports = levels.filter((x) => x.value < price).sort((p, q) => q.value - p.value);
  const resistances = levels.filter((x) => x.value >= price).sort((p, q) => p.value - q.value);
  const nearestSupport = supports[0]?.value ?? price - 2 * a;
  const nearestResistance = resistances[0]?.value ?? price + 3 * a;

  const fibRange = hi52 - lo52;
  const fib = [0.236, 0.382, 0.5, 0.618, 0.786].map((p) => ({ level: p, price: lo52 + fibRange * p }));

  let bbRead = "dentro de bandas";
  if (bb) {
    if (price <= bb.lower) bbRead = "tocando/por debajo de la banda inferior (sobreventa estirada)";
    else if (price >= bb.upper) bbRead = "tocando/por encima de la banda superior (sobrecompra estirada)";
    else if (price > bb.mid) bbRead = "en la mitad superior del canal";
    else bbRead = "en la mitad inferior del canal";
  }

  // Motor de puntuación
  let score = 0;
  const signals = [];
  const add = (cond, pts, msg) => { if (cond) { score += pts; signals.push({ pts, msg }); } };
  add(price > sma50, 1, "Precio por encima de la SMA 50");
  add(price < sma50, -1, "Precio por debajo de la SMA 50");
  add(price > sma200, 1, "Precio por encima de la SMA 200 (tendencia mayor alcista)");
  add(price < sma200, -1, "Precio por debajo de la SMA 200 (tendencia mayor bajista)");
  if (sma50 != null && sma200 != null) {
    add(sma50 > sma200, 1, "SMA 50 > SMA 200 (golden cross)");
    add(sma50 < sma200, -1, "SMA 50 < SMA 200 (death cross)");
  }
  if (m) {
    add(m.hist > 0, 1, "MACD por encima de su señal (momentum positivo)");
    add(m.hist < 0, -1, "MACD por debajo de su señal (momentum negativo)");
  }
  if (r != null) {
    add(r >= 55 && r < 70, 1, "RSI con fuerza alcista (55–70)");
    add(r <= 45 && r > 30, -1, "RSI con debilidad (30–45)");
    if (r >= 70) signals.push({ pts: 0, msg: "RSI en sobrecompra (≥70): riesgo de corrección" });
    if (r <= 30) signals.push({ pts: 0, msg: "RSI en sobreventa (≤30): posible rebote técnico" });
  }
  add(trendWeekly.label === "Alcista", 1, "Tendencia semanal alcista");
  add(trendWeekly.label === "Bajista", -1, "Tendencia semanal bajista");

  let rating, ratingClass;
  if (score >= 5) { rating = "COMPRA FUERTE"; ratingClass = "strong-buy"; }
  else if (score >= 2) { rating = "COMPRA"; ratingClass = "buy"; }
  else if (score >= -1) { rating = "NEUTRAL"; ratingClass = "neutral"; }
  else if (score >= -4) { rating = "VENTA"; ratingClass = "sell"; }
  else { rating = "VENTA FUERTE"; ratingClass = "strong-sell"; }

  const bullishBias = score >= 2;
  const oversoldBounce = r != null && r <= 35 && score < 2;
  const entry = price;
  const stop = Math.min(nearestSupport - 0.5 * a, price - 1.5 * a);
  const target = Math.max(nearestResistance, price + 2 * a);
  const risk = entry - stop, reward = target - entry;
  const rr = risk > 0 ? reward / risk : null;
  const planMode = bullishBias ? "Largo a favor de tendencia"
    : oversoldBounce ? "Rebote de sobreventa (alto riesgo, posición pequeña)"
    : "Espectador / esperar confirmación";

  // Datos para el gráfico de velas (últimas 90 sesiones)
  const N = Math.min(90, candles.length);
  const s50 = smaSeries(closes, 50);
  const s200 = smaSeries(closes, 200);
  const chart = {
    candles: candles.slice(-N).map((c) => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v })),
    sma50: s50.slice(-N),
    sma200: s200.slice(-N),
  };

  return {
    symbol,
    asOf: new Date(last.t).toISOString().slice(0, 10),
    price, changePct, rating, ratingClass, score, signals,
    trend: { daily: trendDaily.label, weekly: trendWeekly.label, monthly: trendMonthly.label },
    movingAverages: { sma50, sma100, sma200 },
    oscillators: {
      rsi: r,
      rsiRead: r == null ? "—" : r >= 70 ? "sobrecompra" : r <= 30 ? "sobreventa" : r >= 50 ? "sesgo alcista" : "sesgo bajista",
      macd: m,
      macdRead: m ? (m.hist > 0 ? "señal de compra (cruce alcista)" : "señal de venta (cruce bajista)") : "—",
      bollinger: bb, bollingerRead: bbRead,
    },
    volume: {
      last: vol, avg20: volAvg,
      read: vol > volAvg * 1.2
        ? (changePct >= 0 ? "Volumen alto en subida: compradores en control" : "Volumen alto en bajada: vendedores en control")
        : "Volumen por debajo del promedio: poca convicción",
    },
    range52w: { high: hi52, low: lo52 },
    supports: supports.slice(0, 4),
    resistances: resistances.slice(0, 4),
    fibonacci: fib,
    atr: a,
    chart,
    plan: { mode: planMode, entry, stop, target, riskPerShare: risk, rewardPerShare: reward, riskReward: rr },
    disclaimer: "Herramienta educativa basada en datos públicos retrasados. No es asesoría financiera.",
  };
}

/* ------------------------------------------------------------------ */
/* HTTP utils                                                          */
/* ------------------------------------------------------------------ */

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "content-type": "application/json; charset=utf-8" },
  });
}
function withCORS(resp) {
  const h = new Headers(resp.headers);
  h.set("Access-Control-Allow-Origin", "*");
  return new Response(resp.body, { status: resp.status, headers: h });
}
