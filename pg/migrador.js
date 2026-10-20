// Herramienta de copia D1 -> Supabase y de comparación entre ambas bases. Se usa desde el navegador con
// ?action=migrar_ui&clave=... (protegida por el secreto MIGRACION_CLAVE). Es repetible: "vaciar" deja Supabase
// limpio y "paso" copia por páginas. Cloudflare/D1 solo se LEE; nunca se modifica.
import { crearTransporteSupabase, literal } from "./transporte_supabase.js";
import { TABLAS_CON_ID } from "./traductor.js";

// Orden: primero las tablas "padre" (las que otras referencian).
export const TABLAS = [
  "proveedores", "productos", "fiados",
  "auditoria", "categorias_loyverse", "clasificacion_abc", "config", "config_categorias", "config_multiplo_producto",
  "config_vida_util", "configuracion", "control_dedup", "control_tx", "diccionario_aprendido", "facturas_calculos",
  "favoritos", "fiados_lineas", "fiados_refunds_linea_manual", "historial_precios", "llegadas", "logs", "mermas",
  "pagos_fiado", "pedidos_pendientes", "por_revisar", "prestamos", "producto_clasificacion_aprendida",
  "producto_proveedor_extra", "push_subscriptions", "registros", "riesgo_excluidos", "sectores",
  "sectores_personalizados", "vencimientos", "ventas", "ventas_diarias_historico", "webhook_eventos"
];
const CON_ID = TABLAS_CON_ID;
const FILAS_POR_PAGINA = 300;
const MAX_CARACTERES = 350000;

function transporte(env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) throw new Error("Faltan los secretos SUPABASE_URL y SUPABASE_SERVICE_KEY en el servidor");
  return crearTransporteSupabase({ url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_KEY });
}
export function autorizado(env, clave) { return !!env.MIGRACION_CLAVE && clave === env.MIGRACION_CLAVE; }
const q = (t) => '"' + t + '"';

export async function vaciar(env) {
  const tx = transporte(env);
  await tx.query("TRUNCATE " + TABLAS.map(t => "argomedo455." + q(t)).join(", ") + " RESTART IDENTITY", []);
  return { ok: true, tablas: TABLAS.length };
}

// Copia páginas de `tabla` desde `desde` (rowid) hasta agotar el tiempo o la tabla. Devuelve dónde seguir.
export async function paso(env, tabla, desde, presupuestoMs = 18000) {
  if (!TABLAS.includes(tabla)) throw new Error("Tabla desconocida: " + tabla);
  const tx = transporte(env);
  const t0 = Date.now(); let copiadas = 0, cursor = Number(desde) || 0;
  while (Date.now() - t0 < presupuestoMs) {
    const rs = await env.DB.prepare("SELECT rowid AS __rid, * FROM " + q(tabla) + " WHERE rowid > ? ORDER BY rowid LIMIT " + FILAS_POR_PAGINA).bind(cursor).all();
    const filas = rs.results || [];
    if (!filas.length) return { ok: true, tabla, terminada: true, siguiente: siguienteTabla(tabla), copiadas };
    const cols = Object.keys(filas[0]).filter(k => k !== "__rid");
    let lote = [], largo = 0;
    const volcar = async () => {
      if (!lote.length) return;
      await tx.query("INSERT INTO argomedo455." + q(tabla) + " (" + cols.map(q).join(",") + ") VALUES " + lote.join(",") + " ON CONFLICT DO NOTHING", []);
      lote = []; largo = 0;
    };
    for (const f of filas) {
      const v = "(" + cols.map(c => literal(f[c])).join(",") + ")";
      if (largo + v.length > MAX_CARACTERES) await volcar();
      lote.push(v); largo += v.length;
    }
    await volcar();
    copiadas += filas.length; cursor = filas[filas.length - 1].__rid;
  }
  return { ok: true, tabla, terminada: false, desde: cursor, copiadas };
}
function siguienteTabla(t) { const i = TABLAS.indexOf(t); return i + 1 < TABLAS.length ? TABLAS[i + 1] : null; }

