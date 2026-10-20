// Prueba del espejo de Argomedo: D1 (SQLite local) y Supabase (Postgres local) parten iguales; se usa el servidor en modo
// normal (escrituras reales, incluido un webhook de ventas de Loyverse) y al final ambas bases deben coincidir, ids incluidos.
// Uso: NODE_PATH=<carpeta con pg> PGHOST=... PGUSER=... PGDATABASE=... node migracion/probar_espejo.mjs
import http from "http";
import fs from "fs";
import assert from "assert";
import { createRequire } from "module";
import { DatabaseSync } from "node:sqlite";
import worker from "../worker.js";
import * as mig from "../pg/migrador.js";
import { conIdDeD1 } from "../pg/espejo.js";
const { Client } = createRequire(import.meta.url)("pg");

const sq = new DatabaseSync(":memory:");
sq.exec(fs.readFileSync("migracion/esquema_d1_real.sql", "utf8"));
sq.exec(`INSERT INTO proveedores(nombre) VALUES ('SOPROLE'),('CCU'),('CCU CHILE'),('soprole');
 INSERT INTO productos(sku,id_loyverse,variant_id,nombre,categoria,proveedor,barcode,precio,costo,stock,sold_by_weight,track_stock,proveedor_id,sector) VALUES
  ('S1','i1','v1','Leche 1L','SOPROLE','SOPROLE','780001',1290,900,12,0,1,1,'LACTEOS'),('S2','i2','v2','Kem piña 3L','CCU','CCU','780002',3000,1500,1,0,1,2,NULL);
 INSERT INTO producto_proveedor_extra VALUES ('S2',3),('S1',4),('S2',4),('S2',1);
 INSERT INTO fiados(cliente_id,receipt_id_loyverse,monto_total,estado,fecha_hora) VALUES ('c1','R1',2000,'abierto','2026-10-19 10:00:00');
 INSERT INTO mermas(fecha,sku,producto,cantidad,costo_total,motivo) VALUES ('2026-10-18','S1','Leche',1,900,'Vencido');
 INSERT INTO vencimientos(fecha_ingreso,sku,producto,cantidad,fecha_vencimiento,estado) VALUES ('2026-10-01','S1','Leche',6,'2026-10-25','Vigente');
 INSERT INTO ventas VALUES ('R0','S1',2,'2026-10-18',2580,780);
 INSERT INTO config(clave,valor) VALUES ('store_id','st1');`);
