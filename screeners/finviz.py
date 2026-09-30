"""Genera public/index.html con los resultados del screener.

Cloudflare solo puede publicar archivos estáticos (HTML, CSS, JS).
Este script corre durante el build, usa finvizfinance para consultar
Finviz y deja el resultado como una página HTML en la carpeta public/.

Uso local:
    python build.py          -> consulta Finviz de verdad
    DEMO=1 python build.py   -> genera la página con datos de ejemplo
"""

from __future__ import annotations

import html
import os
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path

# Permite usar la librería de esta misma carpeta aunque no esté instalada con pip
sys.path.insert(0, str(Path(__file__).resolve().parent))

# Stock Hub: la página se publica en /descubrir/finviz/
OUT_DIR = Path(__file__).resolve().parent.parent / "public" / "descubrir" / "finviz"

# Filtros base que se aplican a todos los screeners:
# acciones de EE.UU., líquidas y de tamaño mediano o mayor.
BASE_FILTERS = {
    "Country": "USA",
    "Market Cap.": "+Mid (over $2bln)",
    "Average Volume": "Over 500K",
    "Price": "Over $10",
}

# Columnas del screener "Custom" de finvizfinance (ver constants.CUSTOM_SCREENER_COLUMNS)
COLUMNS = [1, 2, 3, 6, 7, 54, 57, 59, 62, 64, 65, 66, 69]

SCREENS = [
    {
        "id": "retroceso",
        "title": "Retroceso dentro de una tendencia alcista",
        "why": "Precio sobre su media de 200 días, pero con RSI bajo 40: "
        "acciones que vienen subiendo y hoy están temporalmente castigadas.",
        "filters": {
            "200-Day Simple Moving Average": "Price above SMA200",
            "RSI (14)": "Oversold (40)",
        },
        "order": "Relative Strength Index (14)",
        "ascend": True,
    },
    {
        "id": "maximos",
        "title": "Nuevos máximos con volumen",
        "why": "Marcan un máximo de 52 semanas con al menos 1,5 veces su volumen "
        "habitual: rupturas con interés comprador.",
        "filters": {
            "52-Week High/Low": "New High",
            "Relative Volume": "Over 1.5",
        },
        "order": "Relative Volume",
        "ascend": False,
    },
    {
        "id": "cruce",
        "title": "Cruce dorado reciente",
        "why": "La media de 50 días acaba de cruzar hacia arriba la de 200 días, "
        "una señal clásica de cambio a tendencia alcista.",
        "filters": {
            "50-Day Simple Moving Average": "SMA50 crossed SMA200 above",
        },
        "order": "Market Cap.",
        "ascend": False,
    },
    {
        "id": "analistas",
        "title": "Favoritas de los analistas con descuento",
        "why": "Recomendación promedio de compra o mejor, cotizando 20% o más "
        "bajo su máximo de 52 semanas.",
        "filters": {
            "Analyst Recom.": "Buy or better",
            "52-Week High/Low": "20% or more below High",
        },
        "order": "Market Cap.",
        "ascend": False,
    },
]

ROW_LIMIT = 30


# ---------------------------------------------------------------- datos

def run_screen(screen: dict) -> list[dict]:
    from finvizfinance.screener.custom import Custom

    sc = Custom()
    sc.set_filter(filters_dict={**BASE_FILTERS, **screen["filters"]})
    df = sc.screener_view(
        order=screen["order"],
        ascend=screen["ascend"],
        limit=ROW_LIMIT,
        columns=list(COLUMNS),
        verbose=0,
        sleep_sec=2,
    )
    if df is None or df.empty:
        return []
    df = df.astype(object).where(df.notna(), None)
    return df.head(ROW_LIMIT).to_dict(orient="records")


# ---------------------------------------------------------------- Finviz Elite
#
# Si existe la variable de entorno FINVIZ_AUTH (tu token de Finviz Elite),
# se usa la exportación oficial de Elite: datos en tiempo real y sin scraping.
# El token NUNCA se escribe en el código: se configura como secreto en Cloudflare.

ELITE_EXPORT_URL = "https://elite.finviz.com/export.ashx"
# Nombres internos en el mismo orden que COLUMNS (sin la columna "No.")
COLUMN_KEYS = [
    "Ticker", "Company", "Sector", "Market Cap", "P/E", "SMA200", "52W High",
    "RSI", "Recom", "Rel Volume", "Price", "Change", "Target Price",
]
TEXT_KEYS = {"Ticker", "Company", "Sector"}