// Deja los contadores automáticos (id) de Supabase después del id más alto copiado.
export async function finalizar(env) {
  const tx = transporte(env);
  const sentencias = [...CON_ID].map(t => ({ text: "SELECT setval(pg_get_serial_sequence('argomedo455." + t + "', 'id'), GREATEST(COALESCE((SELECT MAX(id) FROM argomedo455." + q(t) + "), 0), 1), (SELECT COUNT(*) > 0 FROM argomedo455." + q(t) + "))", params: [] }));
  await tx.transaccion(sentencias);
  _cacheComparar = { t: 0, r: null };   // la próxima revisión desde la app ve la copia recién hecha
  return { ok: true, secuencias: sentencias.length };
}

// Compara cantidad de filas por tabla y algunas sumas clave entre D1 y Supabase.
export async function comparar(env) {
  const tx = transporte(env);
  const filas = [];
  for (const t of TABLAS) {
    const a = await env.DB.prepare("SELECT COUNT(*) AS n FROM " + q(t)).first();
    const b = (await tx.query("SELECT COUNT(*) AS n FROM argomedo455." + q(t), [])).rows[0];
    filas.push({ tabla: t, d1: a.n, supabase: Number(b.n), coincide: a.n === Number(b.n) });
  }
  const sumas = [
    ["fiados abiertos (monto)", "SELECT ROUND(COALESCE(SUM(monto_total),0)) AS v FROM fiados WHERE estado='abierto'"],
    ["fiados abiertos (cantidad)", "SELECT COUNT(*) AS v FROM fiados WHERE estado='abierto'"],
    ["ventas (suma venta)", "SELECT ROUND(COALESCE(SUM(venta),0)) AS v FROM ventas"],
    ["stock total productos", "SELECT ROUND(COALESCE(SUM(stock),0)) AS v FROM productos"],
    ["costos manuales (suma)", "SELECT ROUND(COALESCE(SUM(costo),0)) AS v FROM productos"]
  ].map(([nombre, sql]) => ({ nombre, sql }));
  const control = [];
  for (const s of sumas) {
    const a = await env.DB.prepare(s.sql).first();
    const b = (await tx.query(s.sql.replace(/ FROM (\w+)/, " FROM argomedo455.$1"), [])).rows[0];
    control.push({ nombre: s.nombre, d1: Number(a.v), supabase: Number(b.v), coincide: Math.abs(Number(a.v) - Number(b.v)) <= 1 }); // ±1: SQLite y Postgres redondean distinto los .5 (ROUND)
  }
  return { ok: true, todoCoincide: filas.every(f => f.coincide) && control.every(c => c.coincide), tablas: filas, control };
}

