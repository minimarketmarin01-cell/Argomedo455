// Prueba del contador de descargas pesadas (uso.js) con el servidor real de Argomedo sobre una D1 de prueba (SQLite local).
// Uso: node migracion/probar_uso.mjs
import fs from "fs";
import assert from "assert";
import { DatabaseSync } from "node:sqlite";
import { mock } from "node:test";
import worker from "../worker.js";
import { volcarChicas } from "../uso.js";
const sq = new DatabaseSync(":memory:");
sq.exec(fs.readFileSync("migracion/esquema_d1_real.sql", "utf8"));
const ins = sq.prepare("INSERT INTO productos(sku,id_loyverse,variant_id,nombre,categoria,costo,precio,stock,track_stock,barcode,sold_by_weight) VALUES (?,?,?,?,?,?,?,?,1,?,0)");
for (let i = 0; i < 700; i++) ins.run("S" + i, "i" + i, "v" + i, "Producto de prueba número " + i + " con nombre largo", "CATEGORIA " + (i % 20), 900, 1290, 12, "78" + String(i).padStart(8, "0"));
sq.exec("INSERT INTO config(clave,valor) VALUES ('store_id','st1')");
const mk = (sql, p = []) => ({ bind: (...a) => mk(sql, a), all: async () => ({ results: sq.prepare(sql).all(...p), meta: {} }), first: async () => sq.prepare(sql).get(...p) || null,
  run: async () => { const r = sq.prepare(sql).run(...p); return { results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; } });
const escrituras = [];
const DB = { prepare: sql => { if (/^\s*(INSERT|UPDATE|CREATE)/i.test(sql)) escrituras.push(sql); return mk(sql); }, batch: async l => { const o = []; for (const s of l) o.push(await s.run()); return o; } };
let clonesDelStream = 0;
const REALTIME_HUB = { idFromName: () => "g", get: () => ({ fetch: async () => {
  const r = new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(": conectado\n\n")); } }), { headers: { "content-type": "text/event-stream" } });
  const clonar = r.clone.bind(r); r.clone = () => { clonesDelStream++; return clonar(); }; return r; } }) };
const env = { DB, LOYVERSE_TOKEN: "x", REALTIME_HUB };   // sin secretos de Supabase: sin espejo
globalThis.fetch = async () => new Response(JSON.stringify({ stores: [{ id: "st1" }], items: [], categories: [], inventory_levels: [], receipts: [], customers: [] }));
const pend = []; const ctx = { waitUntil: p => pend.push(Promise.resolve(p).catch(() => {})) };
const esperar = async () => { while (pend.length) await pend.shift(); };
const get = async q => { const r = await worker.fetch(new Request("https://x/" + q), env, ctx); const t = await r.text(); await esperar(); return { st: r.status, bytes: new TextEncoder().encode(t).length, j: JSON.parse(t) }; };
let n = 0; const ok = m => console.log("ok", ++n, m);

