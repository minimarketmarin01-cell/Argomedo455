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
    iva: !!p.con_iva
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
async function accionCrearProducto(env, payload) {
  payload = payload || {};
  const nombre = String(payload.nombre || "").trim();
  if (!nombre) throw new Error("Falta el nombre del producto");

  const barcode = String(payload.barcode || "").trim();
  if (barcode) {
    const dup = await get(env, "SELECT sku, nombre FROM productos WHERE barcode = ?", barcode);
    if (dup) throw new Error("Ese código de barras ya está en uso por '" + dup.nombre + "' (SKU " + dup.sku + ")");
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
        return json({ ok: true, ...resultado });
      }

      // GET /?action=catalogo  →  devuelve TODO el catálogo compacto desde D1 (sin tocar
      // Loyverse) — esto es lo que el frontend carga una vez al abrir la app.
      if (action === "catalogo") {
        const items = await catalogoCompacto(env);
        return json({ ok: true, items, total: items.length });
      }

      // POST { action:'lote_nuevo', payload:{...} }  →  recibe mercadería: suma stock
      // en Loyverse, registra el lote de vencimiento, y opcionalmente actualiza costo/precio.
      if (action === "lote_nuevo") {
        const resultado = await accionLoteNuevo(env, payload);
        return json({ ok: true, ...resultado });
      }

      // POST { action:'crear_producto', payload:{...} }  →  crea un producto nuevo en
      // Loyverse (SKU asignado automáticamente) y lo guarda en D1.
      if (action === "crear_producto") {
        const resultado = await accionCrearProducto(env, payload);
        return json({ ok: true, ...resultado });
      }

      // POST { action:'habilitar_track_stock', payload:{sku} }  →  activa el seguimiento
      // de inventario de un producto que se creó sin esa opción en Loyverse.
      if (action === "habilitar_track_stock") {
        const resultado = await accionHabilitarTrackStock(env, payload);
        return json({ ok: true, ...resultado });
      }

      // POST { action:'activar_iva', payload:{sku} }  →  activa el impuesto IVA en
      // Loyverse para un producto que se creó/quedó sin él.
      if (action === "activar_iva") {
        const resultado = await accionActivarIva(env, payload);
        return json({ ok: true, ...resultado });
      }

      // POST { action:'ajustar_stock', payload:{sku,cantidad,motivo,responsable} }  →
      // corrige el stock a mano (conteo, merma, duplicado) y deja registro en auditoría.
      if (action === "ajustar_stock") {
        const resultado = await accionAjustarStock(env, payload);
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

      // Sin acción reconocida: mensaje de bienvenida simple.
      return json({
        ok: true,
        mensaje: "Worker Argomedo455 activo. GET: ?action=setup, test_loyverse, store_id, reset_store_id, sync, catalogo, historial_producto, proveedores_sectores. POST: lote_nuevo, crear_producto, habilitar_track_stock, activar_iva, ajustar_stock, crear_proveedor, crear_sector",
      });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }
};
