// Traduce el SQL que escribe el servidor (dialecto SQLite/D1) a Postgres (Supabase).
// Función pura, sin dependencias: se prueba contra todas las consultas reales del servidor
// (ver migracion/probar_traduccion.mjs). Copia adaptada de Marín 376 con las tablas de Argomedo 455.

// Claves primarias de las tablas que usan INSERT OR REPLACE (Postgres necesita saber el conflicto).
export const PK_POR_TABLA = {};  // Argomedo no usa INSERT OR REPLACE
// Columnas con mayúsculas: Postgres las pasa a minúsculas salvo que se escriban entre comillas.
const IDENT_MIXTOS = [];  // Argomedo no tiene columnas con mayúsculas
// Tablas cuya clave `id` es autoincremental y donde el código lee insertRes.meta.last_row_id.
export const TABLAS_CON_ID = new Set([
  "auditoria", "facturas_calculos", "fiados", "fiados_lineas", "historial_precios", "llegadas", "logs", "mermas",
  "pagos_fiado", "pedidos_pendientes", "por_revisar", "prestamos", "proveedores", "registros", "sectores", "vencimientos"
]);

// UPDATE OR IGNORE: SQLite se salta las filas que chocarían con una clave única. Postgres no tiene equivalente directo:
// se agrega NOT EXISTS sobre las demás columnas de la clave. Tablas con la columna que cambia fuera de toda clave -> UPDATE normal.
export const UPDATE_OR_IGNORE = {
  producto_proveedor_extra: { cambia: "proveedor_id", resto: ["sku"] }
};

const TS_UTC = "to_char(now() at time zone 'utc','YYYY-MM-DD HH24:MI:SS')";
const D_UTC = "to_char(now() at time zone 'utc','YYYY-MM-DD')";

// Aplica `fn` solo a los trozos que NO están dentro de comillas simples.
function fueraDeTextos(sql, fn) {
  let out = "", i = 0;
  while (i < sql.length) {
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length) { if (sql[j] === "'") { if (sql[j + 1] === "'") { j += 2; continue; } break; } j++; }
      out += sql.slice(i, j + 1); i = j + 1;
    } else {
      let j = i; while (j < sql.length && sql[j] !== "'") j++;
      out += fn(sql.slice(i, j)); i = j;
    }
  }
  return out;
}

