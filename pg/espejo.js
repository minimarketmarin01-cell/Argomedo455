// "Espejo" D1 -> Supabase: la app sigue leyendo y escribiendo en D1 exactamente igual; además, cada escritura que
// D1 acepta se repite en Supabase en segundo plano (ctx.waitUntil), sin demorar ni arriesgar la respuesta.
// - Solo se repiten escrituras que D1 hizo con éxito (si D1 falla, no se copia nada).
// - En los INSERT a tablas con id automático se manda el MISMO id que asignó D1, para que ambas bases queden iguales.
// - Las sentencias de cada petición se agrupan y se envían juntas (pocas llamadas HTTP). En Supabase cada una corre
//   aislada: si una falla, las demás se guardan igual y la falla queda contada en el registro.
// - Se apaga con el secreto/variable ESPEJO_SUPABASE = "0".
import { traducirSql, TABLAS_CON_ID } from "./traductor.js";
import { incrustar } from "./transporte_supabase.js";

const ES_ESCRITURA = /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/i;
const MAX_POR_ENVIO = 150;

// asegurarTablas() repite decenas de CREATE ... IF NOT EXISTS en cada webhook: se copian una sola vez por instancia.
const _ddlYaCopiado = new Set();
let _errores = 0, _enviadas = 0, _ultimoAviso = 0, _ultimoError = "";
export function estadoEspejo() { return { enviadas: _enviadas, errores: _errores, ultimoError: _ultimoError }; }

// Agrega el id que asignó D1 a un INSERT de una sola fila en una tabla con id automático.
export function conIdDeD1(sql, params, lastRowId) {
  const m = /^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+"?(\w+)"?\s*\(([^)]*)\)\s*VALUES\s*\(/i.exec(sql);
  if (!m || !lastRowId || !TABLAS_CON_ID.has(m[1])) return null;
  const cols = m[2].split(",").map(c => c.trim().replace(/"/g, "").toLowerCase());
  if (cols.includes("id")) return null;
  const resto = sql.slice(m.index + m[0].length);
  if (/\)\s*,\s*\(/.test(resto)) return null;               // varias filas en un solo INSERT: no se toca
  const cabeza = m[0].replace(/\(([^)]*)\)\s*VALUES\s*\($/i, "(id, $1) VALUES (");
  return { sql: sql.slice(0, m.index) + cabeza + "?, " + resto, params: [lastRowId, ...params] };
}

export function conEspejo(env, ctx) {
  if (!env || !env.DB || env.__espejo || env.__modo === "supabase") return env;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY || String(env.ESPEJO_SUPABASE || "1") === "0") return env;
  const d1 = env.DB;
  const cola = [];
  let enviando = null;

  function encolar(sql, params, meta) {
    if (!ES_ESCRITURA.test(sql)) return;
    if (/^\s*CREATE\s+[\w\s]*?IF\s+NOT\s+EXISTS/i.test(sql)) { if (_ddlYaCopiado.has(sql)) return; _ddlYaCopiado.add(sql); }
    if (/^\s*INSERT/i.test(sql) && meta && meta.changes === 0) return;          // INSERT OR IGNORE que no insertó nada
    let s = sql, p = params || [];
    const ajustado = /^\s*INSERT/i.test(sql) && meta && meta.changes === 1 ? conIdDeD1(sql, p, meta.last_row_id) : null;
    if (ajustado) { s = ajustado.sql; p = ajustado.params; }
    try {
      const { text } = traducirSql(s);
      cola.push(incrustar(text, p.map(v => v === undefined ? null : v === true ? 1 : v === false ? 0 : v)));
    } catch (e) { _errores++; _ultimoError = "traducción: " + e.message; }
    if (!enviando && ctx && ctx.waitUntil) { enviando = vaciar(); ctx.waitUntil(enviando); }
  }

  async function vaciar() {
    await new Promise(r => setTimeout(r, 25));                // junta las escrituras que llegan casi juntas
    while (cola.length) {
      const lote = cola.splice(0, MAX_POR_ENVIO);
      try {
        const r = await fetch(env.SUPABASE_URL.replace(/\/$/, "") + "/rest/v1/rpc/ejecutar_sql_espejo_argomedo", {
          method: "POST",
          headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ sentencias: lote })
        });
        const j = await r.json().catch(() => null);
        if (!r.ok || !j) throw new Error("HTTP " + r.status + " " + JSON.stringify(j).slice(0, 200));
        _enviadas += lote.length;
        const fallas = (j.errores || []);
        if (fallas.length) { _errores += fallas.length; _ultimoError = String(fallas[0].error) + " · " + String(fallas[0].sql).slice(0, 120); }
      } catch (e) { _errores += lote.length; _ultimoError = "envío: " + e.message; }
    }
    enviando = null;
    // Aviso en el registro de D1 (como máximo cada 10 min por instancia), sin pasar por el espejo.
    if (_errores && Date.now() - _ultimoAviso > 600000) {
      _ultimoAviso = Date.now();
      try { await d1.prepare("INSERT INTO logs (mensaje) VALUES (?)").bind("⚠️ Espejo Supabase: " + _errores + " escrituras sin copiar · " + _ultimoError.slice(0, 200)).run(); } catch (_) {}
    }
  }

  const envolver = (stmt, sql, params) => ({
    _d1: stmt, _sql: sql, _params: params,
    bind(...p) { return envolver(stmt.bind(...p), sql, p); },
    async run() { const r = await stmt.run(); encolar(sql, params, r && r.meta); return r; },
    async all() { const r = await stmt.all(); encolar(sql, params, r && r.meta); return r; },
    async first(col) { const r = await stmt.first(col); encolar(sql, params, null); return r; },
    async raw(o) { const r = await stmt.raw(o); encolar(sql, params, null); return r; }
  });
  const DB = {
    prepare(sql) { return envolver(d1.prepare(sql), sql, []); },
    async batch(lista) {
      const res = await d1.batch(lista.map(s => (s && s._d1) || s));
      lista.forEach((s, i) => { if (s && s._sql) encolar(s._sql, s._params, res[i] && res[i].meta); });
      return res;
    },
    exec(q) { return d1.exec(q); },
    dump() { return d1.dump(); }
  };
  return { ...env, DB, __espejo: true };
}
