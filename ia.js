// IA de texto/visión para las funciones de los servidores (sugerir proveedor y sector, leer facturas).
// Usa Gemini (capa gratuita de Google AI Studio) con la clave GEMINI_API_KEY; si no existe pero sí ANTHROPIC_API_KEY, usa Claude.
// Devuelve siempre el TEXTO de la respuesta (JSON); quien llama lo interpreta. Lanza Error con un mensaje claro si falla.
//
// Gemini: modelo gemini-3.8-flash con razonamiento mínimo y corte de 60 s. Ante 503/429 (saturado) reintenta una vez y después
// prueba los demás modelos "flash" que Google tenga disponibles; si un modelo se retira (404) hace lo mismo.
const MODELOS_GEMINI = ["gemini-3.8-flash"];
// Tareas simples de texto (clasificar un producto): modelos "lite", varias veces más rápidos. El alias -latest sigue al modelo vigente.
const MODELOS_GEMINI_RAPIDOS = ["gemini-flash-lite-latest", "gemini-3.5-flash-lite"];

export function hayIA(env) { return !!(env && (env.GEMINI_API_KEY || env.ANTHROPIC_API_KEY)); }

async function modelosGeminiDisponibles(key) {
  try {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": key } });
    const j = await r.json();
    const ver = n => (/(\d+)\.(\d+)/.exec(n) || [0, 0, 0]).slice(1).map(Number);
    return (j.models || [])
      .filter(m => /flash/i.test(m.name) && !/lite|image|live|tts|thinking|audio/i.test(m.name) && (m.supportedGenerationMethods || []).includes("generateContent"))
      .map(m => m.name.replace(/^models\//, ""))
      .sort((a, b) => { const x = ver(a), y = ver(b); return (y[0] - x[0]) || (y[1] - x[1]); })
      .slice(0, 3);
  } catch (e) { return []; }
}

async function conGemini(env, { prompt, imagenB64, mediaType, maxTokens, rapido }) {
  const key = env.GEMINI_API_KEY;
  let modelos = env.MODELO_GEMINI ? String(env.MODELO_GEMINI).split(",").map(x => x.trim()).filter(Boolean)
    : (rapido ? MODELOS_GEMINI_RAPIDOS.concat(MODELOS_GEMINI) : MODELOS_GEMINI.slice());
  const errores = [];
  let busco = false;
  const partes = [{ text: prompt }];
  if (imagenB64) partes.push({ inline_data: { mime_type: mediaType || "image/jpeg", data: imagenB64 } });
  for (let i = 0; i < modelos.length; i++) {
    const modelo = modelos[i];
    try {
      const pedir = (conPensar) => fetch("https://generativelanguage.googleapis.com/v1beta/models/" + modelo + ":generateContent", {
        method: "POST",
        headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(rapido ? 25000 : 60000),
        body: JSON.stringify({
          contents: [{ role: "user", parts: partes }],
          generationConfig: Object.assign({ temperature: 0, maxOutputTokens: Math.max(maxTokens || 1024, 2048), responseMimeType: "application/json" },
            conPensar ? { thinkingConfig: { thinkingLevel: rapido ? "minimal" : "low" } } : {})
        })
      });
      let resp = await pedir(true);
      if (resp.status === 400) resp = await pedir(false);
      if ((resp.status === 503 || resp.status === 429) && !rapido) { await new Promise(r => setTimeout(r, 2500)); resp = await pedir(true); }
      const j = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        errores.push(modelo + ": HTTP " + resp.status + " " + String((j.error && j.error.message) || "").slice(0, 140));
        if ([404, 429, 503].includes(resp.status) && i === modelos.length - 1 && !busco) {
          busco = true;
          modelos = modelos.concat((await modelosGeminiDisponibles(key)).filter(m => !modelos.includes(m)));
        }
        continue;
      }
      const texto = ((j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || []).map(x => x.text || "").join("");
      if (texto.trim()) return texto;
      errores.push(modelo + ": respuesta vacía");
    } catch (e) { errores.push(modelo + ": " + String((e && e.message) || e).slice(0, 140)); }
  }
  throw new Error("Gemini no pudo responder (" + errores.join(" | ") + ")");
}

async function conClaude(env, { prompt, imagenB64, mediaType, maxTokens }) {
  const contenido = imagenB64
    ? [{ type: "image", source: { type: "base64", media_type: mediaType || "image/jpeg", data: imagenB64 } }, { type: "text", text: prompt }]
    : prompt;
  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: maxTokens || 1024, messages: [{ role: "user", content: contenido }] })
    });
  } catch (e) { throw new Error("No se pudo conectar con Claude: " + e.message); }
  if (!res.ok) throw new Error("Claude no pudo responder (" + res.status + "): " + (await res.text().catch(() => "")).slice(0, 200));
  const data = await res.json();
  const bloque = (data.content || []).find(b => b.type === "text");
  if (!bloque) throw new Error("Claude no devolvió texto");
  return bloque.text;
}

