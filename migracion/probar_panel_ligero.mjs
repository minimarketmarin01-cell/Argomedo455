// Prueba del refresco liviano (?action=panel_ligero) y de las dos marcas de cambio en Argomedo, con el servidor real
// sobre una D1 de prueba. Lo clave: última carga completa + refresco liviano = lo mismo que una carga completa nueva.
// Uso: node migracion/probar_panel_ligero.mjs [carpeta donde dejar full1/ligero2/full2.json para la prueba de la app]
import fs from "fs";
import assert from "assert";
import { DatabaseSync } from "node:sqlite";
import worker from "../worker.js";
const sq = new DatabaseSync(":memory:");
sq.exec(fs.readFileSync("migracion/esquema_d1_real.sql", "utf8"));
const dia = ms => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago" }).format(new Date(ms));
const hoy = dia(Date.now()), ayer = dia(Date.now() - 86400000);
const ins = sq.prepare("INSERT INTO productos(sku,id_loyverse,variant_id,nombre,categoria,proveedor,costo,precio,stock,track_stock,barcode,sold_by_weight) VALUES (?,?,?,?,?,?,?,?,?,1,?,0)");
for (let i = 0; i < 400; i++) ins.run("S" + i, "i" + i, "v" + i, "Producto número " + i, "CAT " + (i % 9), "PROV " + (i % 5), 900, 1290, 20, "78" + String(i).padStart(8, "0"));
const vt = sq.prepare("INSERT INTO ventas(receipt_id,sku,cantidad,fecha_venta,venta,utilidad) VALUES (?,?,?,?,?,?)");
for (let i = 0; i < 120; i++) vt.run("A" + i, "S" + i, 2, ayer, 2580, 780);
for (let i = 0; i < 15; i++) vt.run("H" + i, "S" + i, 1, hoy, 1290, 390);
sq.exec("INSERT INTO config(clave,valor) VALUES ('store_id','st1')");
const mk = (sql, p = []) => ({ bind: (...a) => mk(sql, a), all: async () => ({ results: sq.prepare(sql).all(...p), meta: {} }), first: async () => sq.prepare(sql).get(...p) || null,
  run: async () => { const r = sq.prepare(sql).run(...p); return { results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; } });
const DB = { prepare: sql => mk(sql), batch: async l => { const o = []; for (const s of l) o.push(await s.run()); return o; } };
const avisos = [];
const REALTIME_HUB = { idFromName: () => "g", get: () => ({ fetch: async (u, o) => { if (o && o.body) avisos.push(JSON.parse(o.body)); return new Response("ok"); } }) };
const env = { DB, LOYVERSE_TOKEN: "x", REALTIME_HUB };
globalThis.fetch = async () => new Response(JSON.stringify({ stores: [{ id: "st1" }], items: [], categories: [], inventory_levels: [], receipts: [], customers: [] }));
const pend = []; const ctx = { waitUntil: p => pend.push(Promise.resolve(p).catch(() => {})) };
const esperar = async () => { while (pend.length) await pend.shift(); };
const get = async q => { const r = await worker.fetch(new Request("https://x/" + q), env, ctx); const t = await r.text(); await esperar(); return { bytes: new TextEncoder().encode(t).length, j: JSON.parse(t) }; };
const marcas = async () => (await get("?action=ultima_actualizacion")).j;
let n = 0; const ok = m => console.log("ok", ++n, m);
function combinar(base, l) {           // misma combinación que hace la app (index.html: pollLigero)
  const filas = base.items.rows, rows = {};
  Object.keys(l.stock).forEach(k => { rows[k] = filas[k].stock === l.stock[k] ? filas[k] : Object.assign({}, filas[k], { stock: l.stock[k] }); });
  return Object.assign({}, base, { ventasHoy: l.ventasHoy, items: Object.assign({}, base.items, { rows }),
    ventas: Object.assign({}, base.ventas, { rows: Object.assign({}, base.ventas.rows, l.ventas.rows), hoy: l.ventas.hoy }) });
}
const sinHora = j => { const c = JSON.parse(JSON.stringify(j)); delete c.serverTime; delete c.synced; delete c.syncMsg; delete c.version; delete c.cambiosCursor; return c; };

const full1 = await get("");
const l1 = await get("?action=panel_ligero");
assert(l1.j.ok && Object.keys(l1.j.stock).length === 400 && Object.keys(l1.j.ventas.rows).length === 15, JSON.stringify(l1.j).slice(0, 200));
assert.deepStrictEqual(sinHora(combinar(full1.j, l1.j)), sinHora(full1.j));
ok("sin cambios, completa + liviano = la misma completa (liviano " + l1.bytes + " bytes vs completo " + full1.bytes + ", " + Math.round(100 - l1.bytes * 100 / full1.bytes) + "% menos)");
sq.exec(`INSERT INTO ventas(receipt_id,sku,cantidad,fecha_venta,venta,utilidad) VALUES ('H99','S3',2,'${hoy}',2580,780),('H100','S200',4,'${hoy}',5160,1560);
 UPDATE productos SET stock = 17 WHERE sku IN ('S3','S200'); UPDATE productos SET stock = 5 WHERE sku = 'S399';`);
const l2 = await get("?action=panel_ligero");
const full2 = await get("");
assert.deepStrictEqual(sinHora(combinar(full1.j, l2.j)), sinHora(full2.j));
ok("tras ventas y cambios de stock, completa vieja + liviano = completa nueva (stock, resumen de ventas y ventas de hoy)");
if (process.argv[2]) { for (const [k, v] of Object.entries({ full1: full1.j, ligero2: l2.j, full2: full2.j })) fs.writeFileSync(process.argv[2] + "/" + k + ".json", JSON.stringify(v)); }

const wh = async body => { await worker.fetch(new Request("https://x/webhook/loyverse", { method: "POST", body: JSON.stringify(body) }), env, ctx); await esperar(); };
const pausa = () => new Promise(r => setTimeout(r, 5));
const r0 = await worker.fetch(new Request("https://x/", { method: "POST", body: JSON.stringify({ action: "merma", payload: { sku: "S1", cantidad: 1, motivo: "Vencido", responsable: "Dueña" } }) }), env, ctx); await r0.json(); await esperar();
const m0 = await marcas(); assert(m0.versionCompleta, "la versión completa ya existe: " + JSON.stringify(m0));
assert(avisos.at(-1).versionCompleta === m0.versionCompleta && !avisos.at(-1).soloStock); ok("acción de la app: cambia la versión completa y el aviso en vivo pide carga completa");
await pausa(); await wh({ id: "e1", type: "inventory_levels.update", inventory_levels: [{ variant_id: "v5", in_stock: 3, store_id: "st1" }] });
const m1 = await marcas();
assert(m1.actualizadoEn !== m0.actualizadoEn && m1.versionCompleta === m0.versionCompleta, JSON.stringify([m0, m1]));
assert(avisos.at(-1).soloStock === true && !avisos.at(-1).versionCompleta); ok("aviso de stock de Loyverse: solo la marca, y el aviso en vivo dice 'solo stock' → refresco liviano");
await pausa(); await wh({ id: "e2", type: "receipts.update", receipts: [{ receipt_number: "R1", receipt_type: "SALE", created_at: new Date().toISOString(), line_items: [{ variant_id: "v6", sku: "S6", quantity: 1, total_money: 1290, cost_total: 900 }], payments: [] }] });
const m2 = await marcas();
assert(m2.actualizadoEn !== m1.actualizadoEn && m2.versionCompleta === m1.versionCompleta && avisos.at(-1).soloStock === true); ok("venta nueva: solo la marca (refresco liviano)");
await pausa(); await wh({ id: "e3", type: "receipts.update", receipts: [{ receipt_number: "R2", receipt_type: "REFUND", refund_for: "R1", created_at: new Date().toISOString(), line_items: [{ variant_id: "v6", sku: "S6", quantity: 1, total_money: 1290, cost_total: 900 }], payments: [] }] });
const m3 = await marcas();
assert(m3.versionCompleta !== m2.versionCompleta && !avisos.at(-1).soloStock, JSON.stringify([m2, m3])); ok("devolución: carga completa (puede tocar días anteriores)");
console.log("\nTodas las pruebas pasaron:", n); process.exit(0);
