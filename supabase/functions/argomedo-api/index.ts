// Servidor de Argomedo 455 en Supabase (reemplaza al Worker argomedo455 de Cloudflare). Ver plataforma_supabase.js.
// Sin Durable Object: ?action=stream responde "no disponible" y la app sigue con su sondeo de 30 s.
import worker from "../../../worker.js";
import { servir, transporteDirecto, reapuntarWebhooksLoyverse } from "../../../plataforma_supabase.js";
import { crearDB } from "../../../pg/d1_compat.js";

servir({
  worker,
  nombre: "argomedo-api",
  prefijoSecretos: "argomedo",
  armarEnv: () => ({ DB: crearDB(transporteDirecto("ejecutar_sql_col_argomedo")), __transporte: transporteDirecto("ejecutar_sql_col_argomedo") }),
  tareasAdmin: {
    reapuntar_webhooks: (env: Record<string, string>) => reapuntarWebhooksLoyverse(env.LOYVERSE_API_TOKEN,
      "argomedo455.minimarketmarin01.workers.dev", Deno.env.get("SUPABASE_URL") + "/functions/v1/argomedo-api")
  }
});