export function paginaMigracion(clave) {
  const k = encodeURIComponent(clave);
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Copiar a Supabase</title><style>body{font-family:Roboto,system-ui,sans-serif;margin:0;color:#212121}header{background:#4CAF50;color:#fff;padding:16px;font-size:20px}
main{padding:16px}button{background:#4CAF50;color:#fff;border:0;border-radius:2px;padding:14px;font-size:14px;letter-spacing:.06em;text-transform:uppercase;width:100%;margin:6px 0}
button.sec{background:#fff;color:#388E3C;border:1px solid #E0E0E0}pre{white-space:pre-wrap;background:#F5F5F5;padding:12px;font-size:13px;min-height:120px}</style></head><body>
<header>Copiar Argomedo 455 a Supabase</header><main>
<p>Cloudflare solo se lee; no se modifica. Se puede repetir las veces que quieras (la copia reemplaza lo que haya en Supabase).</p>
<button id="b1">1. Copiar todo (reemplaza Supabase)</button><button id="b2" class="sec">2. Comparar con Cloudflare</button><pre id="log">Listo.</pre></main>
<script>
const K="${k}",B=location.pathname;const log=t=>{const l=document.getElementById('log');l.textContent+="\\n"+t;l.scrollTop=l.scrollHeight};
async function api(a,x){const r=await fetch(B+'?action='+a+'&clave='+K+(x||''));const j=await r.json();if(!j.ok)throw new Error(j.error||'error');return j}
document.getElementById('b1').onclick=async()=>{const b1=document.getElementById('b1');b1.disabled=true;document.getElementById('log').textContent='Vaciando Supabase…';
 try{await api('migrar_vaciar');let t='proveedores',d=0,total=0;
  while(t){const j=await api('migrar_paso','&tabla='+t+'&desde='+d);total+=j.copiadas;
   if(j.terminada){log('✓ '+t+' ('+total+' filas en total)');t=j.siguiente;d=0}else{d=j.desde;log('… '+t+' hasta '+d)}}
  await api('migrar_finalizar');log('\\nCOPIA TERMINADA. Ahora toca "Comparar".')}catch(e){log('ERROR: '+e.message)}b1.disabled=false};
document.getElementById('b2').onclick=async()=>{try{log('Comparando…');const j=await api('migrar_comparar');
 log((j.todoCoincide?'✅ TODO COINCIDE':'⚠️ HAY DIFERENCIAS')+'\\n'+j.control.map(c=>(c.coincide?'✓ ':'✗ ')+c.nombre+': D1='+c.d1+' · Supabase='+c.supabase).join('\\n')+
 '\\n'+j.tablas.filter(t=>!t.coincide).map(t=>'✗ '+t.tabla+': D1='+t.d1+' · Supabase='+t.supabase).join('\\n'))}catch(e){log('ERROR: '+e.message)}};
</script></body></html>`;
}

// Comparación liviana para la app (sin clave): solo conteos y sumas, en 1 lote a D1 y 1 llamada a Supabase.
// Si algo no coincide, espera 3 s y repite una vez (el espejo copia en segundo plano y puede ir unos segundos atrás).
const SUMAS = [
  ["Fiados abiertos (monto)", "SELECT ROUND(COALESCE(SUM(monto_total),0)) AS v FROM fiados WHERE estado='abierto'"],
  ["Fiados abiertos (cantidad)", "SELECT COUNT(*) AS v FROM fiados WHERE estado='abierto'"],
  ["Ventas (suma)", "SELECT ROUND(COALESCE(SUM(venta),0)) AS v FROM ventas"],
  ["Stock total", "SELECT ROUND(COALESCE(SUM(stock),0)) AS v FROM productos"],
  ["Costos (suma)", "SELECT ROUND(COALESCE(SUM(costo),0)) AS v FROM productos"]
];
let _cacheComparar = { t: 0, r: null };
async function compararUnaVez(env) {
  const tx = transporte(env);
  const consultas = [...TABLAS.map(t => "SELECT COUNT(*) AS v FROM " + q(t)), ...SUMAS.map(x => x[1])];
  const d1 = await env.DB.batch(consultas.map(s => env.DB.prepare(s)));
  const sb = await tx.transaccion(consultas.map(s => ({ text: s.replace(/ FROM (\w+|"\w+")/, " FROM argomedo455.$1"), params: [] })));
  const val = (r) => Number(((r && (r.results || r.rows)) || [])[0]?.v ?? NaN);
  const tablas = TABLAS.map((t, i) => ({ tabla: t, d1: val(d1[i]), supabase: val(sb[i]) })).map(x => ({ ...x, coincide: x.d1 === x.supabase }));
  const control = SUMAS.map((x, k) => { const i = TABLAS.length + k; const a = val(d1[i]), b = val(sb[i]); return { nombre: x[0], d1: a, supabase: b, coincide: Math.abs(a - b) <= 1 }; });
  return { ok: true, todoCoincide: tablas.every(x => x.coincide) && control.every(x => x.coincide), tablas, control, revisadoEn: new Date().toISOString() };
}
export async function compararRapido(env) {
  if (_cacheComparar.r && Date.now() - _cacheComparar.t < 60000) return { ..._cacheComparar.r, enCache: true };
  let r = await compararUnaVez(env);
  if (!r.todoCoincide) { await new Promise(res => setTimeout(res, 3000)); r = await compararUnaVez(env); }
  _cacheComparar = { t: Date.now(), r };
  return r;
}