const panel = await get("");
assert(panel.st === 200 && panel.bytes > 50000, "el panel de prueba pesa " + panel.bytes + " (HTTP " + panel.st + ")");
const largos = [panel.bytes]; for (let i = 0; i < 2; i++) largos.push((await get("")).bytes);
const suma = largos.reduce((a, b) => a + b, 0);
const fila = sq.prepare("select * from uso_diario").all();
assert.strictEqual(fila.length, 1); assert.strictEqual(fila[0].app, "pedidos"); assert.strictEqual(fila[0].accion, "(panel)"); assert.strictEqual(fila[0].n, 3); assert.strictEqual(fila[0].bytes, suma);
ok("3 cargas del panel (~" + Math.round(suma / 3) + " bytes c/u) quedaron contadas con su peso exacto (" + suma + " bytes)");
await get("?action=ultima_actualizacion");
assert.strictEqual(sq.prepare("select count(*) n from uso_diario").get().n, 1); ok("las respuestas livianas (<50 KB) no escriben en D1 una por una: se suman en memoria");
const u = (await get("?action=uso_diario")).j;
assert(u.ok && u.apps.pedidos.hoyN === 3 && u.apps.pedidos.hoyBytes === suma && u.total.proyeccionMesGB > 0 && u.limiteGB === 5, JSON.stringify(u));
ok("?action=uso_diario: hoy 3 cargas, proyección a 30 días (" + u.total.proyeccionMesGB + " GB de " + u.limiteGB + ")");
// App de etiquetas del POS: se identifica con ?app=etiquetas y se cuenta aparte, también las respuestas livianas.
await get("?action=ultima_actualizacion&app=etiquetas"); await get("?action=ultima_actualizacion&app=etiquetas"); await get("?action=ultima_actualizacion");
const et = sq.prepare("select * from uso_diario where app = 'etiquetas'").all();
assert.strictEqual(et.length, 1); assert.strictEqual(et[0].accion, "ultima_actualizacion"); assert.strictEqual(et[0].n, 2); assert(et[0].bytes > 0 && et[0].bytes < 50000);
assert.strictEqual(sq.prepare("select count(*) n from uso_diario where app = 'pedidos'").get().n, 1);
ok("?app=etiquetas se cuenta aparte (2 respuestas livianas, " + et[0].bytes + " bytes); sin la marca va a 'pedidos'");
const pesada = await get("?app=etiquetas");
assert(pesada.bytes > 50000); assert.strictEqual(sq.prepare("select n from uso_diario where app='etiquetas' and accion='(panel)'").get().n, 1);
ok("una descarga pesada con ?app=etiquetas también queda en 'etiquetas'");
const u2 = (await get("?action=uso_diario")).j; assert(u2.apps.etiquetas && u2.apps.etiquetas.hoyN === 3, JSON.stringify(u2.apps.etiquetas));
ok("?action=uso_diario muestra la app 'etiquetas' por separado");
const rs = await worker.fetch(new Request("https://x/?action=stream"), env, ctx); await esperar();
assert.strictEqual(rs.headers.get("content-type"), "text/event-stream"); assert.strictEqual(clonesDelStream, 0);
ok("la conexión en vivo (stream) se entrega sin copiarla ni medirla (no acumula memoria)");
assert.strictEqual(sq.prepare("select count(*) n from uso_diario").get().n, 3);
// Respuestas chicas (<50 KB): se suman en memoria y se anotan juntas, con " <50KB" en el nombre.
const escritasAntes = sq.prepare("select count(*) n from uso_diario").get().n;
await volcarChicas(DB, true);
const chicas = sq.prepare("select app, accion, n, bytes from uso_diario where accion like '% <50KB' order by app, accion").all();
assert(chicas.some(f => f.app === "pedidos" && f.accion === "ultima_actualizacion <50KB" && f.n >= 1 && f.bytes > 0), JSON.stringify(chicas));
assert(!sq.prepare("select 1 from uso_diario where app='etiquetas' and accion like '% <50KB'").get(), "etiquetas ya cuenta todas por separado");
ok("al volcar, las respuestas chicas quedan anotadas por acción: " + chicas.map(f => f.accion + " ×" + f.n + " (" + f.bytes + " B)").join(", "));
const u3 = (await get("?action=uso_diario")).j;
assert(u3.apps.pedidos.hoyN >= 5 && u3.apps.pedidos.hoyBytes > suma, JSON.stringify(u3.apps.pedidos)); ok("?action=uso_diario suma también las chicas al total de hoy");
// no escribe en D1 cada vez: 40 respuestas chicas seguidas = 0 escrituras hasta que pasen 15 minutos; luego, una tanda
sq.exec("DELETE FROM uso_diario WHERE accion LIKE '% <50KB'");
const wr = () => escrituras.filter(s => /INSERT INTO uso_diario/i.test(s)).length;
const w0 = wr();
for (let i = 0; i < 40; i++) await get("?action=ultima_actualizacion");
assert.strictEqual(wr(), w0, "escribió en D1 con cada respuesta chica");
ok("40 avisos de cambios seguidos no escriben nada en D1 (se acumulan)");
mock.timers.enable({ apis: ["Date"], now: Date.now() + 16 * 60 * 1000 });
try { await get("?action=ultima_actualizacion"); } finally { mock.timers.reset(); }
const f2 = sq.prepare("select n from uso_diario where app='pedidos' and accion='ultima_actualizacion <50KB'").get();
assert(f2 && f2.n >= 41 && wr() - w0 <= 3, JSON.stringify(f2) + " escrituras " + (wr() - w0));
ok("pasados 15 minutos se anotan juntas (" + f2.n + " respuestas en " + (wr() - w0) + " escritura(s), no " + f2.n + ")");
console.log("\nTodas las pruebas pasaron:", n); process.exit(0);
