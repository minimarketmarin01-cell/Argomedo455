/****************************************************************
 *  ARGOMEDO 455 · WORKER (Cloudflare)
 *  ---------------------------------------------------------
 *  PASO 3: tablas D1 + prueba de conexión a Loyverse.
 *  PASO 4: sincronización real del catálogo (Loyverse → D1),
 *          con detección automática del store_id (no hace falta
 *          buscarlo a mano — se detecta solo la primera vez y
 *          queda guardado en D1 para las siguientes veces).
 *
 *  Módulos que vendrán en pasos siguientes (todavía NO están
 *  implementados aquí a propósito, para ir paso a paso):
 *   - Armar pedido (carrito + sugeridos + WhatsApp)
 *   - Recibir mercadería (lote_nuevo) con fecha de vencimiento
 ****************************************************************/

// ============================================================
//  CONFIG
// ============================================================
const LOYVERSE_API = "https://api.loyverse.com/v1.0";
const PAGE = 250; // tamaño de página al paginar listados de Loyverse

// ============================================================
//  CORS + RESPUESTAS
// ============================================================
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS }
  });
}

// ============================================================
//  HELPERS D1
// ============================================================
async function run(env, sql, ...params) {
  const stmt = params.length ? env.DB.prepare(sql).bind(...params) : env.DB.prepare(sql);
  return stmt.run();
}

async function get(env, sql, ...params) {
  const stmt = params.length ? env.DB.prepare(sql).bind(...params) : env.DB.prepare(sql);
  return stmt.first();
}

// Ejecuta muchas sentencias D1 preparadas en un solo viaje (batch), partiendo en trozos
// (chunks) para no exceder límites de D1. Con 3.200+ productos, NUNCA se debe hacer un
// INSERT/UPDATE por producto en loop — eso sería miles de round-trips y sería lentísimo.
async function batchRun(env, stmts, chunkSize = 500) {
  for (let i = 0; i < stmts.length; i += chunkSize) {
    const chunk = stmts.slice(i, i + chunkSize);
    if (chunk.length) await env.DB.batch(chunk);
  }
  return stmts.length;
}

// ============================================================
//  CREAR TABLAS (si no existen) — se ejecuta en cada request al
//  endpoint de setup, es seguro llamarlo varias veces.
// ============================================================
async function asegurarTablas(env) {
  // Catálogo cacheado de Loyverse (evita golpear la API en cada búsqueda).
  await run(env, `CREATE TABLE IF NOT EXISTS productos (
    sku TEXT PRIMARY KEY,
    id_loyverse TEXT,
    variant_id TEXT,
    nombre TEXT,
    categoria TEXT,
    proveedor TEXT,
    barcode TEXT,
    precio REAL,
    costo REAL,
    stock REAL,
    sold_by_weight INTEGER DEFAULT 0,
    track_stock INTEGER DEFAULT 1
  )`);

  // Lotes de mercadería recibida con su fecha de vencimiento.
  await run(env, `CREATE TABLE IF NOT EXISTS vencimientos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha_ingreso TEXT,
    sku TEXT,
    producto TEXT,
    categoria TEXT,
    unidad TEXT,
    lote TEXT,
    cantidad REAL,
    fecha_vencimiento TEXT,
    estado TEXT,
    fecha_revision TEXT,
    revisado_por TEXT
  )`);

  // Productos pedidos a proveedor que aún no han llegado (para el módulo Armar pedido).
  await run(env, `CREATE TABLE IF NOT EXISTS pedidos_pendientes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha TEXT,
    sku TEXT,
    barcode TEXT,
    producto TEXT,
    proveedor TEXT,
    cantidad REAL
  )`);

  // Registro histórico de acciones (auditoría), útil para depurar y para el historial.
  await run(env, `CREATE TABLE IF NOT EXISTS auditoria (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha TEXT,
    accion TEXT,
    sku TEXT,
    producto TEXT,
    categoria TEXT,
    id_loyverse TEXT,
    stock REAL,
    motivo TEXT,
    responsable TEXT
  )`);

  // Configuración simple clave/valor (aquí se guarda el store_id de Loyverse una vez
  // detectado automáticamente, para no tener que volver a consultarlo cada vez).
  await run(env, `CREATE TABLE IF NOT EXISTS config (
    clave TEXT PRIMARY KEY,
    valor TEXT
  )`);

  // Migración: columna con_iva en `productos` (tablas creadas antes de este cambio
  // no la tienen todavía). SQLite/D1 no soporta "ADD COLUMN IF NOT EXISTS", así que
  // se intenta y se ignora el error si ya existe.
  try {
    await run(env, `ALTER TABLE productos ADD COLUMN con_iva INTEGER DEFAULT 0`);
  } catch (e) {
    // ya existía la columna — normal en ejecuciones posteriores a la primera.
  }

  // Migración: columna sector (ubicación física — góndola/bodega/refrigerador).
  try {
    await run(env, `ALTER TABLE productos ADD COLUMN sector TEXT`);
  } catch (e) {
    // ya existía.
  }

  // Catálogos reutilizables de proveedores y sectores — permiten buscar y crear
  // nuevos registros desde el formulario sin salir de él, y que queden disponibles
  // para elegir la próxima vez (Módulo 3: Proveedores y sectores).
  await run(env, `CREATE TABLE IF NOT EXISTS proveedores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT UNIQUE
  )`);
  await run(env, `CREATE TABLE IF NOT EXISTS sectores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT UNIQUE
  )`);

  // Registro de eventos de Webhook ya procesados (Loyverse → Worker). Evita aplicar
  // dos veces el mismo evento si Loyverse lo reintenta o si llega duplicado.
  await run(env, `CREATE TABLE IF NOT EXISTS webhook_eventos (
    event_id TEXT PRIMARY KEY,
    tipo TEXT,
    recibido_en TEXT
  )`);

  // Ventas línea a línea (una fila por sku vendido en un recibo), alimentada en
  // tiempo real por el webhook receipts.update y, para el historial previo a la
  // instalación del webhook, por una sincronización manual (Módulo 4: Armar pedido).
  // Clave única (receipt_id, sku) para poder hacer upsert si Loyverse reenvía el
  // mismo recibo (ej. una devolución que actualiza el original).
  await run(env, `CREATE TABLE IF NOT EXISTS ventas (
    receipt_id TEXT,
    sku TEXT,
    cantidad REAL,
    fecha_venta TEXT,
    PRIMARY KEY (receipt_id, sku)
  )`);
  await run(env, `CREATE INDEX IF NOT EXISTS idx_ventas_fecha ON ventas (fecha_venta)`);
}

// ============================================================
//  FECHA/HORA — Cloudflare Workers corre en UTC; estas funciones
//  traducen a la hora real de Santiago para que fechas de ingreso
//  y auditoría coincidan con lo que el equipo ve en la tienda.
// ============================================================
function chileNowParts() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Santiago", day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(new Date());
  const get = t => parts.find(p => p.type === t).value;
  return { dd: get("day"), mm: get("month"), yyyy: get("year"), hh: get("hour"), mi: get("minute") };
}
function fechaDDMMAAAA() {
  const p = chileNowParts();
  return p.dd + "/" + p.mm + "/" + p.yyyy;
}
// Formato ISO (YYYY-MM-DD) — solo se usa internamente para poder comparar y filtrar
// fechas en SQL con `>=`/`<=` (el DD/MM/AAAA que ve el usuario no ordena bien como texto).
function fechaISO(date) {
  const d = date || new Date();
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = t => p.find(x => x.type === t).value;
  return get("year") + "-" + get("month") + "-" + get("day");
}
function fechaHoraDDMMAAAA() {
  const p = chileNowParts();
  return p.dd + "/" + p.mm + "/" + p.yyyy + " " + p.hh + ":" + p.mi;
}
// Valida "DD/MM/AAAA" y devuelve un objeto Date, o null si no es válida.
function parseFechaDDMMAAAA(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s || "").trim());
  if (!m) return null;
  const d = new Date(+m[3], +m[2] - 1, +m[1]);
  if (d.getFullYear() !== +m[3] || d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[1]) return null; // rechaza 31/02, etc.
  return d;
}


// ============================================================
//  PRUEBA DE CONEXIÓN A LOYVERSE
//  Trae los datos de la(s) tienda(s) asociadas al token — si esto
//  responde bien, confirma que LOYVERSE_API_TOKEN es válido.
// ============================================================
async function probarLoyverse(env) {
  const res = await fetch(LOYVERSE_API + "/stores", {
    headers: { "Authorization": "Bearer " + env.LOYVERSE_API_TOKEN }
  });
  if (!res.ok) {
    const texto = await res.text();
    throw new Error("Loyverse respondió " + res.status + ": " + texto);
  }
  return res.json();
}

// ============================================================
//  LOYVERSE — helpers genéricos de lectura
// ============================================================
// GET simple (una página), con reintento automático si Loyverse responde
// "too many requests" (429) o un error temporal de servidor (5xx).
async function loyverseGet(env, endpoint, params, intento = 0) {
  const qs = new URLSearchParams();
  Object.keys(params || {}).forEach(k => {
    if (params[k] !== null && params[k] !== undefined && params[k] !== "") qs.set(k, params[k]);
  });
  const res = await fetch(LOYVERSE_API + endpoint + "?" + qs.toString(), {
    headers: { "Authorization": "Bearer " + env.LOYVERSE_API_TOKEN }
  });
  if (res.status === 429 || res.status >= 500) {
    if (intento >= 5) throw new Error(endpoint + " HTTP " + res.status + " tras 5 reintentos");
    await new Promise(r => setTimeout(r, 1500 * (intento + 1)));
    return loyverseGet(env, endpoint, params, intento + 1);
  }
  if (!res.ok) throw new Error(endpoint + " HTTP " + res.status + ": " + (await res.text()).slice(0, 200));
  return res.json();
}

// GET con paginación automática (sigue el "cursor" hasta traer todo).
async function loyverseGetAll(env, endpoint, key, extra) {
  let all = [], cursor = null;
  do {
    const params = Object.assign({ limit: PAGE }, extra || {});
    if (cursor) params.cursor = cursor;
    const data = await loyverseGet(env, endpoint, params);
    all = all.concat(data[key] || []);
    cursor = data.cursor || null;
  } while (cursor);
  return all;
}

