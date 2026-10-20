// Contador de descargas pesadas: anota, por día y por app, cuántas respuestas de más de 50 KB entrega el servidor y
// cuántos bytes pesan. Sirve para calcular cuánta transferencia usaría Supabase (plan gratis: 5 GB al mes entre todas
// las apps) cuando la app lea de ahí. Se guarda en una tabla propia de D1 (uso_diario), escrita SIEMPRE con la D1 "cruda",
// sin pasar por el espejo: no se copia a Supabase ni entra en la comparación de las dos bases.
const UMBRAL_BYTES = 50000;
const LIMITE_GB = 5;
const CREAR = "CREATE TABLE IF NOT EXISTS uso_diario (fecha TEXT NOT NULL, app TEXT NOT NULL, accion TEXT NOT NULL, " +
  "n INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (fecha, app, accion))";
let _tablaLista = false;

const formatoDia = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago" });
const dia = (ms) => formatoDia.format(new Date(ms));

async function asegurarTabla(db) {
  if (_tablaLista) return;
  await db.prepare(CREAR).run();
  _tablaLista = true;
}

// Se llama de forma síncrona con la respuesta que se va a entregar: solo copia (clone) las respuestas JSON de lectura, nunca
// las conexiones en vivo (stream), que no terminan y acumularían memoria.
export function iniciarMedicion(request, res, ctx, db, app) {
  try {
    if (!db || !ctx || !ctx.waitUntil || !res || !res.ok || request.method === "OPTIONS") return;
    const accionUrl = new URL(request.url).searchParams.get("action") || "";
    if (accionUrl === "stream" || accionUrl === "uso_diario" || accionUrl === "espejo_comparar") return;
    const tipo = res.headers.get("content-type") || "";
    if (!tipo.includes("json") || res.webSocket || !res.body) return;
    ctx.waitUntil(medirUso(request, res.clone(), db, app));
  } catch (e) { /* medir nunca debe romper una respuesta */ }
}

// `res` debe ser una COPIA (res.clone()) de la respuesta que se entrega: aquí se lee completa para medirla.
export async function medirUso(request, res, db, app) {
  try {
    if (!db || request.method === "OPTIONS" || !res || !res.ok) return;
    const url = new URL(request.url);
    const accionUrl = url.searchParams.get("action") || "";
    if (accionUrl === "stream" || accionUrl === "uso_diario" || accionUrl === "espejo_comparar") return;
    if (!(res.headers.get("content-type") || "").includes("json")) return;
    const bytes = (await res.arrayBuffer()).byteLength;
    if (bytes < UMBRAL_BYTES) return;
    const accion = (request.method === "GET" ? (accionUrl || "(panel)") : "POST") + (url.searchParams.get("db") === "supabase" ? " [prueba Supabase]" : "");
    await asegurarTabla(db);
    await db.prepare("INSERT INTO uso_diario (fecha, app, accion, n, bytes) VALUES (?,?,?,1,?) " +
      "ON CONFLICT(fecha, app, accion) DO UPDATE SET n = n + 1, bytes = bytes + excluded.bytes").bind(dia(Date.now()), app, accion, bytes).run();
  } catch (e) { /* medir nunca debe romper una respuesta */ }
}

// Resumen para la app: por app, hoy y promedio diario de los últimos 7 días, más la proyección a 30 días contra el límite.
export async function resumenUso(db) {
  await asegurarTabla(db);
  const hoy = dia(Date.now()), desde = dia(Date.now() - 6 * 86400000);
  const filas = (await db.prepare("SELECT fecha, app, accion, n, bytes FROM uso_diario WHERE fecha >= ? ORDER BY fecha DESC, bytes DESC").bind(desde).all()).results || [];
  const apps = {}, total = { bytes7d: 0, dias: new Set() };
  for (const f of filas) {
    const a = apps[f.app] || (apps[f.app] = { hoyN: 0, hoyBytes: 0, bytes7d: 0, n7d: 0, dias: new Set(), acciones: {} });
    if (f.fecha === hoy) { a.hoyN += f.n; a.hoyBytes += f.bytes; }
    a.bytes7d += f.bytes; a.n7d += f.n; a.dias.add(f.fecha);
    a.acciones[f.accion] = (a.acciones[f.accion] || 0) + f.bytes;
    total.bytes7d += f.bytes; total.dias.add(f.fecha);
  }
  const prom = (bytes, dias) => (dias.size ? Math.round(bytes / dias.size) : 0);
  const salida = {};
  for (const [k, a] of Object.entries(apps)) {
    const p = prom(a.bytes7d, a.dias);
    salida[k] = { hoyN: a.hoyN, hoyBytes: a.hoyBytes, promedioDiaBytes: p, proyeccionMesGB: +(p * 30 / 1e9).toFixed(2),
      top: Object.entries(a.acciones).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([accion, bytes]) => ({ accion, bytes })) };
  }
  const p = prom(total.bytes7d, total.dias);
  return { ok: true, umbralBytes: UMBRAL_BYTES, limiteGB: LIMITE_GB, hoy, diasConDatos: total.dias.size, apps: salida,
    total: { promedioDiaBytes: p, proyeccionMesGB: +(p * 30 / 1e9).toFixed(2) } };
}
