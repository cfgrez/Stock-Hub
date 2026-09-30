"""Tradinghub Screener: genera public/index.html con las acciones que pasan los 11 filtros.

Cloudflare solo publica archivos estáticos, así que este script corre durante el build:
consulta Finviz, arma la lista de espera y la guarda como página HTML en public/.

Uso local:
    python build.py          -> consulta Finviz de verdad
    DEMO=1 python build.py   -> genera la página con datos de ejemplo

Si existe la variable de entorno FINVIZ_AUTH (token de Finviz Elite), usa la exportación
oficial de Elite con datos en tiempo real. El token nunca se escribe en el código.
"""

from __future__ import annotations

import html
import io
import os
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode

# Stock Hub: la página se publica en /descubrir/metodo-11/
OUT_DIR = Path(__file__).resolve().parent.parent / "public" / "descubrir" / "metodo-11"
ROW_LIMIT = 100

# ------------------------------------------------------------------ los 11 filtros
# Nombres tal como los reconoce finvizfinance (9 de los 11 filtros).
FILTERS = {
    "Average Volume": "Over 2M",
    "InstitutionalOwnership": "Over 60%",
    "50-Day Simple Moving Average": "Price above SMA50",
    "200-Day Simple Moving Average": "Price above SMA200",
    "52-Week High/Low": "0-10% below High",
    "EPS growththis year": "Over 25%",
    "EPS growth ttm": "Over 25%",
    "EPS growthqtr over qtr": "Over 25%",
    "Sales growthqtr over qtr": "Over 25%",
}

# Los otros 2 filtros son nuevos en Finviz y finvizfinance aún no los trae,
# así que se agregan con su código de URL. Si Finviz cambia el código, corrígelo aquí
# (se ve en la barra de direcciones al activar el filtro en finviz.com).
EXTRA_FILTER_CODES = [
    "ta_alltime_b0to10h",   # All-Time High/Low: 0-10% below High
    "fa_salesyoyttm_o25",   # Sales Growth TTM: Over 25%
]

# Cómo se muestran los filtros en la página (bloque, filtro, condición)
CRITERIA = [
    ("Calidad", "Liquidez y fondos grandes adentro", [
        ("Volumen promedio", "Sobre 2 millones"),
        ("Propiedad institucional", "Sobre 60%"),
    ]),
    ("Tendencia", "En fase 2 y cerca de romper máximos", [
        ("Media de 50 días", "Precio sobre ella"),
        ("Media de 200 días", "Precio sobre ella"),
        ("Máximo de 52 semanas", "A menos de 10%"),
        ("Máximo histórico", "A menos de 10%"),
    ]),
    ("Crecimiento", "Utilidades y ventas que aceleran", [
        ("EPS este año", "Sobre 25%"),
        ("EPS últimos 12 meses", "Sobre 25%"),
        ("EPS trimestre vs. trimestre", "Sobre 25%"),
        ("Ventas últimos 12 meses", "Sobre 25%"),
        ("Ventas trimestre vs. trimestre", "Sobre 25%"),
    ]),
]

# Columnas del screener "Custom" de Finviz y nombre interno, en el mismo orden
COLUMNS = [
    (1, "Ticker"), (2, "Company"), (3, "Sector"), (6, "Market Cap"),
    (17, "EPS this Y"), (22, "EPS Q/Q"), (23, "Sales Q/Q"), (28, "Inst Own"),
    (53, "SMA50"), (54, "SMA200"), (57, "52W High"), (59, "RSI"),
    (63, "Avg Volume"), (65, "Price"), (66, "Change"), (68, "Earnings"),
]
TEXT_KEYS = {"Ticker", "Company", "Sector", "Earnings"}
ORDER = "52-Week High (Relative)"  # los más cerca de su techo primero


# ------------------------------------------------------------------ datos

def _to_number(v):
    from finvizfinance.util import number_convert

    if v is None:
        return None
    if isinstance(v, (int, float)):
        return None if v != v else float(v)
    s = str(v).strip()
    if s in ("", "-"):
        return None
    try:
        return number_convert(s)
    except (TypeError, ValueError):
        return None


