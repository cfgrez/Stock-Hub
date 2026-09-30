// Stock Conviction Dashboard — Cloudflare Worker (sin facturación)
//
// 1. Números: SEC EDGAR (gratis, sin clave) + precio de Yahoo Finance / Stooq
//    (gratis, sin clave). El Conviction Score se calcula AQUÍ con la rúbrica,
//    sin IA, así que es reproducible y no gasta cuota.
// 2. Narrativa: una sola llamada de IA para los 3 riesgos y los 3
//    catalizadores. Usa Gemini (si hay GEMINI_API_KEY y tiene cuota) y, si
//    falla, Workers AI (10.000 neurons/día gratis en el plan Workers Free).

const CACHE_TTL_SECONDS = 6 * 60 * 60;
const CACHE_VERSION = "v7-edgar";
const DEFAULT_WORKERS_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const SEC_CONCEPT_BASE = "https://data.sec.gov/api/xbrl/companyconcept";
const SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers_exchange.json";
const TAX_RATE = 0.21; // tasa usada para NOPAT en el ROIC
const DAY_MS = 86_400_000;

const SCORE_MAX = {
  roic: 20,
  fcf: 20,
  leverage: 20,
  revenue: 15,
  earnings: 10,
  priceContext: 5,
  valuation: 10,
};

// Etiquetas XBRL (us-gaap) a probar, en orden de preferencia.
const TAGS = {
  revenue: [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "Revenues",
    "SalesRevenueNet",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
  ],
  grossProfit: ["GrossProfit"],
  operatingIncome: ["OperatingIncomeLoss"],
  depreciation: [
    "DepreciationDepletionAndAmortization",
    "DepreciationAndAmortization",
    "DepreciationAmortizationAndAccretionNet",
    "Depreciation",
  ],
  operatingCashFlow: ["NetCashProvidedByUsedInOperatingActivities"],
  capex: ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"],
  eps: ["EarningsPerShareDiluted", "EarningsPerShareBasic"],
  longTermDebt: ["LongTermDebt"],
  longTermDebtNoncurrent: ["LongTermDebtNoncurrent"],
  longTermDebtCurrent: ["LongTermDebtCurrent", "DebtCurrent"],
  cash: ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"],
  shortTermInvestments: ["ShortTermInvestments", "MarketableSecuritiesCurrent"],
  equity: [
    "StockholdersEquity",
    "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
  ],
};

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      ...extraHeaders,
    },
  });
}

class AppError extends Error {
  constructor(message, status = 502, code = "ANALYSIS_FAILED") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const normalizeTicker = (v) => String(v || "").trim().toUpperCase();
const isValidTicker = (t) => /^[A-Z0-9][A-Z0-9.-]{0,9}$/.test(t);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const toDay = (iso) => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);
const dayToIso = (d) => new Date(d * DAY_MS).toISOString().slice(0, 10);
const near = (a, b, tol = 12) => Math.abs(a - b) <= tol;
const dur = (f) => (f.start == null ? null : f.end - f.start);

function clampInteger(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}

const nf = (digits) =>
  new Intl.NumberFormat("es-CL", { minimumFractionDigits: digits, maximumFractionDigits: digits });

function fmtPct(x, digits = 1) {
  return isNum(x) ? `${nf(digits).format(x * 100)}%` : "ND";
}

function fmtMoney(v) {
  if (!isNum(v)) return "ND";
  const sign = v < 0 ? "−" : "";
  const a = Math.abs(v);
  if (a >= 1e9) return `${sign}US$ ${nf(1).format(a / 1e9)} mil M`;
  if (a >= 1e6) return `${sign}US$ ${nf(0).format(a / 1e6)} M`;
  return `${sign}US$ ${nf(0).format(a)}`;
}

const fmtX = (x) => (isNum(x) ? `${nf(1).format(x)}x` : "ND");

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
function periodLabel(day) {
  const d = new Date(day * DAY_MS);
  return `Trim. a ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function secUserAgent(env) {
  return env.SEC_USER_AGENT || "Stock Conviction Dashboard contacto@example.com";
}

// Límite simple para respetar las 10 solicitudes/segundo de la SEC.
function createLimiter(maxConcurrent = 4, minGapMs = 130) {
  let active = 0;
  let last = 0;
  const queue = [];
  const next = () => {
    if (active >= maxConcurrent || queue.length === 0) return;
    const wait = last + minGapMs - Date.now();
    if (wait > 0) {
      setTimeout(next, wait);
      return;
    }
    const { fn, resolve, reject } = queue.shift();
    active += 1;
    last = Date.now();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        next();
      });
    next();
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

// ---------------------------------------------------------------------------
// SEC EDGAR
// ---------------------------------------------------------------------------

async function secFetch(url, env, { asText = false, ttl = 43_200 } = {}) {
  const res = await fetch(url, {
    headers: { "user-agent": secUserAgent(env), accept: "application/json" },
    cf: { cacheTtl: ttl, cacheEverything: true },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new AppError(
      res.status === 403 || res.status === 429
        ? "La SEC rechazó la consulta (límite de solicitudes o User-Agent). Revisa SEC_USER_AGENT y espera un minuto."
        : `La SEC respondió HTTP ${res.status}.`,
      502,
      "SEC_ERROR",
    );
  }
  return asText ? res.text() : res.json();
}

// Busca el ticker con indexOf en vez de JSON.parse del archivo completo
// (~1 MB), para no gastar el tiempo de CPU del plan gratuito.
async function lookupCompany(ticker, env) {
  const text = await secFetch(SEC_TICKERS_URL, env, { asText: true, ttl: 86_400 });
  if (!text) throw new AppError("No se pudo descargar la lista de tickers de la SEC.");
  const secTicker = ticker.replace(/\./g, "-");
  const needle = `,"${secTicker}","`;
  let from = 0;
  while (true) {
    const i = text.indexOf(needle, from);
    if (i < 0) return null;
    const start = text.lastIndexOf("[", i);
    const end = text.indexOf("]", i);
    try {
      const row = JSON.parse(text.slice(start, end + 1));
      if (typeof row[0] === "number") {
        return { cik: row[0], name: row[1], ticker: row[2], exchange: row[3] || "ND" };
      }
    } catch {
      // fila mal cortada: sigue buscando
    }
    from = i + needle.length;
  }
}