// ============================================================
//  LOYVERSE — helpers de ESCRITURA (afectan datos reales de la tienda)
// ============================================================
async function loyversePost(env, endpoint, body) {
  const res = await fetch(LOYVERSE_API + endpoint, {
    method: "POST",
    headers: { "Authorization": "Bearer " + env.LOYVERSE_API_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(endpoint + " HTTP " + res.status + ": " + (await res.text()).slice(0, 200));
  return res.json();
}

// Stock fresco de UNA variante — se usa antes de sumar/restar, para no trabajar
// con un valor cacheado y viejo de D1 que podría causar descuadres.
async function stockFrescoDeVariante(env, storeId, variantId) {
  const data = await loyverseGet(env, "/inventory", { store_id: storeId, variant_ids: variantId });
  const nivel = (data.inventory_levels || []).find(x => x.variant_id === variantId);
  return nivel ? nivel.in_stock : null;
}

// Suma cantidad al stock actual de un producto (lee fresco de Loyverse, escribe el
// nuevo total, y refleja el cambio también en la caché D1 `productos`).
async function sumarStockLoyverse(env, productoRow, cantidad) {
  if (!productoRow.track_stock) return { ok: false, motivo: "producto sin seguimiento de inventario ('Activar inventario' primero)" };
  if (!productoRow.variant_id) return { ok: false, motivo: "falta variant_id (vuelve a sincronizar el catálogo)" };

  const { storeId } = await obtenerStoreId(env);
  const stockActual = await stockFrescoDeVariante(env, storeId, productoRow.variant_id);
  if (stockActual == null) return { ok: false, motivo: "Loyverse no devolvió inventario para este producto" };

  const nuevoStock = Math.round((stockActual + cantidad) * 1000) / 1000;
  await loyversePost(env, "/inventory", {
    inventory_levels: [{ variant_id: productoRow.variant_id, store_id: storeId, stock_after: nuevoStock }]
  });
  await run(env, "UPDATE productos SET stock = ? WHERE sku = ?", nuevoStock, productoRow.sku);
  return { ok: true, antes: stockActual, despues: nuevoStock };
}

// Actualiza costo y/o precio de venta de un producto en Loyverse. Loyverse requiere
// reenviar el ítem completo con la variante modificada (no acepta un PATCH parcial
// de un solo campo), así que primero se lee el ítem entero y se modifica en memoria.
async function actualizarPrecioCostoLoyverse(env, idLoyverse, variantId, precioNuevo, costoNuevo) {
  const { storeId } = await obtenerStoreId(env);
  const item = await loyverseGet(env, "/items/" + idLoyverse, {});
  const variantes = (item.variants || []).map(v => {
    if (v.variant_id !== variantId) return v;
    const copia = Object.assign({}, v);
    if (costoNuevo != null) copia.cost = costoNuevo;
    if (precioNuevo != null) {
      copia.default_price = precioNuevo;
      // Loyverse usa el precio a nivel de TIENDA (stores[].price) para vender, no
      // default_price, cuando existe un override "FIXED" para esa tienda — que es
      // justo lo que se crea en accionCrearProducto. Si solo se actualiza
      // default_price, el precio de venta real en caja no cambia. Por eso hay que
      // tocar también la entrada de stores[] correspondiente a esta tienda.
      const stores = (v.stores || []).map(s =>
        s.store_id === storeId ? Object.assign({}, s, { price: precioNuevo, pricing_type: "FIXED" }) : s
      );
      if (!stores.some(s => s.store_id === storeId)) {
        stores.push({ store_id: storeId, price: precioNuevo, pricing_type: "FIXED", available_for_sale: true });
      }
      copia.stores = stores;
    }
    return copia;
  });
  await loyversePost(env, "/items", Object.assign({}, item, { variants: variantes }));
}


//  Si la cuenta tiene más de una tienda, se usa la primera y se
//  avisa en la respuesta (por si en el futuro hace falta elegir).
// ============================================================
async function obtenerStoreId(env) {
  const guardado = await get(env, "SELECT valor FROM config WHERE clave = 'store_id'");
  if (guardado && guardado.valor) return { storeId: guardado.valor, detectadoAhora: false, totalTiendas: null };

  const data = await probarLoyverse(env);
  const tiendas = data.stores || [];
  if (!tiendas.length) throw new Error("Loyverse no devolvió ninguna tienda para este token.");

  const storeId = tiendas[0].id;
  await run(env, "INSERT INTO config (clave, valor) VALUES ('store_id', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor", storeId);
  return { storeId, detectadoAhora: true, totalTiendas: tiendas.length, nombreTienda: tiendas[0].name };
}

// Encuentra el impuesto "IVA" ya configurado en el Back Office de Loyverse (Loyverse
// no permite crear impuestos por API, solo asignarlos — por eso debe existir de
// antemano en la cuenta). Se cachea en D1 igual que el store_id, para no consultar
// /taxes en cada creación de producto. Prioriza por nombre "IVA", luego por tasa 19%,
// y como último recurso usa el único impuesto configurado si solo hay uno.
async function obtenerIvaTaxId(env, forzarRefresco) {
  if (!forzarRefresco) {
    const guardado = await get(env, "SELECT valor FROM config WHERE clave = 'iva_tax_id'");
    if (guardado && guardado.valor) return guardado.valor;
  }

  const taxes = await loyverseGetAll(env, "/taxes", "taxes");
  if (!taxes.length) throw new Error("No hay ningún impuesto configurado en Loyverse Back Office (crea el IVA 19% ahí primero)");

  let iva = taxes.find(t => /iva/i.test(t.name || ""));
  if (!iva) iva = taxes.find(t => Math.abs((Number(t.rate) || 0) - 0.19) < 0.005 || Math.abs((Number(t.rate) || 0) - 19) < 0.5);
  if (!iva && taxes.length === 1) iva = taxes[0];
  if (!iva) throw new Error("No se pudo identificar cuál impuesto es el IVA en Loyverse (revisa nombre/tasa en Back Office)");

  await run(env, "INSERT INTO config (clave, valor) VALUES ('iva_tax_id', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor", iva.id);
  return iva.id;
}

// ============================================================
//  SINCRONIZAR CATÁLOGO COMPLETO (Loyverse → D1)
//  Trae items + categorías + inventario y guarda/actualiza la
//  tabla `productos`. Proveedor y Sector son campos propios de la
//  app (no existen en Loyverse) — nunca se pisan aquí: si el
//  producto ya existía, conservan el valor que ya tenían en D1.
// ============================================================
async function sincronizarCatalogo(env) {
  await asegurarTablas(env); // por si la columna con_iva u otra migración aún no se aplicó
  const { storeId } = await obtenerStoreId(env);

  const [items, categorias, inventario] = await Promise.all([
    loyverseGetAll(env, "/items", "items"),
    loyverseGetAll(env, "/categories", "categories"),
    loyverseGetAll(env, "/inventory", "inventory_levels", { store_id: storeId })
  ]);

  const mapaCategorias = {};
  categorias.forEach(c => { mapaCategorias[c.id] = c.name; });

  const mapaStock = {};
  inventario.forEach(x => { mapaStock[x.variant_id] = x.in_stock; });

  // Se necesita el id del impuesto IVA para saber, producto por producto, si lo
  // tiene activado o no (para mostrar el botón "Activar IVA" en la app). Si no se
  // puede detectar (ej. no está configurado en Loyverse Back Office todavía), se
  // sigue sincronizando igual pero con_iva queda en 0 para todos.
  let ivaTaxId = null;
  try { ivaTaxId = await obtenerIvaTaxId(env); } catch (e) { /* se avisa solo al crear/activar, no bloquea el sync */ }

  const stmts = [];
  const saltados = [];
  items.forEach(it => {
    const v = (it.variants && it.variants[0]) ? it.variants[0] : null;
    if (!v || !v.sku) {
      saltados.push(it.item_name || "(sin nombre)");
      return;
    }
    let precio = v.default_price;
    if (v.stores && v.stores[0] && v.stores[0].price != null) precio = v.stores[0].price;
    const stock = mapaStock[v.variant_id] != null ? mapaStock[v.variant_id] : null;
    const peso = !!(it.sold_by_weight || it.soldByWeight);
    const conIva = ivaTaxId ? (Array.isArray(it.tax_ids) && it.tax_ids.includes(ivaTaxId)) : false;

    // ON CONFLICT: si el sku ya existe en D1, NO se toca `proveedor` ni `sector`
    // (columnas que esta sentencia ni siquiera incluye) — solo se refrescan los
    // datos que sí vienen de Loyverse.
    stmts.push(env.DB.prepare(
      `INSERT INTO productos (sku, id_loyverse, variant_id, nombre, categoria, barcode, precio, costo, stock, sold_by_weight, track_stock, con_iva)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(sku) DO UPDATE SET
         id_loyverse=excluded.id_loyverse, variant_id=excluded.variant_id, nombre=excluded.nombre,
         categoria=excluded.categoria, barcode=excluded.barcode, precio=excluded.precio,
         costo=excluded.costo, stock=excluded.stock, sold_by_weight=excluded.sold_by_weight,
         track_stock=excluded.track_stock, con_iva=excluded.con_iva`
    ).bind(v.sku, it.id, v.variant_id, it.item_name, mapaCategorias[it.category_id] || "SIN CATEGORÍA",
      v.barcode || "", precio || 0, v.cost || 0, stock, peso ? 1 : 0, it.track_stock ? 1 : 0, conIva ? 1 : 0));
  });

  await batchRun(env, stmts, 500);

  // --------------------------------------------------------
  // ELIMINAR de D1 los productos que ya no existen en Loyverse
  // (borrados desde Loyverse Back Office o desde el POS). Sin esto,
  // un producto eliminado en Loyverse seguía apareciendo para
  // siempre en la app, porque la caché D1 solo se actualizaba/
  // insertaba pero nunca se depuraba.
  //
  // Salvaguarda: si por algún corte/error parcial de la API de
  // Loyverse `items` viniera vacío o incompleto, NO se debe vaciar
  // el catálogo entero por error. Por eso solo se ejecuta el borrado
  // si los "candidatos a eliminar" son una fracción razonable del
  // catálogo actual (máx. 40%, y solo si ya había al menos 10
  // productos guardados) — si supera ese umbral, se aborta el
  // borrado y se avisa en la respuesta para revisar a mano.
  // --------------------------------------------------------
  const skusVigentes = new Set(
    items.map(it => (it.variants && it.variants[0] && it.variants[0].sku) || null).filter(Boolean)
  );

  const existentesEnD1 = await env.DB.prepare("SELECT sku, nombre, id_loyverse FROM productos").all();
  const filasD1 = existentesEnD1.results || [];
  const aEliminar = filasD1.filter(p => !skusVigentes.has(p.sku));

  let eliminados = { total: 0, nombres: [], abortado: false, motivoAborto: null };

  if (aEliminar.length > 0) {
    const umbral = Math.max(0.4 * filasD1.length, 0); // no más del 40% del catálogo actual
    if (filasD1.length >= 10 && aEliminar.length > umbral) {
      eliminados.abortado = true;
      eliminados.motivoAborto =
        "Se detectaron " + aEliminar.length + " de " + filasD1.length + " productos como 'ya no están en Loyverse', " +
        "lo cual supera el 40% del catálogo — por seguridad NO se borró nada automáticamente " +
        "(podría ser un corte/error temporal de la API de Loyverse, no borrados reales). Revisa manualmente o vuelve a sincronizar.";
    } else {
      const delStmts = aEliminar.map(p => env.DB.prepare("DELETE FROM productos WHERE sku = ?").bind(p.sku));
      await batchRun(env, delStmts, 500);

      const audStmts = aEliminar.map(p => env.DB.prepare(
        `INSERT INTO auditoria (fecha, accion, sku, producto, categoria, id_loyverse, stock, motivo, responsable)
         VALUES (?,?,?,?,?,?,?,?,?)`
      ).bind(fechaHoraDDMMAAAA(), "eliminado_en_loyverse", p.sku, p.nombre, "", p.id_loyverse, null,
        "Producto ya no existe en Loyverse — eliminado automáticamente de la app al sincronizar", "sync"));
      await batchRun(env, audStmts, 500);

      eliminados.total = aEliminar.length;
      eliminados.nombres = aEliminar.slice(0, 10).map(p => p.nombre);
    }
  }

  return {
    totalLoyverse: items.length,
    guardados: stmts.length,
    saltados: saltados.length,
    ejemplosSaltados: saltados.slice(0, 10),
    eliminados
  };
}

// Marca en `config` el momento del último cambio real en `productos`. El frontend
// consulta esto cada cierto tiempo (polling liviano) para saber si debe refrescar
// su copia local del catálogo, sin tener que revisar producto por producto.
async function marcarCatalogoActualizado(env) {
  const ahora = new Date().toISOString();
  await run(env, "INSERT INTO config (clave, valor) VALUES ('catalogo_actualizado_en', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor", ahora);

  // Avisa en el momento (SSE) a todos los celulares conectados — sin esto igual se
  // enterarían en el próximo sondeo de respaldo, pero así queda instantáneo. Si el
  // binding del Durable Object todavía no está desplegado, no rompe nada: el sondeo
  // de respaldo sigue funcionando igual.
  if (env.REALTIME_HUB) {
    try {
      const id = env.REALTIME_HUB.idFromName("global");
      const stub = env.REALTIME_HUB.get(id);
      await stub.fetch("https://internal/broadcast", {
        method: "POST",
        body: JSON.stringify({ actualizadoEn: ahora })
      });
    } catch (e) { /* silencioso: el sondeo de respaldo cubre este caso igual */ }
  }
}

// ============================================================
//  WEBHOOKS DE LOYVERSE (tiempo real → D1)
//  Loyverse envía POST a /webhook/loyverse cuando cambia stock o
//  productos. Esto evita tener que sincronizar el catálogo completo
//  (3.000+ productos) para reflejar un solo cambio.
//
//  IMPORTANTE — pendiente de confirmar contra la documentación
//  actual de Loyverse antes de activar en producción:
//   - nombre exacto del header de firma (se prueban dos variantes
//     comunes: "loyverse-signature" y "x-loyverse-signature")
//   - forma exacta del payload por tipo de evento
//  Recomendado: registrar el webhook, mandar UN evento de prueba,
//  revisar `webhook_eventos`/logs, y ajustar si hace falta antes
//  de confiar en esto para producción.
// ============================================================

// Verifica la clave secreta que va en la URL del webhook (?clave=...). Se usa esto
// en vez de la firma HMAC porque los webhooks creados desde el dashboard de Loyverse
// (a diferencia de los creados vía OAuth 2.0) no envían header de firma.
function claveWebhookValida(env, url) {
  const esperada = env.LOYVERSE_WEBHOOK_SECRET;
  if (!esperada) return true; // sin clave configurada, no se valida (solo para pruebas)
  return url.searchParams.get("clave") === esperada;
}

async function eventoYaProcesado(env, eventId) {
  return !!(await get(env, "SELECT event_id FROM webhook_eventos WHERE event_id = ?", eventId));
}

async function marcarEventoProcesado(env, eventId, tipo) {
  await run(env, "INSERT OR IGNORE INTO webhook_eventos (event_id, tipo, recibido_en) VALUES (?,?,?)", eventId, tipo, fechaHoraDDMMAAAA());
}

// Aplica cambios de stock recibidos por webhook (inventory_levels.update).
// Solo toca `stock`, no vuelve a tocar precio/nombre/etc.
async function aplicarCambiosInventario(env, niveles) {
  if (!niveles || !niveles.length) return 0;
  const { storeId } = await obtenerStoreId(env);
  let actualizados = 0;
  for (const nivel of niveles) {
    if (nivel.store_id && nivel.store_id !== storeId) continue; // otra tienda, no nos afecta
    const fila = await get(env, "SELECT sku FROM productos WHERE variant_id = ?", nivel.variant_id);
    if (!fila) continue; // producto no está en D1 todavía (ej. creado fuera de la app) — un sync completo lo traerá
    await run(env, "UPDATE productos SET stock = ? WHERE sku = ?", nivel.in_stock, fila.sku);
    actualizados++;
  }
  return actualizados;
}

// Aplica ventas recibidas por webhook (receipts.update): guarda una fila por
// sku vendido en `ventas`, para poder calcular v7/v14 (ventas de los últimos
// 7/14 días) sin volver a golpear la API de Loyverse en cada carga del catálogo.
// Se ignoran recibos anulados. Las devoluciones (REFUND) restan cantidad.
async function aplicarVentas(env, receipts) {
  if (!receipts || !receipts.length) return 0;
  let procesados = 0;
  for (const r of receipts) {
    if (r.cancelled_at) continue; // recibo anulado, no cuenta como venta
    if (!r.line_items || !r.line_items.length) continue;
    const receiptId = String(r.receipt_number || r.id || "");
    if (!receiptId) continue;
    const fechaVenta = fechaISO(new Date(r.receipt_date || r.created_at || Date.now()));
    const signo = r.receipt_type === "REFUND" ? -1 : 1;

    // Suma por sku dentro del mismo recibo (un producto puede aparecer en más de
    // una línea si se vendió con distinto precio/descuento).
    const porSku = {};
    for (const li of r.line_items) {
      const fila = await get(env, "SELECT sku FROM productos WHERE variant_id = ?", li.variant_id);
      if (!fila) continue; // producto no está en D1 todavía
      porSku[fila.sku] = (porSku[fila.sku] || 0) + signo * (Number(li.quantity) || 0);
    }
    for (const sku of Object.keys(porSku)) {
      await run(env,
        `INSERT INTO ventas (receipt_id, sku, cantidad, fecha_venta) VALUES (?,?,?,?)
         ON CONFLICT(receipt_id, sku) DO UPDATE SET cantidad = excluded.cantidad, fecha_venta = excluded.fecha_venta`,
        receiptId, sku, porSku[sku], fechaVenta);
      procesados++;
    }
  }
  return procesados;
}


// costo, categoría, código de barras, IVA. Nunca toca `stock` (eso lo maneja el
// webhook de inventario) ni `proveedor`/`sector` (campos propios de la app).
async function aplicarCambiosItems(env, items) {
  if (!items || !items.length) return 0;

  const categorias = await loyverseGetAll(env, "/categories", "categories");
  const mapaCategorias = {};
  categorias.forEach(c => { mapaCategorias[c.id] = c.name; });

  let ivaTaxId = null;
  try { ivaTaxId = await obtenerIvaTaxId(env); } catch (e) { /* no bloquea */ }

  let actualizados = 0;
  for (const it of items) {
    const v = (it.variants && it.variants[0]) ? it.variants[0] : null;
    if (!v || !v.sku) continue;

    let precio = v.default_price;
    if (v.stores && v.stores[0] && v.stores[0].price != null) precio = v.stores[0].price;
    const peso = !!(it.sold_by_weight || it.soldByWeight);
    const conIva = ivaTaxId ? (Array.isArray(it.tax_ids) && it.tax_ids.includes(ivaTaxId)) : false;

    await run(env,
      `INSERT INTO productos (sku, id_loyverse, variant_id, nombre, categoria, barcode, precio, costo, sold_by_weight, track_stock, con_iva)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(sku) DO UPDATE SET
         id_loyverse=excluded.id_loyverse, variant_id=excluded.variant_id, nombre=excluded.nombre,
         categoria=excluded.categoria, barcode=excluded.barcode, precio=excluded.precio,
         costo=excluded.costo, sold_by_weight=excluded.sold_by_weight,
         track_stock=excluded.track_stock, con_iva=excluded.con_iva`,
      v.sku, it.id, v.variant_id, it.item_name, mapaCategorias[it.category_id] || "SIN CATEGORÍA",
      v.barcode || "", precio || 0, v.cost || 0, peso ? 1 : 0, it.track_stock ? 1 : 0, conIva ? 1 : 0);
    actualizados++;
  }
  return actualizados;
}

// Punto de entrada: recibe el POST crudo de Loyverse, valida la clave de la URL,
// evita reprocesar duplicados, y delega según el tipo de evento.
async function manejarWebhookLoyverse(request, env, url) {
  if (!claveWebhookValida(env, url)) return json({ ok: false, error: "Clave inválida" }, 401);

  const rawBody = await request.text();
  let evento;
  try { evento = JSON.parse(rawBody); } catch (e) { return json({ ok: false, error: "JSON inválido" }, 400); }

  const tipo = evento.type || evento.event_type || "desconocido";
  const eventId = evento.id || evento.event_id || (tipo + ":" + (evento.created_at || Date.now()));

  if (await eventoYaProcesado(env, eventId)) {
    return json({ ok: true, ignorado: true, motivo: "evento ya procesado" });
  }

  const resultado = { tipo, procesados: 0 };
  try {
    if (tipo === "inventory_levels.update" && evento.inventory_levels) {
      resultado.procesados = await aplicarCambiosInventario(env, evento.inventory_levels);
    } else if (tipo === "items.update" && evento.items) {
      resultado.procesados = await aplicarCambiosItems(env, evento.items);
    } else if (tipo === "receipts.update" && evento.receipts) {
      resultado.procesados = await aplicarVentas(env, evento.receipts);
    } else {
      resultado.noManejado = true; // tipo recibido pero sin handler todavía (se registra igual)
    }
    if (resultado.procesados > 0) await marcarCatalogoActualizado(env);
  } finally {
    await marcarEventoProcesado(env, eventId, tipo);
  }

  return json({ ok: true, ...resultado });
}

// ============================================================
//  CATÁLOGO COMPACTO (D1 → frontend)
//  Se usa para cargar TODOS los productos una sola vez al abrir
//  la app (igual que Marín) y buscar después en el teléfono sin
//  gastar datos ni esperar al servidor en cada letra escrita.
//  Los nombres de campo van abreviados a propósito (ref, prov,
//  coste...) para que el JSON pese menos en 3G/4G.
// ============================================================
async function catalogoCompacto(env) {
  await asegurarTablas(env); // por si la columna con_iva u otra migración aún no se aplicó
  const { results } = await env.DB.prepare(
    `SELECT sku, nombre, categoria, proveedor, sector, barcode, precio, costo, stock, sold_by_weight, track_stock, con_iva
     FROM productos ORDER BY nombre`
  ).all();

  const [v7, v14] = await Promise.all([ventasPorSku(env, 7), ventasPorSku(env, 14)]);

  return results.map(p => ({
    ref: p.sku,
    nombre: p.nombre,
    cat: p.categoria || "",
    prov: p.proveedor || "SIN PROVEEDOR",
    sector: p.sector || "",
    barcode: p.barcode || "",
    precio: p.precio || 0,
    coste: p.costo || 0,
    stock: p.stock,
    peso: !!p.sold_by_weight,
    track: !!p.track_stock,
    iva: !!p.con_iva,
    v7: v7[p.sku] || 0,
    v14: v14[p.sku] || 0
  }));
}


// ============================================================
//  RECIBIR MERCADERÍA — registra el lote (con o sin fecha de
//  vencimiento), suma el stock en Loyverse, y opcionalmente
//  actualiza costo/precio. Todo en un solo paso desde la app.
// ============================================================
async function accionLoteNuevo(env, payload) {
  payload = payload || {};
  const sku = String(payload.sku || "").trim();
  if (!sku) throw new Error("Falta el SKU del producto");

  const it = await get(env, "SELECT * FROM productos WHERE sku = ?", sku);
  if (!it) throw new Error("Producto no encontrado en el catálogo local (sincroniza el catálogo si es reciente): " + sku);

  const cantidad = Number(payload.cantidad) || 0;
  const precioNuevo = payload.precio != null && payload.precio !== "" ? Number(payload.precio) : null;
  const costoNuevo = payload.costo != null && payload.costo !== "" ? Number(payload.costo) : null;
  const proveedorNuevo = payload.proveedor != null ? String(payload.proveedor).trim() : null;
  const sectorNuevo = payload.sector != null ? String(payload.sector).trim() : null;

  // Cantidad 0 es válida SOLO si viene acompañada de un cambio de precio/costo/proveedor/
  // sector — permite editar esos campos de un producto ya creado sin recibir stock nuevo.
  if (cantidad <= 0 && precioNuevo == null && costoNuevo == null && proveedorNuevo == null && sectorNuevo == null) {
    throw new Error("Indica una cantidad recibida, o un cambio de precio/costo/proveedor/sector");
  }

  const fechaTxt = String(payload.fechaVencimiento || "").trim();
  const tieneFecha = fechaTxt !== "";
  if (tieneFecha && !parseFechaDDMMAAAA(fechaTxt)) throw new Error("Fecha de vencimiento inválida (usa DD/MM/AAAA)");

  const unidad = it.sold_by_weight ? "kg" : "un";
  const fechaIngreso = fechaDDMMAAAA();

  const out = {
    fecha: fechaIngreso, sku, nombre: it.nombre,
    categoria: it.categoria, unidad, cantidad, fechaVencimiento: fechaTxt, nuevoStock: null
  };

  if (cantidad > 0) {
    // 1) Registrar el lote de vencimiento (si trae fecha) — se guarda igual aunque no
    //    tenga fecha, para dejar rastro de la recepción, con estado "Sin fecha". Se
    //    omite por completo si no hubo recepción de stock (cantidad 0, solo edición
    //    de precio/costo), para no dejar lotes fantasma en la tabla de vencimientos.
    const insertRes = await run(env,
      `INSERT INTO vencimientos (fecha_ingreso, sku, producto, categoria, unidad, lote, cantidad, fecha_vencimiento, estado, fecha_revision, revisado_por)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      fechaIngreso, sku, it.nombre, it.categoria, unidad, payload.lote || "", cantidad,
      fechaTxt, tieneFecha ? "Pendiente" : "Sin fecha", "", "");
    out.filaIndex = insertRes.meta.last_row_id;

    // 2) Sumar stock en Loyverse (el paso más importante — si falla, se avisa pero no
    //    se corta el resto: el lote de vencimiento ya quedó guardado igual).
    try {
      const res = await sumarStockLoyverse(env, it, cantidad);
      if (res.ok) {
        out.nuevoStock = res.despues;
        await run(env,
          `INSERT INTO auditoria (fecha, accion, sku, producto, categoria, id_loyverse, stock, motivo, responsable)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          fechaHoraDDMMAAAA(), "recepcion_stock", sku, it.nombre, it.categoria, it.id_loyverse, res.despues,
          "Recepción de mercadería: +" + cantidad + " " + unidad + " (" + res.antes + " → " + res.despues + ")" +
          (tieneFecha ? " · vence " + fechaTxt : ""), payload.responsable || "");
      } else {
        out.avisoStock = "⚠️ No se pudo sumar el stock en Loyverse (" + res.motivo + "). Revísalo a mano.";
      }
    } catch (e) {
      out.avisoStock = "⚠️ No se pudo sumar el stock en Loyverse: " + e.message;
    }
  }

  // 3) Costo y/o precio (opcional): mismo patrón seguro (leer completo → modificar →
  //    reenviar) para no crear un producto nuevo ni perder otros campos de la variante.
  if (precioNuevo != null || costoNuevo != null) {
    if (!it.id_loyverse || !it.variant_id) {
      out.avisoStock = (out.avisoStock ? out.avisoStock + " " : "") + "⚠️ No se pudo actualizar costo/precio: falta id de Loyverse.";
    } else {
      try {
        await actualizarPrecioCostoLoyverse(env, it.id_loyverse, it.variant_id, precioNuevo, costoNuevo);
        const sets = [], vals = [];
        if (precioNuevo != null) { sets.push("precio = ?"); vals.push(precioNuevo); }
        if (costoNuevo != null) { sets.push("costo = ?"); vals.push(costoNuevo); }
        vals.push(sku);
        await run(env, "UPDATE productos SET " + sets.join(", ") + " WHERE sku = ?", ...vals);
        out.precioAplicado = precioNuevo != null ? precioNuevo : it.precio;
        out.costoAplicado = costoNuevo != null ? costoNuevo : it.costo;
        // Deja rastro en auditoría solo cuando es una edición SIN recepción de stock —
        // el caso con stock ya queda registrado en el "recepcion_stock" del paso 2.
        if (cantidad <= 0) {
          const detalle = [];
          if (precioNuevo != null) detalle.push("precio → $" + precioNuevo);
          if (costoNuevo != null) detalle.push("costo → $" + costoNuevo);
          await run(env,
            `INSERT INTO auditoria (fecha, accion, sku, producto, categoria, id_loyverse, stock, motivo, responsable)
             VALUES (?,?,?,?,?,?,?,?,?)`,
            fechaHoraDDMMAAAA(), "editar_precio_costo", sku, it.nombre, it.categoria, it.id_loyverse, null,
            "Edición de " + detalle.join(" y "), payload.responsable || "");
        }
      } catch (e) {
        out.avisoStock = (out.avisoStock ? out.avisoStock + " " : "") + "⚠️ Costo/precio no se pudo actualizar en Loyverse (" + e.message + ").";
      }
    }
  }

  // 4) Proveedor y/o sector (opcional): son campos solo locales (no existen en Loyverse),
  //    así que se actualizan directo en D1 sin tocar nada más del producto. Si el valor
  //    es nuevo, queda guardado también en el catálogo reutilizable para la próxima vez.
  if (proveedorNuevo != null || sectorNuevo != null) {
    const sets = [], vals = [];
    if (proveedorNuevo != null) { sets.push("proveedor = ?"); vals.push(proveedorNuevo || null); }
    if (sectorNuevo != null) { sets.push("sector = ?"); vals.push(sectorNuevo || null); }
    vals.push(sku);
    await run(env, "UPDATE productos SET " + sets.join(", ") + " WHERE sku = ?", ...vals);
    if (proveedorNuevo) await run(env, "INSERT OR IGNORE INTO proveedores (nombre) VALUES (?)", proveedorNuevo);
    if (sectorNuevo) await run(env, "INSERT OR IGNORE INTO sectores (nombre) VALUES (?)", sectorNuevo);
    out.proveedorAplicado = proveedorNuevo != null ? proveedorNuevo : it.proveedor;
    out.sectorAplicado = sectorNuevo != null ? sectorNuevo : it.sector;
  }

  return out;
}

// ============================================================
//  AJUSTE MANUAL DE STOCK — para corregir errores (conteo,
//  ingreso duplicado, merma, etc.) sin pasar por "recepción".
//  Queda registrado en `auditoria` con todos los datos exigidos:
//  fecha, responsable, motivo, stock anterior, ajuste y stock final.
// ============================================================
async function accionAjustarStock(env, payload) {
  payload = payload || {};
  const sku = String(payload.sku || "").trim();
  if (!sku) throw new Error("Falta el SKU del producto");

  const cantidad = Number(payload.cantidad);
  if (!cantidad) throw new Error("Indica una cantidad de ajuste distinta de 0 (positiva para sumar, negativa para restar)");

  const motivo = String(payload.motivo || "").trim();
  if (!motivo) throw new Error("Indica el motivo del ajuste");

  const responsable = String(payload.responsable || "").trim();
  if (!responsable) throw new Error("Indica el usuario responsable del ajuste");

  const it = await get(env, "SELECT * FROM productos WHERE sku = ?", sku);
  if (!it) throw new Error("Producto no encontrado en el catálogo local: " + sku);

  const res = await sumarStockLoyverse(env, it, cantidad);
  if (!res.ok) throw new Error("No se pudo ajustar el stock en Loyverse (" + res.motivo + ")");

  const fecha = fechaHoraDDMMAAAA();
  await run(env,
    `INSERT INTO auditoria (fecha, accion, sku, producto, categoria, id_loyverse, stock, motivo, responsable)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    fecha, "ajuste_stock", sku, it.nombre, it.categoria, it.id_loyverse, res.despues,
    motivo + " · Stock anterior: " + res.antes + " · Ajuste: " + (cantidad > 0 ? "+" : "") + cantidad + " · Stock final: " + res.despues,
    responsable);

  return { sku, nombre: it.nombre, fecha, stockAnterior: res.antes, cantidadAjustada: cantidad, stockFinal: res.despues, motivo, responsable };
}

// ============================================================
//  HISTORIAL DE UN PRODUCTO — últimos movimientos de auditoría
//  (recepciones, ajustes, ediciones de precio/costo) para mostrar
//  en "Recibir productos" y permitir revisar qué pasó y quién lo hizo.
// ============================================================
async function historialProducto(env, sku) {
  const { results } = await env.DB.prepare(
    "SELECT fecha, accion, stock, motivo, responsable FROM auditoria WHERE sku = ? ORDER BY id DESC LIMIT 30"
  ).bind(sku).all();
  return results;
}

// ============================================================
//  VENCIMIENTOS (Módulo 5) — lista de lotes con fecha de
//  vencimiento y cambio de estado (Cambiado / Descuento recibido /
//  Desechado), con retiro opcional de stock en Loyverse.
// ============================================================

// Días restantes hasta la fecha de vencimiento (negativo = ya vencido).
// Devuelve null si el lote no tiene fecha cargada.
function diasRestantes(fechaTxt) {
  const d = parseFechaDDMMAAAA(fechaTxt);
  if (!d) return null;
  const hoy = parseFechaDDMMAAAA(fechaDDMMAAAA());
  return Math.round((d - hoy) / 86400000);
}

// Clasifica la urgencia para pintar la fila en la app:
//  vencido (<0d) / urgente (0-3d) / proximo (4-7d) / ok (>7d) / sin_fecha
function urgenciaDe(dias) {
  if (dias == null) return "sin_fecha";
  if (dias < 0) return "vencido";
  if (dias <= 3) return "urgente";
  if (dias <= 7) return "proximo";
  return "ok";
}

// GET /?action=vencimientos[&estado=Pendiente][&sku=XXXX]
// Por defecto trae los lotes "activos" (Pendiente / Revisado / Sin fecha),
// ordenados por fecha de vencimiento más próxima primero. Si se pasa
// estado=todos, trae también los ya cerrados (Cambiado/Descuento recibido/Desechado).
async function listaVencimientos(env, { estado, sku } = {}) {
  let sql = "SELECT * FROM vencimientos WHERE 1=1";
  const params = [];
  if (sku) { sql += " AND sku = ?"; params.push(sku); }
  if (estado && estado !== "todos") { sql += " AND estado = ?"; params.push(estado); }
  else if (!estado) { sql += " AND estado NOT IN ('Cambiado','Descuento recibido','Desechado')"; }
  sql += " ORDER BY (fecha_vencimiento = '') ASC, id DESC";
  const { results } = await env.DB.prepare(sql).bind(...params).all();
  return results.map(r => {
    const dias = diasRestantes(r.fecha_vencimiento);
    return { ...r, diasRestantes: dias, urgencia: urgenciaDe(dias) };
  }).sort((a, b) => {
    // Vencidos y urgentes primero; sin fecha al final.
    const rank = v => v.diasRestantes == null ? 999999 : v.diasRestantes;
    return rank(a) - rank(b);
  });
}

// POST { action:'vencimiento_estado', payload:{ id, estado, responsable,
//        retirarStock (bool), cantidadRetiro } }
//  → cambia el estado del lote (Revisado, Cambiado, Descuento recibido,
//    Desechado) y, si retirarStock es true, resta esa cantidad del stock
//    en Loyverse (retiro de góndola) dejando registro en auditoría.
const ESTADOS_VENCIMIENTO = ["Pendiente", "Revisado", "Cambiado", "Descuento recibido", "Desechado", "Sin fecha"];
async function accionVencimientoEstado(env, payload) {
  payload = payload || {};
  const id = Number(payload.id);
  if (!id) throw new Error("Falta el id del lote");

  const estado = String(payload.estado || "").trim();
  if (!ESTADOS_VENCIMIENTO.includes(estado)) throw new Error("Estado inválido: " + estado);

  const responsable = String(payload.responsable || "").trim();
  if (!responsable) throw new Error("Indica el usuario responsable");

  const lote = await get(env, "SELECT * FROM vencimientos WHERE id = ?", id);
  if (!lote) throw new Error("Lote no encontrado");

  const fecha = fechaHoraDDMMAAAA();
  const out = { id, estado, retiroStock: null };

  // Retiro de góndola: resta stock en Loyverse solo para estados de cierre
  // (el producto sale de la venta) y solo si el usuario lo pidió explícitamente.
  const estadosQueRetiran = ["Cambiado", "Descuento recibido", "Desechado"];
  if (payload.retirarStock && estadosQueRetiran.includes(estado)) {
    const cantidadRetiro = Number(payload.cantidadRetiro) || Number(lote.cantidad) || 0;
    if (cantidadRetiro > 0) {
      const it = await get(env, "SELECT * FROM productos WHERE sku = ?", lote.sku);
      if (!it) throw new Error("Producto no encontrado en el catálogo local: " + lote.sku);
      const res = await sumarStockLoyverse(env, it, -cantidadRetiro);
      if (res.ok) {
        out.retiroStock = { antes: res.antes, despues: res.despues, cantidad: cantidadRetiro };
        await run(env,
          `INSERT INTO auditoria (fecha, accion, sku, producto, categoria, id_loyverse, stock, motivo, responsable)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          fecha, "retiro_gondola", lote.sku, lote.producto, lote.categoria, it.id_loyverse, res.despues,
          "Retiro de góndola (" + estado + "): -" + cantidadRetiro + " " + lote.unidad + " (" + res.antes + " → " + res.despues + ") · lote vence " + lote.fecha_vencimiento,
          responsable);
      } else {
        out.avisoStock = "⚠️ No se pudo descontar el stock en Loyverse (" + res.motivo + "). Revísalo a mano.";
      }
    }
  }

  await run(env,
    `UPDATE vencimientos SET estado = ?, fecha_revision = ?, revisado_por = ? WHERE id = ?`,
    estado, fecha, responsable, id);

  return out;
}

