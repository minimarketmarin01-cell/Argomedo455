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