def elite_token() -> str:
    return os.environ.get("FINVIZ_AUTH", "").strip()


def _to_number(v):
    from finvizfinance.util import number_convert

    if v is None:
        return None
    if isinstance(v, (int, float)):
        return None if v != v else float(v)  # NaN -> None
    try:
        return number_convert(str(v))
    except (TypeError, ValueError):
        return None


def run_screen_elite(screen: dict, token: str) -> list[dict]:
    import io

    import pandas as pd
    from finvizfinance.constants import order_dict
    from finvizfinance.screener.custom import Custom
    from finvizfinance.util import get_session, headers

    # Reutiliza la traducción de filtros de finvizfinance (p. ej. "USA" -> geo_usa)
    sc = Custom()
    sc.set_filter(filters_dict={**BASE_FILTERS, **screen["filters"]})
    params = {
        "v": "152",
        "f": sc.request_params.get("f", ""),
        "o": ("" if screen["ascend"] else "-") + order_dict[screen["order"]],
        "c": ",".join(str(c) for c in COLUMNS),
        "auth": token,
    }
    resp = get_session().get(ELITE_EXPORT_URL, params=params, headers=headers, timeout=30)
    if resp.status_code in (401, 403):
        raise RuntimeError(f"Finviz rechazó el token de Elite (HTTP {resp.status_code}).")
    resp.raise_for_status()
    text = resp.text.lstrip("\ufeff").strip()
    if not text or text.startswith("<"):
        raise RuntimeError(
            "Finviz devolvió una página web en vez de datos: revisa que FINVIZ_AUTH "
            "sea tu token de Elite y que la suscripción esté activa."
        )

    df = pd.read_csv(io.StringIO(text), dtype=str)
    if df.empty:
        return []
    if str(df.columns[0]).strip().lower().startswith("no"):
        df = df.iloc[:, 1:]
    if len(df.columns) != len(COLUMN_KEYS):
        raise RuntimeError(f"Columnas inesperadas en la exportación: {list(df.columns)}")
    df.columns = COLUMN_KEYS

    rows = []
    for rec in df.head(ROW_LIMIT).to_dict(orient="records"):
        row = {}
        for k, v in rec.items():
            if k in TEXT_KEYS:
                row[k] = None if (v is None or v != v) else str(v)
            else:
                row[k] = _to_number(v)
        # La exportación entrega la capitalización en millones de dólares
        mc = row.get("Market Cap")
        if mc is not None and mc < 1e7:
            row["Market Cap"] = mc * 1e6
        rows.append(row)
    return rows


def demo_rows(seed: int) -> list[dict]:
    import random

    rnd = random.Random(seed)
    names = [
        ("NVDA", "NVIDIA Corp", "Technology"),
        ("JPM", "JPMorgan Chase & Co", "Financial"),
        ("COST", "Costco Wholesale Corp", "Consumer Defensive"),
        ("LLY", "Eli Lilly & Co", "Healthcare"),
        ("CAT", "Caterpillar Inc", "Industrials"),
        ("XOM", "Exxon Mobil Corp", "Energy"),
        ("AMZN", "Amazon.com Inc", "Consumer Cyclical"),
    ]
    rows = []
    for t, c, s in rnd.sample(names, rnd.randint(3, 7)):
        price = rnd.uniform(30, 900)
        rows.append({
            "Ticker": t, "Company": c, "Sector": s,
            "Market Cap": rnd.uniform(5e9, 3e12), "P/E": rnd.uniform(8, 60),
            "SMA200": rnd.uniform(-0.1, 0.3), "52W High": rnd.uniform(-0.35, 0),
            "RSI": rnd.uniform(22, 75), "Recom": rnd.uniform(1.2, 3),
            "Rel Volume": rnd.uniform(0.5, 3.5), "Price": price,
            "Change": rnd.uniform(-0.04, 0.04), "Target Price": price * rnd.uniform(0.9, 1.4),
        })
    return rows


# ---------------------------------------------------------------- formato

def esc(v) -> str:
    return html.escape(str(v)) if v is not None else ""


def num(v, dec=2, suffix="") -> str:
    if v is None:
        return "–"
    try:
        s = f"{float(v):,.{dec}f}"
    except (TypeError, ValueError):
        return esc(v)
    # formato chileno: punto de miles, coma decimal
    return s.replace(",", "X").replace(".", ",").replace("X", ".") + suffix