def _normalize(df) -> list[dict]:
    """Renombra columnas por posición y convierte valores a números."""
    if df is None or df.empty:
        return []
    if str(df.columns[0]).strip().lower().startswith("no"):
        df = df.iloc[:, 1:]
    keys = [k for _, k in COLUMNS]
    if len(df.columns) != len(keys):
        raise RuntimeError(f"Columnas inesperadas: {list(df.columns)}")
    df = df.copy()
    df.columns = keys
    rows = []
    for rec in df.head(ROW_LIMIT).to_dict(orient="records"):
        row = {}
        for k, v in rec.items():
            if k in TEXT_KEYS:
                row[k] = None if (v is None or v != v or str(v).strip() in ("", "-")) else str(v)
            else:
                row[k] = _to_number(v)
        rows.append(row)
    return rows


def filter_codes() -> str:
    from finvizfinance.screener.custom import Custom

    sc = Custom()
    sc.set_filter(filters_dict=FILTERS)
    codes = [c for c in sc.request_params.get("f", "").split(",") if c]
    return ",".join(codes + EXTRA_FILTER_CODES)


def run_free(codes: str) -> list[dict]:
    from finvizfinance.screener.custom import Custom

    sc = Custom()
    sc.set_filter(filters_dict=FILTERS)
    sc.request_params["f"] = codes
    df = sc.screener_view(
        order=ORDER, ascend=False, limit=ROW_LIMIT,
        columns=[c for c, _ in COLUMNS], verbose=0, sleep_sec=2,
    )
    if df is None:
        return []
    df = df.astype(object).where(df.notna(), None)
    return _normalize(df)


def run_elite(codes: str, token: str) -> list[dict]:
    import pandas as pd
    from finvizfinance.constants import order_dict
    from finvizfinance.util import get_session, headers

    params = {
        "v": "152",
        "f": codes,
        "o": "-" + order_dict[ORDER],
        "c": ",".join(str(c) for c, _ in COLUMNS),
        "auth": token,
    }
    resp = get_session().get("https://elite.finviz.com/export.ashx",
                             params=params, headers=headers, timeout=30)
    if resp.status_code in (401, 403):
        raise RuntimeError(f"Finviz rechazó el token de Elite (HTTP {resp.status_code}).")
    resp.raise_for_status()
    text = resp.text.lstrip("\ufeff").strip()
    if not text:
        return []
    if text.startswith("<"):
        raise RuntimeError("Finviz devolvió una página web en vez de datos: revisa el token FINVIZ_AUTH.")
    rows = _normalize(pd.read_csv(io.StringIO(text), dtype=str))
    for r in rows:  # la exportación entrega la capitalización en millones
        mc = r.get("Market Cap")
        if mc is not None and mc < 1e7:
            r["Market Cap"] = mc * 1e6
    return rows


def demo_rows() -> list[dict]:
    base = [
        ("NVDA", "NVIDIA Corp", "Technology", -0.004, 0.61, 0.56, 0.62, 0.67, "Nov 19 AMC"),
        ("AMD", "Advanced Micro Devices Inc", "Technology", -0.021, 0.44, 0.38, 0.32, 0.71, "Nov 03 AMC"),
        ("APH", "Amphenol Corp", "Technology", -0.035, 0.52, 0.64, 0.41, 0.95, "Oct 22 BMO"),
        ("LLY", "Eli Lilly & Co", "Healthcare", -0.058, 0.88, 0.71, 0.38, 0.83, "Oct 30 BMO"),
        ("RBRK", "Rubrik Inc", "Technology", -0.074, 0.31, 0.47, 0.49, 0.64, "Dec 09 AMC"),
        ("HPE", "Hewlett Packard Enterprise Co", "Technology", -0.091, 0.27, 0.29, 0.26, 0.82, "Dec 02 AMC"),
    ]
    rows = []
    for i, (t, c, s, hi, epsy, epsq, salq, inst, earn) in enumerate(base):
        price = [187.4, 241.9, 132.6, 918.3, 104.2, 27.8][i]
        rows.append({
            "Ticker": t, "Company": c, "Sector": s, "Market Cap": price * 2.1e9,
            "EPS this Y": epsy, "EPS Q/Q": epsq, "Sales Q/Q": salq, "Inst Own": inst,
            "SMA50": 0.04 + i * 0.01, "SMA200": 0.18 + i * 0.02, "52W High": hi,
            "RSI": 68 - i * 3.5, "Avg Volume": 3.2e6 * (7 - i), "Price": price,
            "Change": [0.018, -0.006, 0.011, 0.004, -0.013, 0.007][i], "Earnings": earn,
        })
    return rows


# ------------------------------------------------------------------ formato

