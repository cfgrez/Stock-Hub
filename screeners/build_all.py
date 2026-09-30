"""Genera los dos screeners de Stock Hub durante el build de Cloudflare.

  screeners/finviz.py    -> public/descubrir/finviz/index.html
  screeners/metodo11.py  -> public/descubrir/metodo-11/index.html

Cada script corre por separado: si uno falla, el otro igual se publica.
Variables opcionales: FINVIZ_AUTH (token Finviz Elite) y DEMO=1 (datos de ejemplo).
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPTS = ["finviz.py", "metodo11.py"]


def main() -> int:
    for name in SCRIPTS:
        print(f"[stock-hub] Generando {name} …", flush=True)
        result = subprocess.run([sys.executable, str(HERE / name)])
        if result.returncode != 0:
            print(f"[stock-hub] {name} terminó con código {result.returncode}; se sigue con el resto.")
    return 0  # siempre OK para que Cloudflare publique el sitio


if __name__ == "__main__":
    sys.exit(main())