const mk = (sql, p = []) => ({ bind: (...a) => mk(sql, a), all: async () => { const st = sq.prepare(sql); if (/^\s*(SELECT|WITH|PRAGMA)/i.test(sql)) return { results: st.all(...p), meta: { changes: 0 } }; const r = st.run(...p); return { results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
  first: async (c) => { const r = sq.prepare(sql).get(...p) || null; return c && r ? r[c] : r; },
  run: async () => { if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return { results: sq.prepare(sql).all(...p), meta: { changes: 0 } }; const r = sq.prepare(sql).run(...p); return { results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; } });
const DB = { prepare: s => mk(s), batch: async l => { const o = []; sq.exec("BEGIN"); try { for (const s of l) o.push(await s.all()); sq.exec("COMMIT"); } catch (e) { sq.exec("ROLLBACK"); throw e; } return o; } };

const c = new Client(); await c.connect();
await c.query("drop schema if exists argomedo455 cascade; drop function if exists public.ejecutar_sql_argomedo(jsonb); drop function if exists public.ejecutar_sql_espejo_argomedo(jsonb)");
await c.query(fs.readFileSync("migracion/esquema_postgres.sql", "utf8"));
for (const f of ["funcion_ejecutar_sql.sql", "funcion_ejecutar_sql_espejo.sql"]) await c.query(fs.readFileSync("migracion/" + f, "utf8").replace(/revoke all[^;]*;|grant execute[^;]*;/g, ""));
const srv = http.createServer(async (req, res) => {
  let body = ""; for await (const ch of req) body += ch;
  const fn = req.url.includes("ejecutar_sql_espejo_argomedo") ? "ejecutar_sql_espejo_argomedo" : "ejecutar_sql_argomedo";
  try { const r = await c.query("select public." + fn + "($1::jsonb) as r", [JSON.stringify(JSON.parse(body).sentencias)]); res.writeHead(200); res.end(JSON.stringify(r.rows[0].r)); }
  catch (e) { res.writeHead(400); res.end(JSON.stringify({ message: e.message })); }
}).listen(0);
const env = { DB, SUPABASE_URL: "http://127.0.0.1:" + srv.address().port, SUPABASE_SERVICE_KEY: "k", MIGRACION_CLAVE: "s", LOYVERSE_TOKEN: "x" };
const fetchReal = globalThis.fetch;
globalThis.fetch = async (u, o) => String(u).startsWith("http://127.0.0.1") ? fetchReal(u, o)
  : new Response(JSON.stringify({ stores: [{ id: "st1" }], items: [], categories: [], inventory_levels: [], receipts: [], customers: [], payment_types: [] }));
const pendientes = []; const ctx = { waitUntil: p => { pendientes.push(Promise.resolve(p).catch(() => {})); } };
const esperar = async () => { while (pendientes.length) await pendientes.shift(); };
let n = 0; const ok = m => console.log("ok", ++n, m);

assert.strictEqual(conIdDeD1("INSERT INTO mermas (fecha, sku) VALUES (?,?)", ["f", "S1"], 7).sql, "INSERT INTO mermas (id, fecha, sku) VALUES (?, ?,?)"); ok("al INSERT se le agrega el id que asignó D1");
assert.strictEqual(conIdDeD1("INSERT INTO favoritos (sku) VALUES (?)", ["S1"], 7), null); ok("tablas sin id automático no se tocan");

// 1) copia inicial: ambas iguales
const envCopia = { ...env, DB };
await mig.vaciar(envCopia); let t = mig.TABLAS[0], d = 0; while (t) { const j = await mig.paso(envCopia, t, d); if (j.terminada) { t = j.siguiente; d = 0; } else d = j.desde; } await mig.finalizar(envCopia);
const c0 = await mig.comparar(envCopia);
assert(c0.todoCoincide, JSON.stringify(c0.tablas.filter(x => !x.coincide))); ok("copia inicial igual (" + mig.TABLAS.length + " tablas)");
assert.strictEqual(Number((await c.query("select count(*) n from argomedo455.ventas_diarias")).rows[0].n), 1); ok("la vista ventas_diarias existe en Supabase");

// 2) uso normal de la app (modo D1): varias escrituras + un webhook de ventas
const post = async (action, payload) => { const r = await worker.fetch(new Request("https://x/", { method: "POST", body: JSON.stringify({ action, payload }) }), env, ctx); return r.json(); };
const fallas = [];
for (const [a, p] of [["merma", { sku: "S1", cantidad: 1, motivo: "Vencido", responsable: "Dueña" }], ["lote_nuevo", { sku: "S1", cantidad: 6, fechaVencimiento: "25/10/2026" }],
  ["marcar_pedido_realizado", { items: [{ sku: "S1", barcode: "780001", nombre: "Leche", proveedor: "SOPROLE", cantidad: 6, costoUnitario: 900 }], canal: "whatsapp", fechaLlegadaEstimada: "2026-10-25" }],
  ["marcar_favorito", { sku: "S1" }], ["excluir_riesgo", { sku: "S2" }], ["crear_proveedor", { nombre: "NUEVO 'UNO'" }],
  ["ajustar_stock", { sku: "S1", stockNuevo: 5, responsable: "x" }], ["renombrar_proveedor", { id: 3, nombre: "CCU" }],
  ["registrar_prestamo", { sku: "S1", cantidad: 2, direccion: "presto", sucursal: "Marín 376", responsable: "x" }],
  ["merma", { sku: "S1", cantidad: 2, motivo: "Dañado", responsable: "Rossy" }]]) {
  const j = await post(a, p); if (j.ok === false) fallas.push(a + ": " + j.error);
}
const wh = await (await worker.fetch(new Request("https://x/webhook/loyverse", { method: "POST", body: JSON.stringify({ type: "receipts.update", id: "ev1",
  receipts: [{ receipt_number: "R9", receipt_type: "SALE", created_at: "2026-10-20T15:00:00Z", line_items: [{ variant_id: "v1", item_id: "i1", sku: "S1", quantity: 3, total_money: 3870, cost_total: 2700 }], payments: [{ name: "Efectivo", type: "CASH" }] }] }) }), env, ctx)).json();
await worker.fetch(new Request("https://x/?action=ultima_actualizacion"), env, ctx);
await esperar();
console.log("   acciones con error de negocio (no del espejo):", fallas.length ? fallas.join(" | ") : "ninguna", "· webhook:", JSON.stringify(wh));
const ventasD1 = sq.prepare("select count(*) n from ventas").get().n; assert(ventasD1 >= 2, "el webhook registró la venta"); ok("webhook de ventas procesado (" + ventasD1 + " filas en ventas)");
const cmp = await mig.comparar(envCopia);
assert(cmp.todoCoincide, JSON.stringify(cmp.tablas.filter(x => !x.coincide)) + JSON.stringify(cmp.control.filter(x => !x.coincide)));
ok("D1 y Supabase siguen coincidiendo en todas las tablas");
const idsD1 = sq.prepare("select id, motivo from mermas order by id").all().map(r => r.id + ":" + r.motivo).join(",");
const idsPg = (await c.query("select id, motivo from argomedo455.mermas order by id")).rows.map(r => r.id + ":" + r.motivo).join(",");
assert.strictEqual(idsPg, idsD1); ok("mismos ids en las mermas nuevas: " + idsD1);
const st = sq.prepare("select stock from productos where sku='S1'").get().stock, stPg = (await c.query("select stock from argomedo455.productos where sku='S1'")).rows[0].stock;
assert.strictEqual(Number(stPg), st); ok("stock igual en ambas (" + st + ")");
const pv = (await c.query("select string_agg(nombre, ',' order by id) s from argomedo455.proveedores")).rows[0].s;
assert.strictEqual(pv, sq.prepare("select group_concat(nombre, ',') s from (select nombre from proveedores order by id)").get().s); ok("proveedores iguales (texto con comillas intacto): " + pv);
const ex = (await c.query("select string_agg(sku||':'||proveedor_id, ',' order by sku) s from argomedo455.producto_proveedor_extra")).rows[0].s;
assert.strictEqual(ex, sq.prepare("select group_concat(sku||':'||proveedor_id, ',') s from (select * from producto_proveedor_extra order by sku)").get().s); ok("UPDATE OR IGNORE de proveedores extra igual: " + ex);

// 3) DDL repetido: asegurarTablas() corre en cada webhook, pero sus CREATE ... IF NOT EXISTS se copian una sola vez
const antes = (await (await worker.fetch(new Request("https://x/?action=migrar_espejo&clave=s"), env, ctx)).json()).enviadas;
await worker.fetch(new Request("https://x/webhook/loyverse", { method: "POST", body: JSON.stringify({ type: "otro.evento", id: "ev2" }) }), env, ctx); await esperar();
const despues = (await (await worker.fetch(new Request("https://x/?action=migrar_espejo&clave=s"), env, ctx)).json());
assert(despues.enviadas - antes <= 3, "se copiaron " + (despues.enviadas - antes)); ok("un webhook nuevo copia solo " + (despues.enviadas - antes) + " sentencias (no repite los CREATE)");
assert(despues.activo); assert.strictEqual(despues.errores, 0, despues.ultimoError); ok("estado del espejo: activo, " + despues.enviadas + " sentencias copiadas, 0 errores");

// 4) modo de prueba solo lectura + lectura real desde Supabase
const rp = await worker.fetch(new Request("https://x/?db=supabase", { method: "POST", body: JSON.stringify({ action: "marcar_favorito", payload: { sku: "S2" } }) }), env, ctx);
assert.strictEqual(rp.status, 403); ok("en modo prueba no se puede guardar (solo lectura)");
const dash = await (await worker.fetch(new Request("https://x/?db=supabase"), env, ctx)).json();
assert(dash.ok !== false && JSON.stringify(dash).includes("Leche 1L"), JSON.stringify(dash).slice(0, 300)); ok("el panel completo se lee desde Supabase");
const logsAntes = Number((await c.query("select count(*) n from argomedo455.logs")).rows[0].n);
await worker.fetch(new Request("https://x/?db=supabase&action=sync"), env, ctx); await worker.fetch(new Request("https://x/?db=supabase&action=setup"), env, ctx);
assert.strictEqual(Number((await c.query("select count(*) n from argomedo455.logs")).rows[0].n), logsAntes); ok("en modo prueba las rutas GET que escriben (sync, setup) no tocan Supabase");

// 5) comparación para la app
const rc = await (await worker.fetch(new Request("https://x/?action=espejo_comparar"), env, ctx)).json();
assert(rc.ok && rc.todoCoincide && rc.tablas.length === mig.TABLAS.length && rc.control.length === 5, JSON.stringify(rc).slice(0, 300)); ok("comparación para la app (sin clave): todo coincide, " + rc.tablas.length + " tablas y 5 sumas");
const rc2 = await (await worker.fetch(new Request("https://x/?action=espejo_comparar"), env, ctx)).json();
assert(rc2.enCache); ok("dentro de 60 s responde desde la caché");
const rv = await (await worker.fetch(new Request("https://x/?db=supabase&action=migrar_vaciar&clave=s"), env, ctx)).json();
assert(rv.ok && Number((await c.query("select count(*) n from argomedo455.productos")).rows[0].n) === 0);
let tt = mig.TABLAS[0], dd = 0; while (tt) { const j = await (await worker.fetch(new Request("https://x/?db=supabase&action=migrar_paso&clave=s&tabla=" + tt + "&desde=" + dd), env, ctx)).json(); if (j.terminada) { tt = j.siguiente; dd = 0; } else dd = j.desde; }
await worker.fetch(new Request("https://x/?action=migrar_finalizar&clave=s"), env, ctx);
assert((await mig.comparar(envCopia)).todoCoincide); ok("la copia completa lee siempre de D1, aunque la URL traiga ?db=supabase");
const mm = await (await worker.fetch(new Request("https://x/?action=migrar_mayusculas"), env, ctx)).json();
assert(mm.ok !== false, JSON.stringify(mm)); ok("la acción existente migrar_mayusculas no quedó bloqueada por la clave de migración");
await esperar();
const cmp2 = await mig.comparar(envCopia);
assert(cmp2.todoCoincide, JSON.stringify(cmp2.tablas.filter(x => !x.coincide)));
const ex2 = (await c.query("select string_agg(sku||':'||proveedor_id, ',' order by sku, proveedor_id) s from argomedo455.producto_proveedor_extra")).rows[0].s;
assert.strictEqual(ex2, sq.prepare("select group_concat(sku||':'||proveedor_id, ',') s from (select * from producto_proveedor_extra order by sku, proveedor_id)").get().s);
ok("fusión de proveedores 'soprole' -> 'SOPROLE' (UPDATE OR IGNORE + DELETE) igual en ambas: " + ex2);
console.log("\nTodas las pruebas pasaron:", n); srv.close(); await c.end(); process.exit(0);