// ============================================================
//  SINCRONIZACIÓN MANUAL DE VENTAS (Módulo 4 — Armar pedido)
//  El día a día se alimenta solo con el webhook receipts.update
//  (tiempo real, sin golpear la API). Esta función es para el
//  historial previo a instalar el webhook, o para rellenar un
//  hueco puntual — se dispara a mano con el botón "Actualizar
//  ventas", nunca de forma automática/periódica.
// ============================================================
async function accionSyncVentas(env, dias) {
  const diasBack = Number(dias) || 14;
  const { storeId } = await obtenerStoreId(env);
  const desde = new Date(Date.now() - diasBack * 86400000);

  const receipts = await loyverseGetAll(env, "/receipts", "receipts", {
    store_id: storeId,
    created_at_min: desde.toISOString(),
    created_at_max: new Date().toISOString()
  });

  const procesados = await aplicarVentas(env, receipts);
  return { recibos: receipts.length, lineasGuardadas: procesados, dias: diasBack };
}

// Ventas de los últimos N días por sku — usado para armar el mapa v7/v14 que se
// suma al catálogo compacto. Lee solo D1 (rápido, no toca la API de Loyverse).
async function ventasPorSku(env, dias) {
  const desde = fechaISO(new Date(Date.now() - dias * 86400000));
  const { results } = await env.DB.prepare(
    "SELECT sku, SUM(cantidad) as total FROM ventas WHERE fecha_venta >= ? GROUP BY sku"
  ).bind(desde).all();
  const mapa = {};
  results.forEach(r => { mapa[r.sku] = r.total || 0; });
  return mapa;
}