// col GLOB 'patrón' -> col ~ '^regex$' (solo patrones simples: [..], * y ?)
function fueraDeTextosGlob(sql) {
  return sql.replace(/\bGLOB\s+'([^']*)'/gi, (_, pat) => {
    const re = pat.replace(/\*/g, ".*").replace(/\?/g, ".").replace(/(\[[^\]]+\])\1+/g, (m, g) => g + "{" + m.length / g.length + "}");
    return "~ '^" + re + "$'";
  });
}
// SQLite permite usar el alias del SELECT dentro de HAVING; Postgres no -> se reemplaza por la expresión.
function aliasEnHaving(sql) {
  const mh = /\bHAVING\b([\s\S]*?)(?=\bORDER\s+BY\b|\bLIMIT\b|$)/i.exec(sql);
  if (!mh) return sql;
  let out = sql;
  const mSel = /^\s*SELECT\s+([\s\S]*?)\s+FROM\b/i.exec(sql);
  if (!mSel) return sql;
  const alias = {};
  const partes = []; let prof = 0, ini = 0; const sel = mSel[1];
  for (let i = 0; i < sel.length; i++) { const ch = sel[i]; if (ch === "(") prof++; else if (ch === ")") prof--; else if (ch === "," && prof === 0) { partes.push(sel.slice(ini, i)); ini = i + 1; } }
  partes.push(sel.slice(ini));
  partes.forEach(p => { const m = /^([\s\S]+?)\s+AS\s+(\w+)\s*$/i.exec(p.trim()); if (m && /\(/.test(m[1])) alias[m[2]] = m[1].trim(); });
  let having = mh[1];
  Object.keys(alias).forEach(a => { having = having.replace(new RegExp("\\b" + a + "\\b", "g"), "(" + alias[a] + ")"); });
  return out.replace(mh[1], having);
}
// ON CONFLICT ... DO UPDATE SET x = x + excluded.x : en Postgres "x" es ambiguo -> tabla.x
function calificarUpsert(sql) {
  const mt = /^\s*INSERT\s+INTO\s+(\w+)/i.exec(sql);
  const md = /\bDO\s+UPDATE\s+SET\b([\s\S]*)$/i.exec(sql);
  if (!mt || !md) return sql;
  const tabla = mt[1];
  const nuevo = md[1].split(/,(?![^()]*\))/).map(asig => {
    const m = /^(\s*)(\w+)(\s*=\s*)([\s\S]*)$/.exec(asig);
    if (!m) return asig;
    const rhs = m[4].replace(/(?<![\w.])(\w+)(?![\w(.])/g, (x, id, off, str) =>
      (/^(excluded|now|coalesce|case|when|then|else|end|null|and|or|not|is|in|\d+)$/i.test(id) ? x : (id === m[2] || md[1].includes(id + " ") && false) ? tabla + "." + id : x));
    return m[1] + m[2] + m[3] + rhs;
  }).join(",");
  return sql.replace(md[1], nuevo);
}

// SQLite compara los textos byte a byte (BINARY: MAYÚSCULAS antes que minúsculas, tildes al final); Postgres usa el idioma de la base
// (diccionario: "Biscomund" va junto a "BI…"). Para que las listas salgan en el mismo orden que en D1, los ORDER BY por columnas de
// texto conocidas (nombre, categoría, proveedor, producto, sku) se piden con COLLATE "C" (byte a byte, como SQLite).
const ORDEN_TEXTO = /^((?:\w+\.)?(?:nombre|categoria|proveedor|producto|sku)|lower\((?:\w+\.)?(?:nombre|categoria|proveedor|producto)\))(\s+(?:ASC|DESC))?$/i;
function ordenBinario(sql) {
  return sql.replace(/\bORDER\s+BY\s+((?:[^;()]|\([^()]*\))*?)(?=\s+LIMIT\b|\s+OFFSET\b|\)|;|$)/gi, (todo, lista) => {
    const items = lista.split(",").map(it => {
      const m = ORDEN_TEXTO.exec(it.trim());
      return m ? m[1] + ' COLLATE "C"' + (m[2] || "") : it.trim();
    });
    return "ORDER BY " + items.join(", ");
  });
}

