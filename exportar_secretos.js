// Mudanza a Supabase: copia los secretos de este Worker al Vault de Supabase (función public.guardar_secreto_migracion,
// solo para service_role). Así la función de Supabase usa exactamente las mismas claves (Loyverse, notificaciones push...)
// sin que nadie tenga que verlas ni copiarlas a mano. Se ejecuta en segundo plano; si ya están todas, no hace nada.
let _secretosExportados = false;
export async function exportarSecretos(env, prefijo, nombres) {
  if (_secretosExportados || !env || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return;
  _secretosExportados = true;
  const base = String(env.SUPABASE_URL).replace(/\/$/, "") + "/rest/v1/rpc/";
  const h = { apikey: env.SUPABASE_SERVICE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, "Content-Type": "application/json" };
  try {
    const r = await fetch(base + "secretos_migrados", { method: "POST", headers: h, body: JSON.stringify({ prefijo }) });
    const ya = new Set(r.ok ? (await r.json()) : []);
    for (const n of nombres) {
      const v = env[n];
      if (v == null || v === "" || ya.has(prefijo + "__" + n)) continue;
      await fetch(base + "guardar_secreto_migracion", { method: "POST", headers: h, body: JSON.stringify({ nombre: prefijo + "__" + n, valor: String(v) }) });
    }
  } catch (e) { _secretosExportados = false; }
}
