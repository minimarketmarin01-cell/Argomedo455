// Transporte hacia Supabase por HTTPS (sin librerías): llama a la función public.ejecutar_sql_argomedo
// (ver migracion/funcion_ejecutar_sql.sql) con la llave service_role. Los parámetros ($1, $2...) se
// incrustan aquí ya escapados, porque la función recibe SQL completo.

// Convierte un valor JS en un literal SQL seguro.
export function literal(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  return "'" + String(v).replace(/'/g, "''") + "'";
}
// Para los parámetros de las consultas, los números van como texto entre comillas SIN tipo: así Postgres los convierte solo
// al tipo de la columna con la que se comparan (como hace SQLite). Con un número "pelado", `sku = 12345` falla en Postgres.
function literalParam(v) {
  if (typeof v === "number" && Number.isFinite(v)) return "'" + String(v) + "'";
  return literal(v);
}
// Reemplaza $1..$n por sus literales (de mayor a menor para no confundir $1 con $10) y respeta los textos entre comillas.
export function incrustar(text, params) {
  if (!params || !params.length) return text;
  let out = "", i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "'") {
      let j = i + 1;
      while (j < text.length) { if (text[j] === "'") { if (text[j + 1] === "'") { j += 2; continue; } break; } j++; }
      out += text.slice(i, j + 1); i = j + 1;
    } else if (c === "$" && /\d/.test(text[i + 1] || "")) {
      let j = i + 1; while (/\d/.test(text[j] || "")) j++;
      const idx = parseInt(text.slice(i + 1, j), 10) - 1;
      out += literalParam(params[idx]); i = j;
    } else { out += c; i++; }
  }
  return out;
}

// Con `columnar`, las consultas se piden a public.ejecutar_sql_col_argomedo (ver migracion/funcion_ejecutar_sql_col.sql): cada resultado
// llega como { cols, rows: [[...]], rowCount } (los nombres de columna una sola vez, ≈44 % menos bytes) y aquí se rearma en objetos, así
// que quien llama recibe lo mismo de siempre. Si la función todavía no existe en Supabase (404), se usa ejecutar_sql_argomedo sin molestar.
export function expandirColumnar(res) {
  if (!res || !Array.isArray(res.cols)) return res;
  const cols = res.cols;
  const rows = (res.rows || []).map(fila => { const o = {}; for (let i = 0; i < cols.length; i++) o[cols[i]] = fila[i]; return o; });
  return { rows, rowCount: res.rowCount };
}
export function crearTransporteSupabase({ url, key, fetchFn, columnar = false }) {
  const f = fetchFn || fetch;
  let usarColumnar = !!columnar;
  async function rpc(sentencias) {
    const r = await f(url.replace(/\/$/, "") + "/rest/v1/rpc/" + (usarColumnar ? "ejecutar_sql_col_argomedo" : "ejecutar_sql_argomedo"), {
      method: "POST",
      headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ sentencias })
    });
    const txt = await r.text();
    let j; try { j = JSON.parse(txt); } catch (_) { throw new Error("Supabase respondió algo inesperado (HTTP " + r.status + "): " + txt.slice(0, 200)); }
    if (!r.ok && usarColumnar && r.status === 404 && /ejecutar_sql_col_argomedo/.test(txt)) { usarColumnar = false; return rpc(sentencias); } // aún no existe: nada se ejecutó
    if (!r.ok) throw new Error("Supabase: " + (j.message || j.error || txt).toString().slice(0, 300));
    return usarColumnar ? j.map(expandirColumnar) : j;
  }
  return {
    async query(text, params) { const [res] = await rpc([incrustar(text, params)]); return res; },
    async transaccion(lista) { return rpc(lista.map(s => incrustar(s.text, s.params))); }
  };
}

// Para el modo de prueba (?db=supabase): deja pasar solo lecturas. Algunas rutas GET también escriben (registro, sync,
// CREATE ... IF NOT EXISTS); si escribieran directo en Supabase, sus ids chocarían después con los que copia el espejo.
const ES_ESCRITURA_SQL = /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|TRUNCATE)\b/i;
export function soloLectura(transporte) {
  const vacio = { rows: [], rowCount: 0 };
  return {
    async query(text, params) { return ES_ESCRITURA_SQL.test(text) ? vacio : transporte.query(text, params); },
    async transaccion(lista) {
      const lecturas = lista.filter(s => !ES_ESCRITURA_SQL.test(s.text));
      const res = lecturas.length ? await transporte.transaccion(lecturas) : [];
      let i = 0;
      return lista.map(s => ES_ESCRITURA_SQL.test(s.text) ? vacio : res[i++]);
    }
  };
}