def pct(v, signed=True) -> str:
    if v is None:
        return "–"
    try:
        f = float(v) * 100
    except (TypeError, ValueError):
        return esc(v)
    sign = "+" if signed and f > 0 else ""
    return sign + num(f, 1, "%")


def cap(v) -> str:
    if v is None:
        return "–"
    try:
        f = float(v)
    except (TypeError, ValueError):
        return esc(v)
    if f >= 1e12:
        return num(f / 1e12, 2, " bill.")
    if f >= 1e9:
        return num(f / 1e9, 1, " mil mill.")
    return num(f / 1e6, 0, " mill.")


def tone(v) -> str:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return ""
    return "up" if f > 0 else "down" if f < 0 else ""


def upside(row) -> float | None:
    try:
        return float(row.get("Target Price")) / float(row.get("Price")) - 1
    except (TypeError, ValueError, ZeroDivisionError):
        return None


def rsi_cell(v) -> str:
    if v is None:
        return "<td>–</td>"
    try:
        f = max(0.0, min(100.0, float(v)))
    except (TypeError, ValueError):
        return f"<td>{esc(v)}</td>"
    zone = "low" if f < 30 else "high" if f > 70 else "mid"
    return (
        f'<td><span class="rsi"><span class="rsi-bar" aria-hidden="true">'
        f'<i class="{zone}" style="left:{f:.0f}%"></i></span>'
        f"<span>{num(f, 0)}</span></span></td>"
    )


def table(rows: list[dict]) -> str:
    head = (
        "<thead><tr><th scope='col'>Acción</th><th scope='col'>Sector</th>"
        "<th scope='col'>Precio</th><th scope='col'>Hoy</th>"
        "<th scope='col'>RSI (14)</th><th scope='col'>vs. media 200d</th>"
        "<th scope='col'>vs. máx. 52s</th><th scope='col'>Vol. relativo</th>"
        "<th scope='col'>Recom.</th><th scope='col'>Potencial</th>"
        "<th scope='col'>P/E</th><th scope='col'>Capitalización</th></tr></thead>"
    )
    body = []
    for r in rows:
        t = esc(r.get("Ticker"))
        up = upside(r)
        body.append(
            "<tr>"
            f'<th scope="row"><a href="/tecnico/?ticker={t}" data-ticker="{t}">{t}</a>'
            f'<small>{esc(r.get("Company"))}</small></th>'
            f'<td class="txt">{esc(r.get("Sector"))}</td>'
            f'<td>{num(r.get("Price"))}</td>'
            f'<td class="{tone(r.get("Change"))}">{pct(r.get("Change"))}</td>'
            f'{rsi_cell(r.get("RSI"))}'
            f'<td class="{tone(r.get("SMA200"))}">{pct(r.get("SMA200"))}</td>'
            f'<td>{pct(r.get("52W High"))}</td>'
            f'<td>{num(r.get("Rel Volume"))}</td>'
            f'<td>{num(r.get("Recom"), 1)}</td>'
            f'<td class="{tone(up)}">{pct(up)}</td>'
            f'<td>{num(r.get("P/E"), 1)}</td>'
            f'<td>{cap(r.get("Market Cap"))}</td>'
            "</tr>"
        )
    return f'<div class="scroll"><table>{head}<tbody>{"".join(body)}</tbody></table></div>'


def section(screen: dict, rows: list[dict] | None, error: str | None) -> str:
    if error:
        content = (
            '<p class="notice">No se pudo consultar Finviz para este filtro. '
            f"Detalle técnico: <code>{esc(error)}</code></p>"
        )
        count = "error"
    elif not rows:
        content = (
            '<p class="notice">Hoy ninguna acción cumple estas condiciones. '
            "Vuelve a revisar después del próximo cierre.</p>"
        )
        count = "0 acciones"
    else:
        content = table(rows)
        count = f"{len(rows)} acción" + ("" if len(rows) == 1 else "es")
    return f"""
<section id="{screen['id']}" aria-labelledby="h-{screen['id']}">
  <header class="sec">
    <h2 id="h-{screen['id']}">{esc(screen['title'])}</h2>
    <span class="count">{count}</span>
  </header>
  <p class="why">{esc(screen['why'])}</p>
  {content}
</section>"""


