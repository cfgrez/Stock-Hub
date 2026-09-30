const form = document.querySelector("#analysis-form");
const tickerInput = document.querySelector("#ticker-input");
const forceRefreshInput = document.querySelector("#force-refresh");
const analyzeButton = document.querySelector("#analyze-button");
const loadingState = document.querySelector("#loading-state");
const loadingMessage = document.querySelector("#loading-message");
const errorState = document.querySelector("#error-state");
const errorMessage = document.querySelector("#error-message");
const dashboard = document.querySelector("#dashboard");
const historyPanel = document.querySelector("#history-panel");
const historyList = document.querySelector("#history-list");

const HISTORY_KEY = "conviction-filter-history-v1";
let currentAnalysis = null;
let loadingTimer = null;

const SCORE_LABELS = {
  roic: "ROIC",
  fcf: "Flujo de caja libre",
  leverage: "Deuda neta / EBITDA",
  revenue: "Ingresos YoY",
  earnings: "Beneficios y márgenes",
  priceContext: "Contexto 52 semanas",
  valuation: "Valoración P/E",
};

const SCORE_MAX = {
  roic: 20,
  fcf: 20,
  leverage: 20,
  revenue: 15,
  earnings: 10,
  priceContext: 5,
  valuation: 10,
};

const loadingMessages = [
  "Leyendo los últimos 10-K y 10-Q en SEC EDGAR.",
  "Reconstruyendo 8 trimestres de ingresos, márgenes y flujo de caja.",
  "Calculando ROIC, FCF, deuda neta/EBITDA y P/E con la rúbrica.",
  "Redactando los 3 riesgos materiales y sus señales de confirmación.",
  "Evaluando catalizadores: probabilidad, magnitud y cuánto está en precio.",
  "Aplicando la regla: si falla 2 de 3, no se toca.",
];

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "#";
  } catch {
    return "#";
  }
}

function titleCase(value) {
  const text = String(value || "");
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "—";
}

function formatPercent(value, digits = 1) {
  return Number.isFinite(Number(value))
    ? `${Number(value).toLocaleString("es-CL", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      })}%`
    : "ND";
}