//  buscador con creación rápida (Módulo 3). Se combinan con los
//  valores ya usados en `productos` por si algún producto viejo
//  trae un proveedor/sector que todavía no está en el catálogo.
// ============================================================
// ============================================================
//  PROVEEDORES Y SECTORES — catálogos reutilizables para el
//  buscador con creación rápida (Módulo 3). Se combinan con los
//  valores ya usados en `productos` por si algún producto viejo
//  trae un proveedor/sector que todavía no está en el catálogo.
// ============================================================
async function catalogoProveedoresSectores(env) {
  const [provLookup, provProductos, secLookup, secProductos] = await Promise.all([
    env.DB.prepare("SELECT nombre FROM proveedores").all(),
    env.DB.prepare("SELECT DISTINCT proveedor as nombre FROM productos WHERE proveedor IS NOT NULL AND proveedor != ''").all(),
    env.DB.prepare("SELECT nombre FROM sectores").all(),
    env.DB.prepare("SELECT DISTINCT sector as nombre FROM productos WHERE sector IS NOT NULL AND sector != ''").all(),
  ]);
  const proveedores = [...new Set([...provLookup.results.map(r => r.nombre), ...provProductos.results.map(r => r.nombre)])].sort((a, b) => a.localeCompare(b, "es"));
  const sectores = [...new Set([...secLookup.results.map(r => r.nombre), ...secProductos.results.map(r => r.nombre)])].sort((a, b) => a.localeCompare(b, "es"));
  return { proveedores, sectores };
}