# ---------------------------------------------------------------- página

CSS = """
:root{
  --bg:#EEF1EC; --paper:#FBFCFA; --ink:#17201C; --ink2:#51605A; --ink3:#83908A;
  --rule:#D3DAD4; --accent:#1F4E8C; --up:#18794B; --down:#B23A2E;
  --low:#18794B; --mid:#A7B0AB; --high:#B23A2E;
  color-scheme:light dark;
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]){
    --bg:#111614; --paper:#171D1A; --ink:#E6ECE8; --ink2:#A4B0AA; --ink3:#6E7A74;
    --rule:#2A332F; --accent:#7FA9E3; --up:#4CC38A; --down:#F0786B;
    --low:#4CC38A; --mid:#56615B; --high:#F0786B;
  }
}
:root[data-theme="dark"]{
  --bg:#111614; --paper:#171D1A; --ink:#E6ECE8; --ink2:#A4B0AA; --ink3:#6E7A74;
  --rule:#2A332F; --accent:#7FA9E3; --up:#4CC38A; --down:#F0786B;
  --low:#4CC38A; --mid:#56615B; --high:#F0786B;
}
*{box-sizing:border-box}
:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}
html{scroll-padding-top:env(safe-area-inset-top,0px)}
body{margin:0;background:var(--bg);color:var(--ink);
  font-family:"Instrument Sans",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  font-size:15px;line-height:1.55;-webkit-font-smoothing:antialiased}
.wrap{max-width:1180px;margin:0 auto;padding:40px 20px 72px}
.top{display:grid;grid-template-columns:1fr auto;gap:8px 32px;align-items:end;
  padding-bottom:22px;border-bottom:2px solid var(--ink)}
h1{font-family:"Instrument Serif",Georgia,serif;font-weight:400;font-size:clamp(34px,6vw,58px);
  line-height:1;margin:0;letter-spacing:-.01em}
.lead{grid-column:1/-1;margin:6px 0 0;color:var(--ink2);max-width:68ch}
.stamp{text-align:right;color:var(--ink2);font-size:13.5px;line-height:1.4}
.stamp b{display:block;color:var(--ink);font-size:17px;font-weight:600;font-variant-numeric:tabular-nums}
nav{display:flex;flex-wrap:wrap;gap:6px 18px;margin:16px 0 8px;font-size:14px}
nav a{color:var(--accent);text-decoration:none;border-bottom:1px solid transparent}
nav a:hover{border-bottom-color:currentColor}
a:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:2px}
section{margin-top:44px}
.sec{display:flex;justify-content:space-between;align-items:baseline;gap:16px;flex-wrap:wrap}
h2{font-family:"Instrument Serif",Georgia,serif;font-weight:400;font-size:30px;margin:0;line-height:1.15}
.count{color:var(--ink3);font-size:13.5px;font-variant-numeric:tabular-nums}
.why{color:var(--ink2);margin:4px 0 16px;max-width:72ch}
.scroll{overflow-x:auto;background:var(--paper);border:1px solid var(--rule);border-radius:6px}
table{border-collapse:collapse;width:100%;min-width:980px;font-variant-numeric:tabular-nums;font-size:14px}
thead th{position:sticky;top:0;background:var(--paper);text-align:right;font-weight:500;
  color:var(--ink3);font-size:12.5px;padding:12px 12px 10px;border-bottom:1px solid var(--rule);white-space:nowrap}
thead th:first-child,thead th:nth-child(2){text-align:left}
tbody th{text-align:left;font-weight:600;padding:10px 12px;white-space:nowrap}
tbody th a{color:var(--accent);text-decoration:none;font-size:15px}
tbody th a:hover{text-decoration:underline}
tbody th small{display:block;font-weight:400;color:var(--ink3);font-size:12.5px;max-width:190px;
  overflow:hidden;text-overflow:ellipsis}
td{text-align:right;padding:10px 12px;white-space:nowrap;color:var(--ink2)}
td.txt{text-align:left;color:var(--ink2)}
tbody tr+tr th,tbody tr+tr td{border-top:1px solid var(--rule)}
tbody tr:hover{background:color-mix(in srgb,var(--accent) 5%,transparent)}
td.up{color:var(--up)} td.down{color:var(--down)}
td .rsi{display:inline-flex;align-items:center;justify-content:flex-end;gap:10px}
.rsi-bar{position:relative;width:64px;height:4px;border-radius:2px;
  background:linear-gradient(90deg,var(--low) 0 30%,var(--mid) 30% 70%,var(--high) 70%);opacity:.85}
.rsi-bar i{position:absolute;top:50%;width:10px;height:10px;border-radius:50%;
  transform:translate(-50%,-50%);background:var(--paper);border:2px solid var(--ink)}
.rsi > span:last-child{min-width:2ch;color:var(--ink)}
.notice{background:var(--paper);border:1px dashed var(--rule);border-radius:6px;padding:16px 18px;
  color:var(--ink2);margin:0}
.notice code{font-size:12.5px;word-break:break-word}
footer{margin-top:56px;padding-top:18px;border-top:1px solid var(--rule);color:var(--ink3);
  font-size:13px;max-width:80ch}
footer p{margin:0 0 8px}
@media (max-width:640px){.top{grid-template-columns:1fr}.stamp{text-align:left}}
"""


