// App de etiquetas del POS (Android): catálogo liviano y por cambios, búsqueda a pedido y ficha corta.
// Misma lógica en marin376-cloudflare (src/etiquetas.js) y en Argomedo455 (etiquetas.js).
//
// Por qué: la app bajaba el catálogo completo (≈1,6 MB) cada vez que abría. Ahora guarda en el equipo solo las categorías
// de Loyverse elegidas y pregunta por lo que cambió desde el último número del registro de cambios (panel_version /
// panel_cambios, el mismo del panel). Lo que no está guardado se busca a pedido (buscar_etiquetas).
//
// `db` = { todas(sql, ...params) -> filas, uno(sql, ...params) -> fila|null }.
// Toda respuesta lleva `lite: true` como PRIMERA clave: así la app distingue un servidor nuevo de uno viejo, que ante una
// acción que no conoce devuelve el catálogo completo (y la app corta la lectura sin bajarlo).

const COLS = "sku, nombre, precio, barcode, categoria, imagen_url, costo";
const CAT = "COALESCE(NULLIF(categoria, ''), 'SIN CATEGORÍA')";
const MAX_CAMBIOS = 1500;   // más cambios que esto: conviene mandar todo de nuevo
const MAX_BUSQUEDA = 40;

// [sku, nombre, precio, código, categoría, foto, costo]: el mismo formato del archivo guardado en la app.
export const filaEtiqueta = (p) => [String(p.sku), p.nombre || "", Math.round(Number(p.precio) || 0), p.barcode || "",
  p.categoria || "SIN CATEGORÍA", p.imagen_url || "", Math.round(Number(p.costo) || 0)];

export function listaCategorias(raw) {
  if (raw === null || raw === undefined || raw === "") return null;   // null = todas
  try {
    const a = JSON.parse(raw);
    if (!Array.isArray(a)) return null;
    const out = a.map((x) => String(x)).filter(Boolean).slice(0, 300);
    return out.length ? out : null;
  } catch (e) { return null; }
}

async function versionCambios(db) {
  try { const v = await db.uno("SELECT v FROM panel_version WHERE id = 1"); return v ? Number(v.v) : null; } catch (e) { return null; }
}

/** ?action=catalogo_etiquetas&cats=["A","B"]&desde=N → productos de esas categorías (todas si no hay cats). */
export async function catalogoEtiquetas(db, desdeRaw, cats) {
  const hasta = await versionCambios(db);
  const filtro = cats ? " AND " + CAT + " IN (" + cats.map(() => "?").join(",") + ")" : "";
  const parametros = cats || [];
  const completo = async (motivo) => {
    const filas = await db.todas("SELECT " + COLS + " FROM productos WHERE sku IS NOT NULL AND sku <> '' AND nombre IS NOT NULL" + filtro + " ORDER BY nombre", ...parametros);
    return { lite: true, ok: true, completo: true, motivo, cursor: hasta, productos: filas.map(filaEtiqueta), borrados: [] };
  };
  const d = Number(desdeRaw);
  if (hasta == null || desdeRaw === null || desdeRaw === undefined || desdeRaw === "" || !Number.isFinite(d) || d > hasta) return completo("sin cursor");
  if (d === hasta) return { lite: true, ok: true, completo: false, cursor: hasta, productos: [], borrados: [] };
  const cambios = await db.todas("SELECT DISTINCT clave FROM panel_cambios WHERE tabla = 'productos' AND v > ? AND v <= ?", d, hasta);
  const skus = cambios.map((c) => String(c.clave));
  if (skus.length > MAX_CAMBIOS) return completo("muchos cambios");
  const productos = [], borrados = [], vistos = new Set();
  const enCats = cats ? new Set(cats) : null;
  for (let i = 0; i < skus.length; i += 90) {
    const parte = skus.slice(i, i + 90);
    const filas = await db.todas("SELECT " + COLS + " FROM productos WHERE sku IN (" + parte.map(() => "?").join(",") + ")", ...parte);
    for (const p of filas) {
      vistos.add(String(p.sku));
      const cat = p.categoria || "SIN CATEGORÍA";
      if (!enCats || enCats.has(cat)) productos.push(filaEtiqueta(p)); else borrados.push(String(p.sku));   // cambió de categoría
    }
  }
  for (const s of skus) if (!vistos.has(s)) borrados.push(s);   // ya no existe
  return { lite: true, ok: true, completo: false, cursor: hasta, productos, borrados };
}

/** ?action=categorias_etiquetas → [[categoría, cantidad], …] (para elegir cuáles guardar en el equipo). */
export async function categoriasEtiquetas(db) {
  const filas = await db.todas("SELECT " + CAT + " AS categoria, COUNT(*) AS n FROM productos WHERE sku IS NOT NULL AND sku <> '' GROUP BY 1 ORDER BY 1");
  return { lite: true, ok: true, categorias: filas.map((f) => [f.categoria, Number(f.n)]) };
}

