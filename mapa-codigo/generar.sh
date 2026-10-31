#!/usr/bin/env bash
# Regenera el mapa del código con graphify (sin IA, solo análisis local) → mapa-codigo/GRAPH_REPORT.md y graph.json.
# Uso, desde la raíz del repositorio:  bash mapa-codigo/generar.sh
# El código que vive dentro de los .html se extrae conservando los números de línea, así que "index.html L1234" es la línea real.
set -e
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
ARCHIVOS="worker.js uso.js etiquetas.js index.html fiados.html sw.js"
VENV="${GRAPHIFY_VENV:-/tmp/graphify-venv}"
[ -x "$VENV/bin/graphify" ] || { python3 -m venv "$VENV" && "$VENV/bin/pip" install -q graphifyy; }
TMP="$(mktemp -d)"
python3 - "$RAIZ" "$TMP" $ARCHIVOS <<'PY'
import re, sys, os
raiz, tmp, *archivos = sys.argv[1:]
for a in archivos:
    src = open(os.path.join(raiz, a), encoding="utf-8").read()
    nombre = os.path.basename(a)
    if a.endswith(".html"):
        lineas = [""] * (src.count("\n") + 1)
        for m in re.finditer(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", src, re.S):
            ini = src.count("\n", 0, m.start(1))
            for i, l in enumerate(m.group(1).split("\n")):
                lineas[ini + i] = l
        src = "\n".join(lineas)
        nombre = nombre[:-5] + ".html.js"
    open(os.path.join(tmp, nombre), "w", encoding="utf-8").write(src)
PY
(cd "$TMP" && "$VENV/bin/graphify" update . >/dev/null)
cp "$TMP/graphify-out/GRAPH_REPORT.md" "$TMP/graphify-out/graph.json" "$RAIZ/mapa-codigo/"
rm -rf "$TMP"
echo "Mapa actualizado en mapa-codigo/"
