# Mapa del código (graphify)

Mapa de funciones y de quién llama a quién, generado con [graphify](https://github.com/safishamsi/graphify) sin IA (solo análisis local).

- `GRAPH_REPORT.md`: resumen, funciones más conectadas y comunidades.
- `graph.json`: el grafo completo, para consultarlo (`graphify explain "nombreFuncion" --graph mapa-codigo/graph.json`, `graphify path "A" "B" --graph mapa-codigo/graph.json`).
- `generar.sh`: lo vuelve a generar (`bash mapa-codigo/generar.sh`). Hay que regenerarlo después de cambios grandes; los números de línea son los del archivo real.