function formatPrice(value, currency = "USD") {
  if (!Number.isFinite(Number(value))) return "ND";
  try {
    return new Intl.NumberFormat("es-CL", {
      style: "currency",
      currency: currency || "USD",
      maximumFractionDigits: 2,
    }).format(Number(value));
  } catch {
    return `${Number(value).toFixed(2)} ${currency || ""}`;
  }
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "ND";
  return new Intl.DateTimeFormat("es-CL", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function filterIcon(passed) {
  return passed ? "✓" : "×";
}

function statusClass(status) {
  return String(status || "").toLowerCase().replaceAll(" ", "-");
}

function startLoading() {
  dashboard.classList.add("hidden");
  errorState.classList.add("hidden");
  loadingState.classList.remove("hidden");
  analyzeButton.disabled = true;
  let index = 0;
  loadingMessage.textContent = loadingMessages[index];
  loadingTimer = setInterval(() => {
    index = (index + 1) % loadingMessages.length;
    loadingMessage.textContent = loadingMessages[index];
  }, 3800);
}

function stopLoading() {
  loadingState.classList.add("hidden");
  analyzeButton.disabled = false;
  clearInterval(loadingTimer);
  loadingTimer = null;
}

function showError(message) {
  stopLoading();
  errorMessage.textContent = message;
  errorState.classList.remove("hidden");
}

function renderFilters(filters) {
  const entries = [filters.bear, filters.score, filters.catalyst];
  document.querySelector("#filter-grid").innerHTML = entries
    .map(
      (filter) => `
        <article class="filter-card ${filter.passed ? "passed" : "failed"}">
          <span class="filter-icon">${filterIcon(filter.passed)}</span>
          <div>
            <small>${filter.passed ? "APRUEBA" : "FALLA"}</small>
            <h3>${escapeHtml(filter.label)}</h3>
            <p>${escapeHtml(filter.reason)}</p>
          </div>
        </article>`,
    )
    .join("");
}

function renderOverview(data) {
  const overview = data.overview;
  document.querySelector("#company-ticker").textContent = overview.ticker;
  document.querySelector("#company-name").textContent = overview.companyName;
  document.querySelector("#company-exchange").textContent = `${overview.exchange} · ${overview.currency}`;
  document.querySelector("#analysis-date").textContent = `Datos: ${overview.asOf}`;

  const cacheBadge = document.querySelector("#cache-badge");
  cacheBadge.textContent = data.meta.cached ? "Caché" : "Nuevo";
  cacheBadge.className = `cache-badge ${data.meta.cached ? "cached" : "fresh"}`;

  document.querySelector("#company-price").textContent = formatPrice(
    overview.price,
    overview.currency,
  );
  const change = document.querySelector("#company-change");
  change.textContent = Number.isFinite(Number(overview.changePercent))
    ? `${Number(overview.changePercent) >= 0 ? "+" : ""}${formatPercent(overview.changePercent)}`
    : "Variación ND";
  change.className = `quote-change ${Number(overview.changePercent) >= 0 ? "positive" : "negative"}`;
  document.querySelector("#company-market-cap").textContent = `Market cap: ${overview.marketCap}`;

  const total = data.score.total;
  document.querySelector("#score-ring").style.setProperty("--score", total);
  document.querySelector("#score-total").textContent = total;
  document.querySelector("#score-verdict").textContent = titleCase(data.score.verdict);

  const decisionBanner = document.querySelector("#decision-banner");
  decisionBanner.className = `decision-banner decision-${data.finalDecision.failedFilters}`;
  document.querySelector("#decision-title").textContent = data.finalDecision.decision;
  document.querySelector("#decision-explanation").textContent = data.finalDecision.explanation;
  document.querySelector("#decision-count").innerHTML = `<strong>${data.finalDecision.failedFilters}</strong><span>filtros<br>fallidos</span>`;
}

function renderMarketMetrics(overview) {
  const metrics = [
    ["P/E", overview.pe],
    ["Forward P/E", overview.forwardPe],
    ["Máximo 52 semanas", formatPrice(overview.high52Week, overview.currency)],
    ["Distancia al máximo", formatPercent(overview.distanceFromHighPercent)],
    ["Confianza de datos", titleCase(overview.dataConfidence)],
  ];

  document.querySelector("#market-metrics").innerHTML = metrics
    .map(
      ([label, value]) => `
        <div class="market-metric">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}</strong>
        </div>`,
    )
    .join("");
}

function renderRisks(data) {
  document.querySelector("#risk-grid").innerHTML = data.bearCase
    .map(
      (risk, index) => `
        <article class="risk-card">
          <div class="risk-card-top">
            <span class="risk-index">0${index + 1}</span>
            <span class="severity severity-${statusClass(risk.severity)}">${escapeHtml(risk.severity)}</span>
          </div>
          <h3>${escapeHtml(risk.title)}</h3>
          <p class="risk-thesis">${escapeHtml(risk.thesis)}</p>
          <div class="evidence-box">
            <strong>Evidencia</strong>
            <p>${escapeHtml(risk.evidence)}</p>
          </div>
          <dl>
            <div><dt>Tendencia</dt><dd>${escapeHtml(risk.trend)}</dd></div>
            <div><dt>Se confirma si…</dt><dd>${escapeHtml(risk.confirmationSignal)}</dd></div>
          </dl>
        </article>`,
    )
    .join("");

  const insiders = data.insiders;
  const transactions = insiders.notableTransactions.length
    ? `<ul>${insiders.notableTransactions.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
    : "<p>No se identificaron transacciones destacables.</p>";

  document.querySelector("#insider-panel").innerHTML = `
    <div class="insider-status insider-${statusClass(insiders.status)}">Insiders: ${escapeHtml(insiders.status)}</div>
    <div>
      <strong>Lectura de las operaciones internas</strong>
      <p>${escapeHtml(insiders.summary)}</p>
      ${transactions}
    </div>`;
}

function renderScorecard(data) {
  document.querySelector("#score-breakdown").innerHTML = Object.entries(SCORE_LABELS)
    .map(([key, label]) => {
      const metric = data.scorecard[key];
      const max = SCORE_MAX[key];
      const width = Math.max(0, Math.min(100, (metric.score / max) * 100));
      return `
        <article class="score-metric">
          <div class="score-metric-heading">
            <div>
              <span class="metric-status status-${statusClass(metric.status)}">${escapeHtml(metric.status)}</span>
              <h3>${escapeHtml(label)}</h3>
            </div>
            <strong>${metric.score}<small>/${max}</small></strong>
          </div>
          <div class="score-bar"><span data-width="${width}"></span></div>
          <div class="metric-value">${escapeHtml(metric.value)}</div>
          <p>${escapeHtml(metric.explanation)}</p>
        </article>`;
    })
    .join("");
  // La CSP de la página bloquea style="..." en el HTML; se aplica por CSSOM, que sí está permitido.
  document.querySelectorAll("#score-breakdown [data-width]").forEach((el) => {
    el.style.width = `${el.dataset.width}%`;
  });
}

function renderCatalysts(data) {
  document.querySelector("#catalyst-grid").innerHTML = data.catalysts
    .map(
      (catalyst, index) => `
        <article class="catalyst-card">
          <div class="catalyst-top">
            <span class="catalyst-index">C${index + 1}</span>
            <div class="probability-ring" data-probability="${Number(catalyst.probability) || 0}">
              <strong>${catalyst.probability}%</strong><span>prob.</span>
            </div>
          </div>
          <h3>${escapeHtml(catalyst.title)}</h3>
          <p>${escapeHtml(catalyst.description)}</p>
          <div class="catalyst-tags">
            <span>Magnitud ${escapeHtml(catalyst.magnitudeLevel)}</span>
            <span>En precio: ${escapeHtml(catalyst.pricedIn)}</span>
          </div>
          <dl>
            <div><dt>Impacto</dt><dd>${escapeHtml(catalyst.magnitude)}</dd></div>
            <div><dt>Timing</dt><dd>${escapeHtml(catalyst.timing)}</dd></div>
            <div><dt>Evidencia</dt><dd>${escapeHtml(catalyst.evidence)}</dd></div>
            <div><dt>Riesgo</dt><dd>${escapeHtml(catalyst.failureRisk)}</dd></div>
          </dl>
        </article>`,
    )
    .join("");
  document.querySelectorAll("#catalyst-grid [data-probability]").forEach((el) => {
    el.style.setProperty("--probability", el.dataset.probability);
  });
}

function renderQuarters(quarters) {
  document.querySelector("#quarters-table").innerHTML = quarters
    .map(
      (quarter) => `
        <tr>
          <td><strong>${escapeHtml(quarter.period)}</strong></td>
          <td>${formatPercent(quarter.revenueYoY)}</td>
          <td>${formatPercent(quarter.grossMargin)}</td>
          <td>${formatPercent(quarter.operatingMargin)}</td>
          <td>${escapeHtml(quarter.freeCashFlow)}</td>
          <td>${escapeHtml(quarter.guidanceNote)}</td>
        </tr>`,
    )
    .join("");
}

function renderSources(data) {
  document.querySelector("#sources-list").innerHTML = data.sources.length
    ? data.sources
        .map((source, index) => {
          const url = safeUrl(source.url);
          return `
            <a class="source-item" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">
              <span>${String(index + 1).padStart(2, "0")}</span>
              <div>
                <strong>${escapeHtml(source.title)}</strong>
                <small>${escapeHtml(source.publisher)} · ${escapeHtml(source.publishedDate)} · ${escapeHtml(source.sourceType)}</small>
              </div>
              <b aria-hidden="true">↗</b>
            </a>`;
        })
        .join("")
    : "<p>No se devolvieron enlaces verificables.</p>";

  document.querySelector("#limitations-list").innerHTML = `
    <h3>Limitaciones del análisis</h3>
    <ul>${data.limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
    <p class="model-note">Generado ${escapeHtml(formatDate(data.meta.generatedAt))} con ${escapeHtml(data.meta.model)}.</p>`;
}

function renderDashboard(data) {
  currentAnalysis = data;
  renderOverview(data);
  renderFilters(data.filters);
  document.querySelector("#executive-summary").textContent = data.executiveSummary;
  renderMarketMetrics(data.overview);
  renderRisks(data);
  renderScorecard(data);
  renderCatalysts(data);
  renderQuarters(data.quarters);
  renderSources(data);

  errorState.classList.add("hidden");
  dashboard.classList.remove("hidden");
  dashboard.scrollIntoView({ behavior: "smooth", block: "start" });
  saveHistory(data);

  const url = new URL(window.location.href);
  url.searchParams.set("ticker", data.overview.ticker);
  history.replaceState({}, "", url);
  if (window.StockHub) window.StockHub.refresh();
}

async function analyzeTicker(ticker) {
  const normalized = String(ticker || "").trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.-]{0,9}$/.test(normalized)) {
    showError("Ingresa un ticker válido, por ejemplo IBM, AAPL o BRK.B.");
    return;
  }

  tickerInput.value = normalized;
  startLoading();

  try {
    const response = await fetch("/api/conviction/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ticker: normalized,
        forceRefresh: forceRefreshInput.checked,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(
          "La API /api/analyze no fue desplegada. Verifica que src/index.js y wrangler.jsonc estén en GitHub y vuelve a desplegar.",
        );
      }
      throw new Error(payload.error || `Error HTTP ${response.status}`);
    }

    stopLoading();
    renderDashboard(payload);
  } catch (error) {
    showError(error.message || "Ocurrió un error inesperado.");
  }
}

function getHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveHistory(data) {
  const previous = getHistory().filter((item) => item.ticker !== data.overview.ticker);
  const next = [
    {
      ticker: data.overview.ticker,
      companyName: data.overview.companyName,
      score: data.score.total,
      verdict: data.score.verdict,
      decision: data.finalDecision.decision,
      generatedAt: data.meta.generatedAt,
    },
    ...previous,
  ].slice(0, 6);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  renderHistory();
}

function renderHistory() {
  const historyItems = getHistory();
  historyPanel.classList.toggle("hidden", historyItems.length === 0);
  historyList.innerHTML = historyItems
    .map(
      (item) => `
        <button type="button" class="history-item" data-history-ticker="${escapeHtml(item.ticker)}">
          <span><strong>${escapeHtml(item.ticker)}</strong><small>${escapeHtml(item.companyName)}</small></span>
          <b>${item.score}</b>
        </button>`,
    )
    .join("");
}

function buildSummaryText(data) {
  const filterLines = Object.values(data.filters)
    .map((filter) => `${filter.passed ? "APRUEBA" : "FALLA"} — ${filter.label}: ${filter.reason}`)
    .join("\n");
  return `${data.overview.ticker} — ${data.overview.companyName}\nConviction Score: ${data.score.total}/100 (${data.score.verdict})\nDecisión: ${data.finalDecision.decision}\n\n${filterLines}\n\n${data.executiveSummary}\n\nRegla: ${data.finalDecision.rule}`;
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  analyzeTicker(tickerInput.value);
});

document.querySelectorAll("[data-ticker]").forEach((button) => {
  button.addEventListener("click", () => analyzeTicker(button.dataset.ticker));
});

historyList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-history-ticker]");
  if (button) analyzeTicker(button.dataset.historyTicker);
});

document.querySelector("#clear-history").addEventListener("click", () => {
  localStorage.removeItem(HISTORY_KEY);
  renderHistory();
});

document.querySelector("#print-dashboard").addEventListener("click", () => window.print());

document.querySelector("#copy-summary").addEventListener("click", async (event) => {
  if (!currentAnalysis) return;
  const button = event.currentTarget;
  try {
    await navigator.clipboard.writeText(buildSummaryText(currentAnalysis));
    const original = button.textContent;
    button.textContent = "Resumen copiado";
    setTimeout(() => (button.textContent = original), 1800);
  } catch {
    button.textContent = "No se pudo copiar";
  }
});

tickerInput.addEventListener("input", () => {
  tickerInput.value = tickerInput.value.toUpperCase().replace(/[^A-Z0-9.-]/g, "");
});

const initialTicker = new URL(window.location.href).searchParams.get("ticker");
// Stock Hub: si llega con ?ticker=, analiza de inmediato (usa la caché de 6 horas si existe)
if (initialTicker) analyzeTicker(initialTicker);
renderHistory();