async function accionCrearProveedor(env, payload) {
  const nombre = String((payload || {}).nombre || "").trim();
  if (!nombre) throw new Error("Falta el nombre del proveedor");
  await run(env, "INSERT OR IGNORE INTO proveedores (nombre) VALUES (?)", nombre);
  return { nombre };
}

async function accionCrearSector(env, payload) {
  const nombre = String((payload || {}).nombre || "").trim();
  if (!nombre) throw new Error("Falta el nombre del sector");
  await run(env, "INSERT OR IGNORE INTO sectores (nombre) VALUES (?)", nombre);
  return { nombre };
}

// ============================================================
//  ACTIVAR SEGUIMIENTO DE INVENTARIO
//  Algunos productos en Loyverse se crearon sin "track_stock" —
//  sin esto activado, Loyverse no permite sumar/restar stock.
//  Se activa reenviando el ítem completo con track_stock=true.
// ============================================================
async function accionHabilitarTrackStock(env, payload) {
  const sku = String((payload && payload.sku) || "").trim();
  if (!sku) throw new Error("Falta el SKU");
  const it = await get(env, "SELECT * FROM productos WHERE sku = ?", sku);
  if (!it) throw new Error("Producto no encontrado: " + sku);
  if (it.track_stock) return { ok: true, yaEstaba: true };
  if (!it.id_loyverse) throw new Error("Falta el id de Loyverse (vuelve a sincronizar el catálogo)");

  const item = await loyverseGet(env, "/items/" + it.id_loyverse, {});
  await loyversePost(env, "/items", Object.assign({}, item, { track_stock: true }));
  await run(env, "UPDATE productos SET track_stock = 1, stock = COALESCE(stock, 0) WHERE sku = ?", sku);
  return { ok: true, yaEstaba: false };
}