function conceptUrl(cik, taxonomy, tag) {
  return `${SEC_CONCEPT_BASE}/CIK${String(cik).padStart(10, "0")}/${taxonomy}/${tag}.json`;
}

function extractFacts(json, unitPrefs = ["USD"]) {
  const units = json?.units || {};
  const key = unitPrefs.find((u) => units[u]) || Object.keys(units)[0];
  const byPeriod = new Map();
  for (const f of units[key] || []) {
    if (!/^10-[KQ]/.test(f.form || "")) continue; // 10-K, 10-Q y sus enmiendas
    const k = `${f.start || ""}|${f.end}`;
    const prev = byPeriod.get(k);
    if (!prev || f.filed > prev.filed) byPeriod.set(k, f);
  }
  return [...byPeriod.values()].map((f) => ({
    start: f.start ? toDay(f.start) : null,
    end: toDay(f.end),
    val: Number(f.val),
    filed: f.filed,
    accn: f.accn,
    form: f.form,
  }));
}

// Prueba las etiquetas en orden y devuelve la primera con datos recientes.
async function fetchSeries(cik, tags, env, limit, { units = ["USD"], maxAgeDays = 550 } = {}) {
  const today = Math.round(Date.now() / DAY_MS);
  let best = null;
  for (const tag of tags) {
    const json = await limit(() => secFetch(conceptUrl(cik, "us-gaap", tag), env));
    if (!json) continue;
    const facts = extractFacts(json, units);
    if (!facts.length) continue;
    const latestEnd = Math.max(...facts.map((f) => f.end));
    const series = { tag, facts, latestEnd };
    if (today - latestEnd <= maxAgeDays) return series;
    if (!best || latestEnd > best.latestEnd) best = series;
  }
  return best;
}

async function fetchSharesOutstanding(cik, env, limit) {
  const json = await limit(() => secFetch(conceptUrl(cik, "dei", "EntityCommonStockSharesOutstanding"), env));
  const arr = json?.units?.shares || [];
  const valid = arr.filter((f) => /^10-[KQ]/.test(f.form || ""));
  if (!valid.length) return null;
  const latestFiled = valid.reduce((m, f) => (f.filed > m ? f.filed : m), "");
  // Suma todas las clases de acciones del último filing (ej. GOOGL/GOOG).
  const rows = valid.filter((f) => f.filed === latestFiled);
  const latestEnd = rows.reduce((m, f) => (f.end > m ? f.end : m), "");
  return rows.filter((f) => f.end === latestEnd).reduce((s, f) => s + Number(f.val), 0) || null;
}

function findDuration(series, end, minDays, maxDays) {
  if (!series) return null;
  const hits = series.facts.filter(
    (f) => f.start != null && near(f.end, end) && dur(f) >= minDays && dur(f) <= maxDays,
  );
  hits.sort((a, b) => Math.abs(a.end - end) - Math.abs(b.end - end));
  return hits[0] || null;
}

// Últimos 12 meses terminados en `end`: anual, o anual previo + YTD − YTD previo.
function ttmAt(series, end) {
  if (!series) return null;
  const annual = findDuration(series, end, 350, 380);
  if (annual) return annual.val;
  const ytds = series.facts
    .filter((f) => f.start != null && near(f.end, end) && dur(f) >= 80 && dur(f) < 350)
    .sort((a, b) => dur(b) - dur(a));
  const ytd = ytds[0];
  if (!ytd) return null;
  const priorYtd = series.facts.find(
    (f) => f.start != null && near(f.end, ytd.end - 365) && Math.abs(dur(f) - dur(ytd)) <= 12,
  );
  const prevAnnual = series.facts.find(
    (f) => f.start != null && near(f.end, ytd.start - 1) && dur(f) >= 350 && dur(f) <= 380,
  );
  if (!priorYtd || !prevAnnual) return null;
  return prevAnnual.val + ytd.val - priorYtd.val;
}

// Valor de un trimestre aislado (los flujos de caja en 10-Q vienen acumulados).
function quarterAt(series, end) {
  if (!series) return null;
  const q = findDuration(series, end, 80, 100);
  if (q) return q.val;
  const longer = series.facts
    .filter((f) => f.start != null && near(f.end, end) && dur(f) > 100)
    .sort((a, b) => dur(b) - dur(a));
  for (const L of longer) {
    const prev = series.facts.find(
      (f) =>
        f.start != null &&
        near(f.start, L.start, 5) &&
        dur(f) >= dur(L) - 105 &&
        dur(f) <= dur(L) - 75,
    );
    if (prev) return L.val - prev.val;
  }
  return null;
}

function latestInstant(series) {
  if (!series) return null;
  const inst = series.facts.filter((f) => f.start == null);
  if (!inst.length) return null;
  const maxEnd = Math.max(...inst.map((f) => f.end));
  const f = inst.filter((x) => x.end === maxEnd).sort((a, b) => (a.filed < b.filed ? 1 : -1))[0];
  return { val: f.val, end: f.end };
}

function quarterEnds(series, count = 12) {
  const ends = [
    ...new Set(
      series.facts
        .filter((f) => f.start != null && ((dur(f) >= 80 && dur(f) <= 100) || (dur(f) >= 350 && dur(f) <= 380)))
        .map((f) => f.end),
    ),
  ].sort((a, b) => b - a);
  const out = [];
  for (const e of ends) {
    if (!out.some((o) => near(o, e, 20))) out.push(e);
    if (out.length >= count) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Precio (sin clave): Yahoo Finance chart API y, si falla, Stooq CSV.
// ---------------------------------------------------------------------------

async function fetchPriceYahoo(ticker) {
  const symbol = ticker.replace(/\./g, "-");
  const res = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d`,
    { headers: { "user-agent": "Mozilla/5.0 (compatible; StockConvictionDashboard/2.0)" }, cf: { cacheTtl: 900 } },
  );
  if (!res.ok) return null;
  const json = await res.json().catch(() => null);
  const r = json?.chart?.result?.[0];
  const closes = (r?.indicators?.quote?.[0]?.close || []).filter(isNum);
  const highs = (r?.indicators?.quote?.[0]?.high || []).filter(isNum);
  if (closes.length < 20) return null;
  const price = isNum(r.meta?.regularMarketPrice) ? r.meta.regularMarketPrice : closes.at(-1);
  return {
    price,
    previousClose: closes.at(-2),
    high52: isNum(r.meta?.fiftyTwoWeekHigh) ? r.meta.fiftyTwoWeekHigh : Math.max(...highs),
    closes,
    currency: r.meta?.currency || "USD",
    asOf: r.meta?.regularMarketTime
      ? new Date(r.meta.regularMarketTime * 1000).toISOString().slice(0, 10)
      : null,
    source: { name: "Yahoo Finance", url: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}` },
  };
}

