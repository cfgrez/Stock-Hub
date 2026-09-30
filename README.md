# Stock Hub

Tus cuatro apps de acciones en un solo Cloudflare Worker:

| Antes | Ahora |
|---|---|
| finvizfinance-cloudflare | `/descubrir/finviz/` |
| tradinghub-screener | `/descubrir/metodo-11/` |
| stock-to-worker-citadel (Quant TA) | `/tecnico/` |
| stock-conviction-dashboard | `/fundamental/` |

Todas comparten una barra superior con buscador de ticker. Lo que cambia en el uso:

- En los screeners, **clic en un ticker** abre su análisis técnico (antes iba a finviz.com), y la **estrella ☆** lo agrega a la watchlist.
- En la barra, **Técnico** y **Fundamental** mantienen el ticker que estás mirando: saltas de uno a otro sin volver a escribirlo.
- La **watchlist** es una sola para todo el sitio (`/tecnico/?modo=watchlist`), con botón **＋ Importar** para pegar tickers.
- Atajos: `/t/NVDA` abre el técnico, `/f/NVDA` el fundamental y `/watchlist` la watchlist.

## Estructura

```
src/index.js          router: /api/ta/*, /api/conviction/*, atajos; el resto lo sirve public/
src/ta.js             backend técnico (Yahoo Finance / Stooq), sin cambios de lógica
src/conviction.js     backend fundamental (SEC EDGAR + Gemini / Workers AI), sin cambios de lógica
screeners/finviz.py   screener de 4 filtros  -> public/descubrir/finviz/index.html
screeners/metodo11.py screener de 11 condiciones -> public/descubrir/metodo-11/index.html
screeners/build_all.py corre los dos (si uno falla, el otro igual se publica)
public/index.html     inicio
public/tecnico/       interfaz de Quant TA
public/fundamental/   interfaz de Conviction Filter
public/shared/        barra común y watchlist compartida
public/_headers       cabeceras de seguridad
```

Las páginas de `public/descubrir/` que vienen en el repo son de reemplazo; el build las sobrescribe.

## Publicar en Cloudflare

1. Crea el repositorio `stock-hub` en GitHub y sube estos archivos.
2. El email de contacto para la SEC ya está en `SEC_USER_AGENT` (`wrangler.jsonc`). Si algún día lo cambias, usa uno real: la SEC bloquea las consultas sin contacto válido.
3. En Cloudflare: **Workers & Pages → Create → Import a repository** y elige `stock-hub`.
   - Deploy command: `npx wrangler deploy`
   - El build de los screeners ya está declarado en `wrangler.jsonc`. Si después ves la página «Este screener todavía no se ha generado», pon en **Settings → Build → Build command**: `pip install -r requirements.txt && python screeners/build_all.py`
4. Secretos (los mismos que ya usabas):
   - `GEMINI_API_KEY`: **Settings → Variables and Secrets** (tipo Secret). Opcional; sin él se usa Workers AI.
   - `FINVIZ_AUTH`: **Settings → Build → Variables and secrets** (tipo Secret). Opcional; solo si tienes Finviz Elite.
5. Revisa `https://stock-hub.<tu-subdominio>.workers.dev/api/health`: debe mostrar `secUserAgentConfigured: true` y, si pusiste la clave, `geminiConfigured: true`.

## Actualizar los screeners

Los datos de Finviz se regeneran en cada despliegue: **Deployments → Retry deployment**, o sube cualquier cambio al repo.

## Pasar tu watchlist desde las apps antiguas

La watchlist vive en el navegador y está ligada a cada dirección, así que no se traspasa sola.

1. Abre la app antigua de Quant TA → **★ Watchlist** y anota los tickers.
2. En Stock Hub abre **Watchlist → ＋ Importar** y pégalos separados por coma.

Las alertas de precio no se traspasan; hay que crearlas de nuevo.

## Caché KV opcional (análisis técnico más rápido)

1. `npm install` y luego `npm run kv:create`, que imprime un id.
2. En `wrangler.jsonc`, descomenta la línea de `kv_namespaces` al final y pega el id.
3. Vuelve a desplegar. `/api/health` mostrará `kvCache: true`.

## Probar en tu computador

```
npm install
pip install -r requirements.txt
npm run screeners:demo   # screeners con datos de ejemplo
npx wrangler dev
```

`wrangler dev` pide iniciar sesión en Cloudflare por el binding de Workers AI.

## API

| Ruta | Antes |
|---|---|
| `GET /api/ta/analyze?symbol=NVDA` | `/api/analyze` en Quant TA |
| `GET /api/ta/compare?symbols=NVDA,AMD` | `/api/compare` en Quant TA |
| `POST /api/conviction/analyze` `{"ticker":"NVDA"}` | `/api/analyze` en Conviction |
| `GET /api/conviction/metrics?ticker=NVDA` | `/api/metrics` en Conviction |
| `GET /api/health` | estado de ambos backends |

## Cambios respecto a los repos originales

- Rutas de API separadas por módulo (antes Quant TA y Conviction usaban las dos `/api/analyze`).
- Quant TA y Conviction leen `?ticker=` y lo actualizan en la URL; Conviction analiza al llegar con un ticker.
- Corregido un error de Conviction: su política de seguridad bloqueaba los `style="…"` en línea, así que las barras del Conviction Score, el anillo de puntaje y los anillos de probabilidad de los catalizadores no se dibujaban. Ahora se aplican desde JavaScript.

Herramienta de investigación, no asesoría financiera.
