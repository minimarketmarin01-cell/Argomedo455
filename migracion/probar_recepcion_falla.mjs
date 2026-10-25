// Prueba: si Loyverse rechaza el ajuste de stock al recibir mercadería, el lote recién creado se quita (para repetir la
// recepción limpia), y si Loyverse funciona (también tras reintentos) el lote se queda y el stock se suma.
import fs from "fs";
import assert from "assert";
import { DatabaseSync } from "node:sqlite";
import worker from "../worker.js";
const sq = new DatabaseSync(":memory:");
sq.exec(fs.readFileSync("migracion/esquema_d1_real.sql", "utf8"));
sq.exec("INSERT INTO productos(sku,id_loyverse,variant_id,nombre,categoria,proveedor,costo,precio,stock,track_stock,barcode,sold_by_weight) VALUES ('A','ia','va','Agua','CAT','P',500,750,-1,1,'1',0)");
sq.exec("INSERT INTO config(clave,valor) VALUES ('store_id','st1')");
const mk = (sql, p = []) => ({ bind: (...a) => mk(sql, a), all: async () => ({ results: sq.prepare(sql).all(...p), meta: {} }), first: async () => sq.prepare(sql).get(...p) || null,
  run: async () => { const r = sq.prepare(sql).run(...p); return { results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; } });
const DB = { prepare: sql => mk(sql), batch: async l => { const o = []; for (const s of l) o.push(await s.run()); return o; } };
const env = { DB, LOYVERSE_API_TOKEN: "x" };
const pend = []; const ctx = { waitUntil: p => pend.push(Promise.resolve(p).catch(() => {})) };
let modo = "ok", postInv = 0;
const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st });
globalThis.setTimeout = ((f, ms) => { f(); return 0; });   // sin esperas reales entre reintentos
globalThis.fetch = async (url, o) => {
  url = String(url);
  if (url.includes("/inventory") && (!o || o.method !== "POST")) return J({ inventory_levels: [{ variant_id: "va", in_stock: -1 }] });
  if (url.includes("/inventory")) { postInv++; return modo === "ok" || (modo === "una_falla" && postInv > 1) ? J({}) : J({ errors: [{ code: "INTERNAL_ERROR" }] }, 500); }
  if (url.includes("/stores")) return J({ stores: [{ id: "st1" }] });
  return J({});
};
const post = async b => { const r = await worker.fetch(new Request("https://x/", { method: "POST", body: JSON.stringify(b) }), env, ctx); const j = await r.json(); while (pend.length) await pend.shift(); return j; };
const lotes = () => sq.prepare("SELECT * FROM vencimientos WHERE sku='A'").all();
let n = 0; const ok = m => console.log("ok", ++n, m);

modo = "falla"; postInv = 0;
let j = await post({ action: "lote_nuevo", payload: { sku: "A", cantidad: 24 } });
assert.strictEqual(postInv, 3, "intentos: " + postInv);
assert.strictEqual(lotes().length, 0, "no debe quedar lote");
assert(j.fila && j.fila.loteRevertido && /NO quedó guardada/.test(j.fila.avisoStock), JSON.stringify(j).slice(0, 300));
ok("Loyverse da 500 las 3 veces: se reintentó 3 veces, el lote se quitó y el aviso dice que se repita por Recepción");
modo = "una_falla"; postInv = 0;
j = await post({ action: "lote_nuevo", payload: { sku: "A", cantidad: 24 } });
assert.strictEqual(postInv, 2);
assert.strictEqual(lotes().length, 1);
assert.strictEqual(sq.prepare("SELECT stock FROM productos WHERE sku='A'").get().stock, 24);
assert(!j.fila.avisoStock && !j.fila.loteRevertido, JSON.stringify(j.fila));
ok("Loyverse falla una vez y al reintentar funciona: lote guardado, stock -1 → 24, sin aviso");
modo = "falla"; postInv = 0;
j = await post({ action: "lote_nuevo", payload: { sku: "A", cantidad: 6 } });
assert.strictEqual(lotes().length, 1, "el lote anterior debe seguir");
ok("una recepción fallida no toca los lotes que ya existían");
console.log("Todas las pruebas pasaron:", n);