def page(sections_html: str, generated: datetime, demo: bool, elite: bool = False) -> str:
    stamp = generated.strftime("%d-%m-%Y · %H:%M UTC")
    source = "Finviz Elite, en tiempo real," if elite else "Finviz"
    delay_note = (
        "Los datos vienen de tu cuenta Finviz Elite, en tiempo real al momento del build."
        if elite else "La versión gratuita de Finviz entrega precios con retraso."
    )
    nav = "".join(f'<a href="#{s["id"]}">{esc(s["title"])}</a>' for s in SCREENS)
    demo_note = (
        '<p class="notice" style="margin-top:20px">Datos de ejemplo (modo DEMO), '
        "no son cotizaciones reales.</p>" if demo else ""
    )
    return f"""<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Screener de acciones EE.UU.</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📈</text></svg>">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600&family=Instrument+Serif&display=swap" rel="stylesheet">
<style>{CSS}</style>
<link rel="stylesheet" href="/shared/nav.css">
<script src="/shared/nav.js" defer></script>
</head>
<body>
<main class="wrap">
  <div class="top">
    <h1>Screener de acciones<br>de EE.UU.</h1>
    <div class="stamp">Datos de {source} al<b>{stamp}</b></div>
    <p class="lead">Cuatro filtros sobre acciones estadounidenses de más de US$ 2 mil millones
    de capitalización, precio sobre US$ 10 y volumen promedio sobre 500 mil acciones diarias.</p>
  </div>
  <nav aria-label="Filtros">{nav}</nav>
  {demo_note}
  {sections_html}
  <footer>
    <p>Los datos se actualizan cada vez que Cloudflare vuelve a construir el sitio.
    {delay_note}</p>
    <p>Un filtro no es una recomendación de compra: sirve para armar una lista de candidatas que
    luego hay que analizar. Esto no es asesoría financiera.</p>
    <p>Hecho con <a href="https://github.com/lit26/finvizfinance" style="color:inherit">finvizfinance</a>.</p>
  </footer>
</main>
</body>
</html>"""


def main() -> int:
    demo = os.environ.get("DEMO") == "1"
    token = "" if demo else elite_token()
    print("[screener] Fuente:", "DEMO" if demo else "Finviz Elite" if token else "Finviz gratis")
    parts = []
    ok = 0
    for i, screen in enumerate(SCREENS):
        rows, error = None, None
        try:
            if demo:
                rows = demo_rows(i)
            elif token:
                rows = run_screen_elite(screen, token)
            else:
                rows = run_screen(screen)
            ok += 1
            print(f"[screener] {screen['id']}: {len(rows)} filas")
        except Exception as exc:  # noqa: BLE001 - la página debe generarse igual
            error = f"{type(exc).__name__}: {exc}"
            if token:
                error = error.replace(token, "***")
            error = error[:300]
            print(f"[screener] {screen['id']}: ERROR {error}")
            if not token:
                traceback.print_exc()
        parts.append(section(screen, rows, error))

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / "index.html"
    out.write_text(page("".join(parts), datetime.now(timezone.utc), demo, elite=bool(token)), encoding="utf-8")
    print(f"[screener] Página generada en {out} ({ok}/{len(SCREENS)} filtros OK)")
    # Siempre termina OK para que Cloudflare publique la página aunque Finviz falle.
    return 0


if __name__ == "__main__":
    sys.exit(main())