async function fetchPriceStooq(ticker) {
  const symbol = `${ticker.toLowerCase().replace(/\./g, "-")}.us`;
  const ymd = (d) => d.toISOString().slice(0, 10).replaceAll("-", "");
  const now = new Date();
  const from = new Date(now.getTime() - 372 * DAY_MS);
  const res = await fetch(
    `https://stooq.com/q/d/l/?s=${symbol}&i=d&d1=${ymd(from)}&d2=${ymd(now)}`,
    { cf: { cacheTtl: 900 } },
  );
  if (!res.ok) return null;
  const text = await res.text();
  if (!text.startsWith("Date")) return null;
  const rows = text
    .trim()
    .split("\n")
    .slice(1)
    .map((l) => l.split(","))
    .filter((c) => c.length >= 5 && isNum(Number(c[4])));
  if (rows.length < 20) return null;
  const closes = rows.map((c) => Number(c[4]));
  return {
    price: closes.at(-1),
    previousClose: closes.at(-2),
    high52: Math.max(...rows.map((c) => Number(c[2]))),
    closes,
    currency: "USD",
    asOf: rows.at(-1)[0],
    source: { name: "Stooq", url: `https://stooq.com/q/?s=${symbol}` },
  };
}

async function fetchPrice(ticker) {
  try {
    const y = await fetchPriceYahoo(ticker);
    if (y) return y;
  } catch {
    // sigue con Stooq
  }
  try {
    return await fetchPriceStooq(ticker);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Conviction Score — rúbrica exacta, calculada sin IA
// ---------------------------------------------------------------------------

const NO_DATA = (explanation) => ({ value: "ND", score: 0, status: "sin datos", explanation, available: false });
const metric = (value, score, status, explanation) => ({ value, score, status, explanation, available: true });

function scoreRoic(d) {
  if (!isNum(d.opTTM) || !isNum(d.equity)) return NO_DATA("Falta utilidad operativa o patrimonio en los filings.");
  const nopat = d.opTTM * (1 - TAX_RATE);
  let ic = d.equity + (d.debt || 0) - (d.cash || 0);
  let basis = "deuda + patrimonio − caja";
  if (ic <= 0) {
    ic = d.equity + (d.debt || 0);
    basis = "deuda + patrimonio (la caja supera al capital invertido neto)";
  }
  if (ic <= 0) return NO_DATA("Patrimonio negativo: el ROIC no es interpretable.");
  const roic = nopat / ic;
  const score = roic >= 0.15 ? 20 : roic >= 0.1 ? 12 : roic >= 0.05 ? 6 : 0;
  return metric(
    fmtPct(roic),
    score,
    score === 20 ? "cumple" : score > 0 ? "parcial" : "no cumple",
    `Utilidad operativa TTM ${fmtMoney(d.opTTM)} × (1 − ${TAX_RATE * 100}%) sobre capital invertido (${basis}) de ${fmtMoney(ic)}.`,
  );
}

function scoreFcf(d) {
  if (!isNum(d.fcf)) return NO_DATA("Falta flujo operativo o capex en los filings.");
  if (d.fcf < 0) return metric(fmtMoney(d.fcf), 0, "no cumple", "Flujo de caja libre TTM negativo.");
  if (!isNum(d.fcfPrev)) return metric(fmtMoney(d.fcf), 14, "parcial", "Positivo; no hay año previo comparable para medir la tendencia.");
  if (d.fcfPrev <= 0) return metric(fmtMoney(d.fcf), 20, "cumple", `Pasó de ${fmtMoney(d.fcfPrev)} a positivo en 12 meses.`);
  const g = d.fcf / d.fcfPrev - 1;
  const score = g > 0.05 ? 20 : g >= -0.05 ? 14 : 8;
  const label = score === 20 ? "creciendo" : score === 14 ? "estable" : "cayendo";
  return metric(
    fmtMoney(d.fcf),
    score,
    score === 20 ? "cumple" : "parcial",
    `Positivo y ${label}: ${fmtPct(g)} frente a ${fmtMoney(d.fcfPrev)} un año antes (flujo operativo − capex, TTM).`,
  );
}

function scoreLeverage(d) {
  if (!isNum(d.opTTM)) return NO_DATA("Falta utilidad operativa para calcular EBITDA.");
  if (!isNum(d.debt) && !isNum(d.cash)) return NO_DATA("No hay deuda ni caja reportadas en XBRL.");
  const ebitda = d.opTTM + (d.daTTM || 0);
  const daNote = isNum(d.daTTM) ? "" : " Sin dato de depreciación: EBITDA ≈ utilidad operativa.";
  if (ebitda <= 0) return metric("EBITDA negativo", 0, "no cumple", `EBITDA TTM ${fmtMoney(ebitda)}.${daNote}`);
  const netDebt = (d.debt || 0) - (d.cash || 0);
  const ratio = netDebt / ebitda;
  const score = ratio < 1 ? 20 : ratio < 2 ? 16 : ratio < 3 ? 8 : 3;
  const value = netDebt <= 0 ? `Caja neta ${fmtMoney(-netDebt)}` : fmtX(ratio);
  return metric(
    value,
    score,
    score >= 16 ? "cumple" : score === 8 ? "parcial" : "no cumple",
    `Deuda ${fmtMoney(d.debt || 0)}, caja e inversiones corto plazo ${fmtMoney(d.cash || 0)}, EBITDA TTM ${fmtMoney(ebitda)}.${daNote}`,
  );
}

function scoreRevenue(d) {
  if (!isNum(d.revTTM) || !isNum(d.revTTMPrev) || d.revTTMPrev <= 0)
    return NO_DATA("No hay 8 trimestres de ingresos comparables.");
  const g = d.revTTM / d.revTTMPrev - 1;
  const score = g >= 0.15 ? 15 : g >= 0.08 ? 12 : g >= 0.03 ? 8 : g >= 0 ? 4 : 0;
  const q = isNum(d.lastQuarterYoY) ? ` Último trimestre: ${fmtPct(d.lastQuarterYoY)} YoY.` : "";
  return metric(
    `${fmtPct(g)} TTM`,
    score,
    score === 15 ? "cumple" : score >= 4 ? "parcial" : "no cumple",
    `Ingresos 12 meses ${fmtMoney(d.revTTM)} vs ${fmtMoney(d.revTTMPrev)} un año antes.${q}`,
  );
}

function scoreEarnings(d) {
  const m = isNum(d.opTTM) && d.revTTM > 0 ? d.opTTM / d.revTTM : null;
  const mPrev = isNum(d.opTTMPrev) && d.revTTMPrev > 0 ? d.opTTMPrev / d.revTTMPrev : null;
  const dm = isNum(m) && isNum(mPrev) ? m - mPrev : null;
  let epsG = null;
  let epsTrend = null;
  if (isNum(d.eps) && isNum(d.epsPrev)) {
    if (d.epsPrev > 0) {
      epsG = d.eps / d.epsPrev - 1;
      epsTrend = epsG > 0.05 ? 1 : epsG < -0.05 ? -1 : 0;
    } else {
      epsTrend = d.eps > d.epsPrev ? 1 : -1;
    }
  }
  if (dm == null && epsTrend == null) return NO_DATA("No hay márgenes ni BPA comparables.");
  const marginTrend = dm == null ? null : dm > 0.005 ? 1 : dm < -0.005 ? -1 : 0;
  const severe =
    (isNum(epsG) && epsG < -0.25) ||
    (isNum(dm) && dm < -0.05) ||
    (isNum(d.eps) && d.eps < 0 && isNum(d.epsPrev) && d.epsPrev > 0);
  let score;
  if (severe) score = 0;
  else if (marginTrend === 1 && epsTrend === 1) score = 10;
  else if (marginTrend === -1 || epsTrend === -1) score = 3;
  else score = 7;
  const parts = [];
  if (isNum(m)) parts.push(`margen operativo ${fmtPct(m)} (${dm >= 0 ? "+" : ""}${isNum(dm) ? nf(1).format(dm * 100) : "?"} pp)`);
  if (isNum(d.eps)) parts.push(`BPA diluido TTM US$ ${nf(2).format(d.eps)}${isNum(epsG) ? ` (${fmtPct(epsG)})` : ""}`);
  const label = { 10: "ambos crecen", 7: "estables o mixtos", 3: "deterioro moderado", 0: "deterioro severo" }[score];
  return metric(
    parts.join(" · ") || "ND",
    score,
    score === 10 ? "cumple" : score === 7 ? "parcial" : "no cumple",
    `Beneficios y márgenes: ${label}, comparando los últimos 12 meses con el año previo.`,
  );
}

function scorePriceContext(p) {
  if (!p || !isNum(p.price) || !isNum(p.high52)) return NO_DATA("No se pudo obtener el precio.");
  const dist = p.price / p.high52 - 1;
  const last = p.closes.slice(-200);
  const sma = last.reduce((s, x) => s + x, 0) / last.length;
  const above = p.price > sma;
  let score;
  if (above && dist >= -0.1) score = 5;
  else if (above && dist >= -0.25) score = 4;
  else if (above) score = 3;
  else if (dist > -0.3) score = 2;
  else if (dist > -0.5) score = 1;
  else score = 0;
  return metric(
    `${fmtPct(dist)} del máximo`,
    score,
    score >= 4 ? "cumple" : score >= 2 ? "parcial" : "no cumple",
    `Precio ${above ? "sobre" : "bajo"} su media de ${last.length} sesiones (US$ ${nf(2).format(sma)}). Una caída grande bajo la media no se premia.`,
  );
}

function scoreValuation(p, d, epsG) {
  if (!p || !isNum(p.price) || !isNum(d.eps)) return NO_DATA("Falta precio o BPA para calcular el P/E.");
  if (d.eps <= 0) return metric("No interpretable", 0, "no cumple", "BPA TTM negativo o cero: el P/E no es interpretable.");
  const pe = p.price / d.eps;
  let score;
  if (pe <= 15) score = isNum(epsG) && epsG < -0.15 ? 7 : 10;
  else if (pe <= 25) score = isNum(epsG) && epsG < 0 ? 3 : 7;
  else if (pe <= 40) score = isNum(epsG) && epsG >= 0.25 ? 7 : 3;
  else if (pe <= 80) score = isNum(epsG) && epsG >= 0.3 ? 3 : 0;
  else score = 0;
  const label = { 10: "atractiva", 7: "razonable", 3: "exigente", 0: "extrema" }[score];
  return metric(
    `P/E ${fmtX(pe)}`,
    score,
    score === 10 ? "cumple" : score >= 3 ? "parcial" : "no cumple",
    `Valoración ${label}: P/E TTM contrastado con el crecimiento del BPA${isNum(epsG) ? ` (${fmtPct(epsG)})` : ""}. Sin P/E forward: requiere estimaciones de analistas.`,
  );
}

// ---------------------------------------------------------------------------
// Recolección de datos
// ---------------------------------------------------------------------------

async function collectFundamentals(ticker, env) {
  const company = await lookupCompany(ticker, env);
  if (!company) {
    throw new AppError(
      `No encontré ${ticker} en la lista de la SEC. Esta versión cubre empresas que reportan a la SEC (EE.UU.).`,
      404,
      "TICKER_NOT_FOUND",
    );
  }

  const limit = createLimiter();
  const cik = company.cik;
  const get = (key, opts) => fetchSeries(cik, TAGS[key], env, limit, opts);

  const [rev, gp, op, da, ocf, capex, eps, ltd, ltdNc, ltdC, cash, sti, equity, shares, price] =
    await Promise.all([
      get("revenue"),
      get("grossProfit"),
      get("operatingIncome"),
      get("depreciation"),
      get("operatingCashFlow"),
      get("capex"),
      get("eps", { units: ["USD/shares"] }),
      get("longTermDebt"),
      get("longTermDebtNoncurrent"),
      get("longTermDebtCurrent"),
      get("cash"),
      get("shortTermInvestments"),
      get("equity"),
      fetchSharesOutstanding(cik, env, limit).catch(() => null),
      fetchPrice(ticker),
    ]);

  if (!rev) {
    throw new AppError(
      `La SEC no tiene estados financieros us-gaap para ${ticker}. Suele pasar con empresas extranjeras que reportan en IFRS (20-F) o con bancos y aseguradoras.`,
      422,
      "NO_XBRL_DATA",
    );
  }

  const E = Math.max(...rev.facts.filter((f) => f.start != null).map((f) => f.end));
  const E1 = E - 365;

  const ocfTTM = ttmAt(ocf, E);
  const ocfPrev = ttmAt(ocf, E1);
  const capexTTM = ttmAt(capex, E);
  const capexPrev = ttmAt(capex, E1);

  const ltdInst = latestInstant(ltd);
  const nc = latestInstant(ltdNc);
  const cur = latestInstant(ltdC);
  let debt = null;
  if (ltdInst && (!nc || ltdInst.end >= nc.end)) debt = ltdInst.val; // LongTermDebt ya incluye la porción corriente
  else if (nc || cur) debt = (nc?.val || 0) + (cur?.val || 0);

  const cashInst = latestInstant(cash);
  const stiInst = latestInstant(sti);
  const cashTotal =
    cashInst || stiInst
      ? (cashInst?.val || 0) + (stiInst && (!cashInst || near(stiInst.end, cashInst.end, 20)) ? stiInst.val : 0)
      : null;

  const d = {
    revTTM: ttmAt(rev, E),
    revTTMPrev: ttmAt(rev, E1),
    opTTM: ttmAt(op, E),
    opTTMPrev: ttmAt(op, E1),
    daTTM: ttmAt(da, E),
    fcf: isNum(ocfTTM) && isNum(capexTTM) ? ocfTTM - capexTTM : null,
    fcfPrev: isNum(ocfPrev) && isNum(capexPrev) ? ocfPrev - capexPrev : null,
    eps: ttmAt(eps, E),
    epsPrev: ttmAt(eps, E1),
    debt,
    cash: cashTotal,
    equity: latestInstant(equity)?.val ?? null,
    shares,
  };

  const qEnds = quarterEnds(rev, 12);
  const quarters = qEnds.slice(0, 8).map((qe) => {
    const r = quarterAt(rev, qe);
    const rPrev = quarterAt(rev, qe - 365);
    const g = quarterAt(gp, qe);
    const o = quarterAt(op, qe);
    const oc = quarterAt(ocf, qe);
    const cx = quarterAt(capex, qe);
    const fact = rev.facts.find((f) => near(f.end, qe) && f.start != null);
    return {
      period: periodLabel(qe),
      revenueYoY: isNum(r) && isNum(rPrev) && rPrev > 0 ? Math.round((r / rPrev - 1) * 1000) / 10 : null,
      grossMargin: isNum(g) && r > 0 ? Math.round((g / r) * 1000) / 10 : null,
      operatingMargin: isNum(o) && r > 0 ? Math.round((o / r) * 1000) / 10 : null,
      freeCashFlow: isNum(oc) && isNum(cx) ? fmtMoney(oc - cx) : "ND",
      guidanceNote: `Ingresos ${fmtMoney(r)} · ${fact?.form || "SEC"}`,
    };
  });
  d.lastQuarterYoY = isNum(quarters[0]?.revenueYoY) ? quarters[0].revenueYoY / 100 : null;

  const latestFiling = rev.facts.reduce((m, f) => (!m || f.filed > m.filed ? f : m), null);

  return { company, d, quarters, price, periodEnd: E, latestFiling, tags: { rev: rev.tag } };
}

function buildScorecard(data) {
  const { d, price } = data;
  const epsG = isNum(d.eps) && isNum(d.epsPrev) && d.epsPrev > 0 ? d.eps / d.epsPrev - 1 : null;
  const scorecard = {
    roic: scoreRoic(d),
    fcf: scoreFcf(d),
    leverage: scoreLeverage(d),
    revenue: scoreRevenue(d),
    earnings: scoreEarnings(d),
    priceContext: scorePriceContext(price),
    valuation: scoreValuation(price, d, epsG),
  };

  let raw = 0;
  let availableMax = 0;
  let available = 0;
  for (const [key, max] of Object.entries(SCORE_MAX)) {
    const m = scorecard[key];
    m.score = clampInteger(m.score, 0, max);
    raw += m.score;
    if (m.available) {
      availableMax += max;
      available += 1;
    }
  }
  // Con 5 o más métricas se re-escala sobre lo disponible, para que un dato
  // faltante no hunda el score. Con menos, se deja el puntaje bruto.
  const rescaled = available >= 5 && available < 7;
  const total = rescaled ? Math.round((raw / availableMax) * 100) : raw;
  for (const m of Object.values(scorecard)) delete m.available;

  const verdict =
    total >= 80 ? "mejor oportunidad" : total >= 65 ? "fuerte" : total >= 50 ? "vigilar" : "evitar";
  return { scorecard, total, raw, available, rescaled, verdict, epsG };
}

// ---------------------------------------------------------------------------
// IA: caso bajista y catalizadores (una sola llamada)
// ---------------------------------------------------------------------------

const AI_SCHEMA = {
  type: "object",
  properties: {
    executiveSummary: { type: "string" },
    bearCase: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          thesis: { type: "string" },
          evidence: { type: "string" },
          severity: { type: "string", enum: ["baja", "media", "alta", "crítica"] },
          trend: { type: "string", enum: ["mejorando", "estable", "deteriorándose", "incierta"] },
          confirmationSignal: { type: "string" },
        },
        required: ["title", "thesis", "evidence", "severity", "trend", "confirmationSignal"],
      },
    },
    catalysts: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          probability: { type: "integer" },
          magnitudeLevel: { type: "string", enum: ["baja", "media", "alta"] },
          magnitude: { type: "string" },
          timing: { type: "string" },
          pricedIn: { type: "string", enum: ["sí", "parcialmente", "no", "incierto"] },
          evidence: { type: "string" },
          failureRisk: { type: "string" },
        },
        required: [
          "title",
          "description",
          "probability",
          "magnitudeLevel",
          "magnitude",
          "timing",
          "pricedIn",
          "evidence",
          "failureRisk",
        ],
      },
    },
  },
  required: ["executiveSummary", "bearCase", "catalysts"],
};

