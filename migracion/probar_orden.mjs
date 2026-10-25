// Prueba que las listas salgan en el MISMO orden en D1 (SQLite, byte a byte) y en Supabase (Postgres): ORDER BY por nombre/categoría
// (traductor, COLLATE "C"), ordenar sin importar mayúsculas, y la lista de categorías de la app de etiquetas.
// Uso (necesita Postgres con orden de diccionario, como Supabase, y el módulo pg): node --experimental-sqlite migracion/probar_orden.mjs
import fs from "fs";
import assert from "assert";
import { createRequire } from "module";
import { DatabaseSync } from "node:sqlite";
import { crearDB } from "../pg/d1_compat.js";
import { categoriasEtiquetas, buscarEtiquetas } from "../etiquetas.js";
const { Client } = createRequire(import.meta.url)("pg");

const NOMBRES = ["Biscomund", "BRIKS", "BRESLER", "AZETA HOME SPA", "Cattleya", "CCU", "CAFÉ MAQUINA", "CAROZZI", "ÚTILES ESCOLARES", "Ñandú", "abc", "Abd", "zeta", "Zetb", "Minorista", "MINUTO VERDE", "MIEL", "SIN CATEGORÍA", "PAN CASTAÑO", "PANADERIA", "Tia marcela", "TRENDY"];
const sq = new DatabaseSync(":memory:");
sq.exec(fs.readFileSync("migracion/esquema_d1_real.sql", "utf8"));
const c = new Client(); await c.connect();
// La prueba solo sirve si Postgres ordena como Supabase (diccionario). Con una base en orden "C" daría verde sin probar nada.
if ((await c.query("select 'a' < 'B' as diccionario")).rows[0].diccionario !== true) {
  throw new Error("Esta base de Postgres ordena byte a byte (C): no distingue nada. Crea una con orden de diccionario: " +
    "create database t2 template template0 locale_provider icu icu_locale 'en-US' encoding 'UTF8'  (y usa PGDATABASE=t2)");
}
await c.query("drop schema if exists argomedo455 cascade");
await c.query(fs.readFileSync("migracion/esquema_postgres.sql", "utf8"));
await c.query("set search_path = argomedo455");
NOMBRES.forEach((nom, i) => {
  const cat = i % 5 === 0 ? "" : nom;      // algunas sin categoría
  sq.prepare("INSERT INTO productos(sku,id_loyverse,variant_id,nombre,categoria,costo,precio,stock,track_stock,barcode,sold_by_weight) VALUES (?,?,?,?,?,?,?,?,1,?,0)").run("S" + i, "i" + i, "v" + i, nom, cat, 100, 200 + i, 5, "78" + i);
});
for (const f of sq.prepare("SELECT * FROM productos").all()) {
  await c.query("insert into productos(sku,id_loyverse,variant_id,nombre,categoria,costo,precio,stock,track_stock,barcode,sold_by_weight) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
    [f.sku, f.id_loyverse, f.variant_id, f.nombre, f.categoria, f.costo, f.precio, f.stock, f.track_stock, f.barcode, f.sold_by_weight]);
}
const D1 = { prepare: sql => { const mk = (p = []) => ({ bind: (...a) => mk(a), all: async () => ({ results: sq.prepare(sql).all(...p) }), first: async () => sq.prepare(sql).get(...p) || null }); return mk(); } };
const PG = crearDB({ query: async (text, params) => { const r = await c.query(text, params); return { rows: r.rows, rowCount: r.rowCount }; }, transaccion: async () => { throw new Error("no se usa"); } });
const adaptador = (DB) => ({ todas: async (sql, ...p) => (await DB.prepare(sql).bind(...p).all()).results, uno: async (sql, ...p) => DB.prepare(sql).bind(...p).first() });
let n = 0; const ok = m => console.log("ok", ++n, m);

const consultas = [
  "SELECT nombre FROM productos ORDER BY nombre",
  "SELECT p.nombre FROM productos p ORDER BY p.nombre DESC",
  "SELECT nombre FROM productos ORDER BY nombre COLLATE NOCASE",
  "SELECT categoria, nombre FROM productos WHERE categoria <> '' ORDER BY categoria, nombre LIMIT 10",
  "SELECT sku FROM productos ORDER BY sku",
  "SELECT sku, precio FROM productos ORDER BY precio DESC, sku"
];
for (const sql of consultas) {
  const a = (await D1.prepare(sql).all()).results, b = (await PG.prepare(sql).all()).results;
  assert.deepStrictEqual(b.map(f => Object.values(f).join("|")), a.map(f => Object.values(f).join("|")), "distinto orden: " + sql);
}
ok("6 consultas con ORDER BY por nombre, categoría, sku y precio salen en el mismo orden en D1 y en Supabase");
const cd = await categoriasEtiquetas(adaptador(D1)), cp = await categoriasEtiquetas(adaptador(PG));
assert.deepStrictEqual(cp, cd);
assert.strictEqual(cd.categorias[0][0] <= cd.categorias[1][0], true);
ok("la lista de categorías de la app de etiquetas es idéntica en D1 y en Supabase (" + cd.categorias.length + " categorías, mayúsculas antes que minúsculas)");
const bd = await buscarEtiquetas(adaptador(D1), "a"), bp = await buscarEtiquetas(adaptador(PG), "a");
assert.deepStrictEqual(bp.productos.map(x => x[1] || x.nombre), bd.productos.map(x => x[1] || x.nombre));
ok("la búsqueda de la app de etiquetas devuelve los productos en el mismo orden");
console.log("\n" + n + " pruebas OK");
await c.end();
