// Prueba de la regla "producto sin stock -> sus lotes activos se cierran solos" (action=vencimientos y recálculo diario).
import fs from "fs";
import assert from "assert";
import { DatabaseSync } from "node:sqlite";
import worker from "../worker.js";
const sq = new DatabaseSync(":memory:");
sq.exec(fs.readFileSync("migracion/esquema_d1_real.sql", "utf8"));
const ins = sq.prepare("INSERT INTO productos(sku,id_loyverse,variant_id,nombre,categoria,proveedor,costo,precio,stock,track_stock,barcode,sold_by_weight) VALUES (?,?,?,?,?,?,?,?,?,?,?,0)");
ins.run("A", "ia", "va", "Con stock", "CAT", "P", 900, 1290, 10, 1, "1");
ins.run("B", "ib", "vb", "Sin stock", "CAT", "P", 900, 1290, 0, 1, "2");
ins.run("C", "ic", "vc", "Sin control de stock", "CAT", "P", 900, 1290, 0, 0, "3");
ins.run("D", "id", "vd", "Retirado en cero", "CAT", "P", 900, 1290, 0, 1, "4");
const f = d => { const x = new Date(Date.now() + d * 86400000); return String(x.getDate()).padStart(2, "0") + "/" + String(x.getMonth() + 1).padStart(2, "0") + "/" + x.getFullYear(); };
const lote = sq.prepare("INSERT INTO vencimientos(fecha_ingreso,sku,producto,categoria,unidad,lote,cantidad,fecha_vencimiento,estado,prioridad,accion) VALUES ('01/01/2026',?,?,'CAT','un','L',5,?,?,'—','—')");
lote.run("A", "Con stock", f(3), "Por vencer");
lote.run("B", "Sin stock", f(-2), "Vencido");
lote.run("B", "Sin stock", f(10), "Por vencer");
lote.run("C", "Sin control de stock", f(-1), "Vencido");
lote.run("D", "Retirado en cero", f(-1), "Retirado");
const mk = (sql, p = []) => ({ bind: (...a) => mk(sql, a), all: async () => ({ results: sq.prepare(sql).all(...p), meta: {} }), first: async () => sq.prepare(sql).get(...p) || null,
  run: async () => { const r = sq.prepare(sql).run(...p); return { results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; } });
const DB = { prepare: sql => mk(sql), batch: async l => { const o = []; for (const s of l) o.push(await s.run()); return o; } };
const env = { DB, LOYVERSE_TOKEN: "x" };
const pend = []; const ctx = { waitUntil: p => pend.push(Promise.resolve(p).catch(() => {})) };
const get = async q => { const r = await worker.fetch(new Request("https://x/" + q), env, ctx); const j = await r.json(); while (pend.length) await pend.shift(); return j; };
let n = 0; const ok = m => console.log("ok", ++n, m);

const j = await get("?action=vencimientos");
const skus = j.lotes.map(l => l.sku).sort().join("");
assert.strictEqual(skus, "ACD", "quedaron: " + skus);
ok("la lista activa muestra A (con stock), C (sin control de stock) y D (Retirado); B (sin stock) desaparece con sus 2 lotes");
const b = sq.prepare("SELECT estado,motivo_cierre,revisado_por,accion FROM vencimientos WHERE sku='B'").all();
assert(b.length === 2 && b.every(r => r.estado === "Revisado" && r.motivo_cierre === "sin_stock" && r.revisado_por === "sistema"), JSON.stringify(b));
ok("los lotes de B quedaron Revisado, motivo sin_stock, cerrados por el sistema");
assert.strictEqual(sq.prepare("SELECT estado FROM vencimientos WHERE sku='D'").get().estado, "Retirado");
ok("el lote Retirado no se pisó");
// si el stock vuelve a subir, un lote nuevo se ve normal
sq.exec("UPDATE productos SET stock=4 WHERE sku='B'");
lote.run("B", "Sin stock", f(5), "Por vencer");
const j2 = await get("?action=vencimientos");
assert(j2.lotes.some(l => l.sku === "B" && l.estado !== "Revisado"));
ok("con stock otra vez, el lote nuevo de B aparece");
// con filtro de estado explícito no se cierra nada
sq.exec("UPDATE productos SET stock=0 WHERE sku='A'");
const j3 = await get("?action=vencimientos&estado=Por%20vencer");
assert(j3.lotes.some(l => l.sku === "A"));
assert.strictEqual(sq.prepare("SELECT estado FROM vencimientos WHERE sku='A'").get().estado, "Por vencer");
ok("con un filtro de estado explícito no se toca nada");
// recálculo diario
const r = await get("?action=recalcular_vencimientos");
assert.strictEqual(sq.prepare("SELECT estado FROM vencimientos WHERE sku='A'").get().estado, "Revisado");
assert.strictEqual(sq.prepare("SELECT estado FROM vencimientos WHERE sku='C'").get().estado, "Vencido");
ok("el recálculo diario también cierra los lotes de A (ya en 0) y deja C intacto");
console.log("Todas las pruebas pasaron:", n);