const AI_SYSTEM = `Eres un analista bursátil institucional, escéptico y cuantitativo. Recibes datos YA VERIFICADOS de los filings de la SEC y del mercado, y redactas en español claro:
- executiveSummary: 3-4 frases.
- bearCase: exactamente 3 riesgos materiales. La evidencia debe citar cifras de los datos entregados. Severidad "crítica" solo si el riesgo puede poner en duda la viabilidad del negocio o el valor de la acción.
- catalysts: exactamente 3 catalizadores ALCISTAS para los próximos 12 meses, con probabilidad 0-100, magnitud, timing y si ya están en precio.
Reglas: no inventes cifras que no estén en los datos. Para eventos que no aparecen en los datos (lanzamientos, fallos judiciales, contratos) usa lo que sepas y agrega "(verificar)". Sé conservador con las probabilidades. Responde solo con JSON.`;

function buildAiPrompt(data, sc, ticker) {
  const { company, d, quarters, price, periodEnd } = data;
  const lines = [
    `Empresa: ${company.name} (${ticker}), ${company.exchange}. Fecha de hoy: ${new Date().toISOString().slice(0, 10)}.`,
    `Último período reportado a la SEC: ${dayToIso(periodEnd)}.`,
    price
      ? `Precio: US$ ${nf(2).format(price.price)} al ${price.asOf || "hoy"}; máximo 52 semanas US$ ${nf(2).format(price.high52)}.`
      : "Precio: no disponible.",
    `Conviction Score calculado: ${sc.total}/100 (${sc.verdict}).`,
    ...Object.entries(sc.scorecard).map(
      ([k, m]) => `- ${k}: ${m.value} → ${m.score}/${SCORE_MAX[k]} (${m.status}). ${m.explanation}`,
    ),
    `Balance: deuda ${fmtMoney(d.debt)}, caja+inversiones ${fmtMoney(d.cash)}, patrimonio ${fmtMoney(d.equity)}.`,
    "Trimestres (más reciente primero): período | ingresos YoY | margen bruto | margen operativo | FCF",
    ...quarters.map(
      (q) =>
        `${q.period} | ${q.revenueYoY ?? "ND"}% | ${q.grossMargin ?? "ND"}% | ${q.operatingMargin ?? "ND"}% | ${q.freeCashFlow}`,
    ),
  ];
  return lines.join("\n");
}

