// Prueba del formato columnar (public.ejecutar_sql_col_argomedo) contra un Postgres local: cada consulta debe dar EXACTAMENTE lo mismo que
// ejecutar_sql_argomedo (objetos por fila) una vez rearmada, con menos bytes; las escrituras, RETURNING y transacciones se comportan igual;
// y si la función columnar aún no existe en Supabase (404) se usa la de siempre sin error.
// Uso (necesita Postgres y el módulo pg): node migracion/probar_columnar.mjs
import http from "http";
import fs from "fs";
import assert from "assert";
import { createRequire } from "module";
import { crearDB } from "../pg/d1_compat.js";
import { crearTransporteSupabase } from "../pg/transporte_supabase.js";
const { Client } = createRequire(import.meta.url)("pg");
const quitarPermisos = s => s.replace(/revoke all[^;]*;|grant execute[^;]*;/g, "");

const c = new Client(); await c.connect();
await c.query("drop schema if exists argomedo455 cascade; drop function if exists public.ejecutar_sql_argomedo(jsonb); drop function if exists public.ejecutar_sql_col_argomedo(jsonb)");
await c.query(fs.readFileSync("migracion/esquema_postgres.sql", "utf8"));
await c.query(quitarPermisos(fs.readFileSync("migracion/funcion_ejecutar_sql.sql", "utf8")));
await c.query(quitarPermisos(fs.readFileSync("migracion/funcion_ejecutar_sql_col.sql", "utf8")));
// datos variados: tildes, comillas, nulos, ceros, decimales, textos largos, valores con la misma forma de otras columnas
for (let i = 0; i < 3312; i++) {
  await c.query("insert into argomedo455.productos(sku,id_loyverse,variant_id,nombre,categoria,costo,precio,stock,track_stock,barcode,sold_by_weight,imagen_url) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
    ["S" + i, "id-" + i, "var-" + i, i % 7 === 0 ? "Ñandú 'especial' \"x\" número " + i : "Producto número " + i, "CATEGORÍA " + (i % 11), i % 5 === 0 ? 0 : 900.5 + i, 1290 + i, i % 13 === 0 ? null : (i % 4 === 0 ? -3 : i / 4), i % 2, i % 9 === 0 ? "" : "78" + String(i).padStart(10, "0"), 0, i % 3 === 0 ? "https://api.loyverse.com/img/" + i + ".png" : null]);
}
await c.query("insert into argomedo455.config(clave,valor) values ('a','x'),('b',null)");
const registro = { col: 0, obj: 0, bytesCol: 0, bytesObj: 0, vistas: [] };
const srv = http.createServer(async (req, res) => {
  let body = ""; for await (const ch of req) body += ch;
  const fn = req.url.includes("ejecutar_sql_col_argomedo") ? "ejecutar_sql_col_argomedo" : "ejecutar_sql_argomedo";
  registro.vistas.push(fn);
  if (fn === "ejecutar_sql_col_argomedo" && registro.sinColumnar) { res.writeHead(404, { "content-type": "application/json" }); return res.end(JSON.stringify({ code: "PGRST202", message: "Could not find the function public.ejecutar_sql_col_argomedo(sentencias) in the schema cache" })); }
  try {
    const { sentencias } = JSON.parse(body);
    const r = await c.query("select public." + fn + "($1::jsonb) as r", [JSON.stringify(sentencias)]);
    const txt = JSON.stringify(r.rows[0].r);
    if (fn === "ejecutar_sql_col_argomedo") registro.bytesCol += txt.length; else registro.bytesObj += txt.length;
    res.writeHead(200, { "content-type": "application/json" }); res.end(txt);
  } catch (e) { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ message: e.message })); }
}).listen(0);
const url = "http://127.0.0.1:" + srv.address().port;
const DBobj = crearDB(crearTransporteSupabase({ url, key: "k" }));
const DBcol = crearDB(crearTransporteSupabase({ url, key: "k", columnar: true }));
let n = 0; const ok = m => console.log("ok", ++n, m);