def esc(v) -> str:
    return html.escape(str(v)) if v is not None else ""


def num(v, dec=2, suffix="") -> str:
    if v is None:
        return "–"
    try:
        s = f"{float(v):,.{dec}f}"
    except (TypeError, ValueError):
        return esc(v)
    return s.replace(",", "X").replace(".", ",").replace("X", ".") + suffix


def pct(v, signed=True, dec=1) -> str:
    if v is None:
        return "–"
    try:
        f = float(v) * 100
    except (TypeError, ValueError):
        return esc(v)
    return ("+" if signed and f > 0 else "") + num(f, dec, "%")


def big(v) -> str:
    if v is None:
        return "–"
    f = float(v)
    if f >= 1e12:
        return num(f / 1e12, 2, " bill.")
    if f >= 1e9:
        return num(f / 1e9, 1, " mil mill.")
    if f >= 1e6:
        return num(f / 1e6, 1, " mill.")
    return num(f, 0)


def tone(v) -> str:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return ""
    return "up" if f > 0 else "down" if f < 0 else ""


def ceiling(row) -> float | None:
    """Precio del máximo de 52 semanas (el 'techo')."""
    try:
        return float(row["Price"]) / (1 + float(row["52W High"]))
    except (TypeError, ValueError, ZeroDivisionError, KeyError):
        return None


def status(row) -> tuple[str, str]:
    hi = row.get("52W High")
    if hi is None:
        return "wait", "En espera"
    if hi >= -0.01:
        return "break", "Tocando techo"
    return "wait", "En espera"


def meter(hi) -> str:
    """Distancia al techo: 0% a la derecha, -10% a la izquierda."""
    if hi is None:
        return '<span class="meter"></span>'
    pos = max(0.0, min(1.0, 1 + float(hi) / 0.10)) * 100
    return (f'<span class="meter" aria-hidden="true"><i style="width:{pos:.0f}%"></i></span>')


def card_rows(rows: list[dict]) -> str:
    out = []
    for r in rows:
        t = esc(r.get("Ticker"))
        cls, label = status(r)
        hi = r.get("52W High")
        out.append(f"""
<tr>
  <th scope="row"><a href="/tecnico/?ticker={t}" data-ticker="{t}">{t}</a>
    <small>{esc(r.get("Company"))}</small></th>
  <td class="txt"><span class="badge {cls}">{label}</span></td>
  <td>{num(r.get("Price"))}<small class="{tone(r.get("Change"))}">{pct(r.get("Change"))}</small></td>
  <td class="strong">{num(ceiling(r))}</td>
  <td><span class="dist">{meter(hi)}<span>{pct(hi)}</span></span></td>
  <td class="{tone(r.get("EPS this Y"))}">{pct(r.get("EPS this Y"), dec=0)}</td>
  <td class="{tone(r.get("EPS Q/Q"))}">{pct(r.get("EPS Q/Q"), dec=0)}</td>
  <td class="{tone(r.get("Sales Q/Q"))}">{pct(r.get("Sales Q/Q"), dec=0)}</td>
  <td>{pct(r.get("Inst Own"), signed=False, dec=0)}</td>
  <td>{num(r.get("RSI"), 0)}</td>
  <td>{big(r.get("Avg Volume"))}</td>
  <td>{big(r.get("Market Cap"))}</td>
  <td class="txt">{esc(r.get("Earnings")) or "–"}</td>
</tr>""")
    return "".join(out)


def results_html(rows: list[dict] | None, error: str | None) -> str:
    if error:
        return (f'<p class="notice">No se pudo consultar Finviz. Detalle técnico: '
                f'<code>{esc(error)}</code></p>')
    if not rows:
        return ('<p class="notice">Hoy ninguna acción pasa los 11 filtros. Es normal en mercados '
                'débiles: el filtro es exigente a propósito.</p>')
    return f"""
<div class="scroll"><table>
<thead><tr>
  <th scope="col">Acción</th><th scope="col">Estado</th><th scope="col">Precio · hoy</th>
  <th scope="col">Techo (máx. 52s)</th><th scope="col">Distancia al techo</th>
  <th scope="col">EPS este año</th><th scope="col">EPS trim.</th><th scope="col">Ventas trim.</th>
  <th scope="col">Instit.</th><th scope="col">RSI</th><th scope="col">Vol. prom.</th>
  <th scope="col">Capitaliz.</th><th scope="col">Próx. resultados</th>
</tr></thead>
<tbody>{card_rows(rows)}</tbody>
</table></div>"""


