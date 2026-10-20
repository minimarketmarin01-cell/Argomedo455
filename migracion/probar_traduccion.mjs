// Prueba el traductor contra TODAS las consultas SQL reales de worker.js.
// Uso: NODE_PATH=<carpeta con pg y acorn> node migracion/probar_traduccion.mjs
// Necesita un Postgres local (PGHOST/PGUSER/PGDATABASE). Crea el esquema aproximado desde schema_d1.sql
// + los CREATE/ALTER del propio código y hace PREPARE de cada consulta traducida (valida tablas y columnas).
import { execSync } from "child_process";
import fs from "fs";
import { createRequire } from "module";
import { traducirSql } from "../pg/traductor.js";
const require = createRequire(import.meta.url);
const { Client } = require("pg");

execSync("node migracion/extrae_sql.mjs worker.js /tmp/sql_arg.json", { stdio: "inherit" });
const todas = JSON.parse(fs.readFileSync("/tmp/sql_arg.json", "utf8"));
const limpia = s => s.replace(/\{\{[^}]*\}\}/g, "?");

const c = new Client(); await c.connect();
await c.query("drop schema if exists argomedo455 cascade");
await c.query(fs.readFileSync("migracion/esquema_postgres.sql", "utf8"));  // esquema REAL de D1, ya traducido
await c.query("set search_path = argomedo455");
console.log("tablas creadas desde el esquema real");
// 3) PREPARE de cada consulta
let ok = 0; const malas = [];
for (const x of todas) {
  if (/^\s*(CREATE|ALTER|PRAGMA)/i.test(x.sql) || /sqlite_master/i.test(x.sql)) continue;
  let t; try { t = traducirSql(limpia(x.sql)).text; } catch (e) { malas.push({ line: x.line, err: "traductor: " + e.message }); continue; }
  try { await c.query("PREPARE s AS " + t); await c.query("DEALLOCATE s"); ok++; }
  catch (e) { malas.push({ line: x.line, err: e.message, sql: t.replace(/\s+/g, " ").slice(0, 160) }); try { await c.query("DEALLOCATE s"); } catch {} }
}
console.log("consultas OK:", ok, " con problema:", malas.length);
malas.forEach(m => console.log("L" + m.line + ": " + m.err + (m.sql ? "\n     " + m.sql : "")));
await c.end();
