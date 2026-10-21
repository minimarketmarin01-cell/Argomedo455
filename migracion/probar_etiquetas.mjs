// Prueba de la app de etiquetas del POS (etiquetas.js) con el servidor real de Argomedo sobre una D1 de prueba (SQLite local).
// Uso: node migracion/probar_etiquetas.mjs
import fs from "fs";
import assert from "assert";
import { DatabaseSync } from "node:sqlite";
import worker from "../worker.js";
const sq = new DatabaseSync(":memory:");
sq.exec(fs.readFileSync("migracion/esquema_d1_real.sql", "utf8"));
const ins = sq.prepare("INSERT INTO productos(sku,id_loyverse,variant_id,nombre,categoria,costo,precio,stock,track_stock,barcode,sold_by_weight,fecha_creacion,imagen_url) VALUES (?,?,?,?,?,?,?,?,1,?,0,'2026-10-01',?)");
for (let i = 0; i < 700; i++) ins.run("S" + i, "i" + i, "v" + i, "Producto de prueba número " + i + " con nombre largo" + (i === 7 ? " Limón" : ""), "CATEGORIA " + (i % 20), 900, 1290, 12, "78" + String(i).padStart(8, "0"), i % 3 === 0 ? "https://api.loyverse.com/image/" + i : "");
ins.run("SC1", "ic", "vc", "Sin categoría de prueba", null, 100, 200, 1, "", "");
const mk = (sql, p = []) => ({ bind: (...a) => mk(sql, a), all: async () => ({ results: sq.prepare(sql).all(...p), meta: {} }), first: async () => sq.prepare(sql).get(...p) || null,
  run: async () => { const r = sq.prepare(sql).run(...p); return { results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; } });
const DB = { prepare: sql => mk(sql), batch: async l => { const o = []; for (const s of l) o.push(await s.run()); return o; } };
sq.exec("INSERT INTO config(clave,valor) VALUES ('store_id','st1')");
const REALTIME_HUB = { idFromName: () => "g", get: () => ({ fetch: async () => new Response("") }) };
const env = { DB, LOYVERSE_TOKEN: "x", REALTIME_HUB };   // sin secretos de Supabase: sin espejo
globalThis.fetch = async () => new Response(JSON.stringify({ stores: [{ id: "st1" }], items: [], categories: [], inventory_levels: [], receipts: [], customers: [] }));
const pend = []; const ctx = { waitUntil: p => pend.push(Promise.resolve(p).catch(() => {})) };
const esperar = async () => { while (pend.length) await pend.shift(); };
const get = async q => { const r = await worker.fetch(new Request("https://x/?app=etiquetas&" + q), env, ctx); const t = await r.text(); await esperar(); return { st: r.status, t, bytes: new TextEncoder().encode(t).length, j: JSON.parse(t) }; };
const cats = a => "cats=" + encodeURIComponent(JSON.stringify(a));
let n = 0; const ok = m => console.log("ok", ++n, m);

// 1. catálogo completo
const full = await get("action=catalogo_etiquetas");
assert.strictEqual(full.st, 200); assert.strictEqual(Object.keys(full.j)[0], "lite");
assert.strictEqual(full.j.completo, true); assert.strictEqual(full.j.productos.length, 701); assert(Number.isInteger(full.j.cursor));
assert.deepStrictEqual(full.j.productos[0].length, 7);
const s0 = full.j.productos.find(r => r[0] === "S0"); assert.deepStrictEqual(s0, ["S0", "Producto de prueba número 0 con nombre largo", 1290, "7800000000", "CATEGORIA 0", "https://api.loyverse.com/image/0", 900]);
assert.strictEqual(full.j.productos.find(r => r[0] === "SC1")[4], "SIN CATEGORÍA");
ok("catálogo completo: 701 productos, 'lite' como primera clave, filas [sku,nombre,precio,código,categoría,foto,costo] (" + full.bytes + " bytes)");
const cur = full.j.cursor;

// 2. solo las categorías elegidas
const dos = await get("action=catalogo_etiquetas&" + cats(["CATEGORIA 3", "CATEGORIA 4"]));
assert.strictEqual(dos.j.productos.length, 70); assert(dos.j.productos.every(r => r[4] === "CATEGORIA 3" || r[4] === "CATEGORIA 4"));
const sc = await get("action=catalogo_etiquetas&" + cats(["SIN CATEGORÍA"])); assert.strictEqual(sc.j.productos.length, 1);
ok("con 2 categorías elegidas baja 70 productos (" + dos.bytes + " bytes, " + Math.round(100 * dos.bytes / full.bytes) + " % del completo); 'SIN CATEGORÍA' también se puede elegir");

// 3. sin cambios: casi nada
const igual = await get("action=catalogo_etiquetas&desde=" + cur + "&" + cats(["CATEGORIA 3", "CATEGORIA 4"]));
assert.strictEqual(igual.j.completo, false); assert.deepStrictEqual(igual.j.productos, []); assert.deepStrictEqual(igual.j.borrados, []); assert(igual.bytes < 200, igual.bytes);
ok("sin cambios desde el último número: " + igual.bytes + " bytes");

// 4. un cambio de precio en una categoría elegida / no elegida
sq.exec("UPDATE productos SET precio = 1590 WHERE sku = 'S3'");   // CATEGORIA 3
sq.exec("UPDATE productos SET precio = 1590 WHERE sku = 'S5'");   // CATEGORIA 5
const d1 = await get("action=catalogo_etiquetas&desde=" + cur + "&" + cats(["CATEGORIA 3", "CATEGORIA 4"]));
assert.strictEqual(d1.j.completo, false); assert.strictEqual(d1.j.productos.length, 1); assert.strictEqual(d1.j.productos[0][0], "S3"); assert.strictEqual(d1.j.productos[0][2], 1590);
assert.deepStrictEqual(d1.j.borrados, ["S5"]); assert(d1.j.cursor > cur);
ok("cambió el precio de S3 (elegida) → viene la fila; S5 (no elegida) → solo aparece en 'borrados' (" + d1.bytes + " bytes)");
const cur2 = d1.j.cursor;

// 5. de una categoría elegida a otra: se borra; borrado de verdad: se borra; stock: llega la fila (el registro también anota el stock)
sq.exec("UPDATE productos SET categoria = 'CATEGORIA 9' WHERE sku = 'S4'");
sq.exec("DELETE FROM productos WHERE sku = 'S23'");   // CATEGORIA 3
sq.exec("UPDATE productos SET stock = 99 WHERE sku = 'S43'");   // CATEGORIA 3
const d2 = await get("action=catalogo_etiquetas&desde=" + cur2 + "&" + cats(["CATEGORIA 3", "CATEGORIA 4"]));
assert(d2.j.borrados.includes("S4") && d2.j.borrados.includes("S23"), JSON.stringify(d2.j.borrados));
assert(d2.j.productos.some(r => r[0] === "S43"));
ok("cambió de categoría (S4) y se borró (S23) → 'borrados'; cambio de stock (S43) → llega la fila igual (la app la compara y la ignora)");

// 6. cursor desconocido o muy viejo → completo
const raro = await get("action=catalogo_etiquetas&desde=999999&" + cats(["CATEGORIA 3"]));
assert.strictEqual(raro.j.completo, true); assert.strictEqual(raro.j.productos.length, 34);   // 35 menos el borrado S23
const sin = await get("action=catalogo_etiquetas&desde=abc"); assert.strictEqual(sin.j.completo, true);
ok("cursor desconocido o inválido → manda completo (solo de las categorías pedidas)");

// 7. lista de categorías
const lc = await get("action=categorias_etiquetas");
assert.strictEqual(lc.j.categorias.length, 21); assert.deepStrictEqual(lc.j.categorias.find(c => c[0] === "CATEGORIA 1"), ["CATEGORIA 1", 35]); assert(lc.j.categorias.some(c => c[0] === "SIN CATEGORÍA"));
ok("categorias_etiquetas: 21 categorías con su cantidad (" + lc.bytes + " bytes)");

// 8. búsqueda a pedido (todas las categorías, sin importar acentos ni mayúsculas)
const b1 = await get("action=buscar_etiquetas&q=" + encodeURIComponent("LIMON"));
assert(b1.j.productos.some(r => r[0] === "S7"), JSON.stringify(b1.j.productos.map(r => r[0])));
const b2 = await get("action=buscar_etiquetas&q=" + encodeURIComponent("numero 15 con")); assert(b2.j.productos.some(r => r[0] === "S15"));
const b3 = await get("action=buscar_etiquetas&q=7800000042"); assert.strictEqual(b3.j.productos[0][0], "S42");
const b4 = await get("action=buscar_etiquetas&q=S99"); assert.strictEqual(b4.j.productos[0][0], "S99");
const b5 = await get("action=buscar_etiquetas&q=" + encodeURIComponent("zzzz inexistente")); assert.deepStrictEqual(b5.j.productos, []);
const b6 = await get("action=buscar_etiquetas&q=%25"); assert.deepStrictEqual(b6.j.productos, []);
const b7 = await get("action=buscar_etiquetas&q=" + encodeURIComponent("prueba")); assert(b7.j.productos.length <= 40);
ok("buscar_etiquetas: «LIMON» encuentra «Limón», varias palabras, código exacto, SKU exacto, sin resultados y máximo 40 (" + b7.bytes + " bytes)");

// 9. ficha corta
sq.exec("INSERT INTO vencimientos(fecha_ingreso,sku,producto,fecha_vencimiento,estado,prioridad) VALUES ('05/10/2026','S1','x','30/10/2026','Pendiente','🟢'),('01/10/2026','S1','x','25/10/2026','Revisado','🔴'),('20/09/2026','S1','x','15/10/2026',NULL,'🟡'),('01/11/2026','S1','x','01/12/2026','Pendiente','🟢')");
const f = await get("action=ficha_etiqueta&sku=S1");
assert.strictEqual(f.j.ok, true); assert.strictEqual(f.j.ficha.producto.precio, 1290); assert.strictEqual(f.j.ficha.producto.costo, 900); assert.strictEqual(f.j.ficha.producto.barcode, "7800000001");
assert.deepStrictEqual(f.j.ficha.lotes.map(l => l.fechaVencimiento), ["15/10/2026", "30/10/2026", "01/12/2026"]);   // 🟡 antes que 🟢; el 'Revisado' no sale
const fv = await get("action=ficha_etiqueta&sku=NOEXISTE"); assert.strictEqual(fv.j.ok, false); const fs0 = await get("action=ficha_etiqueta"); assert.strictEqual(fs0.st, 400);
const completa = await get("action=ficha_producto&sku=S1");
assert(f.bytes < completa.bytes, f.bytes + " vs " + completa.bytes);   // en producción la ficha completa trae decenas de movimientos y ventas: pesa mucho más
ok("ficha_etiqueta: precio, costo, código y lotes (sin el 'Revisado', el más urgente primero, como ficha_producto de Argomedo): " + f.bytes + " bytes contra " + completa.bytes + " de la ficha completa");

// 10. todo se cuenta como app 'etiquetas'
const u = sq.prepare("select accion, n from uso_diario where app = 'etiquetas' order by accion").all();
assert(u.some(x => x.accion === "catalogo_etiquetas") && u.some(x => x.accion === "ficha_etiqueta") && u.some(x => x.accion === "buscar_etiquetas"));
ok("el uso quedó anotado como app 'etiquetas': " + u.map(x => x.accion + " ×" + x.n).join(", "));
console.log("\nTodas las pruebas pasaron:", n); process.exit(0);