function parseJsonLoose(text) {
  const clean = String(text || "").replace(/```(?:json)?/g, "").trim();
  try {
    return JSON.parse(clean);
  } catch {
    const a = clean.indexOf("{");
    const b = clean.lastIndexOf("}");
    if (a >= 0 && b > a) return JSON.parse(clean.slice(a, b + 1));
    throw new Error("La IA no devolvió JSON válido.");
  }
}

const isQuotaMessage = (msg) => /4006|neuron|quota|exceeded|rate.?limit|429|resource.?exhausted/i.test(String(msg || ""));

async function runWorkersAI(env, prompt) {
  if (!env.AI) throw new Error("Falta el binding AI en wrangler.jsonc.");
  const model = env.WORKERS_AI_MODEL || DEFAULT_WORKERS_AI_MODEL;
  const base = {
    messages: [
      { role: "system", content: AI_SYSTEM },
      { role: "user", content: prompt },
    ],
    max_tokens: 2500,
    temperature: 0.3,
  };
  let out;
  try {
    out = await env.AI.run(model, { ...base, response_format: { type: "json_schema", json_schema: AI_SCHEMA } });
  } catch (error) {
    if (isQuotaMessage(error?.message)) throw error;
    // Modelo sin JSON Mode o esquema no satisfecho: reintento en texto libre.
    out = await env.AI.run(model, base);
  }
  const r = out?.response ?? out?.choices?.[0]?.message?.content ?? out?.result?.response ?? out;
  return { data: typeof r === "object" && r ? r : parseJsonLoose(r), model: `Workers AI ${model}` };
}

async function runGemini(env, prompt) {
  const model = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  try {
    const res = await fetch(`${GEMINI_API_BASE}/${model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": env.GEMINI_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: AI_SYSTEM }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: AI_SCHEMA, temperature: 0.3 },
      }),
      signal: controller.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error?.message || `Gemini respondió HTTP ${res.status}.`);
    const text = (body?.candidates?.[0]?.content?.parts || []).map((p) => p?.text || "").join("");
    return { data: parseJsonLoose(text), model: `Gemini ${model}` };
  } finally {
    clearTimeout(timeout);
  }
}

