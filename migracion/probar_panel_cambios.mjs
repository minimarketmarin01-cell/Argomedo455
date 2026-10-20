// Prueba del registro de cambios del panel (disparadores + ?action=panel_cambios) con el servidor real sobre una D1 de
// prueba. Lo clave: última carga completa + cambios = lo mismo que una carga completa nueva, para cada tipo de cambio.
// Uso: node migracion/probar_panel_cambios.mjs [carpeta donde dejar los JSON para la prueba de la app]
import fs from "fs";
import assert from "assert";
import { DatabaseSync } from "node:sqlite";
import worker from "../worker.js";
const sq = new DatabaseSync(":memory:");
sq.exec(fs.readFileSync("migracion/esquema_d1_real.sql", "utf8"));
const dia = ms => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago" }).format(new Date(ms));
const hoy = dia(Date.now()), ayer = dia(Date.now() - 86400000), hace3 = dia(Date.now() - 3 * 86400000);
sq.exec("INSERT INTO proveedores(nombre) VALUES ('SOPROLE'),('CCU')");
const ins = sq.prepare("INSERT INTO productos(sku,id_loyverse,variant_id,nombre,categoria,proveedor,costo,precio,stock,track_stock,barcode,sold_by_weight,fecha_creacion,proveedor_id) VALUES (?,?,?,?,?,?,?,?,?,1,?,0,'2026-10-01',?)");
for (let i = 0; i < 300; i++) ins.run("S" + i, "i" + i, "v" + i, "Producto número " + i, "CAT " + (i % 9), "PROV " + (i % 4), 900, 1290, 20, "78" + String(i).padStart(8, "0"), i % 3 ? 1 : null);
const vd = sq.prepare("INSERT INTO ventas(receipt_id,sku,cantidad,fecha_venta,venta,utilidad) VALUES (?,?,?,?,?,?)");
for (let i = 0; i < 100; i++) { vd.run("A" + i, "S" + i, 1.5, hace3, 1935, 585); vd.run("B" + i, "S" + i, 2, ayer, 2580, 780); }
for (let i = 0; i < 12; i++) vd.run("H" + i, "S" + i, 1, hoy, 1290, 390);
sq.exec("INSERT INTO config(clave,valor) VALUES ('store_id','st1'); INSERT INTO pedidos_pendientes(fecha,sku,barcode,producto,nombre,proveedor,cantidad,canal,estado) VALUES ('2026-10-19','S1','7800000001','P1','P1','SOPROLE',6,'whatsapp','confirmado'); INSERT INTO favoritos(sku,agregado_en) VALUES ('S2','x');");
const mk = (sql, p = []) => ({ bind: (...a) => mk(sql, a), all: async () => ({ results: sq.prepare(sql).all(...p), meta: {} }), first: async () => sq.prepare(sql).get(...p) || null,
  run: async () => { const r = sq.prepare(sql).run(...p); return { results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; } });
const DB = { prepare: sql => mk(sql), batch: async l => { const o = []; sq.exec("BEGIN"); try { for (const s of l) o.push(await s.run()); sq.exec("COMMIT"); } catch (e) { sq.exec("ROLLBACK"); throw e; } return o; } };
const env = { DB, LOYVERSE_TOKEN: "x" };
globalThis.fetch = async () => new Response(JSON.stringify({ stores: [{ id: "st1" }], items: [], categories: [], inventory_levels: [], receipts: [], customers: [] }));
const pend = []; const ctx = { waitUntil: p => pend.push(Promise.resolve(p).catch(() => {})) };
const esperar = async () => { while (pend.length) await pend.shift(); };
const get = async q => { const r = await worker.fetch(new Request("https://x/" + q), env, ctx); const t = await r.text(); await esperar(); return { bytes: new TextEncoder().encode(t).length, j: JSON.parse(t) }; };
let n = 0; const ok = m => console.log("ok", ++n, m);
// Misma combinación que hace la app (index.html: pollCambios)
function combinar(base, l) {
  const rows = Object.assign({}, base.items.rows), vrows = Object.assign({}, base.ventas.rows);
  for (const [k, v] of Object.entries(l.items || {})) { if (v === null) delete rows[k]; else rows[k] = v; }
  for (const [k, v] of Object.entries(l.ventas.rows || {})) { if (v === null) delete vrows[k]; else vrows[k] = v; }
  return Object.assign({}, base, l.secciones || {}, { ventasHoy: l.ventasHoy, cambiosCursor: l.cursor,
    items: Object.assign({}, base.items, { rows }), ventas: Object.assign({}, base.ventas, { rows: vrows, hoy: l.ventas.hoy }) });
}
const sinHora = j => { const c = JSON.parse(JSON.stringify(j)); delete c.serverTime; delete c.synced; delete c.syncMsg; delete c.version; return c; };
const ahoraReal = Date.now; let saltoMs = 0; Date.now = () => ahoraReal() + saltoMs;   // para vencer la caché de 10 min del resumen
async function paso(nombre, sql, guardar) {
  const base = (await get("")).j;
  assert(Number.isFinite(base.cambiosCursor), "el panel completo trae el número del registro: " + base.cambiosCursor);
  if (sql) sq.exec(sql);
  saltoMs += 11 * 60000;
  const l = await get("?action=panel_cambios&desde=" + base.cambiosCursor);
  const full = await get("");
  assert(l.j.ok && !l.j.completo, nombre + ": " + JSON.stringify(l.j).slice(0, 200));
  assert.deepStrictEqual(sinHora(combinar(base, l.j)), sinHora(full.j), nombre);
  if (guardar && process.argv[2]) for (const [k, v] of Object.entries({ base, cambios: l.j, full: full.j })) fs.writeFileSync(process.argv[2] + "/" + guardar + "_" + k + ".json", JSON.stringify(v));
  ok(nombre + " → completa vieja + cambios = completa nueva (cambios " + l.bytes + " bytes vs completo " + full.bytes + ")");
  return l.j;
}
await get("");   // crea el registro de cambios (disparadores)
const c0 = await paso("sin cambios", null);
assert.deepStrictEqual(Object.keys(c0.items), []); assert.deepStrictEqual(c0.secciones, {});
const c1 = await paso("venta de hoy + stock", `INSERT INTO ventas(receipt_id,sku,cantidad,fecha_venta,venta,utilidad) VALUES ('H90','S3',2,'${hoy}',2580,780),('H91','S200',4,'${hoy}',5160,1560);
  UPDATE productos SET stock = 17 WHERE sku IN ('S3','S200');`, "venta");
assert.deepStrictEqual(Object.keys(c1.items).sort(), ["S200", "S3"]); assert.deepStrictEqual(c1.secciones, {});
await paso("edición de precio y nombre", "UPDATE productos SET precio = 1490, nombre = 'Leche ''nueva''' WHERE sku = 'S5'", "edicion");
await paso("producto nuevo y producto eliminado", "INSERT INTO productos(sku,id_loyverse,variant_id,nombre,categoria,proveedor,costo,precio,stock,track_stock,barcode,sold_by_weight) VALUES ('N1','in','vn','Nuevo','CAT 1','PROV 1',100,200,5,1,'',0); DELETE FROM productos WHERE sku = 'S299';");
const c4 = await paso("pedido pendiente, favorito y proveedor extra", "INSERT INTO pedidos_pendientes(fecha,sku,barcode,producto,nombre,proveedor,cantidad,canal,estado) VALUES ('2026-10-20','S7','7800000007','P7','P7','CCU',12,'whatsapp','confirmado'); DELETE FROM favoritos WHERE sku = 'S2'; INSERT INTO producto_proveedor_extra(sku,proveedor_id) VALUES ('S4',2);", "secciones");
assert(c4.secciones.pendientes && c4.secciones.favoritos && c4.secciones.provsIdsExtra && !c4.secciones.multiplos);
await paso("mínimo de pedido y riesgo", "INSERT INTO config_multiplo_producto(sku,multiplo,empaque,palabra) VALUES ('S8',6,12,'caja'); INSERT INTO riesgo_excluidos(sku,fecha) VALUES ('S9','x');");
await paso("devolución de un día anterior", `UPDATE ventas SET cantidad = 0.5, venta = 645 WHERE fecha_venta = '${ayer}' AND sku = 'S40'; DELETE FROM ventas WHERE fecha_venta = '${hace3}' AND sku = 'S41';`);
await paso("guardado sin cambios reales (no anota)", "UPDATE productos SET precio = precio, stock = stock WHERE sku LIKE 'S1%'");
const vAntes = sq.prepare("SELECT v FROM panel_version").get().v; sq.exec("UPDATE productos SET nombre = nombre"); assert.strictEqual(sq.prepare("SELECT v FROM panel_version").get().v, vAntes); ok("una escritura que no cambia nada no suma al registro");
// El sync automático de la app (?action=sync&desde=N) sincroniza con Loyverse y responde solo los cambios
{ const base = (await get("")).j; sq.exec("UPDATE productos SET stock = 3 WHERE sku = 'S11'");
  const r = await get("?action=sync&desde=" + base.cambiosCursor);
  assert(r.j.ok && !r.j.completo && r.j.synced === true && r.j.items.S11 && r.j.items.S11.stock === 3 && r.bytes < 5000, JSON.stringify(r.j).slice(0, 300));
  ok("sync automático con número: sincroniza y responde solo los cambios (" + r.bytes + " bytes)");
  const sinNum = await get("?action=sync"); assert(sinNum.j.items && sinNum.j.items.rows); ok("sync sin número (botón manual): panel completo como siempre"); }
// Casos que piden carga completa
const base = (await get("")).j;
sq.exec("UPDATE proveedores SET nombre = 'SOPROLE SA' WHERE id = 1");
assert((await get("?action=panel_cambios&desde=" + base.cambiosCursor)).j.completo); ok("si cambia un proveedor (su nombre va en cada producto) pide carga completa");
assert((await get("?action=panel_cambios&desde=999999")).j.completo); ok("número desconocido: carga completa");
assert((await get("?action=panel_cambios")).j.completo); ok("sin número: carga completa");
const tam = sq.prepare("SELECT COUNT(*) n FROM panel_cambios").get().n; assert(tam < 330, "el registro no crece: " + tam); ok("el registro guarda una fila por clave (" + tam + " filas, no crece con cada cambio)");
console.log("\nTodas las pruebas pasaron:", n); process.exit(0);