// ============================================================
//  ACTIVAR IVA
//  Algunos productos quedaron creados en Loyverse SIN el impuesto
//  IVA asignado (ej. porque al crearlos no se pudo detectar el
//  impuesto todavía). Sin esto, Loyverse vende el producto sin
//  cobrar IVA. Se activa reenviando el ítem completo con el
//  impuesto IVA agregado a su lista de taxes (sin tocar otros
//  impuestos que ya pudiera tener).
// ============================================================
async function accionActivarIva(env, payload) {
  const sku = String((payload && payload.sku) || "").trim();
  if (!sku) throw new Error("Falta el SKU");
  const it = await get(env, "SELECT * FROM productos WHERE sku = ?", sku);
  if (!it) throw new Error("Producto no encontrado: " + sku);
  if (it.con_iva) return { ok: true, yaEstaba: true };
  if (!it.id_loyverse) throw new Error("Falta el id de Loyverse (vuelve a sincronizar el catálogo)");

  const ivaTaxId = await obtenerIvaTaxId(env);
  const item = await loyverseGet(env, "/items/" + it.id_loyverse, {});
  const taxIdsActuales = Array.isArray(item.tax_ids) ? item.tax_ids : [];
  const yaTieneEseImpuesto = taxIdsActuales.includes(ivaTaxId);
  const nuevosTaxIds = yaTieneEseImpuesto ? taxIdsActuales : [...taxIdsActuales, ivaTaxId];

  const actualizado = await loyversePost(env, "/items", Object.assign({}, item, { tax_ids: nuevosTaxIds }));

  // Verificación real contra lo que Loyverse devolvió — antes esto se daba por hecho
  // sin comprobar, así que el botón podía marcarse "activado" sin que el impuesto
  // realmente hubiera quedado asignado en Loyverse.
  const confirmado = Array.isArray(actualizado.tax_ids) && actualizado.tax_ids.includes(ivaTaxId);
  if (!confirmado) throw new Error("Loyverse no confirmó el impuesto asignado (revisa el impuesto IVA en el Back Office)");

  await run(env, "UPDATE productos SET con_iva = 1 WHERE sku = ?", sku);
  return { ok: true, yaEstaba: false };
}


//  Confirmado contra la documentación/comportamiento real de la
//  API de Loyverse: POST /items sin "id" crea un ítem nuevo (no
//  existe un endpoint separado "crear producto" — es el mismo
//  POST que se usa para actualizar, la diferencia es no mandar id).
//  El SKU se asigna automáticamente (numérico correlativo de 5
//  dígitos) para que el usuario no tenga que inventar uno.
// ============================================================
// ============================================================
//  DUPLICADOS POR CÓDIGO DE BARRAS
//  Devuelve todos los productos que comparten el mismo barcode —
//  puede pasar si se creó el mismo producto más de una vez, en
//  Loyverse directo o desde la app antes de tener este chequeo.
// ============================================================
async function buscarPorBarcode(env, barcode) {
  barcode = String(barcode || "").trim();
  if (!barcode) return [];
  const { results } = await env.DB.prepare(
    "SELECT sku, nombre, categoria, proveedor, sector, barcode, precio, costo, stock, sold_by_weight, track_stock, con_iva FROM productos WHERE barcode = ?"
  ).bind(barcode).all();
  return results;
}

// ============================================================
//  FICHA COMPLETA DE UN PRODUCTO (para editar todo, tipo Loyverse)
// ============================================================
async function fichaProducto(env, sku) {
  const it = await get(env, "SELECT * FROM productos WHERE sku = ?", sku);
  if (!it) throw new Error("Producto no encontrado: " + sku);
  return it;
}

// ============================================================
//  EDITAR PRODUCTO (ficha completa) — reenvía el ítem completo a
//  Loyverse con los campos que vinieron en el payload, igual que
//  actualizarPrecioCostoLoyverse pero para todos los campos editables
//  de golpe (nombre, barcode, precio, costo, categoría no se toca
//  porque Loyverse la controla por category_id, no por texto).
// ============================================================
async function accionEditarProducto(env, payload) {
  payload = payload || {};
  const sku = String(payload.sku || "").trim();
  if (!sku) throw new Error("Falta el SKU");
  const it = await get(env, "SELECT * FROM productos WHERE sku = ?", sku);
  if (!it) throw new Error("Producto no encontrado: " + sku);
  if (!it.id_loyverse || !it.variant_id) throw new Error("Falta id de Loyverse (vuelve a sincronizar el catálogo)");

  const nuevoBarcode = payload.barcode != null ? String(payload.barcode).trim() : it.barcode;
  if (nuevoBarcode && nuevoBarcode !== it.barcode) {
    const dup = await get(env, "SELECT sku FROM productos WHERE barcode = ? AND sku != ?", nuevoBarcode, sku);
    if (dup) throw new Error("Ese código de barras ya lo usa el SKU " + dup.sku);
  }

  const item = await loyverseGet(env, "/items/" + it.id_loyverse, {});
  const nombre = payload.nombre != null ? String(payload.nombre).trim() : it.nombre;
  const precio = payload.precio != null && payload.precio !== "" ? Number(payload.precio) : it.precio;
  const costo = payload.costo != null && payload.costo !== "" ? Number(payload.costo) : it.costo;
  const soldByWeight = payload.soldByWeight != null ? !!payload.soldByWeight : !!it.sold_by_weight;

  const variantes = (item.variants || []).map(v => {
    if (v.variant_id !== it.variant_id) return v;
    const copia = Object.assign({}, v, { barcode: nuevoBarcode, cost: costo, default_price: precio });
    if (copia.stores && copia.stores[0]) copia.stores[0].price = precio;
    return copia;
  });
  await loyversePost(env, "/items", Object.assign({}, item, { item_name: nombre, sold_by_weight: soldByWeight, variants: variantes }));

  const proveedor = payload.proveedor != null ? String(payload.proveedor).trim() : it.proveedor;
  const sector = payload.sector != null ? String(payload.sector).trim() : it.sector;
  await run(env,
    "UPDATE productos SET nombre=?, barcode=?, precio=?, costo=?, sold_by_weight=?, proveedor=?, sector=? WHERE sku=?",
    nombre, nuevoBarcode, precio, costo, soldByWeight ? 1 : 0, proveedor || null, sector || null, sku);
  if (proveedor) await run(env, "INSERT OR IGNORE INTO proveedores (nombre) VALUES (?)", proveedor);
  if (sector) await run(env, "INSERT OR IGNORE INTO sectores (nombre) VALUES (?)", sector);

  await run(env,
    `INSERT INTO auditoria (fecha, accion, sku, producto, categoria, id_loyverse, stock, motivo, responsable)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    fechaHoraDDMMAAAA(), "editar_producto", sku, nombre, it.categoria, it.id_loyverse, it.stock, "Ficha editada desde la app", payload.responsable || "");

  return { sku, nombre, precio, costo, barcode: nuevoBarcode, proveedor, sector, peso: soldByWeight };
}

// ============================================================
//  ELIMINAR PRODUCTO — borrado real en Loyverse (irreversible).
//  Se pide confirmación en el frontend antes de llamar esto.
// ============================================================
async function accionEliminarProducto(env, payload) {
  const sku = String((payload || {}).sku || "").trim();
  if (!sku) throw new Error("Falta el SKU");
  const it = await get(env, "SELECT * FROM productos WHERE sku = ?", sku);
  if (!it) throw new Error("Producto no encontrado: " + sku);

  if (it.id_loyverse) {
    const res = await fetch(LOYVERSE_API + "/items/" + it.id_loyverse, {
      method: "DELETE",
      headers: { "Authorization": "Bearer " + env.LOYVERSE_API_TOKEN }
    });
    // 404 = ya no existe en Loyverse (igual se limpia de D1 abajo); cualquier otro
    // error sí se reporta, porque puede ser una falla real que conviene saber.
    if (!res.ok && res.status !== 404) {
      throw new Error("Loyverse HTTP " + res.status + ": " + (await res.text()).slice(0, 200));
    }
  }

  await run(env, "DELETE FROM productos WHERE sku = ?", sku);
  await run(env,
    `INSERT INTO auditoria (fecha, accion, sku, producto, categoria, id_loyverse, stock, motivo, responsable)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    fechaHoraDDMMAAAA(), "eliminar_producto", sku, it.nombre, it.categoria, it.id_loyverse, it.stock, "Eliminado desde la app", (payload || {}).responsable || "");

  return { sku, nombre: it.nombre };
}

// ============================================================
//  MÓDULO PROVEEDORES — listado con conteo, y productos de uno
// ============================================================
async function listaProveedoresConConteo(env) {
  const { results } = await env.DB.prepare(
    `SELECT COALESCE(NULLIF(proveedor,''), 'SIN PROVEEDOR') as proveedor, COUNT(*) as total
     FROM productos GROUP BY proveedor ORDER BY proveedor = 'SIN PROVEEDOR', proveedor COLLATE NOCASE`
  ).all();
  return results;
}

async function productosDeProveedor(env, proveedor) {
  proveedor = String(proveedor || "").trim();
  const esSinProveedor = !proveedor || proveedor === "SIN PROVEEDOR";
  const { results } = esSinProveedor
    ? await env.DB.prepare("SELECT sku, nombre, barcode, precio, costo, stock, sold_by_weight, track_stock FROM productos WHERE proveedor IS NULL OR proveedor = '' ORDER BY nombre").all()
    : await env.DB.prepare("SELECT sku, nombre, barcode, precio, costo, stock, sold_by_weight, track_stock FROM productos WHERE proveedor = ? ORDER BY nombre").bind(proveedor).all();
  return results;
}