async function generateNarrative(env, prompt) {
  const order = [];
  const hasGemini = Boolean(env.GEMINI_API_KEY);
  if (hasGemini && env.AI_PROVIDER !== "workers-ai") order.push(runGemini, runWorkersAI);
  else order.push(runWorkersAI, ...(hasGemini ? [runGemini] : []));

  const errors = [];
  for (const run of order) {
    try {
      return await run(env, prompt);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.some((e) => isQuotaMessage(e?.message))) {
    throw new AppError(
      "Se agotó la cuota gratuita de IA de hoy. Workers AI se reinicia a las 00:00 UTC (21:00 en Chile, horario de verano). Los tickers ya analizados siguen disponibles desde el caché.",
      429,
      "AI_QUOTA",
    );
  }
  throw new AppError(`No fue posible generar el caso bajista y los catalizadores: ${errors.at(-1)?.message || "error desconocido"}.`);
}

const SEVERITY = { baja: "baja", media: "media", alta: "alta", critica: "crítica", "crítica": "crítica" };
const TREND = { mejorando: "mejorando", estable: "estable", deteriorandose: "deteriorándose", "deteriorándose": "deteriorándose", incierta: "incierta" };
const PRICED = { si: "sí", "sí": "sí", parcialmente: "parcialmente", no: "no", incierto: "incierto" };
const MAGNITUDE = { baja: "baja", media: "media", alta: "alta" };
const plain = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
const pick = (map, v, fallback) => map[plain(v)] || map[String(v || "").toLowerCase()] || fallback;

function normalizeNarrative(raw) {
  const text = (v) => String(v ?? "").slice(0, 900);
  const bearCase = (Array.isArray(raw?.bearCase) ? raw.bearCase : []).slice(0, 3).map((r) => ({
    title: text(r.title),
    thesis: text(r.thesis),
    evidence: text(r.evidence),
    severity: pick(SEVERITY, r.severity, "media"),
    trend: pick(TREND, r.trend, "incierta"),
    confirmationSignal: text(r.confirmationSignal),
  }));
  const catalysts = (Array.isArray(raw?.catalysts) ? raw.catalysts : []).slice(0, 3).map((c) => ({
    title: text(c.title),
    description: text(c.description),
    probability: clampInteger(c.probability, 0, 100),
    magnitudeLevel: pick(MAGNITUDE, c.magnitudeLevel, "baja"),
    magnitude: text(c.magnitude),
    timing: text(c.timing),
    pricedIn: pick(PRICED, c.pricedIn, "incierto"),
    evidence: text(c.evidence),
    failureRisk: text(c.failureRisk),
  }));
  if (bearCase.length < 3 || catalysts.length < 3) {
    throw new AppError("La IA devolvió menos de 3 riesgos o 3 catalizadores. Intenta de nuevo.");
  }
  return { executiveSummary: text(raw.executiveSummary), bearCase, catalysts };
}

// ---------------------------------------------------------------------------
// Ensamblado final (mismo formato JSON que usa public/app.js)
// ---------------------------------------------------------------------------

function buildOverview(ticker, data, sc) {
  const { company, d, price, periodEnd } = data;
  const pe = isNum(price?.price) && d.eps > 0 ? price.price / d.eps : null;
  const dataConfidence = sc.available === 7 && price ? "alta" : sc.available >= 5 ? "media" : "baja";
  return {
    ticker,
    companyName: company.name,
    exchange: company.exchange,
    currency: price?.currency || "USD",
    price: price?.price ?? null,
    changePercent:
      isNum(price?.price) && isNum(price?.previousClose) && price.previousClose > 0
        ? Math.round((price.price / price.previousClose - 1) * 1000) / 10
        : null,
    marketCap: isNum(price?.price) && isNum(d.shares) ? fmtMoney(price.price * d.shares) : "ND",
    pe: pe ? fmtX(pe) : "ND",
    forwardPe: "ND",
    high52Week: price?.high52 ?? null,
    distanceFromHighPercent:
      isNum(price?.price) && isNum(price?.high52) ? Math.round((price.price / price.high52 - 1) * 1000) / 10 : null,
    asOf: `precio ${price?.asOf || "ND"} · estados al ${dayToIso(periodEnd)}`,
    dataConfidence,
  };
}

function buildSources(data) {
  const { company, latestFiling, price } = data;
  const cik10 = String(company.cik).padStart(10, "0");
  const sources = [
    {
      title: `Filings de ${company.name} en SEC EDGAR`,
      url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik10}&type=10-&dateb=&owner=include&count=40`,
      publisher: "sec.gov",
      publishedDate: latestFiling?.filed || "ND",
      sourceType: "regulatorio",
    },
  ];
  if (latestFiling?.accn) {
    sources.push({
      title: `Último ${latestFiling.form} usado en el cálculo`,
      url: `https://www.sec.gov/Archives/edgar/data/${company.cik}/${latestFiling.accn.replace(/-/g, "")}/`,
      publisher: "sec.gov",
      publishedDate: latestFiling.filed,
      sourceType: "regulatorio",
    });
  }
  if (price?.source) {
    sources.push({
      title: `Precio e historial de 52 semanas (${price.source.name})`,
      url: price.source.url,
      publisher: new URL(price.source.url).hostname,
      publishedDate: price.asOf || "ND",
      sourceType: "mercado",
    });
  }
  return sources;
}