def criteria_html() -> str:
    blocks = []
    for name, why, items in CRITERIA:
        lis = "".join(f"<li><span>{esc(a)}</span><b>{esc(b)}</b></li>" for a, b in items)
        blocks.append(f'<div class="block"><h3>{esc(name)}</h3><p>{esc(why)}</p><ul>{lis}</ul></div>')
    return "".join(blocks)


# ------------------------------------------------------------------ página

CSS = """
:root{
  --bg:#F5F4EF; --paper:#FFFFFF; --ink:#12151C; --ink2:#4B5261; --ink3:#868C99;
  --rule:#DEDCD3; --accent:#2B3FD1; --accent-soft:#E8EBFC; --hot:#D9531E; --hot-soft:#FCEBE2;
  --up:#16784A; --down:#B7372C; --track:#ECEAE3;
  color-scheme:light dark;
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]){
    --bg:#0F1116; --paper:#161922; --ink:#EDEEF2; --ink2:#AAB0BE; --ink3:#727989;
    --rule:#2A2E3A; --accent:#8C9BFF; --accent-soft:#1E2340; --hot:#FF8A55; --hot-soft:#3A2218;
    --up:#4CC38A; --down:#F07A6E; --track:#252936;
  }
}
:root[data-theme="dark"]{
  --bg:#0F1116; --paper:#161922; --ink:#EDEEF2; --ink2:#AAB0BE; --ink3:#727989;
  --rule:#2A2E3A; --accent:#8C9BFF; --accent-soft:#1E2340; --hot:#FF8A55; --hot-soft:#3A2218;
  --up:#4CC38A; --down:#F07A6E; --track:#252936;
}
*{box-sizing:border-box}
:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}
html{scroll-padding-top:env(safe-area-inset-top,0px)}
body{margin:0;background:var(--bg);color:var(--ink);
  font-family:"Archivo",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  font-size:15px;line-height:1.55;-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
a:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:2px}
.wrap{max-width:1200px;margin:0 auto;padding:36px 20px 72px}

.brand{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;
  font-stretch:112%;font-weight:700;letter-spacing:.14em;text-transform:uppercase;font-size:12.5px}
.brand .mark{display:inline-flex;align-items:center;gap:10px}
.brand .mark i{width:22px;height:22px;border-radius:6px;background:var(--accent);position:relative}
.brand .mark i::after{content:"";position:absolute;inset:6px 5px 5px 6px;border-top:2.5px solid var(--paper);
  border-right:2.5px solid var(--paper);transform:skewX(-8deg)}
.brand .stamp{letter-spacing:.02em;text-transform:none;font-weight:500;color:var(--ink2);font-stretch:100%}
.brand .stamp b{color:var(--ink);font-weight:600}

.hero{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);gap:28px;margin:34px 0 30px;align-items:stretch}
h1{font-stretch:75%;font-weight:800;font-size:clamp(44px,7.4vw,92px);overflow-wrap:anywhere;line-height:.9;letter-spacing:-.02em;margin:0 0 18px;text-transform:uppercase}
h1 span{color:var(--accent)}
.lead{color:var(--ink2);max-width:56ch;margin:0}
.count{background:var(--ink);color:var(--bg);border-radius:14px;padding:22px 24px;display:flex;flex-direction:column;justify-content:space-between;gap:14px}
.count .lbl{font-stretch:112%;font-size:12px;letter-spacing:.14em;text-transform:uppercase;font-weight:600;opacity:.7}
.count .n{font-stretch:75%;font-weight:800;font-size:96px;line-height:.85}
.count .n small{font-size:18px;font-stretch:100%;font-weight:500;margin-left:10px;opacity:.75;letter-spacing:0}
.count .tk{display:flex;flex-wrap:wrap;gap:6px}
.count .tk a{color:inherit;text-decoration:none;font-weight:700;font-size:14px;border:1px solid color-mix(in srgb,var(--bg) 35%,transparent);
  padding:3px 9px;border-radius:999px}
.count .tk a:hover{background:color-mix(in srgb,var(--bg) 14%,transparent)}

.rule{display:flex;gap:14px;align-items:flex-start;background:var(--hot-soft);border-left:4px solid var(--hot);
  padding:14px 18px;border-radius:0 10px 10px 0;margin:0 0 34px;color:var(--ink)}
.rule b{color:var(--hot);white-space:nowrap;font-stretch:112%;text-transform:uppercase;letter-spacing:.08em;font-size:12.5px;padding-top:2px}

h2{font-stretch:88%;font-weight:700;font-size:26px;margin:0 0 4px;letter-spacing:-.005em}
.sub{color:var(--ink2);margin:0 0 16px}
.sechead{display:flex;justify-content:space-between;align-items:baseline;gap:16px;flex-wrap:wrap}
.sechead a{color:var(--accent);font-size:14px;text-decoration:none;font-weight:500}
.sechead a:hover{text-decoration:underline}

.scroll{overflow-x:auto;background:var(--paper);border:1px solid var(--rule);border-radius:12px}
table{border-collapse:collapse;width:100%;min-width:1180px;font-size:14px}
thead th{text-align:right;font-weight:600;color:var(--ink3);font-size:11.5px;letter-spacing:.04em;text-transform:uppercase;
  padding:13px 12px 11px;border-bottom:1px solid var(--rule);white-space:nowrap;font-stretch:108%}
thead th:first-child,thead th:nth-child(2),thead th:last-child{text-align:left}
tbody th{text-align:left;padding:12px;white-space:nowrap}
tbody th a{color:var(--ink);font-weight:800;font-size:16px;text-decoration:none;font-stretch:108%}
tbody th a:hover{color:var(--accent)}
tbody th small{display:block;font-weight:400;color:var(--ink3);font-size:12.5px;max-width:200px;overflow:hidden;text-overflow:ellipsis}
td{text-align:right;padding:12px;white-space:nowrap;color:var(--ink2)}
td small{display:block;font-size:12px}
td.txt{text-align:left}
td.strong{color:var(--ink);font-weight:700}
td.up,small.up{color:var(--up)} td.down,small.down{color:var(--down)}
tbody tr+tr th,tbody tr+tr td{border-top:1px solid var(--rule)}
tbody tr:hover{background:color-mix(in srgb,var(--accent) 4%,transparent)}
.badge{display:inline-block;font-size:12px;font-weight:600;padding:3px 9px;border-radius:999px;font-stretch:108%}
.badge.wait{background:var(--accent-soft);color:var(--accent)}
.badge.break{background:var(--hot-soft);color:var(--hot)}
.dist{display:inline-flex;align-items:center;justify-content:flex-end;gap:10px}
.dist span:last-child{min-width:5ch;color:var(--ink)}
.meter{display:inline-block;width:90px;height:8px;border-radius:4px;background:var(--track);overflow:hidden;position:relative}
.meter i{position:absolute;left:0;top:0;bottom:0;background:linear-gradient(90deg,var(--accent),var(--hot));border-radius:4px}

.criteria{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-top:40px}
.block{background:var(--paper);border:1px solid var(--rule);border-radius:12px;padding:18px 20px}
.block h3{margin:0;font-stretch:112%;text-transform:uppercase;letter-spacing:.1em;font-size:13px;color:var(--accent)}
.block p{margin:2px 0 12px;color:var(--ink3);font-size:13.5px}
.block ul{list-style:none;margin:0;padding:0}
.block li{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-top:1px solid var(--rule);font-size:14px}
.block li span{color:var(--ink2)}
.block li b{font-weight:600;white-space:nowrap}

.notice{background:var(--paper);border:1px dashed var(--rule);border-radius:12px;padding:18px 20px;color:var(--ink2);margin:0}
.notice code{font-size:12.5px;word-break:break-word}
footer{margin-top:56px;padding-top:18px;border-top:1px solid var(--rule);color:var(--ink3);font-size:13px}
footer p{margin:0 0 8px;max-width:85ch}
footer a{color:inherit}
@media (max-width:860px){.hero{grid-template-columns:1fr}.criteria{grid-template-columns:1fr}.count .n{font-size:76px}}
"""


