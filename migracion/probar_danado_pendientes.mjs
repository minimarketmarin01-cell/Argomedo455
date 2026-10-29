// Prueba: Merma por "dañado" / "cambio con proveedor" de un proveedor que hace cambio (Ideal, Pan Castaño, San Jorge) va a Pendientes
// (lote Retirado + stock descontado, sin fila de merma); el resto de proveedores y motivos siguen siendo merma normal.
import fs from "fs";
import assert from "assert";
import { DatabaseSync } from "node:sqlite";
import worker from "../worker.js";
const sq = new DatabaseSync(":memory:");
sq.exec(fs.readFileSync("migracion/esquema_d1_real.sql", "utf8"));
const ins = sq.prepare("INSERT INTO productos(sku,id_loyverse,variant_id,nombre,categoria,costo,precio,stock,track_stock,barcode,sold_by_weight) VALUES (?,?,?,?,?,?,?,?,1,?,0)");
ins.run("C1", "i1", "v1", "Hamburguesa 4und", "PAN CASTAÑO", 600, 1500, 6, "1");
sq.exec("INSERT INTO config(clave,valor) VALUES ('store_id','st1')");
ins.run("K1", "i2", "v2", "Coca 2L", "COCA COLA", 1200, 2000, 10, "2");
sq.exec("INSERT OR REPLACE INTO config_vida_util(categoria,dias_alerta,tipo,nota) VALUES ('IDEAL',15,'cambio',''),('PAN CASTAÑO',15,'cambio',''),('SAN JORGE',7,'cambio','')");
const mk = (sql, p = []) => ({ bind: (...a) => mk(sql, a), all: async () => ({ results: sq.prepare(sql).all(...p), meta: {} }), first: async () => sq.prepare(sql).get(...p) || null,
  run: async () => { const r = sq.prepare(sql).run(...p); return { results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; } });
const env = { DB: { prepare: sql => mk(sql), batch: async l => { const o = []; for (const s of l) o.push(await s.run()); return o; } }, LOYVERSE_API_TOKEN: "x" };
const ctx = { waitUntil: p => p };
const stockLoy = { v1: 6, v2: 10 };
globalThis.fetch = async (url, o) => {
  url = String(url);
  const J = (x, st = 200) => new Response(JSON.stringify(x), { status: st });
  if (url.includes("/inventory") && (!o || o.method !== "POST")) { const v = new URL(url).searchParams.get("variant_ids"); return J({ inventory_levels: [{ variant_id: v, in_stock: stockLoy[v] }] }); }
  if (url.includes("/inventory")) { JSON.parse(o.body).inventory_levels.forEach(l => { stockLoy[l.variant_id] = l.stock_after; }); return J({}); }
  return J({});
};
const post = async (action, payload) => { const r = await worker.fetch(new Request("https://x/", { method: "POST", body: JSON.stringify({ action, payload }) }), env, ctx); return r.json(); };
const lotes = sku => sq.prepare("SELECT estado,cantidad,fecha_vencimiento,accion FROM vencimientos WHERE sku=?").all(sku);
const mermas = sku => sq.prepare("SELECT motivo,cantidad FROM mermas WHERE sku=?").all(sku);
let n = 0; const ok = m => console.log("ok", ++n, m);

let j = await post("merma_lote", { items: [{ sku: "C1", cantidad: 2 }], motivo: "dañado", responsable: "Rossy" });
assert(j.ok && j.resumen.aPendientes === 1 && j.filas[0].aPendientes, JSON.stringify(j).slice(0, 300));
assert.strictEqual(lotes("C1").length, 1); assert.strictEqual(lotes("C1")[0].estado, "Retirado"); assert.strictEqual(lotes("C1")[0].cantidad, 2);
assert.strictEqual(mermas("C1").length, 0); assert.strictEqual(stockLoy.v1, 4);
ok("dañado de Pan Castaño: lote Retirado de 2 u (Pendientes), sin merma, stock 6 → 4");
j = await post("merma_lote", { items: [{ sku: "C1", cantidad: 1 }], motivo: "cambio_proveedor", responsable: "Rossy" });
assert(j.resumen.aPendientes === 1 && stockLoy.v1 === 3 && mermas("C1").length === 0); ok("'cambio con proveedor' también va a Pendientes");
j = await post("merma_lote", { items: [{ sku: "C1", cantidad: 1 }], motivo: "robo", responsable: "Rossy" }); 
assert(j.resumen.aPendientes === 0 && mermas("C1").length === 1 && stockLoy.v1 === 2); ok("robo de Pan Castaño sigue siendo merma normal");
j = await post("merma_lote", { items: [{ sku: "K1", cantidad: 3 }], motivo: "dañado", responsable: "Rossy" });
assert(j.resumen.aPendientes === 0 && mermas("K1").length === 1 && lotes("K1").length === 0 && stockLoy.v2 === 7); ok("dañado de un proveedor sin cambio (Coca) sigue siendo merma normal");
j = await post("merma_lote", { items: [{ sku: "K1", cantidad: 1 }, { sku: "C1", cantidad: 1 }], motivo: "dañado", responsable: "Rossy" });
assert(j.resumen.n === 2 && j.resumen.aPendientes === 1 && mermas("K1").length === 2 && lotes("C1").length === 3); ok("carrito mixto: Coca a merma y Castaño a Pendientes en el mismo guardado");

// --- Elegir de qué lote salen las dañadas ---
stockLoy.v1 = 10;
const insL = sq.prepare("INSERT INTO vencimientos(fecha_ingreso,sku,producto,categoria,unidad,lote,cantidad,fecha_vencimiento,estado) VALUES (?,?,?,?,?,?,?,?,?)");
const idA = Number(insL.run("01/11/2026", "C1", "Hamburguesa 4und", "PAN CASTAÑO", "un", "", 5, "12/11/2026", "Vigente").lastInsertRowid);
const idB = Number(insL.run("02/11/2026", "C1", "Hamburguesa 4und", "PAN CASTAÑO", "un", "", 3, "05/11/2026", "Vigente").lastInsertRowid);
let g = await (await worker.fetch(new Request("https://x/?action=lotes_abiertos&sku=C1"), env, ctx)).json();
assert(g.ok && g.lotes.length >= 2 && g.lotes[0].filaIndex === idB && g.lotes.some(l => l.filaIndex === idA)); ok("lotes_abiertos lista los lotes abiertos (más nuevo primero)");
const antes = lotes("C1").length;
j = await post("merma_lote", { items: [{ sku: "C1", cantidad: 2, loteId: idA }], motivo: "dañado", responsable: "Rossy" });
assert(j.ok && j.filas[0].loteDescontado === idA && stockLoy.v1 === 8, JSON.stringify(j).slice(0, 300));
const a = sq.prepare("SELECT estado,cantidad FROM vencimientos WHERE id=?").get(idA);
assert.strictEqual(a.estado, "Retirado"); assert.strictEqual(a.cantidad, 2);
assert.strictEqual(lotes("C1").length, antes + 1);
assert(sq.prepare("SELECT 1 FROM vencimientos WHERE sku='C1' AND estado='Vigente' AND cantidad=3 AND fecha_vencimiento='12/11/2026'").get());
ok("loteId: 2 u salen del lote A (queda Retirado de 2 y Vigente de 3), stock 10 → 8");
j = await post("merma_lote", { items: [{ sku: "C1", cantidad: 5, loteId: idB }], motivo: "dañado", responsable: "Rossy" });
assert(j.ok && stockLoy.v1 === 3 && sq.prepare("SELECT estado,cantidad FROM vencimientos WHERE id=?").get(idB).estado === "Retirado"); ok("más dañadas que el lote: 3 del lote B + 2 aparte, stock 8 → 3");
j = await post("merma_lote", { items: [{ sku: "C1", cantidad: 1, loteId: 99999 }], motivo: "dañado", responsable: "Rossy" });
assert(j.ok && j.resumen.aPendientes === 1 && stockLoy.v1 === 2); ok("lote inexistente: cae al lote nuevo en Pendientes");
console.log("Todas las pruebas pasaron:", n);
