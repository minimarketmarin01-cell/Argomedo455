// Imita la interfaz de D1 (env.DB.prepare(sql).bind(...).all()/run()/first(), env.DB.batch([...]))
// sobre Postgres, para que el código del servidor funcione sin reescribir cada consulta.
// El transporte (cómo se llega a Supabase) se inyecta desde afuera:
//   transporte.query(text, params)      -> { rows, rowCount }
//   transporte.transaccion([{text,params}]) -> [{ rows, rowCount }]  (todo o nada)
import { traducirSql, tablaDeInsert, TABLAS_CON_ID } from "./traductor.js";

const MIXTOS = {};  // Argomedo no tiene columnas con mayúsculas

function normalizarParam(v) {
  if (v === undefined) return null;
  if (v === true) return 1;
  if (v === false) return 0;
  return v;
}
function restaurarClaves(rows) {
  return rows.map(r => {
    for (const k of Object.keys(MIXTOS)) if (k in r) { r[MIXTOS[k]] = r[k]; delete r[k]; }
    return r;
  });
}

// Consultas propias de SQLite que no existen en Postgres: se emulan o se devuelven vacías.
// (Las de sqlite_master sirven a migraciones de SQLite, p. ej. quitar un CHECK: en Postgres el esquema ya nace sin él.)
function emular(sql, params) {
  let m;
  if ((m = /^\s*PRAGMA\s+table_info\(\s*"?(\w+)"?\s*\)/i.exec(sql))) {
    return { text: `SELECT (ordinal_position - 1) AS cid, column_name AS name, data_type AS type,
      (CASE WHEN is_nullable = 'NO' THEN 1 ELSE 0 END) AS notnull, column_default AS dflt_value, 0 AS pk
      FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`, params: [m[1]] };
  }
  if (/^\s*PRAGMA\s+foreign_key_list/i.test(sql)) return { vacio: true };
  if (/FROM\s+sqlite_master/i.test(sql)) {
    if (/SELECT\s+name\s+FROM\s+sqlite_master\s+WHERE\s+type='table'\s+AND\s+name\s+NOT\s+LIKE/i.test(sql)) {
      return { text: "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'", params: [] };
    }
    return { vacio: true };
  }
  return null;
}

function prepararSentencia(sql, params) {
  const e = emular(sql, params);
  if (e) return e;
  const { text } = traducirSql(sql);
  let final = text, conId = false;
  const tabla = tablaDeInsert(text);
  if (tabla && TABLAS_CON_ID.has(tabla) && !/\bRETURNING\b/i.test(text)) { final += " RETURNING id"; conId = true; }
  return { text: final, params: params.map(normalizarParam), conId };
}

function resultado(r, conId) {
  const rows = restaurarClaves(r.rows || []);
  const meta = { changes: r.rowCount || 0, last_row_id: conId && rows[0] ? Number(rows[0].id) : 0 };
  return { results: rows, success: true, meta };
}

export function crearDB(transporte) {
  function stmt(sql, params = []) {
    return {
      _sql: sql, _params: params,
      bind(...p) { return stmt(sql, p); },
      async all() { return this._ejecutar(); },
      async run() { return this._ejecutar(); },
      async first(col) { const r = await this._ejecutar(); const f = r.results[0] || null; return col && f ? f[col] : f; },
      async raw() { const r = await this._ejecutar(); return r.results.map(o => Object.values(o)); },
      async _ejecutar() {
        const p = prepararSentencia(this._sql, this._params);
        if (p.vacio) return { results: [], success: true, meta: { changes: 0, last_row_id: 0 } };
        return resultado(await transporte.query(p.text, p.params), p.conId);
      },
      _preparada() { return prepararSentencia(this._sql, this._params); }
    };
  }
  return {
    prepare(sql) { return stmt(sql); },
    async batch(lista) {
      const ps = lista.map(s => s._preparada());
      const reales = ps.filter(p => !p.vacio);
      const out = await transporte.transaccion(reales.map(p => ({ text: p.text, params: p.params })));
      let i = 0;
      return ps.map(p => p.vacio ? { results: [], success: true, meta: { changes: 0, last_row_id: 0 } } : resultado(out[i++], p.conId));
    }
  };
}
