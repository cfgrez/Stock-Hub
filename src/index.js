// Stock Hub — un solo Worker para las cuatro herramientas
//
//   /                        inicio
//   /descubrir/finviz/       screener de 4 filtros (HTML generado en el build)
//   /descubrir/metodo-11/    screener de 11 condiciones (HTML generado en el build)
//   /tecnico/?ticker=NVDA    análisis técnico (ex Quant TA)
//   /fundamental/?ticker=NVDA  Conviction Score (ex Conviction Filter)
//
//   /api/ta/*          backend técnico    → src/ta.js
//   /api/conviction/*  backend fundamental → src/conviction.js
//
// Todo lo que no es /api/ lo sirve Cloudflare directo desde public/.

import { handleTA } from "./ta.js";
import { handleConviction, convictionHealth } from "./conviction.js";

const TICKER_RE = /^[A-Z0-9][A-Z0-9.\-]{0,9}$/;

function redirect(to, status = 302) {
  return new Response(null, { status, headers: { location: to } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/health") {
      return Response.json({
        ok: true,
        service: "Stock Hub",
        kvCache: Boolean(env.CACHE),
        conviction: convictionHealth(env),
        timestamp: new Date().toISOString(),
      });
    }
    if (path.startsWith("/api/ta/")) return handleTA(request, env);
    if (path.startsWith("/api/conviction/")) return handleConviction(request, env, ctx);

    // Atajos legibles
    if (path === "/descubrir" || path === "/descubrir/") return redirect("/descubrir/finviz/");
    if (path === "/watchlist" || path === "/watchlist/") return redirect("/tecnico/?modo=watchlist");
    const m = path.match(/^\/(t|f)\/([^/]+)\/?$/i); // /t/NVDA y /f/NVDA
    if (m) {
      const t = decodeURIComponent(m[2]).toUpperCase();
      if (TICKER_RE.test(t)) {
        return redirect((m[1].toLowerCase() === "t" ? "/tecnico/" : "/fundamental/") + "?ticker=" + encodeURIComponent(t));
      }
    }

    return env.ASSETS.fetch(request);
  },
};