async function accionCrearProducto(env, payload) {
  payload = payload || {};
  const nombre = String(payload.nombre || "").trim();
  if (!nombre) throw new Error("Falta el nombre del producto");

  const barcode = String(payload.barcode || "").trim();
  if (barcode && !payload.forzarDuplicado) {
    const dup = await get(env, "SELECT sku, nombre FROM productos WHERE barcode = ?", barcode);
    if (dup) throw new Error("DUPLICADO: Ese código de barras ya está en uso por '" + dup.nombre + "' (SKU " + dup.sku + ")");
  }

  // Siguiente SKU numérico de 5 dígitos disponible, siguiendo la secuencia ya usada
  // en el catálogo — solo mira SKUs que YA son de exactamente 5 dígitos, para no
  // dispararse a un número absurdo si algún producto viejo usa el barcode como SKU.
  const maxRow = await get(env,
    "SELECT MAX(CAST(sku AS INTEGER)) as maxsku FROM productos WHERE LENGTH(sku) = 5 AND sku GLOB '[0-9][0-9][0-9][0-9][0-9]'");
  let candidato = (maxRow && maxRow.maxsku ? maxRow.maxsku : 9999) + 1;
  while (await get(env, "SELECT 1 FROM productos WHERE sku = ?", String(candidato))) candidato++;
  let sku = String(candidato);

  const precio = payload.precio != null && payload.precio !== "" ? Number(payload.precio) : 0;
  const costo = payload.costo != null && payload.costo !== "" ? Number(payload.costo) : 0;
  const trackStock = payload.trackStock !== false; // por defecto SÍ sigue inventario
  const soldByWeight = !!payload.soldByWeight;
  const activo = payload.activo !== false; // por defecto SÍ está a la venta (disponible en POS)
  const quiereIva = payload.activarIva !== false; // por defecto SÍ intenta activar IVA (desmarcable para productos exentos)
  const stockMinimo = (payload.stockMinimo != null && payload.stockMinimo !== "") ? Number(payload.stockMinimo) : null;
  const proveedor = String(payload.proveedor || "").trim();
  const sector = String(payload.sector || "").trim();

  const { storeId } = await obtenerStoreId(env);

  // El IVA debe quedar activado en Loyverse desde la creación — sin esto, el producto
  // se crea "sin impuesto" y hay que activarlo a mano en Loyverse cada vez. Si por algún
  // motivo no se puede identificar el impuesto (ej. no está configurado en Loyverse
  // Back Office todavía), NO se bloquea la creación del producto — se avisa aparte para
  // que se active manualmente esta vez. Si el usuario desmarcó "IVA" a propósito (ej.
  // producto exento), no se intenta activar ni se avisa nada.
  let ivaTaxId = null;
  let taxIds = [];
  let avisoImpuesto = null;
  if (quiereIva) {
    try {
      ivaTaxId = await obtenerIvaTaxId(env);
      taxIds = [ivaTaxId];
    } catch (e) {
      avisoImpuesto = "⚠️ El producto se creó SIN impuesto activado (" + e.message + "). Actívalo a mano en Loyverse.";
    }
  }

  const nuevoItem = {
    item_name: nombre,
    track_stock: trackStock,
    sold_by_weight: soldByWeight,
    is_composite: false,
    tax_ids: taxIds,
    variants: [{
      sku: sku, barcode: barcode, cost: costo, default_price: precio, default_pricing_type: "FIXED",
      stores: [{ store_id: storeId, price: precio, pricing_type: "FIXED", available_for_sale: activo }]
    }]
  };

  // Reintenta con el siguiente SKU si Loyverse dice que ya existe (choque poco probable,
  // pero posible si D1 quedó desactualizada respecto al catálogo real).
  let creado = null, intentos = 0;
  while (!creado) {
    nuevoItem.variants[0].sku = sku;
    nuevoItem.variants[0].stores[0].price = precio;
    try {
      creado = await loyversePost(env, "/items", nuevoItem);
    } catch (e) {
      const esDuplicado = /duplicate variant sku/i.test(e.message || "");
      if (!esDuplicado || intentos >= 20) throw e;
      intentos++; candidato++; sku = String(candidato);
    }
  }
  const v = creado && creado.variants && creado.variants[0];
  if (!v || !v.variant_id) throw new Error("Loyverse no devolvió la variante creada — no se pudo confirmar");

  // Verificación real: no basta con que el POST no haya dado error — hay que confirmar
  // contra lo que Loyverse efectivamente devolvió que el impuesto quedó asignado. Si no
  // quedó (ej. el ID de IVA cacheado en D1 estaba obsoleto), se reintenta UNA vez
  // re-detectando el impuesto desde cero (ignorando el caché) antes de rendirse y avisar.
  let ivaConfirmado = ivaTaxId ? (Array.isArray(creado.tax_ids) && creado.tax_ids.includes(ivaTaxId)) : false;
  if (ivaTaxId && !ivaConfirmado) {
    try {
      const ivaTaxIdFresco = await obtenerIvaTaxId(env, true); // forzarRefresco=true, ignora el caché
      const reenviado = await loyversePost(env, "/items", Object.assign({}, creado, { tax_ids: [ivaTaxIdFresco] }));
      ivaTaxId = ivaTaxIdFresco;
      creado = reenviado;
      ivaConfirmado = Array.isArray(creado.tax_ids) && creado.tax_ids.includes(ivaTaxIdFresco);
      if (!ivaConfirmado) {
        avisoImpuesto = "⚠️ El producto se creó pero el IVA no quedó activado en Loyverse (verificado tras reintento). Actívalo desde el botón 'Activar IVA' en la app o a mano en Loyverse.";
      }
    } catch (e) {
      avisoImpuesto = "⚠️ El producto se creó pero el IVA no quedó activado (" + e.message + "). Actívalo desde el botón 'Activar IVA' en la app o a mano en Loyverse.";
    }
  }

  // Guarda en D1 (categoría queda vacía — se clasifica después desde la app; proveedor
  // y sector se guardan si vinieron del formulario de Crear producto).
  await run(env,
    `INSERT INTO productos (sku, id_loyverse, variant_id, nombre, categoria, proveedor, sector, barcode, precio, costo, stock, sold_by_weight, track_stock, con_iva)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    sku, creado.id, v.variant_id, nombre, "SIN CATEGORÍA", proveedor || null, sector || null, barcode, precio, costo, trackStock ? 0 : null, soldByWeight ? 1 : 0, trackStock ? 1 : 0, ivaConfirmado ? 1 : 0);
  if (proveedor) await run(env, "INSERT OR IGNORE INTO proveedores (nombre) VALUES (?)", proveedor);
  if (sector) await run(env, "INSERT OR IGNORE INTO sectores (nombre) VALUES (?)", sector);

  await run(env,
    `INSERT INTO auditoria (fecha, accion, sku, producto, categoria, id_loyverse, stock, motivo, responsable)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    fechaHoraDDMMAAAA(), "crear_producto", sku, nombre, "", creado.id, trackStock ? 0 : null, "Producto creado desde la app", payload.responsable || "");

  // Stock inicial opcional: usa el mismo camino de "recibir mercadería" si trae fecha de
  // vencimiento (para que el lote quede registrado desde el arranque), o lo fija directo.
  // Stock mínimo (aviso de inventario bajo): campo aparte de Loyverse (`low_stock` a nivel
  // de tienda/variante) — se manda best-effort, sin bloquear la creación si Loyverse lo
  // rechaza por algún motivo (ej. cuenta sin ese plan/feature habilitado).
  let stockFinal = trackStock ? 0 : null;
  const stockInicial = Number(payload.stockInicial) || 0;
  let avisoStockMinimo = null;
  if (trackStock) {
    if (stockInicial > 0 && payload.fechaVencimiento) {
      const r = await accionLoteNuevo(env, { sku, cantidad: stockInicial, fechaVencimiento: payload.fechaVencimiento });
      stockFinal = r.nuevoStock != null ? r.nuevoStock : stockInicial;
      if (stockMinimo != null) {
        try {
          await loyversePost(env, "/inventory", { inventory_levels: [{ variant_id: v.variant_id, store_id: storeId, low_stock: stockMinimo }] });
        } catch (e) {
          avisoStockMinimo = "⚠️ No se pudo guardar el stock mínimo en Loyverse (" + e.message + ").";
        }
      }
    } else if (stockInicial > 0 || stockMinimo != null) {
      const nivel = { variant_id: v.variant_id, store_id: storeId, stock_after: stockInicial };
      if (stockMinimo != null) nivel.low_stock = stockMinimo;
      try {
        await loyversePost(env, "/inventory", { inventory_levels: [nivel] });
        await run(env, "UPDATE productos SET stock = ? WHERE sku = ?", stockInicial, sku);
        stockFinal = stockInicial;
      } catch (e) {
        if (stockMinimo != null && stockInicial === 0) {
          avisoStockMinimo = "⚠️ No se pudo guardar el stock mínimo en Loyverse (" + e.message + ").";
        } else {
          throw e;
        }
      }
    }
  }

  return { sku, nombre, idLoyverse: creado.id, variantId: v.variant_id, precio, costo, stock: stockFinal, barcode, track: trackStock, peso: soldByWeight, iva: ivaConfirmado, avisoImpuesto, avisoStockMinimo };
}