const consultas = [
  ["SELECT * FROM productos ORDER BY sku", []],
  ["SELECT sku, nombre, precio FROM productos WHERE categoria = ? ORDER BY sku", ["CATEGORÍA 3"]],
  ["SELECT COUNT(*) AS n, SUM(stock) AS s, MAX(precio) AS m FROM productos", []],
  ["SELECT sku FROM productos WHERE sku = ?", ["no-existe"]],
  ["SELECT * FROM config ORDER BY clave", []],
  ["SELECT categoria, COUNT(*) AS n FROM productos GROUP BY categoria ORDER BY categoria", []],
  ["SELECT nombre FROM productos WHERE nombre LIKE ? ORDER BY sku LIMIT 20", ["%ñandú%"]],
  ["SELECT 1 AS uno, 'a' AS texto, NULL AS nulo", []]
];
for (const [sql, p] of consultas) {
  const a = await DBobj.prepare(sql).bind(...p).all(), b = await DBcol.prepare(sql).bind(...p).all();
  assert.deepStrictEqual(b.results, a.results, "distinto: " + sql);
  assert.strictEqual(b.meta.changes, a.meta.changes, "cantidad de filas distinta: " + sql);
}
ok("8 consultas (todo el catálogo, filtros, agregados, sin filas, LIKE con ñ, nulos, valores nulos en una tabla chica) dan exactamente lo mismo que el formato por filas");
registro.bytesCol = 0; registro.bytesObj = 0;
await DBobj.prepare("SELECT * FROM productos ORDER BY sku").all();
await DBcol.prepare("SELECT * FROM productos ORDER BY sku").all();
const ahorro = 1 - registro.bytesCol / registro.bytesObj;
assert(ahorro > 0.35, "ahorro menor al esperado: " + ahorro);
ok("el catálogo completo (3.312 productos) pesa " + Math.round(registro.bytesObj / 1024) + " KB por filas y " + Math.round(registro.bytesCol / 1024) + " KB en columnas: −" + Math.round(ahorro * 100) + " %");

// escrituras y RETURNING
let r = await DBcol.prepare("INSERT INTO fiados (cliente_id, receipt_id_loyverse, monto_total, fecha_hora) VALUES (?,?,?,?)").bind("c1", "R-1", 1500.5, "2026-10-20 10:00:00").run();
assert(r.meta.last_row_id >= 1 && r.meta.changes === 1);
let u = await DBcol.prepare("UPDATE productos SET precio = precio + 1 WHERE categoria = ?").bind("CATEGORÍA 3").run();
assert(u.meta.changes > 100);
let d = await DBcol.prepare("DELETE FROM fiados WHERE receipt_id_loyverse = ?").bind("nada").run();
assert.strictEqual(d.meta.changes, 0);
ok("INSERT (last_row_id), UPDATE y DELETE devuelven las mismas cantidades de filas afectadas");
// transacción mezclada, todo o nada
await assert.rejects(DBcol.batch([
  DBcol.prepare("INSERT INTO sectores (nombre) VALUES (?)").bind("X"),
  DBcol.prepare("INSERT INTO fiados (receipt_id_loyverse, monto_total, fecha_hora) VALUES (?,?,?)").bind("R-1", 1, "x")]));
assert.strictEqual((await DBcol.prepare("SELECT COUNT(*) AS n FROM sectores").first()).n, 0);
const lote = await DBcol.batch([DBcol.prepare("INSERT INTO sectores (nombre) VALUES (?)").bind("Y"), DBcol.prepare("SELECT nombre FROM sectores")]);
assert.strictEqual(lote[1].results[0].nombre, "Y");
ok("una transacción con una escritura que falla no deja nada; una buena devuelve sus lecturas");
// un error de SQL se informa igual
await assert.rejects(DBcol.prepare("SELECT * FROM tabla_que_no_existe").all(), /Supabase/);
ok("un error de la base llega como error");

// la función columnar todavía no está en Supabase: se usa la de siempre y se recuerda
registro.vistas.length = 0; registro.sinColumnar = true;
const DBsin = crearDB(crearTransporteSupabase({ url, key: "k", columnar: true }));
const a1 = await DBsin.prepare("SELECT sku FROM productos ORDER BY sku LIMIT 3").all();
const a2 = await DBsin.prepare("SELECT sku FROM productos ORDER BY sku LIMIT 3").all();
assert.deepStrictEqual(a1.results.map(x => x.sku), ["S0", "S1", "S10"]);
assert.deepStrictEqual(registro.vistas, ["ejecutar_sql_col_argomedo", "ejecutar_sql_argomedo", "ejecutar_sql_argomedo"], "debía probar una vez y quedarse con la de siempre: " + registro.vistas);
ok("sin la función columnar en Supabase (404) usa la de siempre, y no vuelve a probar en cada consulta");
console.log("\n" + n + " pruebas OK");
srv.close(); await c.end();