def page(rows, error, generated: datetime, mode: str, finviz_link: str) -> str:
    stamp = generated.strftime("%d-%m-%Y · %H:%M UTC")
    source = {"elite": "Finviz Elite (tiempo real)", "demo": "ejemplo", "free": "Finviz"}[mode]
    n = len(rows) if rows else 0
    tickers = "".join(
        f'<a href="/tecnico/?ticker={esc(r["Ticker"])}">{esc(r["Ticker"])}</a>'
        for r in (rows or []) if r.get("Ticker"))
    count_label = "—" if error else str(n)
    word = "acción" if n == 1 else "acciones"
    demo_note = ('<p class="notice" style="margin-bottom:24px">Modo DEMO: datos de ejemplo, '
                 'no son cotizaciones reales.</p>') if mode == "demo" else ""
    return f"""<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Tradinghub Screener</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🚀</text></svg>">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..800&display=swap" rel="stylesheet">
<style>{CSS}</style>
<link rel="stylesheet" href="/shared/nav.css">
<script src="/shared/nav.js" defer></script>
</head>
<body>
<main class="wrap">
  <div class="brand">
    <span class="mark"><i></i>Tradinghub</span>
    <span class="stamp">Datos de {source} al <b>{stamp}</b></span>
  </div>

  <div class="hero">
    <div>
      <h1>Tradinghub<br><span>Screener</span></h1>
      <p class="lead">Acciones del mercado estadounidense que cumplen a la vez 11 condiciones de calidad,
      tendencia y crecimiento: empresas líquidas, con fondos adentro, en tendencia alcista cerca de
      sus máximos y con utilidades y ventas creciendo sobre 25%.</p>
    </div>
    <div class="count">
      <span class="lbl">Hoy pasan el filtro</span>
      <span class="n">{count_label}<small>{word if not error else "sin datos"}</small></span>
      <div class="tk">{tickers}</div>
    </div>
  </div>

  {demo_note}
  <div class="rule"><b>Regla</b><span>Pasar el filtro no es una señal de compra. Cada acción queda
  en lista de espera hasta que supere su techo, es decir, su máximo de 52 semanas.</span></div>

  <section aria-labelledby="h-lista">
    <div class="sechead">
      <h2 id="h-lista">Lista de espera</h2>
      <a href="{esc(finviz_link)}" target="_blank" rel="noopener">Ver este filtro en Finviz →</a>
    </div>
    <p class="sub">Ordenadas de la más cercana a la más lejana de su techo. «Tocando techo» marca las que
    están a menos de 1% del máximo de 52 semanas.</p>
    {results_html(rows, error)}
  </section>

  <section class="criteria" aria-label="Filtros">{criteria_html()}</section>

  <footer>
    <p>La página se actualiza cada vez que Cloudflare vuelve a construir el sitio.
    {"Con Finviz Elite los precios son en tiempo real al momento del build." if mode == "elite" else "La versión gratuita de Finviz entrega precios con un pequeño retraso."}</p>
    <p>Filtros basados en el método de 11 condiciones presentado por Club de Trading
    (<a href="https://www.inversapiens.com" target="_blank" rel="noopener">inversapiens.com</a>).
    Datos obtenidos con <a href="https://github.com/lit26/finvizfinance" target="_blank" rel="noopener">finvizfinance</a>.
    Esto no es asesoría financiera.</p>
  </footer>
</main>
</body>
</html>"""