function buildLimitations(data, sc) {
  const missing = Object.entries(sc.scorecard)
    .filter(([, m]) => m.status === "sin datos")
    .map(([k]) => k);
  const list = [
    `Conviction Score calculado con datos XBRL de la SEC; el ROIC usa una tasa de impuesto supuesta de ${TAX_RATE * 100}%.`,
    "La deuda considera deuda financiera de largo plazo y su porción corriente; no incluye arriendos ni papeles comerciales.",
    "Caso bajista y catalizadores redactados por IA sin búsqueda web: los eventos marcados «(verificar)» deben confirmarse.",
    "No se revisaron transacciones de insiders (Form 4) ni estimaciones de analistas (P/E forward).",
  ];
  if (missing.length) {
    list.unshift(
      `Sin datos para: ${missing.join(", ")}.${sc.rescaled ? ` El score se re-escaló sobre las ${sc.available} métricas disponibles (bruto ${sc.raw}).` : ""}`,
    );
  }
  if (!data.price) list.push("No se pudo obtener el precio: contexto de 52 semanas y P/E quedan sin datos.");
  return list.slice(0, 6);
}

function applyFilters(sc, narrative) {
  const { bearCase, catalysts } = narrative;
  const seriousRisks = bearCase.filter((r) => ["alta", "crítica"].includes(r.severity));
  const criticalRisks = bearCase.filter((r) => r.severity === "crítica");
  const bearPassed = seriousRisks.length < 2 && criticalRisks.length === 0;

  const catalystCandidates = catalysts.filter(
    (c) => c.probability >= 50 && ["media", "alta"].includes(c.magnitudeLevel) && c.pricedIn !== "sí",
  );
  const catalystPassed = catalystCandidates.length >= 2;
  const scorePassed = sc.total >= 65;
  const coverage = sc.available < 7 ? ` Con ${sc.available} de 7 métricas con datos.` : "";

  const filters = {
    bear: {
      passed: bearPassed,
      label: "Caso bajista",
      reason: bearPassed
        ? "No aparecen dos riesgos de severidad alta/crítica simultáneamente."
        : `${seriousRisks.length} riesgos materiales de severidad alta o crítica.`,
    },
    score: {
      passed: scorePassed,
      label: "Conviction Score",
      reason: `${sc.total}/100 — ${sc.verdict}. El filtro aprueba desde 65 puntos.${coverage}`,
    },
    catalyst: {
      passed: catalystPassed,
      label: "Catalizadores",
      reason: `${catalystCandidates.length} catalizadores cumplen probabilidad, magnitud y precio exigidos.`,
    },
  };

  const failedFilters = Object.values(filters).filter((f) => !f.passed).length;
  const decision =
    failedFilters >= 2 ? "NO TOCAR" : failedFilters === 1 ? "VIGILAR / ENTRADA CONDICIONADA" : "APTO PARA PROFUNDIZAR";
  return {
    filters,
    finalDecision: {
      decision,
      failedFilters,
      rule: "Si falla 2 de 3, no lo toco.",
      explanation:
        failedFilters >= 2
          ? `La acción falla ${failedFilters} filtros. Según la regla definida, queda descartada por ahora.`
          : failedFilters === 1
            ? "Solo falla un filtro. Requiere una condición de entrada y seguimiento antes de actuar."
            : "Supera los tres filtros, pero todavía requiere valoración de entrada, técnica y tamaño de posición.",
    },
  };
}