export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // POST /webhook/loyverse — Loyverse envía su propio formato de body (no el
    // {action,payload} de la app), así que se atiende aparte y antes del parseo
    // genérico de abajo.
    if (request.method === "POST" && url.pathname === "/webhook/loyverse") {
      try {
        await asegurarTablas(env);
        return await manejarWebhookLoyverse(request, env, url);
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    }

    let action = url.searchParams.get("action");
    let payload = null;

    // Las acciones que ESCRIBEN datos (recibir mercadería, etc.) llegan por POST con
    // un body JSON { action, payload } — las de solo lectura siguen usando GET.
    if (request.method === "POST") {
      try {
        const body = await request.json();
        action = body.action || action;
        payload = body.payload || null;
      } catch (e) {
        return json({ ok: false, error: "Body inválido: se esperaba JSON" }, 400);
      }
    }

    try {
      // GET /?action=stream  →  conexión SSE en tiempo real: el celular queda "escuchando"
      // y el servidor le avisa apenas cambia algo en D1 (webhook, sync manual, ajuste,
      // vencimiento, etc.), sin que el celular tenga que preguntar. Requiere el binding
      // de Durable Object REALTIME_HUB desplegado (ver wrangler.toml / dashboard).
      if (action === "stream") {
        if (!env.REALTIME_HUB) {
          return json({ ok: false, error: "REALTIME_HUB no está configurado todavía (falta el binding del Durable Object)." }, 503);
        }
        const id = env.REALTIME_HUB.idFromName("global");
        const stub = env.REALTIME_HUB.get(id);
        const subscribeUrl = new URL(request.url);
        subscribeUrl.pathname = "/subscribe";
        return stub.fetch(new Request(subscribeUrl.toString(), { headers: request.headers }));
      }

      // GET /?action=setup  →  crea las tablas D1 si no existen
      if (action === "setup") {
        await asegurarTablas(env);
        return json({ ok: true, mensaje: "Tablas D1 verificadas/creadas correctamente." });
      }

      // GET /?action=test_loyverse  →  prueba que el token funcione
      if (action === "test_loyverse") {
        const data = await probarLoyverse(env);
        return json({ ok: true, tiendas: data.stores || data });
      }

      // GET /?action=store_id  →  detecta (o confirma) el store_id guardado
      if (action === "store_id") {
        const info = await obtenerStoreId(env);
        return json({ ok: true, ...info });
      }

      // GET /?action=reset_store_id  →  borra el store_id guardado (por si quedó mal
      // detectado, ej. token equivocado apuntando a otra tienda). La próxima llamada a
      // store_id o sync lo vuelve a detectar desde cero con el token que esté vigente.
      if (action === "reset_store_id") {
        await run(env, "DELETE FROM config WHERE clave = 'store_id'");
        return json({ ok: true, mensaje: "store_id borrado. Se detectará de nuevo en la próxima sincronización." });
      }

      // GET /?action=reset_iva_tax_id  →  borra el ID de impuesto IVA guardado en caché
      // (por si quedó apuntando a un impuesto viejo/incorrecto). La próxima creación o
      // activación de IVA lo vuelve a detectar desde cero contra Loyverse.
      if (action === "reset_iva_tax_id") {
        await run(env, "DELETE FROM config WHERE clave = 'iva_tax_id'");
        return json({ ok: true, mensaje: "iva_tax_id borrado. Se detectará de nuevo en la próxima creación/activación de IVA." });
      }

      // GET /?action=sync  →  trae el catálogo completo de Loyverse y lo guarda en D1
      if (action === "sync") {
        const resultado = await sincronizarCatalogo(env);
        await marcarCatalogoActualizado(env);
        return json({ ok: true, ...resultado });
      }

      // GET /?action=catalogo  →  devuelve TODO el catálogo compacto desde D1 (sin tocar
      // Loyverse) — esto es lo que el frontend carga una vez al abrir la app.
      if (action === "catalogo") {
        const items = await catalogoCompacto(env);
        return json({ ok: true, items, total: items.length });
      }

      // GET /?action=ultima_actualizacion  →  devuelve solo la marca de tiempo del
      // último cambio en el catálogo. Consulta muy liviana (una fila de `config`),
      // pensada para que el frontend la pregunte cada 15-20s y solo pida el catálogo
      // completo si de verdad cambió algo.
      if (action === "ultima_actualizacion") {
        const fila = await get(env, "SELECT valor FROM config WHERE clave = 'catalogo_actualizado_en'");
        return json({ ok: true, actualizadoEn: fila ? fila.valor : null });
      }

      // POST { action:'lote_nuevo', payload:{...} }  →  recibe mercadería: suma stock
      // en Loyverse, registra el lote de vencimiento, y opcionalmente actualiza costo/precio.
      if (action === "lote_nuevo") {
        const resultado = await accionLoteNuevo(env, payload);
        await marcarCatalogoActualizado(env);
        return json({ ok: true, ...resultado });
      }

      // POST { action:'crear_producto', payload:{...} }  →  crea un producto nuevo en
      // Loyverse (SKU asignado automáticamente) y lo guarda en D1.
      if (action === "crear_producto") {
        const resultado = await accionCrearProducto(env, payload);
        await marcarCatalogoActualizado(env);
        return json({ ok: true, ...resultado });
      }

      // POST { action:'habilitar_track_stock', payload:{sku} }  →  activa el seguimiento
      // de inventario de un producto que se creó sin esa opción en Loyverse.
      if (action === "habilitar_track_stock") {
        const resultado = await accionHabilitarTrackStock(env, payload);
        await marcarCatalogoActualizado(env);
        return json({ ok: true, ...resultado });
      }

      // POST { action:'activar_iva', payload:{sku} }  →  activa el impuesto IVA en
      // Loyverse para un producto que se creó/quedó sin él.
      if (action === "activar_iva") {
        const resultado = await accionActivarIva(env, payload);
        await marcarCatalogoActualizado(env);
        return json({ ok: true, ...resultado });
      }

      // POST { action:'ajustar_stock', payload:{sku,cantidad,motivo,responsable} }  →
      // corrige el stock a mano (conteo, merma, duplicado) y deja registro en auditoría.
      if (action === "ajustar_stock") {
        const resultado = await accionAjustarStock(env, payload);
        await marcarCatalogoActualizado(env);
        return json({ ok: true, ...resultado });
      }

      // GET /?action=historial_producto&sku=XXXXX  →  últimos movimientos (recepciones,
      // ajustes, ediciones) de un producto, para mostrar el historial en la app.
      if (action === "historial_producto") {
        const sku = String(url.searchParams.get("sku") || "").trim();
        if (!sku) return json({ ok: false, error: "Falta el parámetro sku" }, 400);
        const historial = await historialProducto(env, sku);
        return json({ ok: true, historial });
      }

      // GET /?action=proveedores_sectores  →  catálogos para el buscador de Proveedor/Sector.
      if (action === "proveedores_sectores") {
        const r = await catalogoProveedoresSectores(env);
        return json({ ok: true, ...r });
      }

      // POST { action:'crear_proveedor', payload:{nombre} }
      if (action === "crear_proveedor") {
        const resultado = await accionCrearProveedor(env, payload);
        return json({ ok: true, ...resultado });
      }

      // POST { action:'crear_sector', payload:{nombre} }
      if (action === "crear_sector") {
        const resultado = await accionCrearSector(env, payload);
        return json({ ok: true, ...resultado });
      }

      // GET /?action=vencimientos[&estado=Pendiente|Revisado|todos][&sku=XXXX]
      // → lotes con fecha de vencimiento, con días restantes y urgencia calculados.
      if (action === "vencimientos") {
        const estado = url.searchParams.get("estado") || "";
        const sku = url.searchParams.get("sku") || "";
        const lista = await listaVencimientos(env, { estado, sku });
        return json({ ok: true, lista });
      }

      // POST { action:'vencimiento_estado', payload:{id,estado,responsable,retirarStock,cantidadRetiro} }
      // → cambia el estado de un lote (Revisado/Cambiado/Descuento recibido/Desechado),
      //   descontando stock en Loyverse si corresponde retiro de góndola.
      if (action === "vencimiento_estado") {
        const resultado = await accionVencimientoEstado(env, payload);
        await marcarCatalogoActualizado(env);
        return json({ ok: true, ...resultado });
      }

      // GET /?action=sync_ventas[&dias=14]  →  trae recibos recientes de Loyverse y
      // los guarda en `ventas`. SOLO manual (botón "Actualizar ventas" en Armar pedido)
      // — el día a día lo cubre el webhook receipts.update, no hay polling automático.
      if (action === "sync_ventas") {
        const dias = url.searchParams.get("dias") || 14;
        const resultado = await accionSyncVentas(env, dias);
        await marcarCatalogoActualizado(env);
        return json({ ok: true, ...resultado });
      }

      // GET /?action=buscar_barcode&barcode=XXXX  →  todos los productos con ese código
      // (para detectar y listar duplicados).
      if (action === "buscar_barcode") {
        const barcode = url.searchParams.get("barcode") || "";
        const lista = await buscarPorBarcode(env, barcode);
        return json({ ok: true, lista });
      }

      // GET /?action=ficha_producto&sku=XXXX  →  ficha completa de un producto.
      if (action === "ficha_producto") {
        const sku = url.searchParams.get("sku") || "";
        const it = await fichaProducto(env, sku);
        return json({ ok: true, item: it });
      }

      // POST { action:'editar_producto', payload:{sku,...} }  →  edita nombre, barcode,
      // precio, costo, proveedor, sector, peso — reenvía a Loyverse y actualiza D1.
      if (action === "editar_producto") {
        const resultado = await accionEditarProducto(env, payload);
        await marcarCatalogoActualizado(env);
        return json({ ok: true, ...resultado });
      }

      // POST { action:'eliminar_producto', payload:{sku} }  →  borra el producto en
      // Loyverse (irreversible) y lo quita de D1.
      if (action === "eliminar_producto") {
        const resultado = await accionEliminarProducto(env, payload);
        await marcarCatalogoActualizado(env);
        return json({ ok: true, ...resultado });
      }

      // GET /?action=proveedores_conteo  →  lista de proveedores con cantidad de productos.
      if (action === "proveedores_conteo") {
        const lista = await listaProveedoresConConteo(env);
        return json({ ok: true, lista });
      }

      // GET /?action=productos_proveedor&proveedor=XXXX  →  productos de un proveedor.
      if (action === "productos_proveedor") {
        const proveedor = url.searchParams.get("proveedor") || "";
        const lista = await productosDeProveedor(env, proveedor);
        return json({ ok: true, lista });
      }

      // Sin acción reconocida: mensaje de bienvenida simple.
      return json({
        ok: true,
        mensaje: "Worker Argomedo455 activo. GET: ?action=setup, test_loyverse, store_id, reset_store_id, sync, catalogo, ultima_actualizacion, historial_producto, proveedores_sectores, vencimientos, sync_ventas, buscar_barcode, ficha_producto, proveedores_conteo, productos_proveedor. POST: lote_nuevo, crear_producto, habilitar_track_stock, activar_iva, ajustar_stock, crear_proveedor, crear_sector, vencimiento_estado, editar_producto, eliminar_producto. Webhook Loyverse: POST /webhook/loyverse",
      });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }
};

// ============================================================
//  DURABLE OBJECT: RealtimeHub
//  Mantiene abierta una conexión SSE (Server-Sent Events) por cada
//  celular conectado y les avisa al instante cuando algo cambia en
//  D1 — así el celular no tiene que preguntar cada X segundos.
//  Se usa UNA sola instancia para toda la app (idFromName("global")),
//  correcto para un solo local/tienda.
//  Requiere plan Cloudflare Workers Paid + el binding configurado
//  (ver wrangler.toml o Settings → Bindings en el dashboard):
//    [[durable_objects.bindings]]
//    name = "REALTIME_HUB"
//    class_name = "RealtimeHub"
//    [[migrations]]
//    tag = "v1"
//    new_classes = ["RealtimeHub"]
// ============================================================
export class RealtimeHub {
  constructor(state, env) {
    this.state = state;
    this.sessions = new Set(); // WritableStreamDefaultWriter de cada celular conectado
  }

  async fetch(request) {
    const url = new URL(request.url);

    // El celular se conecta acá y se queda escuchando (no se cierra la respuesta).
    if (url.pathname === "/subscribe") {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();
      await writer.write(encoder.encode(": conectado\n\n")); // comentario SSE: confirma la conexión
      this.sessions.add(writer);

      return new Response(readable, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    // El Worker principal llama acá cada vez que algo cambió en D1
    // (marcarCatalogoActualizado) — se reparte a todos los celulares conectados.
    if (url.pathname === "/broadcast" && request.method === "POST") {
      const body = await request.text();
      const encoder = new TextEncoder();
      const mensaje = encoder.encode("data: " + body + "\n\n");
      const muertos = [];
      for (const writer of this.sessions) {
        try {
          await writer.write(mensaje);
        } catch (e) {
          muertos.push(writer); // conexión cerrada del otro lado (celular sin señal, app cerrada, etc.)
        }
      }
      muertos.forEach(w => this.sessions.delete(w));
      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  }
}

