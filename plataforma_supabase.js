// Corre el mismo servidor del Worker dentro de una Edge Function de Supabase (Deno), sin Cloudflare.
//  - env.DB: la misma interfaz de D1 (crearDB) sobre Postgres, por conexión directa (SUPABASE_DB_URL) a las funciones
//    public.ejecutar_sql_* que ya usaba el modo ?db=supabase: mismos resultados, sin pasar por la API REST.
//  - Secretos: se leen de Supabase Vault (nombres "<prefijo>__<SECRETO>"), una vez por instancia.
//  - Tareas programadas: pg_cron llama POST /__cron con la cabecera x-cron-clave (secreto CRON_CLAVE).
//  - Respuestas JSON comprimidas con gzip cuando el navegador lo acepta (cuida la cuota de 5 GB de salida).
import postgres from "npm:postgres@3.4.5";
import { crearDB } from "./pg/d1_compat.js";
import { incrustar, expandirColumnar } from "./pg/transporte_supabase.js";

let _sql = null;
export function conexion() {
  if (!_sql) _sql = postgres(Deno.env.get("SUPABASE_DB_URL"), { prepare: false, max: 3, idle_timeout: 20, connect_timeout: 15 });
  return _sql;
}

// funcion: "ejecutar_sql_col" (Marín), "ejecutar_sql_col_argomedo", "ejecutar_sql_rossy"...
export function transporteDirecto(funcion) {
  const columnar = /_col(_|$)/.test(funcion);
  async function rpc(sentencias) {
    const filas = await conexion().unsafe("select public." + funcion + "($1::jsonb) as r", [conexion().json(sentencias)]);
    let r = filas[0].r;
    if (typeof r === "string") r = JSON.parse(r);
    return columnar ? r.map(expandirColumnar) : r;
  }
  return {
    async query(text, params) { const [res] = await rpc([incrustar(text, params)]); return res; },
    async transaccion(lista) { return rpc(lista.map(s => incrustar(s.text, s.params))); }
  };
}

export async function leerSecretos(prefijo) {
  const filas = await conexion().unsafe("select name, decrypted_secret from vault.decrypted_secrets where name like $1", [prefijo + "\\_\\_%"]);
  const out = {};
  for (const f of filas) out[f.name.slice(prefijo.length + 2)] = f.decrypted_secret;
  return out;
}

function comprimir(res, req) {
  const tipo = res.headers.get("content-type") || "";
  if (!res.body || res.headers.get("content-encoding") || !/json|text|javascript/.test(tipo)) return res;
  if (!/\bgzip\b/.test(req.headers.get("accept-encoding") || "")) return res;
  const h = new Headers(res.headers);
  h.set("content-encoding", "gzip"); h.delete("content-length"); h.append("vary", "Accept-Encoding");
  return new Response(res.body.pipeThrough(new CompressionStream("gzip")), { status: res.status, statusText: res.statusText, headers: h });
}

// worker: el objeto exportado por el servidor ({ fetch, scheduled }); nombre: el slug de la función (p. ej. "marin-api").
// armarEnv(transporteDirecto, secretos) -> env para el servidor (DB, DB_ARGOMEDO, vars, etc.).
// Cambia la URL de los webhooks de Loyverse que apuntan al Worker viejo (hostViejo) para que apunten a urlNueva,
// conservando la ruta /webhook/... y el ?token=. Devuelve solo los ids y si cambiaron (nunca el token).
export async function reapuntarWebhooksLoyverse(tokenLoyverse, hostViejo, urlNueva) {
  if (!tokenLoyverse) throw new Error("Falta el token de Loyverse en el Vault");
  const h = { Authorization: "Bearer " + tokenLoyverse, "Content-Type": "application/json" };
  const r = await fetch("https://api.loyverse.com/v1.0/webhooks", { headers: h });
  if (!r.ok) throw new Error("Loyverse HTTP " + r.status);
  const lista = (await r.json()).webhooks || [];
  const out = [];
  for (const w of lista) {
    let url; try { url = new URL(w.url); } catch (_) { continue; }
    if (url.host !== hostViejo) { out.push({ id: w.id, type: w.type, cambiado: false, host: url.host }); continue; }
    const nueva = urlNueva.replace(/\/$/, "") + url.pathname + url.search;
    const p = await fetch("https://api.loyverse.com/v1.0/webhooks", { method: "POST", headers: h,
      body: JSON.stringify({ id: w.id, url: nueva, type: w.type, status: w.status || "ENABLED" }) });
    out.push({ id: w.id, type: w.type, cambiado: p.ok, http: p.status });
  }
  return out;
}

export function servir({ worker, nombre, prefijoSecretos, armarEnv, tareasAdmin }) {
  let envListo = null;
  async function obtenerEnv() {
    if (!envListo) envListo = (async () => {
      const sec = await leerSecretos(prefijoSecretos);
      const env = await armarEnv(sec);
      return { ...sec, ...env, __plataforma: "supabase", __modo: "supabase", ESPEJO_SUPABASE: "0",
        __soloLectura: String(sec.SOLO_LECTURA || Deno.env.get("SOLO_LECTURA") || "") === "1" };
    })().catch(e => { envListo = null; throw e; });
    return envListo;
  }
  Deno.serve(async (req) => {
    const u = new URL(req.url);
    u.pathname = u.pathname.replace(new RegExp("^(/functions/v1)?/" + nombre + "(?=/|$)"), "") || "/";
    let env;
    try { env = await obtenerEnv(); }
    catch (e) { return new Response(JSON.stringify({ ok: false, error: "Arranque: " + e.message }), { status: 500, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } }); }
    const pendientes = [];
    const ctx = {
      waitUntil(p) {
        const pr = Promise.resolve(p).catch(e => console.error("waitUntil:", e && e.message));
        pendientes.push(pr);
        try { EdgeRuntime.waitUntil(pr); } catch (_) { /* fuera del runtime de Supabase */ }
      },
      passThroughOnException() {}
    };
    // Tareas de la mudanza (p. ej. reapuntar los webhooks de Loyverse a esta función). Las dispara Postgres con pg_net y la
    // clave del Vault, así ninguna clave pasa por fuera de Supabase.
    if (u.pathname === "/__admin") {
      if (!env.CRON_CLAVE || req.headers.get("x-cron-clave") !== env.CRON_CLAVE) return new Response("no autorizado", { status: 403 });
      const tarea = (tareasAdmin || {})[u.searchParams.get("tarea") || ""];
      if (!tarea) return Response.json({ ok: false, error: "tarea desconocida" }, { status: 400 });
      try { return Response.json({ ok: true, resultado: await tarea(env, u) }); }
      catch (e) { return Response.json({ ok: false, error: String(e && e.message || e) }, { status: 500 }); }
    }
    if (u.pathname === "/__cron") {
      if (!env.CRON_CLAVE || req.headers.get("x-cron-clave") !== env.CRON_CLAVE) return new Response("no autorizado", { status: 403 });
      if (env.__soloLectura) return Response.json({ ok: true, ignorado: "modo sombra" });
      const t0 = Date.now();
      await worker.scheduled({ cron: u.searchParams.get("cron") || "0 * * * *", scheduledTime: Date.now() }, env, ctx);
      await Promise.allSettled(pendientes);
      return Response.json({ ok: true, ms: Date.now() - t0 });
    }
    const req2 = new Request(u.toString(), req);
    const res = await worker.fetch(req2, env, ctx);
    return comprimir(res, req);
  });
}
