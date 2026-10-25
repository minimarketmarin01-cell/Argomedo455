// Prueba del cron de cada hora: solo a las 00 y 06 (hora de Chile) toca lo diario; a las 06 recalcula el ABC; sin avisos push.
import fs from "fs";
import assert from "assert";
import { DatabaseSync } from "node:sqlite";
import { mock } from "node:test";
import worker from "../worker.js";
const sq = new DatabaseSync(":memory:");
sq.exec(fs.readFileSync("migracion/esquema_d1_real.sql", "utf8"));
let sqls = [];
const mk = (sql, p = []) => ({ bind: (...a) => mk(sql, a), all: async () => { sqls.push(sql); return { results: sq.prepare(sql).all(...p), meta: {} }; }, first: async () => { sqls.push(sql); return sq.prepare(sql).get(...p) || null; },
  run: async () => { sqls.push(sql); const r = sq.prepare(sql).run(...p); return { results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; } });
const DB = { prepare: sql => mk(sql), batch: async l => { const o = []; for (const s of l) o.push(await s.run()); return o; }, exec: async s => sq.exec(s) };
const env = { DB, LOYVERSE_TOKEN: "x" };
const pend = []; const ctx = { waitUntil: p => pend.push(Promise.resolve(p).catch(() => {})) };
const chileHh = ms => new Intl.DateTimeFormat("en-GB", { timeZone: "America/Santiago", hour: "2-digit", hour12: false }).format(new Date(ms));
// un instante cuya hora en Chile sea la pedida (se recorre un día entero en horas UTC)
const instante = hh => { const base = Date.UTC(2026, 9, 20, 0, 0, 0); for (let h = 0; h < 24; h++) if (chileHh(base + h * 3600000) === hh) return base + h * 3600000; throw new Error("sin hora " + hh); };
const correr = async hh => {
  sqls = [];
  mock.timers.enable({ apis: ["Date"], now: instante(hh) });
  try { await worker.scheduled({}, env, ctx); while (pend.length) await pend.shift(); } finally { mock.timers.reset(); }
  return sqls.slice();
};
let n = 0; const ok = m => console.log("ok", ++n, m);
const tocaAbc = s => s.some(x => /(FROM|INTO|UPDATE)\s+clasificacion_abc/i.test(x));
const tocaVenc = s => s.some(x => /FROM vencimientos/i.test(x));
const tocaVentas = s => s.some(x => /FROM ventas\b/i.test(x));

for (const hh of ["01", "03", "08", "12", "15", "18", "23"]) {
  const s = await correr(hh);
  assert(!tocaAbc(s) && !tocaVenc(s) && !tocaVentas(s), "a las " + hh + " leyó tablas pesadas: " + s.filter(x => /abc|vencimientos|ventas/i.test(x)).slice(0, 2).join(" | "));
}
ok("a las 01, 03, 08, 12, 15, 18 y 23 h el cron no lee ABC, vencimientos ni ventas");
const s00 = await correr("00");
assert(tocaVenc(s00) && !tocaAbc(s00), "a las 00 revisa descuentos vencidos (vencimientos) y no recalcula el ABC");
ok("a las 00 h solo revisa los descuentos vencidos");
const s06 = await correr("06");
assert(tocaAbc(s06) && tocaVenc(s06), "a las 06 recalcula ABC y revisa descuentos vencidos");
ok("a las 06 h recalcula el ABC y revisa los descuentos vencidos");
console.log("\n" + n + " pruebas OK");