export async function llamarIA(env, opciones) {
  if (env.GEMINI_API_KEY) return conGemini(env, opciones);
  if (env.ANTHROPIC_API_KEY) return conClaude(env, opciones);
  throw new Error("Falta la clave de IA: agrega GEMINI_API_KEY en Supabase (Edge Functions → Secrets)");
}

// Quita los ``` y interpreta el JSON de una respuesta de IA.
export function jsonDeIA(texto) {
  const raw = String(texto || "").trim().replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/```\s*$/, "").trim();
  return JSON.parse(raw);
}

// ---- Foto de producto: quitar el fondo (Cloudflare Images, gratis) y ajustar el color (Gemini, gratis) ----
// remove.bg cierra el 1-dic-2026. El Worker "quitafondos" de Cloudflare usa el modelo de segmentación de Cloudflare Images
// (plan gratuito: 5.000 imágenes distintas al mes). Devuelve un PNG con transparencia, igual que remove.bg.
export async function quitarFondoConCloudflare(env, imagenB64) {
  if (!env.QUITAFONDOS_CLAVE) throw new Error("Falta la clave del quitafondos (QUITAFONDOS_CLAVE en el Vault de Supabase)");
  const url = env.QUITAFONDOS_URL || "https://quitafondos.minimarketmarin01.workers.dev";
  const bytes = Uint8Array.from(atob(imagenB64), c => c.charCodeAt(0));
  let r;
  try {
    r = await fetch(url, { method: "POST", headers: { "x-clave": env.QUITAFONDOS_CLAVE, "content-type": "application/octet-stream" }, body: bytes, signal: AbortSignal.timeout(45000) });
  } catch (e) { throw new Error("No se pudo conectar con el quitafondos: " + String((e && e.message) || e).slice(0, 100)); }
  if (!r.ok) throw new Error("El quitafondos respondió " + r.status + ": " + (await r.text().catch(() => "")).slice(0, 150));
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf.byteLength > 6 * 1024 * 1024) throw new Error("La imagen procesada quedó demasiado pesada");
  let s = "";
  for (let i = 0; i < buf.length; i += 8192) s += String.fromCharCode.apply(null, buf.subarray(i, i + 8192));
  return { image_base64: btoa(s), content_type: "image/png" };
}

// La IA mira la foto ya armada (producto sobre fondo blanco) y sugiere brillo, contraste y color. Porcentajes: 100 = sin cambio.
const PROMPT_COLOR_FOTO =
  "You are a product photo retoucher preparing a catalog image of a retail product. The background of this photo WILL BE REMOVED and replaced by pure white, " +
  "so ignore the background, the table and the lighting around the product: judge ONLY the product itself (its packaging). " +
  "Decide the adjustments needed so the product, once on a white background, looks bright, clean and true-to-life, WITHOUT oversaturating. " +
  "A product that looks dim or dark compared to a white background needs a clear brightness increase. " +
  "Reply ONLY with JSON: {\"brillo\":number,\"contraste\":number,\"saturacion\":number}. Values are percentages where 100 means no change. " +
  "Allowed ranges: brillo 85-130, contraste 90-130, saturacion 85-125. Guidance: underexposed or dark product -> raise brillo; flat or hazy -> raise contraste; " +
  "dull or washed out colors -> raise saturacion a little; already vivid or reddish/yellow cast -> keep saturacion at or below 100.";
export async function ajustarColorConIA(env, { imagenB64, mediaType }) {
  const texto = await llamarIA(env, { prompt: PROMPT_COLOR_FOTO, imagenB64, mediaType: mediaType || "image/jpeg", maxTokens: 120, rapido: true });
  const j = jsonDeIA(texto);
  const lim = (v, a, b, def) => { v = Number(v); return Number.isFinite(v) ? Math.max(a, Math.min(b, Math.round(v))) : def; };
  return { brillo: lim(j.brillo, 85, 130, 108), contraste: lim(j.contraste, 90, 130, 110), saturacion: lim(j.saturacion, 85, 125, 112) };
}

// ---- Embellecer la foto con IA generativa (FLUX.2 Klein 4B en Workers AI, vía el Worker "quitafondos") ----
// OPCIONAL y distinta del flujo normal: la IA REDIBUJA el producto, así que puede alterar textos, logos y detalles del envase.
// Por eso en la app va detrás de un botón con aviso, y siempre se puede volver a la versión fiel (píxeles reales).
// Gratis: ~125 neurons por foto de los 10.000 diarios (~80 fotos al día). El filtro de seguridad de Cloudflare a veces bloquea (422).
const PROMPT_EMBELLECER =
  "This is a catalog photo of a retail product on a white background. Improve it like a professional product photographer: " +
  "vivid but true-to-life colors, even soft studio lighting, crisp sharp details, a clean pure white background and a subtle soft contact shadow. " +
  "Keep the product EXACTLY the same: identical shape and proportions, packaging design, logos, brand names and every printed word, letter and number. " +
  "Do not redraw, translate, rewrite or invent any text or graphics. Keep the whole product visible and centered.";
export async function embellecerFotoConIA(env, { imagenB64, mediaType }) {
  if (!env.QUITAFONDOS_CLAVE) throw new Error("Falta la clave del Worker de Cloudflare (QUITAFONDOS_CLAVE en el Vault de Supabase)");
  if (!imagenB64) throw new Error("Falta la foto a procesar");
  const base = (env.QUITAFONDOS_URL || "https://quitafondos.minimarketmarin01.workers.dev").replace(/\/$/, "");
  const bytes = Uint8Array.from(atob(imagenB64), c => c.charCodeAt(0));
  let r;
  try {
    r = await fetch(base + "/embellecer?prompt=" + encodeURIComponent(PROMPT_EMBELLECER), {
      method: "POST", headers: { "x-clave": env.QUITAFONDOS_CLAVE, "x-tipo": mediaType || "image/png", "content-type": "application/octet-stream" },
      body: bytes, signal: AbortSignal.timeout(90000)
    });
  } catch (e) { throw new Error("No se pudo conectar con la IA de Cloudflare: " + String((e && e.message) || e).slice(0, 100)); }
  if (r.status === 422) throw new Error("El filtro de seguridad de Cloudflare bloqueó esta foto. Usa la versión normal o prueba con otra toma.");
  if (!r.ok) throw new Error("La IA de Cloudflare respondió " + r.status + ": " + (await r.text().catch(() => "")).slice(0, 150));
  const buf = new Uint8Array(await r.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 8192) s += String.fromCharCode.apply(null, buf.subarray(i, i + 8192));
  return { image_base64: btoa(s), content_type: "image/png" };
}