async function analyze(ticker, env) {
  const data = await collectFundamentals(ticker, env);
  const sc = buildScorecard(data);
  const { data: raw, model } = await generateNarrative(env, buildAiPrompt(data, sc, ticker));
  const narrative = normalizeNarrative(raw);
  const { filters, finalDecision } = applyFilters(sc, narrative);

  return {
    overview: buildOverview(ticker, data, sc),
    executiveSummary: narrative.executiveSummary,
    bearCase: narrative.bearCase,
    insiders: {
      status: "sin datos",
      summary: "Esta versión no consulta transacciones de insiders (Form 4). Revísalas en SEC EDGAR antes de decidir.",
      notableTransactions: [],
    },
    scorecard: sc.scorecard,
    catalysts: narrative.catalysts,
    quarters: data.quarters,
    score: { total: sc.total, verdict: sc.verdict },
    filters,
    finalDecision,
    sources: buildSources(data),
    limitations: buildLimitations(data, sc),
    meta: {
      generatedAt: new Date().toISOString(),
      model: `SEC EDGAR + ${model}`,
      cached: false,
      cacheHours: CACHE_TTL_SECONDS / 3600,
    },
  };
}

// ---------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------

function errorResponse(error) {
  if (error instanceof AppError) {
    return jsonResponse({ error: error.message, code: error.code }, error.status);
  }
  return jsonResponse(
    { error: error?.message || "No fue posible completar el análisis.", code: "ANALYSIS_FAILED" },
    502,
  );
}

async function handleAnalyze(request, env, ctx) {
  let input;
  try {
    input = await request.json();
  } catch {
    return jsonResponse({ error: "El cuerpo debe ser JSON válido." }, 400);
  }
  const ticker = normalizeTicker(input?.ticker);
  if (!isValidTicker(ticker)) {
    return jsonResponse({ error: "Ticker inválido. Usa entre 1 y 10 caracteres: letras, números, punto o guion." }, 400);
  }

  const cacheKey = new Request(
    `https://cache.stock-filter.internal/${CACHE_VERSION}/${encodeURIComponent(ticker)}`,
    { method: "GET" },
  );
  if (!input?.forceRefresh) {
    const cached = await caches.default.match(cacheKey);
    if (cached) {
      const payload = await cached.json();
      payload.meta = { ...(payload.meta || {}), cached: true };
      return jsonResponse(payload, 200, { "x-analysis-cache": "HIT" });
    }
  }

  try {
    const payload = await analyze(ticker, env);
    ctx.waitUntil(
      caches.default.put(
        cacheKey,
        new Response(JSON.stringify(payload), {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": `public, max-age=${CACHE_TTL_SECONDS}`,
          },
        }),
      ),
    );
    return jsonResponse(payload, 200, { "x-analysis-cache": "MISS" });
  } catch (error) {
    return errorResponse(error);
  }
}

// GET /api/conviction/metrics?ticker=AMD — solo números, sin IA (no gasta cuota).
async function handleMetrics(url, env) {
  const ticker = normalizeTicker(url.searchParams.get("ticker"));
  if (!isValidTicker(ticker)) return jsonResponse({ error: "Usa /api/conviction/metrics?ticker=AMD" }, 400);
  try {
    const data = await collectFundamentals(ticker, env);
    const sc = buildScorecard(data);
    return jsonResponse({
      overview: buildOverview(ticker, data, sc),
      score: { total: sc.total, raw: sc.raw, verdict: sc.verdict, metricsWithData: sc.available, rescaled: sc.rescaled },
      scorecard: sc.scorecard,
      quarters: data.quarters,
      inputs: data.d,
      revenueTag: data.tags.rev,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

// Rutas de este módulo (montadas en /api/conviction/ por src/index.js)
export function convictionHealth(env) {
  return {
    dataSources: ["SEC EDGAR", "Yahoo Finance / Stooq"],
    workersAiConfigured: Boolean(env.AI),
    workersAiModel: env.WORKERS_AI_MODEL || DEFAULT_WORKERS_AI_MODEL,
    geminiConfigured: Boolean(env.GEMINI_API_KEY),
    secUserAgentConfigured: Boolean(env.SEC_USER_AGENT) && !/ejemplo\.com|example\.com/.test(env.SEC_USER_AGENT),
  };
}

export async function handleConviction(request, env, ctx) {
  const url = new URL(request.url);

  if (url.pathname === "/api/conviction/metrics" && request.method === "GET") {
    return handleMetrics(url, env);
  }

  if (url.pathname === "/api/conviction/analyze") {
    if (request.method === "POST") return handleAnalyze(request, env, ctx);
    if (request.method === "GET") {
      return jsonResponse({ name: "Stock Conviction Dashboard API", method: "POST", example: { ticker: "AMD", forceRefresh: false } });
    }
    return jsonResponse({ error: "Método no permitido. Usa POST en /api/conviction/analyze." }, 405, { allow: "GET, POST" });
  }

  return jsonResponse({ error: "Ruta no encontrada. Usa /api/conviction/analyze o /api/conviction/metrics." }, 404);
}
