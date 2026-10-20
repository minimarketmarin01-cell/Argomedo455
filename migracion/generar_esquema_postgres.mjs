// Genera migracion/esquema_postgres.sql a partir del esquema real de D1 (esquema_d1_real.sql)
// usando el mismo traductor que usa el servidor. Uso: node migracion/generar_esquema_postgres.mjs
import fs from "fs";
import { traducirSql } from "../pg/traductor.js";
const entrada = fs.readFileSync("migracion/esquema_d1_real.sql", "utf8");
const sentencias = entrada.split(/;\s*\n/).map(s => s.trim()).filter(Boolean);
const salida = ["-- Esquema de Argomedo 455 para Supabase (generado desde D1). Ejecutar en el SQL Editor del proyecto.",
  "create schema if not exists argomedo455;", "set search_path = argomedo455;", ""];
for (const s of sentencias) salida.push(traducirSql(s).text.replace(/^CREATE TABLE /, "CREATE TABLE IF NOT EXISTS ").replace(/^CREATE INDEX /, "CREATE INDEX IF NOT EXISTS ").replace(/^CREATE VIEW /, "CREATE OR REPLACE VIEW ") + ";");
salida.push("");
fs.writeFileSync("migracion/esquema_postgres.sql", salida.join("\n"));
console.log("sentencias:", sentencias.length);