def main() -> int:
    mode = "demo" if os.environ.get("DEMO") == "1" else ("elite" if os.environ.get("FINVIZ_AUTH", "").strip() else "free")
    token = os.environ.get("FINVIZ_AUTH", "").strip() if mode == "elite" else ""
    print(f"[tradinghub] Fuente: {mode}")

    rows, error = None, None
    codes = ""
    try:
        codes = filter_codes()
        print(f"[tradinghub] Filtros: {codes}")
        if mode == "demo":
            rows = demo_rows()
        elif mode == "elite":
            rows = run_elite(codes, token)
        else:
            rows = run_free(codes)
        print(f"[tradinghub] {len(rows)} acciones pasan el filtro")
    except Exception as exc:  # noqa: BLE001 - la página debe generarse igual
        error = f"{type(exc).__name__}: {exc}"
        if token:
            error = error.replace(token, "***")
        error = error[:300]
        print(f"[tradinghub] ERROR {error}")
        if not token:
            traceback.print_exc()

    try:
        from finvizfinance.constants import order_dict
        order_code = "-" + order_dict[ORDER]
    except Exception:  # noqa: BLE001
        order_code = ""
    link = "https://finviz.com/screener.ashx?" + urlencode({"v": "111", "f": codes, "o": order_code})
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / "index.html"
    out.write_text(page(rows, error, datetime.now(timezone.utc), mode, link), encoding="utf-8")
    print(f"[tradinghub] Página generada en {out}")
    return 0  # siempre OK para que Cloudflare publique aunque Finviz falle


if __name__ == "__main__":
    sys.exit(main())
