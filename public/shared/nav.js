/* Stock Hub — barra de navegación común y watchlist compartida.
 * Se carga en todas las páginas (con defer). Sin dependencias ni estilos en línea,
 * para cumplir la política de seguridad estricta de /fundamental/.
 */
(function () {
  "use strict";
  if (document.getElementById("sh-bar")) return;

  var WL_KEY = "qta_watchlist"; // la misma clave que ya usaba Quant TA
  var TICKER_RE = /^[A-Z0-9][A-Z0-9.\-]{0,9}$/;

  function readWL() {
    try { var v = JSON.parse(localStorage.getItem(WL_KEY) || "[]"); return Array.isArray(v) ? v : []; }
    catch (e) { return []; }
  }
  function writeWL(list) {
    try { localStorage.setItem(WL_KEY, JSON.stringify(list)); } catch (e) { /* modo privado */ }
  }
  function params() { return new URLSearchParams(location.search); }
  function currentTicker() {
    var t = (params().get("ticker") || "").trim().toUpperCase();
    return TICKER_RE.test(t) ? t : "";
  }
  function section() {
    var p = location.pathname;
    if (p.indexOf("/tecnico") === 0) return params().get("modo") === "watchlist" ? "watchlist" : "tecnico";
    if (p.indexOf("/fundamental") === 0) return "fundamental";
    if (p.indexOf("/descubrir/finviz") === 0) return "finviz";
    if (p.indexOf("/descubrir/metodo-11") === 0) return "metodo11";
    if (p === "/" || p === "/index.html") return "inicio";
    return "";
  }
  function fichaURL(kind, t) {
    return "/" + kind + "/" + (t ? "?ticker=" + encodeURIComponent(t) : "");
  }

  var bar = document.createElement("div");
  bar.id = "sh-bar";
  bar.setAttribute("role", "navigation");
  bar.setAttribute("aria-label", "Stock Hub");
  bar.innerHTML =
    '<a class="sh-brand" href="/"><span class="sh-mark" aria-hidden="true"><i></i><i></i><i></i></span>Stock Hub</a>' +
    '<div class="sh-nav">' +
      '<div class="sh-group"><span class="sh-glabel">Descubrir</span>' +
        '<a class="sh-link" data-sec="finviz" href="/descubrir/finviz/">Filtros Finviz</a>' +
        '<a class="sh-link" data-sec="metodo11" href="/descubrir/metodo-11/">Método 11 condiciones</a>' +
      '</div>' +
      '<div class="sh-group"><span class="sh-glabel">Analizar<span class="sh-tk" data-tk></span></span>' +
        '<a class="sh-link" data-sec="tecnico" data-ficha="tecnico" href="/tecnico/">Técnico</a>' +
        '<a class="sh-link" data-sec="fundamental" data-ficha="fundamental" href="/fundamental/">Fundamental</a>' +
      '</div>' +
      '<a class="sh-link" data-sec="watchlist" href="/tecnico/?modo=watchlist">Watchlist <span class="sh-count" data-count></span></a>' +
    '</div>' +
    '<form class="sh-search" role="search">' +
      '<input name="t" maxlength="10" autocomplete="off" spellcheck="false" placeholder="Ticker" aria-label="Analizar ticker">' +
      '<button type="submit">Analizar</button>' +
    '</form>';

  document.body.insertBefore(bar, document.body.firstChild);

  var tkLabel = bar.querySelector("[data-tk]");
  var countEl = bar.querySelector("[data-count]");

  function refresh() {
    var sec = section();
    var t = currentTicker();
    bar.querySelectorAll("[data-sec]").forEach(function (a) {
      if (a.getAttribute("data-sec") === sec) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    // Las pestañas Técnico / Fundamental llevan el ticker que estás mirando
    bar.querySelectorAll("[data-ficha]").forEach(function (a) {
      a.href = fichaURL(a.getAttribute("data-ficha"), t);
    });
    tkLabel.textContent = t ? "\u00a0" + t : "";
    var n = readWL().length;
    countEl.textContent = n ? String(n) : "";
    syncStars();
  }

  // Buscador: se queda en Fundamental si ya estás ahí; si no, va a Técnico
  bar.querySelector("form").addEventListener("submit", function (e) {
    e.preventDefault();
    var input = this.elements.t;
    var t = (input.value || "").trim().toUpperCase();
    if (!TICKER_RE.test(t)) { input.focus(); input.select(); return; }
    location.href = fichaURL(section() === "fundamental" ? "fundamental" : "tecnico", t);
  });

  // Estrellas en las tablas de los screeners (links con data-ticker)
  var stars = [];
  document.querySelectorAll("table a[data-ticker]").forEach(function (a) {
    var t = (a.getAttribute("data-ticker") || "").toUpperCase();
    if (!TICKER_RE.test(t)) return;
    var b = document.createElement("button");
    b.type = "button";
    b.className = "sh-star";
    b.setAttribute("data-ticker", t);
    b.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation();
      var wl = readWL();
      wl = wl.indexOf(t) >= 0 ? wl.filter(function (x) { return x !== t; }) : wl.concat([t]);
      writeWL(wl);
      refresh();
    });
    a.insertAdjacentElement("afterend", b);
    stars.push(b);
  });
  function syncStars() {
    if (!stars.length) return;
    var wl = readWL();
    stars.forEach(function (b) {
      var t = b.getAttribute("data-ticker");
      var on = wl.indexOf(t) >= 0;
      b.textContent = on ? "\u2605" : "\u2606";
      b.setAttribute("aria-pressed", on ? "true" : "false");
      b.setAttribute("aria-label", (on ? "Quitar " : "Agregar ") + t + (on ? " de" : " a") + " la watchlist");
      b.title = on ? "En tu watchlist" : "Agregar a la watchlist";
    });
  }

  window.addEventListener("storage", function (e) { if (e.key === WL_KEY) refresh(); });
  window.addEventListener("popstate", refresh);
  window.StockHub = { refresh: refresh };
  refresh();
})();