const ACENTOS = [["á", "a"], ["é", "e"], ["í", "i"], ["ó", "o"], ["ú", "u"], ["ü", "u"], ["ñ", "n"],
  ["Á", "a"], ["É", "e"], ["Í", "i"], ["Ó", "o"], ["Ú", "u"], ["Ü", "u"], ["Ñ", "n"]];
const NOMBRE_NORM = "lower(" + ACENTOS.reduce((e, [a, b]) => "replace(" + e + ",'" + a + "','" + b + "')", "nombre") + ")";
const sinAcentos = (s) => String(s).normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();

/** ?action=buscar_etiquetas&q=… → hasta 40 productos de TODAS las categorías (por código/SKU exacto o por nombre). */
export async function buscarEtiquetas(db, texto) {
  const t = String(texto || "").trim().slice(0, 60);
  if (t.length < 2) return { lite: true, ok: true, productos: [] };
  const palabras = sinAcentos(t).replace(/[%_\\]/g, "").split(/\s+/).filter(Boolean).slice(0, 4);
  const condiciones = ["sku = ?", "barcode = ?"], parametros = [t, t];
  if (/^[0-9]{4,}$/.test(t)) { condiciones.push("barcode LIKE ?", "sku LIKE ?"); parametros.push("%" + t + "%", "%" + t + "%"); }
  if (palabras.length) {
    condiciones.push("(" + palabras.map(() => NOMBRE_NORM + " LIKE ?").join(" AND ") + ")");
    palabras.forEach((w) => parametros.push("%" + w + "%"));
  }
  const filas = await db.todas("SELECT " + COLS + " FROM productos WHERE sku IS NOT NULL AND sku <> '' AND (" + condiciones.join(" OR ") + ") ORDER BY nombre LIMIT " + MAX_BUSQUEDA, ...parametros);
  // Los exactos (código/SKU) primero.
  filas.sort((a, b) => (String(b.sku) === t || b.barcode === t ? 1 : 0) - (String(a.sku) === t || a.barcode === t ? 1 : 0));
  return { lite: true, ok: true, productos: filas.map(filaEtiqueta) };
}

const ddmmaaaaOrdenable = (f) => { const p = String(f || "").split("/"); return p.length === 3 ? p[2] + p[1].padStart(2, "0") + p[0].padStart(2, "0") : ""; };

/**
 * ?action=ficha_etiqueta&sku=… → lo mismo que la app usaba de ficha_producto (precio, costo, código y lotes) con 2
 * consultas en vez de ~10. `orden`: "ingreso" (Marín: el lote que entró primero) o "prioridad" (Argomedo: el más urgente).
 */
export async function fichaEtiqueta(db, sku, orden) {
  const producto = await db.uno("SELECT sku, nombre, categoria, barcode, costo, precio FROM productos WHERE sku = ?", sku);
  if (!producto) throw new Error("SKU no encontrado en el catálogo: " + sku);
  const filas = await db.todas("SELECT fecha_vencimiento, fecha_ingreso, estado, prioridad FROM vencimientos WHERE sku = ? AND (estado IS NULL OR estado <> 'Revisado')", sku);
  const prio = { "⚫": 0, "🔴": 1, "🟠": 2, "🟡": 3, "🟢": 4, "—": 5 };
  const lotes = filas.slice().sort(orden === "prioridad"
    ? (a, b) => (prio[a.prioridad] ?? 9) - (prio[b.prioridad] ?? 9)
    : (a, b) => ddmmaaaaOrdenable(a.fecha_ingreso).localeCompare(ddmmaaaaOrdenable(b.fecha_ingreso)));
  return { ok: true, ficha: { producto: { sku: producto.sku, nombre: producto.nombre, categoria: producto.categoria, barcode: producto.barcode,
    costo: producto.costo, precio: producto.precio }, lotes: lotes.map((l) => ({ fechaVencimiento: l.fecha_vencimiento, fechaIngreso: l.fecha_ingreso, estado: l.estado, prioridad: l.prioridad })) } };
}

/** Atiende las 4 acciones; null si la acción no es de esta app. */
export async function atenderEtiquetas(accion, url, db, orden) {
  if (accion === "catalogo_etiquetas") return catalogoEtiquetas(db, url.searchParams.get("desde"), listaCategorias(url.searchParams.get("cats")));
  if (accion === "categorias_etiquetas") return categoriasEtiquetas(db);
  if (accion === "buscar_etiquetas") return buscarEtiquetas(db, url.searchParams.get("q"));
  if (accion === "ficha_etiqueta") {
    const sku = url.searchParams.get("sku");
    if (!sku) return { ok: false, error: "Falta el parámetro sku" };
    return fichaEtiqueta(db, sku, orden);
  }
  return null;
}