export function traducirSql(sqlOriginal) {
  let sql = String(sqlOriginal).trim().replace(/;\s*$/, "");
  // Supabase rechaza DELETE sin WHERE ("DELETE requires a WHERE clause"): un borrado total se manda con WHERE true.
  sql = sql.replace(/^(\s*DELETE\s+FROM\s+"?\w+"?)\s*$/i, "$1 WHERE true");
  const mUpd = /^\s*UPDATE\s+OR\s+IGNORE\s+(\w+)\s+SET\s+(\w+)\s*=\s*\?\s+WHERE\s+(\w+)\s*=\s*\?\s*$/i.exec(sql);
  if (mUpd) {
    const [, tabla, colSet, colWhere] = mUpd;
    const regla = UPDATE_OR_IGNORE[tabla];
    if (regla === undefined || colSet !== colWhere) throw new Error("UPDATE OR IGNORE no soportado para " + tabla);
    sql = regla
      ? "UPDATE " + tabla + " t SET " + colSet + " = ? WHERE t." + colWhere + " = ? AND NOT EXISTS (SELECT 1 FROM " + tabla + " x WHERE " +
        regla.resto.map(c => "x." + c + " = t." + c).join(" AND ") + " AND x." + colSet + " = $1)"
      : "UPDATE " + tabla + " SET " + colSet + " = ? WHERE " + colWhere + " = ?";
  }
  const esInsertIgnore = /^\s*INSERT\s+OR\s+IGNORE\s+INTO/i.test(sql);
  const mReplace = /^\s*INSERT\s+OR\s+REPLACE\s+INTO\s+(\w+)\s*\(([^)]*)\)/i.exec(sql);
  sql = sql.replace(/^\s*INSERT\s+OR\s+(IGNORE|REPLACE)\s+INTO/i, "INSERT INTO");

  sql = fueraDeTextos(sql, t => t
    .replace(/\bGROUP_CONCAT\s*\(\s*([^(),]+?)\s*\)/gi, "string_agg(($1)::text, ',')")
    .replace(/\b(\w+)\s+COLLATE\s+NOCASE\b/gi, "lower($1)")
    .replace(/\browid\b/gi, "id")
    .replace(/\bLIKE\b/gi, "ILIKE")
    .replace(/\bIFNULL\s*\(/gi, "COALESCE(")
    .replace(/\bAUTOINCREMENT\b/gi, "")
  );
  sql = fueraDeTextosGlob(sql);
  // Con SELECT DISTINCT, o si el SELECT le pone a otra expresión el nombre de la columna (AS categoria), Postgres no acepta
  // ordenar por "columna COLLATE": en esos casos se deja como estaba.
  if (/^\s*(SELECT|WITH)\b/i.test(sql) && !/\bDISTINCT\b/i.test(sql) && !/\bAS\s+(nombre|categoria|proveedor|producto|sku)\b/i.test(sql)) sql = fueraDeTextos(sql, ordenBinario);
  sql = aliasEnHaving(sql);
  sql = calificarUpsert(sql);
  // Fechas: datetime('now') y date('now') (el 'now' de SQLite es UTC) — van con texto entre comillas, así que se hacen antes.
  sql = sql
    .replace(/datetime\(\s*'now'\s*\)/gi, TS_UTC)
    .replace(/date\(\s*'now'\s*\)/gi, D_UTC)
    // date(X, '-7 day')  /  date(X, '-' || ? || ' day')
    .replace(/date\(\s*([^,()]+?)\s*,\s*'-(\d+) day'\s*\)/gi, "to_char(($1)::date - $2,'YYYY-MM-DD')")
    .replace(/date\(\s*([^,()]+?)\s*,\s*'-'\s*\|\|\s*(\?)\s*\|\|\s*' day'\s*\)/gi, "to_char(($1)::date - ($2)::int,'YYYY-MM-DD')");

  // Tipos y detalles de CREATE/ALTER
  if (/^\s*(CREATE|ALTER)\s/i.test(sql)) {
    sql = fueraDeTextos(sql, t => t
      .replace(/\bINTEGER\s+PRIMARY\s+KEY\s*(?=[,)])/gi, "BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY")
      .replace(/\bINTEGER\b/gi, "BIGINT")
      .replace(/\bREAL\b/gi, "DOUBLE PRECISION")
      .replace(/\bADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS)/gi, "ADD COLUMN IF NOT EXISTS ")
    );
    sql = sql.replace(/DEFAULT\s*\(\s*(to_char\([^)]*\)[^)]*\))\s*\)/gi, "DEFAULT $1");
  }

  // Nombres con mayúsculas -> entre comillas
  IDENT_MIXTOS.forEach(id => { sql = fueraDeTextos(sql, t => t.replace(new RegExp("(?<![\\w\"])" + id + "(?![\\w\"])", "g"), '"' + id + '"')); });

  // INSERT OR IGNORE / OR REPLACE
  if (esInsertIgnore) sql += " ON CONFLICT DO NOTHING";
  if (mReplace) {
    const tabla = mReplace[1];
    const cols = mReplace[2].split(",").map(s => s.trim());
    const pk = PK_POR_TABLA[tabla];
    if (!pk) throw new Error("INSERT OR REPLACE sin clave primaria conocida para " + tabla);
    const q = c => (IDENT_MIXTOS.includes(c) ? '"' + c + '"' : c);
    const sets = cols.filter(c => !pk.includes(c)).map(c => q(c) + " = EXCLUDED." + q(c));
    sql += " ON CONFLICT (" + pk.map(q).join(", ") + ") " + (sets.length ? "DO UPDATE SET " + sets.join(", ") : "DO NOTHING");
  }

  // Marcadores ? -> $1, $2...
  let n = 0;
  sql = fueraDeTextos(sql, t => t.replace(/\?/g, () => "$" + (++n)));
  return { text: sql, nParams: n };
}

// Nombre de la tabla de un INSERT (para pedir RETURNING id y reproducir last_row_id).
export function tablaDeInsert(sqlPg) {
  const m = /^\s*INSERT\s+INTO\s+"?(\w+)"?/i.exec(sqlPg);
  return m ? m[1] : null;
}
