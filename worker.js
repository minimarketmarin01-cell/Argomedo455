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

  // Migración: estado del pedido pendiente ('confirmado' al copiar el pedido a
  // WhatsApp, 'recibido' cuando llega la mercadería por Recepción) — permite
  // avisar "Ya pedido a X" en Armar pedido sin borrar el historial al recibir.
  try {
    await run(env, `ALTER TABLE pedidos_pendientes ADD COLUMN estado TEXT DEFAULT 'confirmado'`);
  } catch (e) {
    // ya existía.
  }

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

  // Migración: imagen_url — foto del producto tal como está cargada en Loyverse
  // (campo item.image_url). Se completa sola en el próximo sync/webhook, no hace
  // falta acción manual.
  try {
    await run(env, `ALTER TABLE productos ADD COLUMN imagen_url TEXT`);
  } catch (e) {
    // ya existía.
  }

  // Mínimo de pedido / empaque configurado a mano por producto (módulo Proveedores
  // → Configuración) — mismo mecanismo que usa Marín 376: 0/NULL en una columna
  // significa "sin override para eso"; si multiplo y empaque quedan en 0 se borra
  // la fila entera (ver accionGuardarMultiploProducto). Pisa el cálculo automático
  // de empaque que hace tag() en el frontend (por nombre de producto) cuando el
  // dueño necesita fijar un mínimo real de compra al proveedor.
  await run(env, `CREATE TABLE IF NOT EXISTS config_multiplo_producto (
    sku TEXT PRIMARY KEY,
    multiplo INTEGER,
    empaque INTEGER,
    palabra TEXT,
    actualizado_en TEXT
  )`);

  // Migración: fecha_retiro en `vencimientos` — distingue el momento en que un
  // lote se retiró físicamente de la góndola (estado "Retirado", pendiente de que
  // el proveedor lo cambie o se confirme como merma) del momento en que se cierra
  // definitivamente (fecha_revision).
  try {
    await run(env, `ALTER TABLE vencimientos ADD COLUMN fecha_retiro TEXT`);
  } catch (e) {
    // ya existía.
  }

  // Migración: columnas de "Descuentos activos" en `vencimientos` — un lote con
  // descuento_activo=1 tiene su precio ya rebajado en Loyverse y se hace
  // seguimiento de cuánto de esa cantidad se vendió o quedó en merma, hasta
  // cerrarse (manual o automático al agotarse o al vencer la fecha).
  const columnasDescuento = [
    "descuento_activo INTEGER DEFAULT 0",
    "precio_original REAL",
    "precio_aplicado REAL",
    "cant_vendida_desc REAL DEFAULT 0",
    "cant_merma_desc REAL DEFAULT 0",
    "fecha_descuento_aplicado TEXT",
    "motivo_cierre TEXT",
    "merma_id INTEGER"
  ];
  for (const col of columnasDescuento) {
    try {
      await run(env, `ALTER TABLE vencimientos ADD COLUMN ${col}`);
    } catch (e) {
      // ya existía.
    }
  }

  // Tabla de mermas — necesaria para que "Descuentos activos" pueda registrar la
  // parte de un lote que termina en merma (no vendida) usando el mismo mecanismo
  // que el resto de la app, sin llevar un conteo paralelo que no aparezca en
  // ningún reporte. Estructura mínima suficiente para este flujo.
  await run(env, `CREATE TABLE IF NOT EXISTS mermas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha TEXT,
    sku TEXT,
    producto TEXT,
    categoria TEXT,
    unidad TEXT,
    lote TEXT,
    cantidad REAL,
    costo_unitario REAL,
    costo_total REAL,
    motivo TEXT,
    estado_costo TEXT,
    responsable TEXT,
    origen TEXT
  )`);

  // "Recién llegado": stock que subió directo en Loyverse (no por Recibir mercadería
  // ni por un ajuste hecho desde la app) y todavía no tiene fecha de vencimiento
  // asignada. Se llena sola desde el webhook inventory_levels.update (ver
  // aplicarCambiosInventario) comparando el stock nuevo contra el que ya había en D1.
  await run(env, `CREATE TABLE IF NOT EXISTS llegadas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha_deteccion TEXT,
    sku TEXT,
    nombre TEXT,
    categoria TEXT,
    unidad TEXT,
    stock_antes REAL,
    stock_despues REAL,
    aumento REAL,
    estado TEXT DEFAULT 'pendiente',
    fecha_vencimiento_asignada TEXT,
    fecha_resolucion TEXT
  )`);

  // Clasificación ABC (participación en ventas de los últimos N días, cortes
  // 80/95/100) — se recalcula a pedido (?action=abc_calcular), esta tabla solo
  // guarda el último resultado para no tener que recalcular en cada consulta.
  // Categorías marcadas para gestionarse por "cambio con proveedor" en vez de
  // descuento/merma al vencer (ej. productos en consignación). Puramente
  // informativo por ahora — no cambia el cálculo de prioridad de Vencimientos,
  // que sigue siendo el mismo flujo manual ya en producción.
  // Productos excluidos a mano del módulo "Riesgo de quiebre" (ej. producto de
  // temporada que ya no se va a reponer) — persistido en D1 para que la
  // exclusión sea la misma en todos los celulares, no solo en el que la marcó.
  await run(env, `CREATE TABLE IF NOT EXISTS riesgo_excluidos (
    sku TEXT PRIMARY KEY,
    agregado_en TEXT
  )`);

  // Favoritos de Armar pedido — productos marcados a mano (ej. "los que pido
  // siempre a este proveedor"), persistidos en D1 para que el marcado sea el
  // mismo en todos los celulares. Misma forma que riesgo_excluidos.
  await run(env, `CREATE TABLE IF NOT EXISTS favoritos (
    sku TEXT PRIMARY KEY,
    agregado_en TEXT
  )`);

  await run(env, `CREATE TABLE IF NOT EXISTS config_categorias (
    categoria TEXT PRIMARY KEY,
    tipo TEXT
  )`);

  await run(env, `CREATE TABLE IF NOT EXISTS clasificacion_abc (
    sku TEXT PRIMARY KEY,
    venta_total REAL,
    pct_participacion REAL,
    pct_acumulado REAL,
    clase TEXT,
    periodo_dias INTEGER,
    calculado_en TEXT
  )`);

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

  // Proveedores ADICIONALES de un producto — `productos.proveedor` sigue siendo el
  // proveedor principal (compatibilidad con Recepción, Crear producto, etc.); esta
  // tabla permite asignar proveedores extra al mismo SKU (un producto puede
  // comprarse a más de un proveedor). El producto aparece en Armar pedido y
  // Proveedores para TODOS sus proveedores asignados (principal + extras).
  await run(env, `CREATE TABLE IF NOT EXISTS producto_proveedor_extra (
    sku TEXT NOT NULL,
    proveedor_id INTEGER NOT NULL REFERENCES proveedores(id),
    PRIMARY KEY (sku, proveedor_id)
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

  // Suscripciones Web Push (una fila por celular/navegador que aceptó recibir
  // notificaciones). Se guarda/actualiza desde el frontend justo después de que el
  // usuario acepta el permiso de notificaciones.
  await run(env, `CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    p256dh TEXT,
    auth TEXT,
    creado TEXT
  )`);

  // Log simple de eventos automáticos (avisos push enviados, chequeos programados) —
  // útil para depurar sin acceso directo a los logs de Cloudflare.
  await run(env, `CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha TEXT,
    mensaje TEXT
  )`);

  // ==========================================================
  //  FASE 1 — Los Cumpas pasa a usar la estructura de Marín Pedidos
  //  (columnas y tablas nuevas que necesitan las funciones portadas
  //  desde Marín; ver plan "FASE 1" para el detalle de cada una).
  // ==========================================================

  // ventas: ingreso ($) y utilidad ($) por línea — hoy la tabla solo tenía cantidad.
  // Queda en 0 para todo lo histórico (no se hace backfill en esta fase); se completa
  // desde ahora en cada venta nueva (webhook) y en sync_ventas.
  const columnasVentas = ["venta REAL DEFAULT 0", "utilidad REAL DEFAULT 0"];
  for (const col of columnasVentas) {
    try { await run(env, `ALTER TABLE ventas ADD COLUMN ${col}`); } catch (e) { /* ya existía */ }
  }

  // productos: proveedor_id (FK, en paralelo al `proveedor` TEXT existente — modelo dual,
  // ver §4 del plan), descripcion (texto libre de Loyverse) y fecha_creacion.
  const columnasProductos = [
    "proveedor_id INTEGER REFERENCES proveedores(id)",
    "descripcion TEXT",
    "fecha_creacion TEXT"
  ];
  for (const col of columnasProductos) {
    try { await run(env, `ALTER TABLE productos ADD COLUMN ${col}`); } catch (e) { /* ya existía */ }
  }

  // vencimientos: prioridad/acción/precio recomendado que calcula Marín al evaluar cada
  // lote, más de dónde salió el costo usado — hoy Los Cumpas no persiste ninguno de los 5.
  const columnasVencimientosMarin = [
    "prioridad TEXT",
    "accion TEXT",
    "precio_recomendado REAL",
    "costo_usado REAL",
    "costo_origen TEXT",
    "monto_descuento REAL"
  ];
  for (const col of columnasVencimientosMarin) {
    try { await run(env, `ALTER TABLE vencimientos ADD COLUMN ${col}`); } catch (e) { /* ya existía */ }
  }

  // pedidos_pendientes: Marín llama "nombre" a lo que acá se llama "producto" — se agrega
  // sin renombrar la columna existente (se escribe en ambas), más costo/fecha de llegada.
  const columnasPedidosPendientes = [
    "nombre TEXT",
    "canal TEXT",
    "costo_unitario REAL DEFAULT 0",
    "costo_total REAL DEFAULT 0",
    "fecha_llegada_estimada TEXT"
  ];
  for (const col of columnasPedidosPendientes) {
    try { await run(env, `ALTER TABLE pedidos_pendientes ADD COLUMN ${col}`); } catch (e) { /* ya existía */ }
  }

  // riesgo_excluidos: Marín guarda fecha/responsable de la exclusión (Los Cumpas ya tenía
  // agregado_en, que se conserva sin cambios en paralelo).
  const columnasRiesgoExcluidos = ["fecha TEXT", "responsable TEXT"];
  for (const col of columnasRiesgoExcluidos) {
    try { await run(env, `ALTER TABLE riesgo_excluidos ADD COLUMN ${col}`); } catch (e) { /* ya existía */ }
  }

  // Préstamos de mercadería entre Los Cumpas y Marín 376 (ver §6 del plan — el nombre del
  // socio en el frontend es "Marín 376", esta tabla es neutra respecto a esa distinción).
  await run(env, `CREATE TABLE IF NOT EXISTS prestamos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha TEXT NOT NULL,
    sucursal TEXT NOT NULL,
    direccion TEXT NOT NULL,
    sku TEXT NOT NULL,
    producto TEXT,
    cantidad REAL NOT NULL,
    unidad TEXT,
    costo_unitario REAL,
    costo_total REAL,
    estado TEXT NOT NULL DEFAULT 'pendiente',
    fecha_devolucion TEXT,
    responsable TEXT,
    nota TEXT
  )`);

  // Evolución de costo/precio por SKU — no existía ni siquiera como CREATE TABLE en el
  // repo de Marín (vivía solo en su D1 en producción); se diseña completa desde el día
  // uno acá porque es justo el tipo de dato que el futuro proyecto financiero va a
  // necesitar leer (ver "Consideración para futura integración financiera" en el plan).
  await run(env, `CREATE TABLE IF NOT EXISTS historial_precios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku TEXT NOT NULL,
    fecha TEXT,
    precio_antes REAL,
    precio_despues REAL,
    costo_antes REAL,
    costo_despues REAL,
    responsable TEXT
  )`);
  await run(env, `CREATE INDEX IF NOT EXISTS idx_historial_precios_sku ON historial_precios (sku)`);

  // Cálculos guardados de la Calculadora de precios (por foto de factura) — cada fila
  // pertenece a un factura_id, varias filas por factura.
  await run(env, `CREATE TABLE IF NOT EXISTS facturas_calculos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    factura_id TEXT,
    fecha TEXT,
    producto TEXT,
    costo_unitario REAL,
    margen REAL,
    precio_venta REAL,
    precio_psicologico REAL,
    categoria TEXT,
    responsable TEXT
  )`);

  // Clasificación (proveedor/sector) aprendida por patrón de categoría o de nombre de
  // producto — funciona sin IA (lookup por patrón exacto); solo si no hay patrón
  // aprendido se recurre a IA (§7 del plan).
  await run(env, `CREATE TABLE IF NOT EXISTS producto_clasificacion_aprendida (
    patron TEXT PRIMARY KEY,
    proveedor_id INTEGER,
    sector TEXT,
    actualizado_en TEXT
  )`);

  // Categorías de Loyverse cacheadas con su id real — Mapeo de categorías necesita el id
  // (no solo el nombre que ya guarda productos.categoria) para poder reasignar productos.
  await run(env, `CREATE TABLE IF NOT EXISTS categorias_loyverse (
    id TEXT PRIMARY KEY,
    nombre TEXT
  )`);

  // Vida útil por categoría (días de alerta antes de vencer + tipo de manejo) — más
  // detallada que config_categorias, que se conserva en paralelo sin cambios.
  await run(env, `CREATE TABLE IF NOT EXISTS config_vida_util (
    categoria TEXT PRIMARY KEY,
    dias_alerta INTEGER NOT NULL,
    tipo TEXT NOT NULL,
    nota TEXT
  )`);
  // Semilla — mismos 13 valores que trae Marín (ver d1_config_vida_util.sql). OR IGNORE
  // para no pisar un ajuste manual si esta migración se vuelve a correr.
  const semillaVidaUtil = [
    ["PAN A GRANEL", 2, "corta", null],
    ["VERDURAS y ENSALADAS", 3, "corta", null],
    ["FRUTAS", 3, "corta", null],
    ["PALTA", 4, "corta", null],
    ["JAMONES A GRANEL", 5, "corta", null],
    ["QUESOS EN BARRA", 5, "corta", null],
    ["LA VAQUITA", 5, "corta", null],
    ["SOPROLE", 5, "corta", null],
    ["COLUN", 5, "corta", null],
    ["CONGELADOS", 15, "larga", null],
    ["ABARROTES", 30, "larga", null],
    ["IDEAL", 15, "cambio", "Siempre hacen cambio de producto, nunca rebaja"],
    ["PAN CASTAÑO", 15, "cambio", "Siempre hacen cambio de producto, nunca rebaja"]
  ];
  for (const [categoria, dias, tipo, nota] of semillaVidaUtil) {
    await run(env, `INSERT OR IGNORE INTO config_vida_util (categoria, dias_alerta, tipo, nota) VALUES (?,?,?,?)`,
      categoria, dias, tipo, nota);
  }

  // Sectores creados a mano que no vinieron de Loyverse — Marín los combina con `sectores`
  // (que ya existe en Los Cumpas) vía una consulta combinada al leer.
  await run(env, `CREATE TABLE IF NOT EXISTS sectores_personalizados (
    nombre TEXT PRIMARY KEY
  )`);
}

// ============================================================
//  WEB PUSH (notificaciones aunque la app esté cerrada)
// ============================================================
// Implementación con Web Crypto API nativa del Worker (crypto.subtle) — sin
// librerías npm, porque los paquetes de "web-push" están pensados para Node.js y
// no corren tal cual en el runtime de Cloudflare Workers. Sigue el estándar
// RFC 8291 (cifrado del mensaje) + RFC 8292 (VAPID, para que el navegador sepa
// que el push viene de nuestro servidor).
//
// Requiere 2 Secrets en Cloudflare: VAPID_PUBLIC_KEY y VAPID_PRIVATE_KEY (el par
// se genera UNA vez y no debe cambiar, o las suscripciones existentes dejan de
// funcionar y cada celular tendría que volver a aceptar notificaciones).

function base64UrlToUint8Array(base64url) {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = base64.length % 4 === 0 ? "" : "=".repeat(4 - (base64.length % 4));
  const raw = atob(base64 + pad);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}
function uint8ArrayToBase64Url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Firma un JWT ES256 (VAPID) para autenticar el envío ante el servicio push del
// navegador (FCM para Chrome/Android, etc.) — válido por un tiempo corto, se
// genera fresco en cada envío.
async function vapidGenerarJWT(env, audience) {
  const header = { typ: "JWT", alg: "ES256" };
  const payload = {
    aud: audience, // origen del servicio push (ej. https://fcm.googleapis.com)
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: "mailto:soporte@loscumpas.cl"
  };
  const encHeader = uint8ArrayToBase64Url(new TextEncoder().encode(JSON.stringify(header)));
  const encPayload = uint8ArrayToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const unsigned = encHeader + "." + encPayload;

  const privKeyRaw = base64UrlToUint8Array(env.VAPID_PRIVATE_KEY);
  const jwk = {
    kty: "EC", crv: "P-256", d: uint8ArrayToBase64Url(privKeyRaw),
    x: env.VAPID_PUBLIC_KEY ? uint8ArrayToBase64Url(base64UrlToUint8Array(env.VAPID_PUBLIC_KEY).slice(1, 33)) : undefined,
    y: env.VAPID_PUBLIC_KEY ? uint8ArrayToBase64Url(base64UrlToUint8Array(env.VAPID_PUBLIC_KEY).slice(33, 65)) : undefined,
    ext: true
  };
  const cryptoKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, cryptoKey, new TextEncoder().encode(unsigned));
  return unsigned + "." + uint8ArrayToBase64Url(new Uint8Array(sig));
}

// Cifra el mensaje según RFC 8291 (aes128gcm) usando la clave pública y el "auth
// secret" que el navegador entregó al suscribirse (guardados en push_subscriptions).
async function webPushCifrarPayload(mensajeTexto, p256dh, authSecret) {
  const enc = new TextEncoder();
  const mensajeBytes = enc.encode(mensajeTexto);

  const userPublicKeyBytes = base64UrlToUint8Array(p256dh);
  const authSecretBytes = base64UrlToUint8Array(authSecret);

  const serverKeyPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const serverPublicKeyRaw = new Uint8Array(await crypto.subtle.exportKey("raw", serverKeyPair.publicKey));

  const userPublicKey = await crypto.subtle.importKey("raw", userPublicKeyBytes, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const sharedSecretBits = await crypto.subtle.deriveBits({ name: "ECDH", public: userPublicKey }, serverKeyPair.privateKey, 256);
  const sharedSecret = new Uint8Array(sharedSecretBits);

  const salt = crypto.getRandomValues(new Uint8Array(16));

  // HKDF de dos pasos según RFC 8291 — deriva el "pseudo random key" (PRK)
  // combinado con el auth secret, luego los parámetros finales de cifrado.
  async function hkdf(saltBytes, ikm, infoBytes, length) {
    const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: saltBytes, info: infoBytes }, key, length * 8
    );
    return new Uint8Array(bits);
  }
  const authInfo = enc.encode("WebPush: info\0");
  const authInfoFull = new Uint8Array([...authInfo, ...userPublicKeyBytes, ...serverPublicKeyRaw]);
  const prk = await hkdf(authSecretBytes, sharedSecret, authInfoFull, 32);

  const cekInfo = enc.encode("Content-Encoding: aes128gcm\0");
  const cek = await hkdf(salt, prk, cekInfo, 16);
  const nonceInfo = enc.encode("Content-Encoding: nonce\0");
  const nonce = await hkdf(salt, prk, nonceInfo, 12);

  // Registro (record) según aes128gcm: 2 bytes de padding delimiter al final del
  // texto plano — suficiente para mensajes cortos como los nuestros.
  const paddedPlaintext = new Uint8Array([...mensajeBytes, 0x02]);
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, paddedPlaintext));

  // Header binario aes128gcm: salt(16) + record size(4, big-endian) + keyid length(1) + keyid
  const recordSize = 4096;
  const header = new Uint8Array(16 + 4 + 1 + serverPublicKeyRaw.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, recordSize, false);
  header[20] = serverPublicKeyRaw.length;
  header.set(serverPublicKeyRaw, 21);

  return new Uint8Array([...header, ...ciphertext]);
}

// Envía una notificación a UNA suscripción guardada. Devuelve { ok, status,
// expirada } — expirada=true significa que el navegador invalidó esa suscripción
// (celular desinstaló la app, borró datos, etc.) y conviene eliminarla.
async function webPushEnviar(env, sub, titulo, cuerpo, urlDestino) {
  try {
    const mensaje = JSON.stringify({ title: titulo, body: cuerpo, url: urlDestino || "./" });
    const payloadCifrado = await webPushCifrarPayload(mensaje, sub.p256dh, sub.auth);

    const endpointUrl = new URL(sub.endpoint);
    const audience = endpointUrl.protocol + "//" + endpointUrl.host;
    const jwt = await vapidGenerarJWT(env, audience);

    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        "Authorization": "vapid t=" + jwt + ", k=" + env.VAPID_PUBLIC_KEY,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        "TTL": "86400" // el servicio push puede guardar el mensaje hasta 24h si el celular está apagado/sin señal
      },
      body: payloadCifrado
    });
    if (res.status === 404 || res.status === 410) return { ok: false, status: res.status, expirada: true };
    return { ok: res.ok, status: res.status, expirada: false };
  } catch (e) {
    return { ok: false, status: 0, expirada: false, error: e.message };
  }
}

// Guarda o actualiza la suscripción push de este celular/navegador.
async function accionGuardarSuscripcionPush(env, payload) {
  const sub = payload && payload.subscription;
  if (!sub || !sub.endpoint || !sub.keys) throw new Error("Suscripción inválida");
  await run(env,
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, creado)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth`,
    sub.endpoint, sub.keys.p256dh, sub.keys.auth, fechaDDMMAAAA()
  );
  return { ok: true };
}
async function accionQuitarSuscripcionPush(env, payload) {
  const endpoint = payload && payload.endpoint;
  if (!endpoint) throw new Error("Falta el endpoint de la suscripción");
  await run(env, "DELETE FROM push_subscriptions WHERE endpoint = ?", endpoint);
  return { ok: true };
}

// Manda la misma notificación a TODOS los celulares suscritos — si alguna
// suscripción resulta expirada, se borra de la tabla en el mismo paso.
async function webPushEnviarATodos(env, titulo, cuerpo, urlDestino) {
  const { results: subs } = await env.DB.prepare("SELECT * FROM push_subscriptions").all();
  let enviados = 0, expiradas = 0;
  for (const sub of subs) {
    const r = await webPushEnviar(env, sub, titulo, cuerpo, urlDestino);
    if (r.ok) enviados++;
    if (r.expirada) { expiradas++; try { await run(env, "DELETE FROM push_subscriptions WHERE endpoint = ?", sub.endpoint); } catch (_) {} }
  }
  return { enviados, expiradas, total: subs.length };
}

async function logMsg(env, mensaje) {
  try { await run(env, "INSERT INTO logs (fecha, mensaje) VALUES (?, ?)", fechaHoraDDMMAAAA(), mensaje); } catch (_) {}
}


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
//   opts.clampBaseNegativo — si true, un stock de partida negativo se trata como 0
//   antes de sumar. Uso EXCLUSIVO de recepción de mercadería (accionLoteNuevo): recibir
//   nunca debe dejar el stock más negativo del que ya estaba. El resto de los llamadores
//   (ajuste de stock, retiro de góndola, merma) opera sobre el stock REAL sin recortar,
//   porque ya calculan su delta a partir del valor verdadero (ej. "Cantidad exacta" en
//   Ajustar stock necesita el stock real para aterrizar justo en lo contado).
async function sumarStockLoyverse(env, productoRow, cantidad, opts) {
  opts = opts || {};
  if (!productoRow.track_stock) return { ok: false, motivo: "producto sin seguimiento de inventario ('Activar inventario' primero)" };
  if (!productoRow.variant_id) return { ok: false, motivo: "falta variant_id (vuelve a sincronizar el catálogo)" };

  const { storeId } = await obtenerStoreId(env);
  const stockActual = await stockFrescoDeVariante(env, storeId, productoRow.variant_id);
  if (stockActual == null) return { ok: false, motivo: "Loyverse no devolvió inventario para este producto" };

  // El RESULTADO de una resta grande sí puede seguir dando negativo (ej. stock=0 y se
  // resta 5 → queda en -5); esto no se recorta nunca, solo el PUNTO DE PARTIDA, y solo
  // cuando opts.clampBaseNegativo lo pide.
  const base = opts.clampBaseNegativo ? Math.max(0, stockActual) : stockActual;
  const nuevoStock = Math.round((base + cantidad) * 1000) / 1000;
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
      // Loyverse rechaza default_price si default_pricing_type es "VARIABLE" (precio
      // libre en caja). Si el usuario está fijando un precio desde la app, eso implica
      // que quiere un precio fijo — se cambia el tipo a FIXED junto con el valor, para
      // no mandar una combinación que la API considera inválida.
      copia.default_pricing_type = "FIXED";
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
      `INSERT INTO productos (sku, id_loyverse, variant_id, nombre, categoria, barcode, precio, costo, stock, sold_by_weight, track_stock, con_iva, imagen_url)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(sku) DO UPDATE SET
         id_loyverse=excluded.id_loyverse, variant_id=excluded.variant_id, nombre=excluded.nombre,
         categoria=excluded.categoria, barcode=excluded.barcode, precio=excluded.precio,
         costo=excluded.costo, stock=excluded.stock, sold_by_weight=excluded.sold_by_weight,
         track_stock=excluded.track_stock, con_iva=excluded.con_iva, imagen_url=excluded.imagen_url`
    ).bind(v.sku, it.id, v.variant_id, it.item_name, mapaCategorias[it.category_id] || "SIN CATEGORÍA",
      v.barcode || "", precio || 0, v.cost || 0, stock, peso ? 1 : 0, it.track_stock ? 1 : 0, conIva ? 1 : 0, it.image_url || null));
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
//
// De paso detecta "Recién llegado": si el stock SUBE y ese aumento no lo hizo la
// app (Recibir mercadería, ajuste, etc. ya dejan el valor nuevo escrito en D1
// ANTES de que llegue el eco del webhook — ver sumarStockLoyverse), entonces
// alguien cargó stock directo en Loyverse sin pasar por la app, y por lo tanto
// sin fecha de vencimiento. Se guarda en `llegadas` para que el módulo "Recién
// llegado" lo muestre y se le pueda asignar fecha o ignorar.
async function aplicarCambiosInventario(env, niveles) {
  if (!niveles || !niveles.length) return 0;
  const { storeId } = await obtenerStoreId(env);
  let actualizados = 0;
  for (const nivel of niveles) {
    if (nivel.store_id && nivel.store_id !== storeId) continue; // otra tienda, no nos afecta
    const fila = await get(env, "SELECT sku, nombre, categoria, sold_by_weight, stock FROM productos WHERE variant_id = ?", nivel.variant_id);
    if (!fila) continue; // producto no está en D1 todavía (ej. creado fuera de la app) — un sync completo lo traerá
    const stockAntes = Number(fila.stock) || 0;
    const stockDespues = Number(nivel.in_stock) || 0;
    await run(env, "UPDATE productos SET stock = ? WHERE sku = ?", stockDespues, fila.sku);
    actualizados++;

    if (stockDespues > stockAntes) {
      const aumento = Math.round((stockDespues - stockAntes) * 1000) / 1000;
      const unidad = fila.sold_by_weight ? "kg" : "un";
      const pendiente = await get(env, "SELECT id, aumento FROM llegadas WHERE sku = ? AND estado = 'pendiente'", fila.sku);
      if (pendiente) {
        // Ya había una llegada sin resolver de este mismo producto — se acumula
        // en vez de crear una fila nueva, para no duplicar el aviso.
        await run(env,
          "UPDATE llegadas SET aumento = ?, stock_despues = ?, fecha_deteccion = ? WHERE id = ?",
          Math.round((Number(pendiente.aumento) + aumento) * 1000) / 1000, stockDespues, fechaDDMMAAAA(), pendiente.id);
      } else {
        await run(env,
          `INSERT INTO llegadas (fecha_deteccion, sku, nombre, categoria, unidad, stock_antes, stock_despues, aumento, estado)
           VALUES (?,?,?,?,?,?,?,?,'pendiente')`,
          fechaDDMMAAAA(), fila.sku, fila.nombre, fila.categoria, unidad, stockAntes, stockDespues, aumento);
      }
    }
  }
  return actualizados;
}

// Lista de "llegadas" pendientes (stock que subió directo en Loyverse, sin fecha
// de vencimiento todavía), más nuevas primero por tamaño de aumento.
async function repLlegadasPendientes(env) {
  const { results: rows } = await env.DB.prepare("SELECT * FROM llegadas WHERE estado = 'pendiente' ORDER BY aumento DESC").all();
  return rows.map(r => ({
    filaIndex: r.id, fecha: r.fecha_deteccion, sku: r.sku, nombre: r.nombre, categoria: r.categoria,
    unidad: r.unidad, stockAntes: r.stock_antes, stockDespues: r.stock_despues, aumento: r.aumento
  }));
}

// Le asigna fecha de vencimiento a una llegada: crea el lote en `vencimientos`
// con la cantidad detectada. NO vuelve a tocar el stock en Loyverse — ese stock
// ya está sumado desde que se detectó la llegada.
async function accionAsignarLlegada(env, payload) {
  payload = payload || {};
  const fi = Number(payload.filaIndex);
  if (!fi) throw new Error("Falta filaIndex");
  const row = await get(env, "SELECT * FROM llegadas WHERE id = ?", fi);
  if (!row) throw new Error("Llegada no encontrada");
  if (row.estado !== "pendiente") throw new Error("Esta llegada ya fue resuelta");

  const fechaTxt = String(payload.fechaVencimiento || "").trim();
  if (!fechaTxt || !parseFechaDDMMAAAA(fechaTxt)) throw new Error("Fecha de vencimiento inválida (usa DD/MM/AAAA)");

  const it = await get(env, "SELECT * FROM productos WHERE sku = ?", row.sku);
  const tablaVidaUtil = await getVidaUtilTabla(env);
  const calc = await calcularLote(env, { categoria: row.categoria, fechaVencimiento: fechaTxt }, it, null, tablaVidaUtil);

  const insertRes = await run(env,
    `INSERT INTO vencimientos (fecha_ingreso, sku, producto, categoria, unidad, lote, cantidad, fecha_vencimiento, estado, prioridad, accion, precio_recomendado, costo_usado, costo_origen, fecha_revision, revisado_por)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    row.fecha_deteccion, row.sku, row.nombre, row.categoria, row.unidad, "", row.aumento, fechaTxt,
    calc.estado, calc.prioridad, calc.accion, calc.precioRecomendado || null, calc.costoUsado || null, calc.costoOrigen, "", "");

  await run(env, "UPDATE llegadas SET estado='asignado', fecha_vencimiento_asignada=?, fecha_resolucion=? WHERE id=?",
    fechaTxt, fechaDDMMAAAA(), fi);

  return { ok: true, filaIndex: fi, loteId: insertRes.meta.last_row_id };
}

// Descarta una llegada sin asignarle fecha (ej. producto que no requiere control
// de vencimiento). No toca stock ni crea lote.
async function accionIgnorarLlegada(env, payload) {
  payload = payload || {};
  const fi = Number(payload.filaIndex);
  if (!fi) throw new Error("Falta filaIndex");
  const row = await get(env, "SELECT id, estado FROM llegadas WHERE id = ?", fi);
  if (!row) throw new Error("Llegada no encontrada");
  if (row.estado !== "pendiente") throw new Error("Esta llegada ya fue resuelta");
  await run(env, "UPDATE llegadas SET estado='ignorado', fecha_resolucion=? WHERE id=?", fechaDDMMAAAA(), fi);
  return { ok: true, filaIndex: fi };
}

// ============================================================
//  CLASIFICACIÓN ABC + PRECIO SUGERIDO
//  Participación de cada producto en las ventas de los últimos N días
//  (cortes 80/95/100: A = primer 80% acumulado, B = hasta 95%, C = resto).
//  Argomedo455 solo guarda CANTIDAD vendida por línea (no el monto — a
//  diferencia de Marín, que agrega venta en pesos en `ventas_diarias`),
//  así que la venta en pesos se aproxima con cantidad × precio ACTUAL
//  del producto. No es exacto si el precio cambió a mitad del período,
//  pero alcanza para priorizar qué productos mueven más plata.
// ============================================================
async function calcularABC(env, periodoDias) {
  const dias = Number(periodoDias) || 30;
  const desde = fechaISO(new Date(Date.now() - dias * 86400000));

  const { results: rows } = await env.DB.prepare(
    `SELECT v.sku AS sku, SUM(v.cantidad * p.precio) AS venta_total
     FROM ventas v JOIN productos p ON p.sku = v.sku
     WHERE v.fecha_venta >= ?
     GROUP BY v.sku
     HAVING venta_total > 0
     ORDER BY venta_total DESC`
  ).bind(desde).all();

  await run(env, "DELETE FROM clasificacion_abc");
  const totalGeneral = rows.reduce((s, r) => s + (Number(r.venta_total) || 0), 0);
  if (totalGeneral <= 0) return { clasificados: 0, periodo_dias: dias };

  const CORTE_A = 0.80, CORTE_B = 0.95;
  let acumulado = 0;
  const registros = rows.map(r => {
    const venta = Number(r.venta_total) || 0;
    acumulado += venta;
    const pctAcum = acumulado / totalGeneral;
    const clase = pctAcum <= CORTE_A ? "A" : (pctAcum <= CORTE_B ? "B" : "C");
    return { sku: r.sku, venta_total: venta, pct_participacion: venta / totalGeneral, pct_acumulado: pctAcum, clase };
  });

  const calculadoEn = fechaHoraDDMMAAAA();
  const stmts = registros.map(r => env.DB.prepare(
    `INSERT INTO clasificacion_abc (sku, venta_total, pct_participacion, pct_acumulado, clase, periodo_dias, calculado_en)
     VALUES (?,?,?,?,?,?,?)`
  ).bind(r.sku, r.venta_total, r.pct_participacion, r.pct_acumulado, r.clase, dias, calculadoEn));
  await batchRun(env, stmts);

  return { clasificados: registros.length, periodo_dias: dias };
}

async function repABC(env) {
  const { results } = await env.DB.prepare("SELECT sku, clase, pct_participacion, venta_total FROM clasificacion_abc ORDER BY pct_acumulado ASC").all();
  return results;
}

// Redondeo psicológico: sube al .90 o .50 más cercano por arriba, preservando
// la unidad de mil (nunca baja el precio calculado).
function redondearPsicologico(precio) {
  if (!precio || precio <= 0) return 0;
  const base = Math.floor(precio / 100) * 100;
  const candidatos = [base - 100 + 90, base - 100 + 50, base + 90, base + 50, base + 100 + 90];
  const elegido = candidatos.find(c => c >= precio);
  return elegido != null ? elegido : (Math.ceil(precio / 10) * 10 + 90);
}

// Margen sugerido por clase — retail minimarket, margen sobre venta (mismo
// criterio que Marín).
const MARGEN_SUGERIDO_ABC = {
  A: { min: 0.25, max: 0.35 },
  B: { min: 0.30, max: 0.40 },
  C: { min: 0.40, max: 0.50 }
};

// Calcula el precio sugerido para un SKU según su clase ABC + margen deseado.
// No escribe nada — el frontend siempre confirma antes de aplicar.
async function accionSugerirPrecioABC(env, payload) {
  payload = payload || {};
  const sku = String(payload.sku || "").trim();
  if (!sku) throw new Error("Falta el SKU");
  const it = await get(env, "SELECT * FROM productos WHERE sku = ?", sku);
  if (!it) throw new Error("SKU no encontrado: " + sku);

  const clasif = await get(env, "SELECT * FROM clasificacion_abc WHERE sku = ?", sku);
  const clase = clasif ? clasif.clase : null;
  const rango = clase ? MARGEN_SUGERIDO_ABC[clase] : null;

  const margen = payload.margen != null && payload.margen !== ""
    ? Number(payload.margen)
    : (rango ? (rango.min + rango.max) / 2 : 0.30);
  if (isNaN(margen) || margen <= 0 || margen >= 1) throw new Error("Margen inválido (debe ser 0-1, ej. 0.30)");

  const costo = Number(it.costo || 0);
  const precioCalculado = costo > 0 ? costo / (1 - margen) : 0;
  const precioPsicologico = redondearPsicologico(precioCalculado);

  return {
    sku, nombre: it.nombre, costo, clase,
    pct_participacion: clasif ? clasif.pct_participacion : null,
    margen_usado: margen, margen_rango_sugerido: rango,
    precio_calculado: Math.round(precioCalculado), precio_psicologico: precioPsicologico,
    precio_actual: it.precio
  };
}

// Aplica el precio sugerido: reutiliza accionEditarProducto (misma auditoría +
// sincronización con Loyverse), no duplica la escritura de precio.
async function accionAplicarPrecioABC(env, payload) {
  const sugerencia = await accionSugerirPrecioABC(env, payload);
  const precioFinal = (payload && payload.usar_psicologico === false) ? sugerencia.precio_calculado : sugerencia.precio_psicologico;
  await accionEditarProducto(env, { sku: sugerencia.sku, precio: precioFinal, responsable: (payload && payload.responsable) || "ABC" });
  return Object.assign({}, sugerencia, { precio_aplicado: precioFinal });
}

// ============================================================
//  PRODUCTOS SIN COSTO — productos con seguimiento de inventario activo
//  pero sin costo cargado en Loyverse (bloquea mermas exactas, reportes
//  de utilidad, y el precio sugerido ABC de arriba).
// ============================================================
async function repSinCosto(env) {
  const { results } = await env.DB.prepare(
    "SELECT sku, nombre, categoria, sold_by_weight FROM productos WHERE track_stock = 1 AND (costo IS NULL OR costo = 0)"
  ).all();
  const items = results.map(r => ({ sku: r.sku, nombre: r.nombre, categoria: r.categoria || "SIN CATEGORÍA", peso: !!r.sold_by_weight }));
  items.sort((a, b) => (b.peso - a.peso) || String(a.nombre).localeCompare(String(b.nombre)));
  return { total: items.length, porPeso: items.filter(x => x.peso).length, items };
}

// ============================================================
//  CONFIG CATEGORÍAS — categorías marcadas para gestionarse por "cambio
//  con proveedor" al vencer, en vez de descuento/merma (ej. productos en
//  consignación). Informativo: se muestra como aviso en Vencimientos,
//  no cambia el flujo manual de estados ya en producción.
// ============================================================
async function repCategoriasCambio(env) {
  const { results } = await env.DB.prepare("SELECT categoria FROM config_categorias WHERE tipo = 'cambio' ORDER BY categoria").all();
  return results.map(r => r.categoria);
}

async function accionConfigCategoriaCambio(env, payload) {
  payload = payload || {};
  const categoria = String(payload.categoria || "").trim();
  if (!categoria) throw new Error("Falta la categoría");
  if (payload.activo) {
    await run(env, "INSERT INTO config_categorias (categoria, tipo) VALUES (?, 'cambio') ON CONFLICT(categoria) DO UPDATE SET tipo='cambio'", categoria);
  } else {
    await run(env, "DELETE FROM config_categorias WHERE categoria = ?", categoria);
  }
  return { categoria, activo: !!payload.activo };
}

// Costo total de mermas por "consumo_interno" (ej. la familia dueña consume
// stock) agrupado por categoría, en los últimos N días — usa la tabla
// `mermas` que ya existe (Módulo Mermas), no crea nada nuevo.
async function repConsumoCategoria(env, dias) {
  const diasNum = Number(dias) || 30;
  const { results } = await env.DB.prepare("SELECT categoria, fecha, costo_total FROM mermas WHERE motivo = 'consumo_interno'").all();
  const corte = Date.now() - diasNum * 86400000;
  const cats = {};
  results.forEach(r => {
    const f = parseFechaDDMMAAAA(r.fecha);
    if (!f || f.getTime() < corte) return;
    const cat = r.categoria || "SIN CATEGORÍA";
    cats[cat] = (cats[cat] || 0) + (Number(r.costo_total) || 0);
  });
  const arr = Object.keys(cats).map(c => ({ categoria: c, total: Math.round(cats[c]) })).sort((a, b) => b.total - a.total);
  const total = arr.reduce((s, x) => s + x.total, 0);
  return { total, dias: diasNum, categorias: arr };
}

// ============================================================
//  RIESGO DE QUIEBRE — productos de alta rotación (clase ABC A o B, ver
//  módulo Precio sugerido) con cobertura urgente o sin stock, excluyendo
//  los marcados a mano. Mismo criterio que ya usa Armar pedido
//  (apEstadoDe: stock<=0 o cobertura<3 días) — el frontend calcula esto
//  directo desde DB.items sin llamar al backend; acá solo se recalcula
//  para el aviso automático del cron (scheduled), que no tiene DB.items.
// ============================================================
async function repRiesgoExcluidos(env) {
  const { results } = await env.DB.prepare("SELECT sku FROM riesgo_excluidos").all();
  return results.map(r => r.sku);
}

async function accionRiesgoExcluir(env, payload) {
  payload = payload || {};
  const sku = String(payload.sku || "").trim();
  if (!sku) throw new Error("Falta el SKU");
  if (payload.excluido) {
    await run(env, "INSERT OR IGNORE INTO riesgo_excluidos (sku, agregado_en) VALUES (?, ?)", sku, fechaHoraDDMMAAAA());
  } else {
    await run(env, "DELETE FROM riesgo_excluidos WHERE sku = ?", sku);
  }
  return { sku, excluido: !!payload.excluido };
}

// ============================================================
//  FAVORITOS (Armar pedido) — mismo mecanismo que riesgo_excluidos:
//  set de SKUs marcados a mano, persistido en D1.
// ============================================================
async function repFavoritos(env) {
  const { results } = await env.DB.prepare("SELECT sku FROM favoritos").all();
  return results.map(r => r.sku);
}

async function accionFavorito(env, payload) {
  payload = payload || {};
  const sku = String(payload.sku || "").trim();
  if (!sku) throw new Error("Falta el SKU");
  if (payload.favorito) {
    await run(env, "INSERT OR IGNORE INTO favoritos (sku, agregado_en) VALUES (?, ?)", sku, fechaHoraDDMMAAAA());
  } else {
    await run(env, "DELETE FROM favoritos WHERE sku = ?", sku);
  }
  return { sku, favorito: !!payload.favorito };
}

async function calcularRiesgoQuiebre(env) {
  const { results: productos } = await env.DB.prepare(
    "SELECT sku, nombre, stock FROM productos WHERE track_stock = 1"
  ).all();
  const { results: abcRows } = await env.DB.prepare("SELECT sku, clase FROM clasificacion_abc WHERE clase IN ('A','B')").all();
  const claseBySku = {}; abcRows.forEach(r => { claseBySku[r.sku] = r.clase; });
  const excluidos = new Set(await repRiesgoExcluidos(env));
  const v30 = await ventasPorSku(env, 30);

  const riesgo = [];
  for (const p of productos) {
    if (!claseBySku[p.sku] || excluidos.has(p.sku)) continue;
    const rate = (v30[p.sku] || 0) / 30;
    const stock = Number(p.stock) || 0;
    const cobertura = rate > 0 ? stock / rate : (stock > 0 ? Infinity : 0);
    const enRiesgo = stock <= 0 || (rate > 0 && cobertura < 3);
    if (enRiesgo) riesgo.push({ sku: p.sku, nombre: p.nombre, clase: claseBySku[p.sku] });
  }
  return riesgo;
}

// Llamado desde scheduled() (mismo cron de las 8:00/15:00) — reutiliza el
// espacio ya reservado para esto ("cuando exista la clasificación ABC").
async function chequearYNotificarRiesgoQuiebre(env) {
  const riesgo = await calcularRiesgoQuiebre(env);
  if (!riesgo.length) { await logMsg(env, "✓ Riesgo de quiebre: nada urgente, no se envía notificación"); return; }

  const titulo = "📉 " + riesgo.length + " producto" + (riesgo.length === 1 ? "" : "s") + " en riesgo de quiebre";
  const primeros = riesgo.slice(0, 3).map(r => r.nombre).join(", ");
  const cuerpo = primeros + (riesgo.length > 3 ? " y " + (riesgo.length - 3) + " más" : "") + " · alta rotación, sin stock o cobertura crítica";

  const resultado = await webPushEnviarATodos(env, titulo, cuerpo, "./");
  await logMsg(env, "🔔 Riesgo de quiebre: " + riesgo.length + " productos · push enviados a " +
    resultado.enviados + "/" + resultado.total + " celulares" + (resultado.expiradas ? " (" + resultado.expiradas + " expiradas, eliminadas)" : ""));
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
    // una línea si se vendió con distinto precio/descuento). venta/utilidad usan los
    // mismos campos del recibo de Loyverse que ya usa Marín 376 (total_money,
    // gross_total_money, cost_total) — antes esta tabla solo guardaba cantidad.
    const porSku = {};
    for (const li of r.line_items) {
      const fila = await get(env, "SELECT sku FROM productos WHERE variant_id = ?", li.variant_id);
      if (!fila) continue; // producto no está en D1 todavía
      const acc = porSku[fila.sku] || (porSku[fila.sku] = { cantidad: 0, venta: 0, utilidad: 0 });
      acc.cantidad += signo * (Number(li.quantity) || 0);
      acc.venta += signo * (Number(li.total_money) || 0);
      acc.utilidad += signo * ((Number(li.gross_total_money) || Number(li.total_money) || 0) - (Number(li.cost_total) || 0));
    }
    for (const sku of Object.keys(porSku)) {
      const acc = porSku[sku];
      await run(env,
        `INSERT INTO ventas (receipt_id, sku, cantidad, fecha_venta, venta, utilidad) VALUES (?,?,?,?,?,?)
         ON CONFLICT(receipt_id, sku) DO UPDATE SET cantidad = excluded.cantidad, fecha_venta = excluded.fecha_venta,
           venta = excluded.venta, utilidad = excluded.utilidad`,
        receiptId, sku, acc.cantidad, fechaVenta, acc.venta, acc.utilidad);
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
      `INSERT INTO productos (sku, id_loyverse, variant_id, nombre, categoria, barcode, precio, costo, sold_by_weight, track_stock, con_iva, imagen_url)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(sku) DO UPDATE SET
         id_loyverse=excluded.id_loyverse, variant_id=excluded.variant_id, nombre=excluded.nombre,
         categoria=excluded.categoria, barcode=excluded.barcode, precio=excluded.precio,
         costo=excluded.costo, sold_by_weight=excluded.sold_by_weight,
         track_stock=excluded.track_stock, con_iva=excluded.con_iva, imagen_url=excluded.imagen_url`,
      v.sku, it.id, v.variant_id, it.item_name, mapaCategorias[it.category_id] || "SIN CATEGORÍA",
      v.barcode || "", precio || 0, v.cost || 0, peso ? 1 : 0, it.track_stock ? 1 : 0, conIva ? 1 : 0, it.image_url || null);
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
//  MÍNIMO DE PEDIDO / EMPAQUE MANUAL POR PRODUCTO — mismo código que
//  Marín 376 (config_multiplo_producto / guardar_multiplo_producto):
//  multiplo = mínimo de pedido en UNIDADES (pisa el fmt automático del
//  frontend); empaque = cuántas unidades trae 1 caja/display; palabra =
//  cómo se llama el pack ("caja"/"display").
// ============================================================
async function accionGuardarMultiploProducto(env, payload) {
  const sku = String((payload && payload.sku) || "").trim();
  if (!sku) throw new Error("Falta el SKU");
  const multiplo = Math.round(Number((payload && payload.multiplo) || 0));
  const empaque = Math.round(Number((payload && payload.empaque) || 0));
  const palabra = String((payload && payload.palabra) || "").trim().toLowerCase().slice(0, 30);
  if (multiplo > 0 || empaque > 0) {
    await run(env,
      `INSERT INTO config_multiplo_producto (sku, multiplo, empaque, palabra, actualizado_en) VALUES (?,?,?,?,?)
       ON CONFLICT(sku) DO UPDATE SET multiplo=excluded.multiplo, empaque=excluded.empaque, palabra=excluded.palabra, actualizado_en=excluded.actualizado_en`,
      sku, multiplo, empaque > 0 ? empaque : null, (empaque > 0 && palabra) ? palabra : null, fechaHoraDDMMAAAA());
  } else {
    await run(env, "DELETE FROM config_multiplo_producto WHERE sku = ?", sku);
  }
  return { sku, multiplo: multiplo > 0 ? multiplo : null, empaque: empaque > 0 ? empaque : null, palabra: (empaque > 0 && palabra) ? palabra : null };
}

async function obtenerMultiplosProducto(env) {
  const { results } = await env.DB.prepare("SELECT sku, multiplo, empaque, palabra FROM config_multiplo_producto").all();
  const multiplos = {}, empaques = {}, palabras = {};
  (results || []).forEach(r => {
    if (r.multiplo) multiplos[r.sku] = r.multiplo;
    if (r.empaque) empaques[r.sku] = r.empaque;
    if (r.palabra) palabras[r.sku] = r.palabra;
  });
  return { multiplos, empaques, palabras };
}

// ============================================================
//  "YA PEDIDO A X" (Armar pedido) — al confirmar un pedido (copiar a
//  WhatsApp) se guarda una fila por producto con estado='confirmado'; al
//  recibir la mercadería (Recepción) pasa a 'recibido' sin borrarse, para
//  que quede como historial real. pedidos_pendientes.sku NO es PK única en
//  Argomedo (a diferencia de Marín), así que un mismo sku puede tener varias
//  filas confirmadas si se pidió más de una vez sin recibir — se usa
//  siempre la más reciente (MAX(id)) para saber qué mostrar.
// ============================================================
async function accionMarcarPedidoRealizado(env, payload) {
  payload = payload || {};
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (!items.length) throw new Error("No hay productos en el pedido a marcar");
  const fecha = fechaHoraDDMMAAAA();
  let marcados = 0;
  for (const it of items) {
    const sku = String((it && it.sku) || "").trim();
    const cantidad = Number(it && it.cantidad) || 0;
    if (!sku || cantidad <= 0) continue;
    await run(env,
      "INSERT INTO pedidos_pendientes (fecha, sku, barcode, producto, proveedor, cantidad, estado) VALUES (?,?,?,?,?,?,'confirmado')",
      fecha, sku, String((it && it.barcode) || ""), String((it && it.producto) || ""), String((it && it.proveedor) || ""), cantidad);
    marcados++;
  }
  return { marcados };
}

// Mapa sku → {proveedor,cantidad,fecha} con lo último confirmado (sin recibir
// todavía) de cada producto — se manda junto al catálogo, mismo patrón que
// obtenerMultiplosProducto.
async function obtenerPedidosPendientesPorSku(env) {
  const { results } = await env.DB.prepare(
    "SELECT sku, proveedor, cantidad, fecha, MAX(id) FROM pedidos_pendientes WHERE estado = 'confirmado' GROUP BY sku"
  ).all();
  const map = {};
  (results || []).forEach(r => { map[r.sku] = { proveedor: r.proveedor, cantidad: r.cantidad, fecha: r.fecha }; });
  return map;
}

// ============================================================
//  PRÉSTAMOS DE MERCADERÍA (portado de Marín 376) — un préstamo mueve stock real en
//  Loyverse en el momento de registrarlo (no espera a la devolución), igual que una
//  merma o una recepción, así el stock que la app muestra siempre refleja lo que
//  físicamente hay en el local. La tabla `prestamos` (creada en asegurarTablas) es el
//  "libro de deudas": qué salió/entró, con quién, y si ya se devolvió. Al marcar
//  devuelto se revierte el MISMO movimiento (si salió, vuelve a entrar; si entró,
//  vuelve a salir) — se asume devolución del mismo producto y cantidad exacta.
//  El nombre del socio ("Marín 376") se fija en el frontend (ver plan §6, renombre de
//  Préstamos) — acá la tabla es neutra respecto a esa etiqueta.
// ============================================================
const SUCURSAL_PRESTAMO_FIJA = "Marín 376";

// direccion: "salida" = Los Cumpas le presta a Marín 376 (sale stock de acá, sumar
// cuando vuelva). "entrada" = Marín 376 le presta a Los Cumpas (entra stock acá,
// restar cuando se devuelva).
async function accionRegistrarPrestamo(env, payload) {
  payload = payload || {};
  const sku = String(payload.sku || "").trim();
  if (!sku) throw new Error("Falta el SKU");
  const direccion = payload.direccion === "entrada" ? "entrada" : "salida";
  const cantidad = Number(payload.cantidad);
  if (!cantidad || cantidad <= 0) throw new Error("Cantidad inválida");

  const it = await get(env, "SELECT * FROM productos WHERE sku = ?", sku);
  if (!it) throw new Error("SKU no encontrado en el catálogo: " + sku);
  const unidad = it.sold_by_weight ? "kg" : "un";

  // Si falta costo, se guarda el que escriba el usuario a mano (no persiste en
  // Loyverse desde acá — un préstamo sin costo cargado normalmente significa que el
  // producto nunca lo tuvo; se deja para editarlo desde la Ficha del producto).
  const costoManual = Number(payload.costoManual);
  const costoUnit = it.costo || (costoManual > 0 ? costoManual : 0);
  const costoTotal = Math.round(cantidad * costoUnit);
  const fecha = fechaHoraDDMMAAAA();
  const sucursal = SUCURSAL_PRESTAMO_FIJA;

  const insertRes = await run(env,
    `INSERT INTO prestamos (fecha, sucursal, direccion, sku, producto, cantidad, unidad, costo_unitario, costo_total, estado, responsable, nota)
     VALUES (?,?,?,?,?,?,?,?,?,'pendiente',?,?)`,
    fecha, sucursal, direccion, sku, it.nombre, cantidad, unidad, costoUnit, costoTotal,
    payload.responsable || "", payload.nota || "");

  const out = {
    id: insertRes.meta.last_row_id, fecha, sucursal, direccion, sku, nombre: it.nombre,
    cantidad, unidad, costoUnitario: costoUnit, costoTotal, estado: "pendiente"
  };

  // "salida" (le prestamos al socio) → sale stock de acá, igual que una merma/venta.
  // "entrada" (el socio nos presta) → entra stock acá, igual que una recepción.
  try {
    const res = await sumarStockLoyverse(env, it, direccion === "salida" ? -cantidad : cantidad);
    if (res.ok) out.nuevoStock = res.despues;
    else out.avisoStock = "⚠️ No se pudo ajustar el stock en Loyverse (" + res.motivo + "). Revísalo a mano.";
  } catch (e) {
    out.avisoStock = "⚠️ No se pudo ajustar el stock en Loyverse. Revísalo a mano.";
  }

  return out;
}

// Devuelve el préstamo: revierte el movimiento de stock original. Mismo producto,
// misma cantidad exacta — si "salida" restó al registrar, la devolución suma; si
// "entrada" sumó, la devolución resta.
async function accionDevolverPrestamo(env, payload) {
  payload = payload || {};
  const id = Number(payload.id);
  if (!id) throw new Error("Falta el id del préstamo");
  const prestamo = await get(env, "SELECT * FROM prestamos WHERE id = ?", id);
  if (!prestamo) throw new Error("Préstamo no encontrado");
  if (prestamo.estado === "devuelto") return { id, yaEstaba: true };

  const it = await get(env, "SELECT * FROM productos WHERE sku = ?", prestamo.sku);
  const out = { id, sku: prestamo.sku, nombre: prestamo.producto, estado: "devuelto" };

  if (it) {
    try {
      const res = await sumarStockLoyverse(env, it, prestamo.direccion === "salida" ? prestamo.cantidad : -prestamo.cantidad);
      if (res.ok) out.nuevoStock = res.despues;
      else out.avisoStock = "⚠️ No se pudo ajustar el stock en Loyverse (" + res.motivo + "). Revísalo a mano.";
    } catch (e) {
      out.avisoStock = "⚠️ No se pudo ajustar el stock en Loyverse. Revísalo a mano.";
    }
  } else {
    out.avisoStock = "⚠️ El producto ya no existe en el catálogo — no se pudo ajustar el stock.";
  }

  await run(env, "UPDATE prestamos SET estado = 'devuelto', fecha_devolucion = ? WHERE id = ?", fechaHoraDDMMAAAA(), id);
  return out;
}

async function repHistorialPrestamos(env, limite) {
  const { results: rows } = await env.DB.prepare("SELECT * FROM prestamos ORDER BY id DESC LIMIT ?").bind(limite || 100).all();
  const pendientes = rows.filter(r => r.estado === "pendiente");
  return {
    prestamos: rows.map(r => ({
      id: r.id, fecha: r.fecha, sucursal: r.sucursal, direccion: r.direccion, sku: r.sku,
      producto: r.producto, cantidad: r.cantidad, unidad: r.unidad, costoUnitario: r.costo_unitario,
      costoTotal: r.costo_total, estado: r.estado, fechaDevolucion: r.fecha_devolucion,
      responsable: r.responsable, nota: r.nota
    })),
    resumen: {
      totalPendientes: pendientes.length,
      valorPendienteSalidas: pendientes.filter(r => r.direccion === "salida").reduce((s, r) => s + (r.costo_total || 0), 0),
      valorPendienteEntradas: pendientes.filter(r => r.direccion === "entrada").reduce((s, r) => s + (r.costo_total || 0), 0)
    }
  };
}

// ============================================================
//  CALCULADORA DE PRECIOS — GUARDAR CÁLCULOS DE FACTURA (portado de Marín 376) —
//  guarda en D1 los cálculos de precio ya revisados/confirmados por el usuario, tabla
//  propia (facturas_calculos), sin tocar vencimientos/mermas/productos. Todas las
//  filas de una misma foto de factura comparten factura_id, así queda historial.
// ============================================================
async function accionGuardarCalculoPrecio(env, payload) {
  const items = Array.isArray(payload && payload.items) ? payload.items : [];
  if (!items.length) throw new Error("No hay productos para guardar");
  const facturaIdProvista = payload && payload.factura_id;
  const facturaId = facturaIdProvista || ("FC-" + Date.now());
  const fecha = fechaHoraDDMMAAAA();
  const responsable = (payload && payload.responsable) || "";
  // Si viene un factura_id existente (edición desde el historial), se reemplazan sus
  // filas en vez de insertar unas nuevas al lado — evita que "editar y guardar" duplique.
  if (facturaIdProvista) {
    await run(env, "DELETE FROM facturas_calculos WHERE factura_id = ?", facturaIdProvista);
  }
  const stmts = items.map(it => env.DB.prepare(
    `INSERT INTO facturas_calculos (factura_id, fecha, producto, costo_unitario, margen, precio_venta, precio_psicologico, categoria, responsable)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(
    facturaId, fecha, String(it.producto || "").trim(),
    Number(it.costo_unitario) || 0, Number(it.margen) || 0,
    Number(it.precio_venta) || 0, Number(it.precio_psicologico) || 0,
    String(it.categoria || ""), responsable
  ));
  await batchRun(env, stmts);
  return { factura_id: facturaId, guardados: items.length };
}

// Lee el historial completo agrupado por factura_id.
async function accionListarCalculosFactura(env) {
  const { results: rows } = await env.DB.prepare("SELECT * FROM facturas_calculos ORDER BY id DESC").all();
  const porFactura = {};
  const orden = [];
  rows.forEach(r => {
    if (!porFactura[r.factura_id]) {
      porFactura[r.factura_id] = { facturaId: r.factura_id, fecha: r.fecha, items: [] };
      orden.push(r.factura_id);
    }
    porFactura[r.factura_id].items.push({
      producto: r.producto, costo_unitario: r.costo_unitario, margen: r.margen,
      precio_venta: r.precio_venta, precio_psicologico: r.precio_psicologico, categoria: r.categoria
    });
  });
  return { historial: orden.map(id => porFactura[id]) };
}

// Elimina todas las filas de una factura.
async function accionEliminarCalculoFactura(env, payload) {
  const facturaId = payload && payload.factura_id;
  if (!facturaId) throw new Error("Falta factura_id");
  await run(env, "DELETE FROM facturas_calculos WHERE factura_id = ?", facturaId);
  return { factura_id: facturaId };
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
    `SELECT sku, nombre, categoria, proveedor, sector, barcode, precio, costo, stock, sold_by_weight, track_stock, con_iva, imagen_url
     FROM productos ORDER BY nombre`
  ).all();

  const [v7, v14, v30, v90] = await Promise.all([
    ventasPorSku(env, 7), ventasPorSku(env, 14), ventasPorSku(env, 30), ventasPorSku(env, 90)
  ]);

  // Proveedores EXTRA por sku (además del principal) — mapa sku -> [nombres], para
  // que Armar pedido pueda mostrar un producto bajo todos sus proveedores asignados.
  const { results: extrasRows } = await env.DB.prepare(
    "SELECT pe.sku, pv.nombre FROM producto_proveedor_extra pe JOIN proveedores pv ON pv.id = pe.proveedor_id"
  ).all();
  const extrasPorSku = {};
  extrasRows.forEach(r => { (extrasPorSku[r.sku] = extrasPorSku[r.sku] || []).push(r.nombre); });

  return results.map(p => ({
    ref: p.sku,
    nombre: p.nombre,
    cat: p.categoria || "",
    prov: p.proveedor || "SIN PROVEEDOR",
    provsExtra: extrasPorSku[p.sku] || [],
    sector: p.sector || "",
    barcode: p.barcode || "",
    precio: p.precio || 0,
    coste: p.costo || 0,
    imagen: p.imagen_url || "",
    stock: p.stock,
    peso: !!p.sold_by_weight,
    track: !!p.track_stock,
    iva: !!p.con_iva,
    v7: v7[p.sku] || 0,
    v14: v14[p.sku] || 0,
    v30: v30[p.sku] || 0,
    v90: v90[p.sku] || 0
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
    //    Con fecha, el estado/prioridad/acción/precio recomendado salen del motor de
    //    Marín 376 (calcularLote) en vez del "Pendiente" fijo que se usaba antes.
    let calc;
    if (tieneFecha) {
      const tablaVidaUtil = await getVidaUtilTabla(env);
      calc = await calcularLote(env, { categoria: it.categoria, fechaVencimiento: fechaTxt }, it, null, tablaVidaUtil);
    } else {
      calc = { estado: "Sin fecha", prioridad: "—", accion: "Sin vencimiento", precioRecomendado: null, costoUsado: null, costoOrigen: "" };
    }
    const insertRes = await run(env,
      `INSERT INTO vencimientos (fecha_ingreso, sku, producto, categoria, unidad, lote, cantidad, fecha_vencimiento, estado, prioridad, accion, precio_recomendado, costo_usado, costo_origen, fecha_revision, revisado_por)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      fechaIngreso, sku, it.nombre, it.categoria, unidad, payload.lote || "", cantidad,
      fechaTxt, calc.estado, calc.prioridad, calc.accion, calc.precioRecomendado || null,
      calc.costoUsado || null, calc.costoOrigen, "", "");
    out.filaIndex = insertRes.meta.last_row_id;

    // 2) Sumar stock en Loyverse (el paso más importante — si falla, se avisa pero no
    //    se corta el resto: el lote de vencimiento ya quedó guardado igual). Único
    //    llamador que pide clampBaseNegativo: recibir mercadería nunca debe sumar sobre
    //    un stock de partida negativo (ver comentario en sumarStockLoyverse).
    try {
      const res = await sumarStockLoyverse(env, it, cantidad, { clampBaseNegativo: true });
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

    // 2b) Si este producto tenía un pedido confirmado sin recibir ("Ya pedido a
    // X" en Armar pedido), pasa a 'recibido' — no se borra, queda como historial.
    try {
      await run(env, "UPDATE pedidos_pendientes SET estado = 'recibido' WHERE sku = ? AND estado = 'confirmado'", sku);
    } catch (e) {
      // no crítico: si falla, el chip "Ya pedido" simplemente sigue mostrándose.
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

  const motivo = String(payload.motivo || "").trim();
  if (!motivo) throw new Error("Indica el motivo del ajuste");

  const responsable = String(payload.responsable || "").trim();
  if (!responsable) throw new Error("Indica el usuario responsable del ajuste");

  const it = await get(env, "SELECT * FROM productos WHERE sku = ?", sku);
  if (!it) throw new Error("Producto no encontrado en el catálogo local: " + sku);

  let res, cantidadAjustada;
  if (payload.modo === "exacto") {
    // Conteo físico: el usuario escribe la cantidad REAL que contó (no un +/-). Se
    // lee el stock fresco de Loyverse y se calcula el delta necesario para llegar
    // exactamente a ese número — sin importar si el stock previo era negativo.
    const cantidadExacta = Number(payload.cantidadExacta);
    if (cantidadExacta == null || isNaN(cantidadExacta) || cantidadExacta < 0) {
      throw new Error("Indica la cantidad exacta contada (0 o mayor)");
    }
    if (!it.track_stock) throw new Error("Este producto no tiene seguimiento de inventario activado");
    if (!it.variant_id) throw new Error("Falta variant_id (vuelve a sincronizar el catálogo)");
    const { storeId } = await obtenerStoreId(env);
    const stockActual = await stockFrescoDeVariante(env, storeId, it.variant_id);
    if (stockActual == null) throw new Error("Loyverse no devolvió inventario para este producto");
    const delta = Math.round((cantidadExacta - stockActual) * 1000) / 1000;
    if (delta === 0) {
      res = { ok: true, antes: stockActual, despues: stockActual };
    } else {
      res = await sumarStockLoyverse(env, it, delta);
      if (!res.ok) throw new Error("No se pudo ajustar el stock en Loyverse (" + res.motivo + ")");
    }
    cantidadAjustada = delta;
  } else {
    const cantidad = Number(payload.cantidad);
    if (!cantidad) throw new Error("Indica una cantidad de ajuste distinta de 0 (positiva para sumar, negativa para restar)");
    res = await sumarStockLoyverse(env, it, cantidad);
    if (!res.ok) throw new Error("No se pudo ajustar el stock en Loyverse (" + res.motivo + ")");
    cantidadAjustada = cantidad;
  }

  const fecha = fechaHoraDDMMAAAA();
  const detalleModo = payload.modo === "exacto" ? "Conteo físico: " + payload.cantidadExacta + " · " : "";
  await run(env,
    `INSERT INTO auditoria (fecha, accion, sku, producto, categoria, id_loyverse, stock, motivo, responsable)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    fecha, "ajuste_stock", sku, it.nombre, it.categoria, it.id_loyverse, res.despues,
    detalleModo + motivo + " · Stock anterior: " + res.antes + " · Ajuste: " + (cantidadAjustada > 0 ? "+" : "") + cantidadAjustada + " · Stock final: " + res.despues,
    responsable);

  return { sku, nombre: it.nombre, fecha, stockAnterior: res.antes, cantidadAjustada, stockFinal: res.despues, motivo, responsable };
}

// ============================================================
//  HISTORIAL DE UN PRODUCTO — últimos movimientos de auditoría
//  (recepciones, ajustes, ediciones de precio/costo) para mostrar
//  en "Recibir productos" y permitir revisar qué pasó y quién lo hizo.
// ============================================================
async function historialProducto(env, sku, limit) {
  const { results } = await env.DB.prepare(
    "SELECT fecha, accion, stock, motivo, responsable FROM auditoria WHERE sku = ? ORDER BY id DESC LIMIT ?"
  ).bind(sku, limit || 30).all();
  return results;
}

// ============================================================
//  MOTOR DE PRIORIDAD DE VENCIMIENTOS (portado de Marín 376, Fase 1) —
//  calcula estado/prioridad/acción/precio recomendado de UN lote según la
//  vida útil configurada para su categoría (config_vida_util) y los días
//  que faltan para vencer. Reemplaza, para lotes CON fecha, el "Pendiente"
//  fijo que Argomedo usaba antes — un lote sin fecha sigue quedando "Sin
//  fecha" igual que antes, sin pasar por este cálculo. Los estados
//  manuales propios de Argomedo (Retirado/Cambiado/Descuento recibido/
//  Desechado/Revisado, ver ESTADOS_VENCIMIENTO) no los toca este motor —
//  solo calcula la parte "activa, todavía sin revisar" del lote.
// ============================================================
const VIDA_UTIL_DEFAULT = { dias: 15, tipo: "larga" };

function redondeoPsicologico(p) {
  const base = Math.floor(p / 100) * 100;
  const candidatos = [base + 90, base + 50, base + 190, base + 150];
  let best = candidatos[0], bd = Math.abs(candidatos[0] - p);
  candidatos.forEach(c => { const d = Math.abs(c - p); if (d < bd) { bd = d; best = c; } });
  return best;
}

async function getVidaUtilTabla(env) {
  const { results } = await env.DB.prepare("SELECT * FROM config_vida_util").all();
  const out = {};
  results.forEach(r => { out[r.categoria] = { dias: r.dias_alerta, tipo: r.tipo, nota: r.nota }; });
  return out;
}
function vidaUtilCat(cat, tabla) {
  return tabla[cat] || VIDA_UTIL_DEFAULT;
}

// Margen promedio real de la categoría (mín. 3 productos comparables) — solo se usa
// para ESTIMAR el costo de un lote cuyo producto no tiene costo cargado en Loyverse.
async function margenPromedioCategoria(env, cat) {
  const { results } = await env.DB.prepare(
    "SELECT costo, precio FROM productos WHERE categoria = ? AND costo > 0 AND precio > 0 AND precio > costo"
  ).bind(cat).all();
  if (results.length < 3) return null;
  const ms = results.map(r => (r.precio - r.costo) / r.precio);
  return ms.reduce((a, b) => a + b, 0) / ms.length;
}

// `lote` necesita {categoria, fechaVencimiento} (DD/MM/AAAA); `productoRow` es una fila
// de `productos` (o null); `ventaRow` trae {u30} (o null); `saltarMargen=true` evita la
// consulta de margen promedio (se usa en el recálculo masivo, para no hacer N consultas).
async function calcularLote(env, lote, productoRow, ventaRow, tablaVidaUtil, saltarMargen) {
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const venc = parseFechaDDMMAAAA(lote.fechaVencimiento);
  if (!venc) return { estado: "Vigente", prioridad: "—", accion: "⚠️ Fecha inválida", precioRecomendado: null, costoUsado: 0, costoOrigen: "" };

  const diasRestantes = Math.round((venc - hoy) / 86400000);
  const cfgCat = vidaUtilCat(lote.categoria, tablaVidaUtil);

  const it = productoRow || {};
  const precioActual = it.precio || 0;
  let costoUsado = it.costo || 0, costoOrigen = "real";
  if (!costoUsado) {
    const m = saltarMargen ? null : await margenPromedioCategoria(env, lote.categoria);
    if (m != null) { costoUsado = Math.round(precioActual * (1 - m)); costoOrigen = "estimado"; }
    else costoOrigen = "sin_datos";
  }

  const v = ventaRow || {};
  const ventaDiaria = (v.u30 || 0) / 30;
  const cobertura = ventaDiaria > 0 ? (it.stock || 0) / ventaDiaria : Infinity;
  const acelerar = diasRestantes >= 0 && diasRestantes <= 7 && cobertura > diasRestantes * 1.3;

  let estado, prioridad, accion, descuento = 0;
  if (diasRestantes <= 0) {
    if (cfgCat.tipo === "cambio") { estado = "Vencido"; prioridad = "⚫"; accion = "Vencido — gestionar cambio con proveedor"; descuento = 0; }
    else { estado = "Vencido"; prioridad = "⚫"; accion = "Vencido — retirar y registrar merma"; descuento = 1; }
  } else if (diasRestantes > cfgCat.dias) {
    estado = "Vigente"; prioridad = "—"; accion = "—"; descuento = 0;
  } else if (cfgCat.tipo === "cambio") {
    estado = "Por vencer";
    const diasEnVentana = cfgCat.dias - diasRestantes;
    if (diasEnVentana <= 5) { prioridad = "🟢"; accion = "Gestionar cambio con proveedor"; }
    else if (diasEnVentana <= 15) { prioridad = "🟡"; accion = "Gestionar cambio con proveedor (urgente)"; }
    else { prioridad = "🔴"; accion = "Gestionar cambio con proveedor (muy atrasado)"; }
    descuento = 0;
  } else {
    estado = "Por vencer";
    if (cfgCat.tipo === "corta") {
      if (diasRestantes >= 5) { prioridad = "🟡"; accion = "Reubicar, sin rebaja"; descuento = 0; }
      else if (diasRestantes >= 3) { prioridad = "🟠"; accion = "Rebaja 25%"; descuento = 0.25; }
      else if (diasRestantes >= 1) { prioridad = "🔴"; accion = "Rebaja 45%"; descuento = 0.45; }
      else { prioridad = "⚫"; accion = "Liquidar al costo"; descuento = 1; }
      if (acelerar && descuento < 0.45 && diasRestantes >= 1) {
        prioridad = "🔴"; accion = "Rebaja 45% (acelerado: el stock no alcanza a rotar)"; descuento = 0.45;
      }
    } else {
      const diasEnVentana = cfgCat.dias - diasRestantes;
      if (diasEnVentana <= 1) { prioridad = "🟢"; accion = "Gestionar cambio con proveedor"; descuento = 0; }
      else if (diasEnVentana <= 6) { prioridad = "🟡"; accion = "Rebaja 10%"; descuento = 0.10; }
      else if (diasEnVentana <= 11) { prioridad = "🟠"; accion = "Rebaja 20%"; descuento = 0.20; }
      else { prioridad = "🔴"; accion = "Liquidación 50%"; descuento = 0.50; }
      if (acelerar && descuento < 0.50) {
        prioridad = "🔴"; accion = "Liquidación 50% (acelerado: el stock no alcanza a rotar)"; descuento = 0.50;
      }
    }
  }

  let precioRecomendado = null;
  if (precioActual > 0 && cfgCat.tipo !== "cambio") {
    if (descuento === 0) precioRecomendado = (estado === "Vigente") ? null : precioActual;
    else if (descuento === 1) precioRecomendado = costoUsado || null;
    else precioRecomendado = redondeoPsicologico(Math.max(Math.round(precioActual * (1 - descuento)), costoUsado || 0));
  }

  return { estado, prioridad, accion, precioRecomendado, costoUsado, costoOrigen, diasRestantes };
}

// Recalcula estado/prioridad/acción/precio de TODOS los lotes activos (con fecha,
// sin revisar todavía y sin un descuento ya activo) — se invoca a pedido
// (?action=recalcular_vencimientos) y conviene sumarla al cron diario que ya existe.
async function recalcularVencimientosD1(env) {
  const { results: rows } = await env.DB.prepare(
    "SELECT * FROM vencimientos WHERE estado NOT IN ('Revisado','Retirado','Cambiado','Descuento recibido','Desechado') " +
    "AND fecha_vencimiento IS NOT NULL AND fecha_vencimiento != '' AND sku IS NOT NULL " +
    "AND (descuento_activo IS NULL OR descuento_activo = 0)"
  ).all();
  if (!rows.length) return 0;
  const [{ results: prodRows }, ventaRows, tablaVidaUtil] = await Promise.all([
    env.DB.prepare("SELECT * FROM productos").all(),
    ventasResumenTodas(env),
    getVidaUtilTabla(env)
  ]);
  const prodMap = {}; prodRows.forEach(p => { prodMap[p.sku] = p; });
  const ventaMap = {}; ventaRows.forEach(v => { ventaMap[v.sku] = v; });

  const stmts = [];
  for (const row of rows) {
    const calc = await calcularLote(env, { categoria: row.categoria, fechaVencimiento: row.fecha_vencimiento },
      prodMap[row.sku], ventaMap[row.sku], tablaVidaUtil, true);
    stmts.push(env.DB.prepare(
      "UPDATE vencimientos SET estado=?, prioridad=?, accion=?, precio_recomendado=?, costo_usado=?, costo_origen=? WHERE id=?"
    ).bind(calc.estado, calc.prioridad, calc.accion, calc.precioRecomendado || null, calc.costoUsado || null, calc.costoOrigen, row.id));
  }
  await batchRun(env, stmts, 100);
  return stmts.length;
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

// Arma y manda la notificación push con el resumen de productos por vencer — se
// llama desde scheduled() a las 8:00 y 15:00 hora Chile. Si no hay nada urgente
// (vencido o vence en 3 días o menos), no manda notificación — silencio significa
// que todo está bien, evita interrumpir sin motivo.
async function chequearYNotificarVencimientos(env) {
  const lista = await listaVencimientos(env, {});
  const urgentes = lista.filter(l => l.urgencia === "vencido" || l.urgencia === "urgente");
  if (!urgentes.length) { await logMsg(env, "✓ Vencimientos: nada urgente, no se envía notificación"); return; }

  const vencidos = urgentes.filter(l => l.urgencia === "vencido").length;
  const titulo = "⏰ " + urgentes.length + " producto" + (urgentes.length === 1 ? "" : "s") + " por vencer";
  const primeros = urgentes.slice(0, 3).map(l => l.producto).join(", ");
  const cuerpo = primeros + (urgentes.length > 3 ? " y " + (urgentes.length - 3) + " más" : "") +
    (vencidos ? " · " + vencidos + " ya vencido" + (vencidos === 1 ? "" : "s") : "");

  const resultado = await webPushEnviarATodos(env, titulo, cuerpo, "./");
  await logMsg(env, "🔔 Vencimientos: " + urgentes.length + " productos · push enviados a " +
    resultado.enviados + "/" + resultado.total + " celulares" + (resultado.expiradas ? " (" + resultado.expiradas + " expiradas, eliminadas)" : ""));
}


// POST { action:'vencimiento_estado', payload:{ id, estado, responsable,
//        retirarStock (bool), cantidadRetiro } }
//  → cambia el estado del lote (Revisado, Cambiado, Descuento recibido,
//    Desechado) y, si retirarStock es true, resta esa cantidad del stock
//    en Loyverse (retiro de góndola) dejando registro en auditoría.
const ESTADOS_VENCIMIENTO = ["Pendiente", "Retirado", "Revisado", "Cambiado", "Descuento recibido", "Desechado", "Sin fecha"];
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
    `UPDATE vencimientos SET estado = ?, fecha_revision = ?, revisado_por = ?${estado === "Retirado" ? ", fecha_retiro = ?" : ""} WHERE id = ?`,
    ...(estado === "Retirado" ? [estado, fecha, responsable, fecha, id] : [estado, fecha, responsable, id]));

  return out;
}

// POST { action:'vencimiento_eliminar', payload:{id,responsable} } → elimina un lote
// de vencimientos (ej. se cargó por error). No toca stock ni Loyverse — si el lote ya
// sumó stock al recibirse, esa parte se corrige por separado con un ajuste de stock.
async function accionEliminarLoteVencimiento(env, payload) {
  payload = payload || {};
  const id = Number(payload.id);
  if (!id) throw new Error("Falta el id del lote");
  const lote = await get(env, "SELECT * FROM vencimientos WHERE id = ?", id);
  if (!lote) throw new Error("Lote no encontrado");
  await run(env, "DELETE FROM vencimientos WHERE id = ?", id);
  await run(env,
    `INSERT INTO auditoria (fecha, accion, sku, producto, categoria, id_loyverse, stock, motivo, responsable)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    fechaHoraDDMMAAAA(), "vencimiento_eliminado", lote.sku, lote.producto, lote.categoria, null, null,
    "Lote eliminado de Vencimientos (" + lote.cantidad + " " + lote.unidad + ", vencía " + (lote.fecha_vencimiento || "sin fecha") + ")",
    payload.responsable || "");
  return { id };
}

// POST { action:'vencimiento_fecha', payload:{id,fechaVencimiento,responsable} } → corrige
// la fecha de vencimiento de un lote ya creado. No toca stock ni estado, salvo que el
// lote estuviera "Sin fecha": ahí pasa a "Pendiente" porque ya tiene una fecha real.
async function accionEditarFechaVencimiento(env, payload) {
  payload = payload || {};
  const id = Number(payload.id);
  if (!id) throw new Error("Falta el id del lote");
  const fechaTxt = String(payload.fechaVencimiento || "").trim();
  if (!fechaTxt || !parseFechaDDMMAAAA(fechaTxt)) throw new Error("Fecha inválida (usa DD/MM/AAAA)");
  const lote = await get(env, "SELECT * FROM vencimientos WHERE id = ?", id);
  if (!lote) throw new Error("Lote no encontrado");

  // Recalcula estado/prioridad/acción/precio recomendado con la fecha nueva (motor de
  // Marín 376, ver calcularLote) — antes esto solo pisaba "Sin fecha" por "Pendiente".
  const it = await get(env, "SELECT * FROM productos WHERE sku = ?", lote.sku);
  const tablaVidaUtil = await getVidaUtilTabla(env);
  const calc = await calcularLote(env, { categoria: lote.categoria, fechaVencimiento: fechaTxt }, it, null, tablaVidaUtil);

  await run(env,
    "UPDATE vencimientos SET fecha_vencimiento = ?, estado = ?, prioridad = ?, accion = ?, precio_recomendado = ? WHERE id = ?",
    fechaTxt, calc.estado, calc.prioridad, calc.accion, calc.precioRecomendado || null, id);
  return { id, fechaVencimiento: fechaTxt, estado: calc.estado, prioridad: calc.prioridad, accion: calc.accion };
}

// ============================================================
//  DESCUENTOS ACTIVOS (lotes de vencimiento con precio rebajado)
//  Flujo: aplicar descuento (rebaja el precio en Loyverse y marca
//  el lote) → gestionar venta/merma parcial → cierre (manual o
//  automático al agotarse la cantidad, o al vencer sin venderse).
// ============================================================

// Mismos motivos que usa la app hermana (Marín 376) — "otro" se mantiene al final
// solo como red de seguridad para datos viejos/llamadas internas que no manden uno
// de la lista, el formulario de Mermas no lo ofrece como opción.
const MOTIVOS_MERMA_VALIDOS = ["liquidado", "vencido", "dañado", "robo", "consumo_interno", "cambio_proveedor", "otro"];

// Registro de merma — usado tanto por el módulo "Mermas" (registro manual) como por
// el flujo de Descuentos activos, para contabilizar la parte de un lote que no se
// logra vender antes de vencer. El costo sale de Loyverse cuando el producto lo
// tiene cargado; si no, se acepta costoManual (digitado a mano en el formulario).
async function accionMerma(env, payload) {
  payload = payload || {};
  const it = await get(env, "SELECT * FROM productos WHERE sku = ?", String(payload.sku || "").trim());
  if (!it) throw new Error("SKU no encontrado en el catálogo: " + payload.sku);

  const cantidad = Number(payload.cantidad);
  if (!cantidad || cantidad <= 0) throw new Error("Cantidad inválida para " + it.nombre);

  const responsable = String(payload.responsable || "").trim();
  if (!responsable) throw new Error("Indica el usuario responsable");

  const unidad = it.sold_by_weight ? "kg" : "un";
  const costoLoyverse = Number(it.costo) || 0;
  const costoManual = Number(payload.costoManual) || 0;
  // El costo de Loyverse manda siempre que exista — el manual es solo un respaldo
  // para productos que todavía no lo tienen cargado ahí.
  const costoUnit = costoLoyverse > 0 ? costoLoyverse : costoManual;
  const costoTotal = Math.round(cantidad * costoUnit);
  const motivo = MOTIVOS_MERMA_VALIDOS.includes(payload.motivo) ? payload.motivo : "otro";
  const origen = payload.origen === "vencimiento" ? "vencimiento" : "manual";
  const fecha = fechaDDMMAAAA();

  const insertRes = await run(env,
    `INSERT INTO mermas (fecha, sku, producto, categoria, unidad, lote, cantidad, costo_unitario, costo_total, motivo, estado_costo, responsable, origen)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    fecha, it.sku, it.nombre, it.categoria, unidad, payload.lote || "", cantidad,
    costoUnit, costoTotal, motivo, costoUnit ? "OK" : "⚠️ SIN COSTO", responsable, origen);

  const out = {
    id: insertRes.meta.last_row_id, filaIndex: insertRes.meta.last_row_id, fecha, sku: it.sku, nombre: it.nombre,
    categoria: it.categoria, unidad, cantidad, costoUnitario: costoUnit, costoTotal, motivo,
    costoDesdeLoyverse: costoLoyverse > 0, responsable
  };

  // Descuenta stock en Loyverse sobre el valor REAL (sin recortar el punto de partida
  // — el tope-en-0 es exclusivo de recepción, ver sumarStockLoyverse) — si falla, la
  // merma ya quedó guardada igual, solo se avisa para revisarlo a mano.
  try {
    const res = await sumarStockLoyverse(env, it, -cantidad);
    if (res.ok) out.nuevoStock = res.despues;
    else out.avisoStock = "⚠️ No se pudo descontar el stock en Loyverse (" + res.motivo + "). Revísalo a mano.";
  } catch (e) {
    out.avisoStock = "⚠️ No se pudo descontar el stock en Loyverse. Revísalo a mano.";
  }

  return out;
}

// GET /?action=historial_mermas[&sku=XXXX][&dias=30][&limit=200]  →  historial de
// mermas registradas, más reciente primero. `dias` filtra en JS sobre el campo
// `fecha` (texto DD/MM/AAAA, igual que vencimientos/auditoría — no se puede
// comparar como texto en SQL, por eso se usa parseFechaDDMMAAAA aquí igual que en
// diasRestantes()).
async function historialMermas(env, { sku, dias, limit } = {}) {
  let sql = "SELECT * FROM mermas WHERE 1=1";
  const params = [];
  const skuLimpio = String(sku || "").trim();
  if (skuLimpio) { sql += " AND sku = ?"; params.push(skuLimpio); }
  sql += " ORDER BY id DESC LIMIT ?";
  const tope = Math.min(Number(limit) || 200, 500);
  params.push(tope);
  const { results } = await env.DB.prepare(sql).bind(...params).all();

  let lista = results;
  const diasNum = Number(dias) || 0;
  if (diasNum > 0) {
    const desde = new Date(Date.now() - diasNum * 86400000);
    lista = lista.filter(r => {
      const d = parseFechaDDMMAAAA(r.fecha);
      return d && d >= desde;
    });
  }

  const totalCosto = lista.reduce((s, r) => s + (Number(r.costo_total) || 0), 0);
  const totalCantidad = lista.reduce((s, r) => s + (Number(r.cantidad) || 0), 0);
  return { lista, totalCosto, totalCantidad, total: lista.length };
}

// POST { action:'merma_motivo', payload:{id,motivo,responsable} }  →  corrige el
// motivo de una merma ya registrada (ej. se anotó "vencido" y en realidad fue
// "dañado"). Mismo estilo que vencimiento_estado, pero acá NO se vuelve a tocar el
// stock en Loyverse — eso ya se descontó al registrar la merma, esto solo corrige
// la clasificación para los reportes. Queda registrado en `auditoria` para trazar
// quién corrigió y cuándo.
async function accionMermaMotivo(env, payload) {
  payload = payload || {};
  const id = Number(payload.id);
  if (!id) throw new Error("Falta el id de la merma");

  const motivo = String(payload.motivo || "").trim();
  if (!MOTIVOS_MERMA_VALIDOS.includes(motivo)) throw new Error("Motivo inválido: " + motivo);

  const responsable = String(payload.responsable || "").trim();
  if (!responsable) throw new Error("Indica el usuario responsable");

  const merma = await get(env, "SELECT * FROM mermas WHERE id = ?", id);
  if (!merma) throw new Error("Merma no encontrada");

  await run(env, "UPDATE mermas SET motivo = ? WHERE id = ?", motivo, id);

  await run(env,
    `INSERT INTO auditoria (fecha, accion, sku, producto, categoria, id_loyverse, stock, motivo, responsable)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    fechaHoraDDMMAAAA(), "correccion_motivo_merma", merma.sku, merma.producto, merma.categoria, null, null,
    "Corrección de motivo de merma #" + id + ": " + merma.motivo + " → " + motivo, responsable);

  return { id, sku: merma.sku, nombre: merma.producto, motivoAnterior: merma.motivo, motivo };
}

// POST { action:'aplicar_descuento_vencimiento', payload:{id,precio,responsable} }
// Reutiliza accionEditarProducto para sincronizar el precio con Loyverse (misma
// función que usa Ficha de producto) — acá solo se decide CUÁNDO llamarla y qué
// guardar en vencimientos, sin reimplementar nada de la comunicación con Loyverse.
async function accionAplicarDescuentoVencimiento(env, payload) {
  payload = payload || {};
  const id = Number(payload.id);
  if (!id) throw new Error("Falta el id del lote");
  const lote = await get(env, "SELECT * FROM vencimientos WHERE id = ?", id);
  if (!lote) throw new Error("Lote no encontrado");
  if (lote.descuento_activo) throw new Error("Este lote ya tiene un descuento activo");

  const precio = Number(payload.precio);
  if (!precio || precio <= 0) throw new Error("Precio inválido");

  const it = await get(env, "SELECT * FROM productos WHERE sku = ?", lote.sku);
  if (!it) throw new Error("SKU no encontrado en el catálogo: " + lote.sku);
  const precioOriginal = it.precio;

  const resPrecio = await accionEditarProducto(env, { sku: lote.sku, precio, responsable: payload.responsable || "" });

  await run(env,
    `UPDATE vencimientos SET descuento_activo=1, precio_original=?, precio_aplicado=?, cant_vendida_desc=0, cant_merma_desc=0, fecha_descuento_aplicado=? WHERE id=?`,
    precioOriginal, resPrecio.precio, fechaHoraDDMMAAAA(), id);

  return { ok: true, sku: lote.sku, nombre: lote.producto, precioOriginal, precioAplicado: resPrecio.precio };
}

// GET /?action=descuentos_activos — lista de lotes con descuento aplicado y
// todavía en gestión (sin cerrar).
async function repDescuentosActivos(env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM vencimientos WHERE descuento_activo = 1 AND sku IS NOT NULL ORDER BY (fecha_vencimiento = '') ASC, fecha_vencimiento ASC"
  ).all();
  return results.map(r => ({
    id: r.id, sku: r.sku, nombre: r.producto, categoria: r.categoria, unidad: r.unidad,
    lote: r.lote, cantidad: r.cantidad, fechaVencimiento: r.fecha_vencimiento,
    precioOriginal: r.precio_original, precioAplicado: r.precio_aplicado,
    cantVendida: r.cant_vendida_desc || 0, cantMerma: r.cant_merma_desc || 0,
    fechaDescuentoAplicado: r.fecha_descuento_aplicado,
    diasRestantes: diasRestantes(r.fecha_vencimiento)
  }));
}

// POST { action:'registrar_gestion_descuento', payload:{id,cantidadVendida,cantidadMerma,responsable} }
// Anota cantidad vendida y/o en merma sobre un lote con descuento activo, SIN
// cerrarlo — salvo que con este movimiento se agote la cantidad total del lote
// (vendida+merma >= cantidad), en cuyo caso se cierra automático a Historial.
async function accionRegistrarGestionDescuento(env, payload) {
  payload = payload || {};
  const id = Number(payload.id);
  if (!id) throw new Error("Falta el id del lote");
  const lote = await get(env, "SELECT * FROM vencimientos WHERE id = ?", id);
  if (!lote) throw new Error("Lote no encontrado");
  if (!lote.descuento_activo) throw new Error("Este lote no tiene un descuento activo");

  const sumaVendida = Math.max(0, Number(payload.cantidadVendida) || 0);
  const sumaMerma = Math.max(0, Number(payload.cantidadMerma) || 0);
  if (sumaVendida <= 0 && sumaMerma <= 0) throw new Error("Indica una cantidad vendida o en merma");

  const nuevaVendida = (Number(lote.cant_vendida_desc) || 0) + sumaVendida;
  const nuevaMerma = (Number(lote.cant_merma_desc) || 0) + sumaMerma;

  let avisoStockMerma = null;
  if (sumaMerma > 0) {
    try {
      const resMerma = await accionMerma(env, {
        sku: lote.sku, cantidad: sumaMerma, motivo: "vencido", origen: "vencimiento",
        responsable: payload.responsable || ""
      });
      if (resMerma.avisoStock) avisoStockMerma = resMerma.avisoStock;
    } catch (e) {
      avisoStockMerma = "⚠️ La merma no se pudo registrar del todo: " + e.message;
    }
  }

  await run(env, "UPDATE vencimientos SET cant_vendida_desc=?, cant_merma_desc=? WHERE id=?", nuevaVendida, nuevaMerma, id);

  const totalGestionado = nuevaVendida + nuevaMerma;
  if (totalGestionado >= Number(lote.cantidad)) {
    const cierre = await accionCerrarGestionDescuento(env, { id, responsable: payload.responsable || "", motivo: "agotado" });
    return { ...cierre, cerrado: true, cantVendida: nuevaVendida, cantMerma: nuevaMerma, cantidadTotal: lote.cantidad, avisoStock: avisoStockMerma };
  }
  return { ok: true, sku: lote.sku, cantVendida: nuevaVendida, cantMerma: nuevaMerma, cantidadTotal: lote.cantidad, cerrado: false, avisoStock: avisoStockMerma };
}

// POST { action:'cerrar_gestion_descuento', payload:{id,responsable} } — cierre
// manual explícito, o automático cuando se agota la cantidad. Pasa el lote a
// Historial (estado='Revisado', igual que el resto de cierres) conservando los
// acumulados de vendido/merma.
async function accionCerrarGestionDescuento(env, payload) {
  payload = payload || {};
  const id = Number(payload.id);
  if (!id) throw new Error("Falta el id del lote");
  const lote = await get(env, "SELECT * FROM vencimientos WHERE id = ?", id);
  if (!lote) throw new Error("Lote no encontrado");
  if (!lote.descuento_activo) throw new Error("Este lote no tiene un descuento activo");

  const motivo = payload.motivo === "agotado" ? "descuento_agotado" : "descuento_cerrado_manual";
  await run(env,
    "UPDATE vencimientos SET estado='Revisado', descuento_activo=0, motivo_cierre=?, fecha_revision=?, revisado_por=? WHERE id=?",
    motivo, fechaHoraDDMMAAAA(), payload.responsable || "", id);

  return { ok: true, sku: lote.sku, nombre: lote.producto, estado: "Revisado", motivo };
}

// action=precios_pendientes_restaurar (portado de Marín 376) — lotes cerrados por
// "agotado" o "Cerrar gestión" cuyo precio de descuento nunca volvió a Loyverse (se
// detecta comparando el precio actual del producto con el precio_aplicado guardado:
// si siguen iguales, lo más probable es que nunca se restauró).
async function repPreciosPendientesRestaurar(env) {
  const { results } = await env.DB.prepare(
    "SELECT v.*, p.precio AS precio_actual FROM vencimientos v JOIN productos p ON p.sku = v.sku " +
    "WHERE v.descuento_activo = 0 AND v.motivo_cierre IN ('descuento_agotado','descuento_cerrado_manual') " +
    "AND v.precio_original IS NOT NULL AND v.precio_aplicado IS NOT NULL " +
    "AND ABS(p.precio - v.precio_aplicado) < 0.5 ORDER BY v.fecha_revision DESC LIMIT 100"
  ).all();
  return results.map(r => ({
    filaIndex: r.id, sku: r.sku, nombre: r.producto,
    precioOriginal: r.precio_original, precioAplicado: r.precio_aplicado, precioActual: r.precio_actual,
    fechaCierre: r.fecha_revision
  }));
}

// POST { action:'restaurar_precio_descuento', payload:{filaIndex,responsable} } →
// restaura a mano el precio original de un lote detectado por precios_pendientes_restaurar
// (reusa accionEditarProducto, mismo mecanismo que ya usa chequearYRevertirDescuentosVencidos).
async function accionRestaurarPrecioDescuento(env, payload) {
  payload = payload || {};
  const row = await get(env, "SELECT * FROM vencimientos WHERE id = ?", Number(payload.filaIndex));
  if (!row) throw new Error("Lote no encontrado");
  if (row.precio_original == null) throw new Error("Este lote no tiene un precio original guardado para restaurar");
  await accionEditarProducto(env, { sku: row.sku, precio: row.precio_original, responsable: payload.responsable || "manual" });
  if (row.descuento_activo) {
    await run(env,
      "UPDATE vencimientos SET estado='Revisado', descuento_activo=0, motivo_cierre='vencido_con_descuento', fecha_revision=?, revisado_por=? WHERE id=?",
      fechaHoraDDMMAAAA(), payload.responsable || "manual", row.id);
  }
  return { sku: row.sku, nombre: row.producto };
}

// Corre desde scheduled() (mismo cron de las 8:00/15:00) — un lote con
// descuento_activo=1 cuya fecha_vencimiento ya pasó se considera "no se vendió a
// tiempo ni con rebaja": se restaura el precio normal en Loyverse y se cierra a
// Historial. No se vuelve a aplicar descuento sobre ese lote.
async function chequearYRevertirDescuentosVencidos(env) {
  const { results: rows } = await env.DB.prepare("SELECT * FROM vencimientos WHERE descuento_activo = 1 AND sku IS NOT NULL").all();
  let revertidos = 0;
  for (const row of rows) {
    const dias = diasRestantes(row.fecha_vencimiento);
    if (dias == null || dias >= 0) continue; // sin fecha, o todavía no vence — sigue en Descuentos activos
    try {
      if (row.precio_original != null) {
        await accionEditarProducto(env, { sku: row.sku, precio: row.precio_original, responsable: "sistema (auto-reversión por vencimiento)" });
      }
      await run(env,
        "UPDATE vencimientos SET estado='Revisado', descuento_activo=0, motivo_cierre='vencido_con_descuento', fecha_revision=?, revisado_por=? WHERE id=?",
        fechaHoraDDMMAAAA(), "sistema (auto-reversión por vencimiento)", row.id);
      revertidos++;
    } catch (e) {
      await logMsg(env, "⚠️ Error al revertir descuento vencido de " + row.producto + ": " + e.message);
    }
  }
  if (revertidos) await logMsg(env, "↩️ " + revertidos + " descuento(s) revertido(s) por vencimiento (precio normal restaurado)");
  return revertidos;
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

// Resumen de ventas por sku (u_all/u7/u14/u30/u90/rev/prof) en una sola consulta —
// equivalente a la vista vw_ventas_resumen de Marín, pero calculado sobre la tabla
// `ventas` de Argomedo (histórico completo, nunca se purga) en vez de una tabla
// separada de ventas diarias. rev/prof solo son reales desde que se agregaron las
// columnas venta/utilidad (Fase 1) — antes de eso quedan en 0 para esas filas viejas.
async function ventasResumenTodas(env) {
  const ahora = Date.now();
  const d7 = fechaISO(new Date(ahora - 7 * 86400000));
  const d14 = fechaISO(new Date(ahora - 14 * 86400000));
  const d30 = fechaISO(new Date(ahora - 30 * 86400000));
  const d90 = fechaISO(new Date(ahora - 90 * 86400000));
  const { results } = await env.DB.prepare(
    `SELECT sku,
       SUM(cantidad) AS u_all,
       SUM(CASE WHEN fecha_venta >= ? THEN cantidad ELSE 0 END) AS u7,
       SUM(CASE WHEN fecha_venta >= ? THEN cantidad ELSE 0 END) AS u14,
       SUM(CASE WHEN fecha_venta >= ? THEN cantidad ELSE 0 END) AS u30,
       SUM(CASE WHEN fecha_venta >= ? THEN cantidad ELSE 0 END) AS u90,
       SUM(venta) AS rev,
       SUM(utilidad) AS prof
     FROM ventas GROUP BY sku`
  ).bind(d7, d14, d30, d90).all();
  return results || [];
}

// ============================================================
//  PAYLOAD DEL DASHBOARD (GET sin action) — arma TODO el estado inicial que
//  necesita el frontend de Marín para arrancar: catálogo, ventas resumidas,
//  pendientes, proveedores extra, riesgo excluido, favoritos, multiplos,
//  empaques, palabras. Sin esto la app no carga (ver plan "FASE 1").
//  Adaptado del payloadDashboard de Marín 376 a que `productos.proveedor` es
//  TEXT en Argomedo (no FK) y a la tabla `ventas` propia (histórico completo,
//  nunca se purga, a diferencia de la `ventas_diarias` rodante de Marín).
// ============================================================
async function payloadDashboard(env, synced, syncMsg) {
  await asegurarTablas(env);
  const { results: productos } = await env.DB.prepare("SELECT * FROM productos").all();

  const { results: proveedoresRows } = await env.DB.prepare("SELECT id, nombre FROM proveedores").all();
  const proveedorNombrePorId = {};
  proveedoresRows.forEach(pr => { proveedorNombrePorId[pr.id] = pr.nombre; });

  const itemsRows = {};
  productos.forEach(p => {
    itemsRows[p.sku] = {
      id: p.id_loyverse, vid: p.variant_id || "", ref: p.sku, nombre: p.nombre,
      prov: p.proveedor || "SIN PROVEEDOR", cat: p.categoria || "", costo: p.costo || 0, precio: p.precio || 0,
      stock: p.stock, track: !!p.track_stock, barcode: p.barcode || "", peso: !!p.sold_by_weight,
      creado: p.fecha_creacion || null, descripcion: p.descripcion || "", imagen: p.imagen_url || "",
      proveedorId: p.proveedor_id || null,
      proveedorNombre: p.proveedor_id ? (proveedorNombrePorId[p.proveedor_id] || null) : null,
      sector: p.sector || null
    };
  });

  const resumen = await ventasResumenTodas(env);
  const ventasRows = {};
  resumen.forEach(r => {
    ventasRows[r.sku] = {
      ref: r.sku, u_all: r.u_all || 0, u7: r.u7 || 0, u14: r.u14 || 0, u30: r.u30 || 0, u90: r.u90 || 0,
      rev: Math.round(r.rev || 0), prof: Math.round(r.prof || 0)
    };
  });

  const hoyISO = fechaISO();
  const { results: ventasHoyRows } = await env.DB.prepare("SELECT DISTINCT sku FROM ventas WHERE fecha_venta = ?").bind(hoyISO).all();
  const hoyRowsObj = {};
  ventasHoyRows.forEach(r => { hoyRowsObj[r.sku] = 1; });

  // Pedidos pendientes — se manda siempre junto al resto del dashboard para que el
  // frontend pueda avisar "ya pedido" sin una consulta extra por producto.
  let pendientesRows = [];
  try {
    const { results } = await env.DB.prepare(
      "SELECT sku, barcode, COALESCE(nombre, producto) AS nombre, proveedor, cantidad, canal, fecha, costo_unitario, costo_total, fecha_llegada_estimada, estado FROM pedidos_pendientes"
    ).all();
    pendientesRows = results || [];
  } catch (err) { /* tabla recién migrada, sin filas todavía */ }

  // Proveedores extra (multi-proveedor por FK) — mapa sku → [id,...] y sku → [nombre,...].
  // Argomedo solo tiene el mecanismo FK (`producto_proveedor_extra`); no existe el mecanismo
  // de texto libre más viejo de Marín (`producto_proveedores`), así que provsExtra (texto)
  // no se manda — el frontend ya sabe convivir sin él (cae a prov/proveedorNombre).
  let provsIdsExtraObj = {}, provsNombresExtraObj = {};
  try {
    const { results: extraRows } = await env.DB.prepare("SELECT sku, proveedor_id FROM producto_proveedor_extra").all();
    extraRows.forEach(r => {
      (provsIdsExtraObj[r.sku] = provsIdsExtraObj[r.sku] || []).push(r.proveedor_id);
      const nombre = proveedorNombrePorId[r.proveedor_id];
      if (nombre) (provsNombresExtraObj[r.sku] = provsNombresExtraObj[r.sku] || []).push(nombre);
    });
  } catch (err) { /* sin filas todavía */ }

  let riesgoExcluidos = [];
  try { riesgoExcluidos = await repRiesgoExcluidos(env); } catch (err) { /* sin filas todavía */ }

  let favoritos = [];
  try { favoritos = await repFavoritos(env); } catch (err) { /* sin filas todavía */ }

  let multiplosObj = {}, empaquesObj = {}, palabrasObj = {};
  try { ({ multiplos: multiplosObj, empaques: empaquesObj, palabras: palabrasObj } = await obtenerMultiplosProducto(env)); }
  catch (err) { /* sin filas todavía */ }

  return {
    ok: true,
    version: "v2",
    synced: !!synced,
    syncMsg: syncMsg || "",
    ventasHoy: ventasHoyRows.length,
    items: { rows: itemsRows },
    ventas: { rows: ventasRows, hoy: { fecha: hoyISO, rows: hoyRowsObj } },
    pendientes: { rows: pendientesRows },
    provsIdsExtra: provsIdsExtraObj,
    provsNombresExtra: provsNombresExtraObj,
    riesgoExcluidos: riesgoExcluidos,
    favoritos: favoritos,
    multiplos: multiplosObj,
    empaques: empaquesObj,
    palabras: palabrasObj,
    serverTime: new Date().toISOString()
  };
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

// POST { action:'renombrar_proveedor', payload:{id,nombre} } (portado de Marín 376)
// → renombra un proveedor del catálogo (por id, no por nombre — evita ambigüedad si
// dos filas comparten nombre visible con espacios distintos).
async function accionRenombrarProveedor(env, payload) {
  const id = Number((payload && payload.id) || 0);
  const nombreNuevo = String((payload && payload.nombre) || "").trim();
  if (!id) throw new Error("Falta el id del proveedor");
  if (!nombreNuevo) throw new Error("Falta el nombre nuevo");
  const actual = await get(env, "SELECT id, nombre FROM proveedores WHERE id = ?", id);
  if (!actual) throw new Error("Ese proveedor no existe");
  const chocaCon = await get(env, "SELECT id FROM proveedores WHERE id != ? AND nombre = ?", id, nombreNuevo);
  if (chocaCon) throw new Error("Ya existe otro proveedor con ese nombre: " + nombreNuevo);
  await run(env, "UPDATE proveedores SET nombre = ? WHERE id = ?", nombreNuevo, id);
  // El nombre principal de producto (productos.proveedor, TEXT) se guarda por copia, no por
  // FK — hay que propagar el renombre ahí también para no dejarlo desactualizado.
  await run(env, "UPDATE productos SET proveedor = ? WHERE proveedor = ?", nombreNuevo, actual.nombre);
  return { proveedor: { id, nombre: nombreNuevo }, nombreAnterior: actual.nombre };
}

// POST { action:'renombrar_sector', payload:{actual,nuevo} } (portado de Marín 376) →
// renombra un sector; si el nombre destino ya existe, se fusionan (los productos del
// sector viejo pasan al nuevo, y el nombre viejo se retira del catálogo).
async function accionRenombrarSector(env, payload) {
  const actualNombre = String((payload && payload.actual) || "").trim();
  const nuevoNombre = String((payload && payload.nuevo) || "").trim();
  if (!actualNombre) throw new Error("Falta el sector actual");
  if (!nuevoNombre) throw new Error("Falta el nombre nuevo");
  if (actualNombre === nuevoNombre) return { sinCambios: true, productosActualizados: 0 };

  const yaExisteDestino = await get(env, "SELECT id FROM sectores WHERE nombre = ?", nuevoNombre);
  const fusionado = !!yaExisteDestino;
  if (!fusionado) await run(env, "INSERT OR IGNORE INTO sectores (nombre) VALUES (?)", nuevoNombre);

  const { meta } = await run(env, "UPDATE productos SET sector = ? WHERE sector = ?", nuevoNombre, actualNombre);
  await run(env, "DELETE FROM sectores WHERE nombre = ?", actualNombre);
  await run(env, "DELETE FROM sectores_personalizados WHERE nombre = ?", actualNombre);
  if (!fusionado) await run(env, "INSERT OR IGNORE INTO sectores_personalizados (nombre) VALUES (?)", nuevoNombre);

  return { sectorAnterior: actualNombre, sectorNuevo: nuevoNombre, fusionado, productosActualizados: (meta && meta.changes) || 0 };
}

// POST { action:'editar_codigo_barras', payload:{sku,barcode} } (portado de Marín 376)
// → reusa accionEditarProducto (que ya valida duplicados y reenvía a Loyverse), sin
// duplicar esa lógica en una función aparte.
async function accionEditarCodigoBarras(env, payload) {
  const sku = String((payload && payload.sku) || "").trim();
  if (!sku) throw new Error("Falta el SKU");
  return accionEditarProducto(env, { sku, barcode: String((payload && payload.barcode) || "").trim(), responsable: payload && payload.responsable });
}

// POST { action:'crear_categoria', payload:{nombre} } (portado de Marín 376) → crea una
// categoría nueva directo en Loyverse (evita duplicar si ya existe una con ese nombre).
async function accionCrearCategoria(env, payload) {
  const nombre = String((payload && payload.nombre) || "").trim();
  if (!nombre) throw new Error("Falta el nombre de la categoría");
  const existentes = await loyverseGetAll(env, "/categories", "categories");
  const dup = existentes.find(c => String(c.name || "").trim().toUpperCase() === nombre.toUpperCase());
  if (dup) return { categoria: { id: dup.id, name: dup.name }, yaExistia: true };
  const creada = await loyversePost(env, "/categories", { name: nombre });
  if (!creada || !creada.id) throw new Error("Loyverse no devolvió la categoría creada");
  return { categoria: { id: creada.id, name: creada.name } };
}

// POST { action:'consumo_interno', payload:{items:[{sku,cantidad,costoManual}],responsable} }
// (portado de Marín 376) → registra varias mermas de una con motivo fijo "consumo_interno"
// (reusa accionMerma, sin duplicar la lógica de descuento de stock/costo).
async function accionConsumoInterno(env, payload) {
  const items = Array.isArray(payload && payload.items) ? payload.items : [];
  if (!items.length) throw new Error("No hay productos para registrar");
  let total = 0, n = 0, avisoStock = "";
  for (const it of items) {
    const r = await accionMerma(env, {
      sku: it.sku, cantidad: it.cantidad, costoManual: it.costoManual,
      motivo: "consumo_interno", origen: "manual", responsable: payload.responsable
    });
    total += r.costoTotal || 0;
    n++;
    if (r.avisoStock) avisoStock = r.avisoStock;
  }
  return { resumen: { n, total, avisoStock } };
}

// POST { action:'marcar_descuento_factura', payload:{filaIndex,montoDescuento,revisadoPor} }
// (portado de Marín 376) → cierra un lote "Retirado" cuando el proveedor lo cambió con
// descuento en la factura (en vez de reponer el producto físico).
async function accionMarcarDescuentoFactura(env, payload) {
  const fi = Number((payload && payload.filaIndex) || 0);
  const row = await get(env, "SELECT * FROM vencimientos WHERE id = ?", fi);
  if (!row) throw new Error("Lote no encontrado");
  if (row.estado !== "Retirado") throw new Error("Este lote no está en estado 'Retirado' — puede que ya se haya cerrado.");
  const monto = payload && payload.montoDescuento != null && payload.montoDescuento !== "" && !isNaN(Number(payload.montoDescuento))
    ? Number(payload.montoDescuento) : null;
  await run(env,
    "UPDATE vencimientos SET estado='Revisado', motivo_cierre='descuento_factura', monto_descuento=?, fecha_revision=?, revisado_por=? WHERE id=?",
    monto, fechaHoraDDMMAAAA(), (payload && payload.revisadoPor) || "", fi);
  return { sku: row.sku, nombre: row.producto, categoria: row.categoria, unidad: row.unidad, lote: row.lote, cantidad: row.cantidad, montoDescuento: monto };
}

// ============================================================
//  ELIMINAR PROVEEDOR — solo permitido si no tiene productos
//  asignados (evita dejar productos huérfanos apuntando a un
//  proveedor que ya no existe en el catálogo).
// ============================================================
async function accionEliminarProveedor(env, payload) {
  const nombre = String((payload || {}).nombre || "").trim();
  if (!nombre) throw new Error("Falta el nombre del proveedor");
  if (nombre === "SIN PROVEEDOR") throw new Error("SIN PROVEEDOR no es un proveedor real, no se puede eliminar");

  const enUso = await get(env, "SELECT COUNT(*) as total FROM productos WHERE proveedor = ?", nombre);
  if (enUso && enUso.total > 0) {
    throw new Error("No se puede eliminar: tiene " + enUso.total + " producto(s) asignado(s)");
  }
  await run(env, "DELETE FROM proveedores WHERE nombre = ?", nombre);
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
  const { results: extras } = await env.DB.prepare(
    "SELECT pv.id, pv.nombre FROM producto_proveedor_extra pe JOIN proveedores pv ON pv.id = pe.proveedor_id WHERE pe.sku = ? ORDER BY pv.nombre"
  ).bind(sku).all();
  it.proveedoresExtra = extras;
  return it;
}

// Resumen de ventas de UN sku (u7/u14/u30/u90/rev/prof) — misma ventana de fechas
// que ventasResumenTodas(), pero acotado a un solo producto.
async function ventaResumenUnSku(env, sku) {
  const ahora = Date.now();
  const d7 = fechaISO(new Date(ahora - 7 * 86400000));
  const d14 = fechaISO(new Date(ahora - 14 * 86400000));
  const d30 = fechaISO(new Date(ahora - 30 * 86400000));
  const d90 = fechaISO(new Date(ahora - 90 * 86400000));
  return get(env,
    `SELECT sku,
       SUM(CASE WHEN fecha_venta >= ? THEN cantidad ELSE 0 END) AS u7,
       SUM(CASE WHEN fecha_venta >= ? THEN cantidad ELSE 0 END) AS u14,
       SUM(CASE WHEN fecha_venta >= ? THEN cantidad ELSE 0 END) AS u30,
       SUM(CASE WHEN fecha_venta >= ? THEN cantidad ELSE 0 END) AS u90,
       SUM(venta) AS rev, SUM(utilidad) AS prof
     FROM ventas WHERE sku = ? GROUP BY sku`,
    d7, d14, d30, d90, sku);
}

// ============================================================
//  FICHA COMPLETA DE PRODUCTO (portado de Marín 376, ver repFichaProducto) —
//  producto + ventas + lotes activos + mermas recientes + movimientos de
//  auditoría + historial de precios + proveedor (principal y extras). El
//  ?action=ficha_producto de Argomedo devolvía solo el producto plano
//  (ver fichaProducto arriba, que se conserva para no romper nada existente);
//  esta versión es la que consume el frontend de Marín.
// ============================================================
async function repFichaProducto(env, sku) {
  const producto = await get(env, "SELECT * FROM productos WHERE sku = ?", sku);
  if (!producto) throw new Error("SKU no encontrado en el catálogo: " + sku);
  const venta = await ventaResumenUnSku(env, sku);

  const { results: lotes } = await env.DB.prepare("SELECT * FROM vencimientos WHERE sku = ? ORDER BY fecha_vencimiento ASC").bind(sku).all();
  const ordenPrio = { "⚫": 0, "🔴": 1, "🟠": 2, "🟡": 3, "🟢": 4, "—": 5 };
  const lotesActivos = lotes.filter(l => l.estado !== "Revisado")
    .sort((a, b) => (ordenPrio[a.prioridad] ?? 9) - (ordenPrio[b.prioridad] ?? 9));

  const { results: mermas } = await env.DB.prepare("SELECT * FROM mermas WHERE sku = ? ORDER BY id DESC LIMIT 20").bind(sku).all();
  const { results: auditoria } = await env.DB.prepare("SELECT * FROM auditoria WHERE sku = ? ORDER BY id DESC LIMIT 30").bind(sku).all();
  const { results: historialPrecios } = await env.DB.prepare("SELECT * FROM historial_precios WHERE sku = ? ORDER BY id DESC LIMIT 20").bind(sku).all();

  const fechasCandidatas = [];
  if (auditoria[0]) fechasCandidatas.push(auditoria[0].fecha);
  if (mermas[0]) fechasCandidatas.push(mermas[0].fecha);
  if (lotes[0]) fechasCandidatas.push(lotes[0].fecha_ingreso);
  const ultimaModificacion = fechasCandidatas.sort((a, b) => {
    const da = parseFechaDDMMAAAA((a || "").slice(0, 10)), db = parseFechaDDMMAAAA((b || "").slice(0, 10));
    return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
  })[0] || null;

  const proveedor = producto.proveedor_id ? await get(env, "SELECT id, nombre FROM proveedores WHERE id = ?", producto.proveedor_id) : null;
  const { results: proveedoresExtraRows } = await env.DB.prepare(
    "SELECT pv.id, pv.nombre FROM producto_proveedor_extra pe JOIN proveedores pv ON pv.id = pe.proveedor_id WHERE pe.sku = ? ORDER BY pv.nombre"
  ).bind(sku).all();

  return {
    producto: {
      sku: producto.sku, nombre: producto.nombre, categoria: producto.categoria,
      barcode: producto.barcode, costo: producto.costo, precio: producto.precio,
      margen: producto.precio > 0 ? Math.round((1 - producto.costo / producto.precio) * 100) : null,
      stock: producto.stock, trackStock: !!producto.track_stock, soldByWeight: !!producto.sold_by_weight,
      descripcion: producto.descripcion || "", idLoyverse: producto.id_loyverse || "",
      imagen: producto.imagen_url || "",
      proveedorId: producto.proveedor_id || null, proveedor: proveedor ? proveedor.nombre : (producto.proveedor || null),
      sector: producto.sector || null,
      proveedoresExtra: proveedoresExtraRows.map(r => r.nombre),
      proveedoresIdsExtra: proveedoresExtraRows.map(r => ({ id: r.id, nombre: r.nombre })),
      ultimaModificacion
    },
    ventas: venta ? { u7: venta.u7 || 0, u14: venta.u14 || 0, u30: venta.u30 || 0, u90: venta.u90 || 0, rev: Math.round(venta.rev || 0), prof: Math.round(venta.prof || 0) } : null,
    lotes: lotesActivos.map(l => ({
      filaIndex: l.id, lote: l.lote, cantidad: l.cantidad, fechaVencimiento: l.fecha_vencimiento,
      estado: l.estado, prioridad: l.prioridad, accion: l.accion, precioRecomendado: l.precio_recomendado
    })),
    mermasRecientes: mermas.map(m => ({ fecha: m.fecha, cantidad: m.cantidad, motivo: m.motivo, costoTotal: m.costo_total, responsable: m.responsable })),
    movimientos: auditoria.map(a => ({ fecha: a.fecha, accion: a.accion, stock: a.stock, motivo: a.motivo, responsable: a.responsable })),
    historialPrecios: historialPrecios.map(h => ({
      fecha: h.fecha, precioAntes: h.precio_antes, precioDespues: h.precio_despues,
      costoAntes: h.costo_antes, costoDespues: h.costo_despues, responsable: h.responsable
    }))
  };
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
  const { storeId } = await obtenerStoreId(env);

  const variantes = (item.variants || []).map(v => {
    if (v.variant_id !== it.variant_id) return v;
    const copia = Object.assign({}, v, { barcode: nuevoBarcode, cost: costo });
    // Igual que en actualizarPrecioCostoLoyverse: Loyverse rechaza default_price si
    // default_pricing_type sigue en "VARIABLE" — al editar desde la ficha se asume
    // que el usuario quiere un precio fijo, así que se ajusta el tipo junto al valor.
    copia.default_pricing_type = "FIXED";
    copia.default_price = precio;
    const stores = (v.stores || []).map(s =>
      s.store_id === storeId ? Object.assign({}, s, { price: precio, pricing_type: "FIXED" }) : s
    );
    if (!stores.some(s => s.store_id === storeId)) {
      stores.push({ store_id: storeId, price: precio, pricing_type: "FIXED", available_for_sale: true });
    }
    copia.stores = stores;
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
//  MÓDULO PROVEEDORES — listado con conteo, y productos de uno.
//  Un producto puede tener un proveedor PRINCIPAL (productos.proveedor)
//  y proveedores EXTRA (producto_proveedor_extra) — el conteo y el
//  listado consideran ambos, sin contar dos veces el mismo SKU si
//  por error apareciera en los dos a la vez.
// ============================================================
async function listaProveedoresConConteo(env) {
  // LEFT JOIN desde la tabla `proveedores` (catálogo de nombres) hacia `productos`
  // (principal) y `producto_proveedor_extra` (adicionales), combinados con UNION
  // y contados con DISTINCT sku — así aparecen también los proveedores creados
  // pero sin ningún producto asignado todavía (total=0).
  const { results } = await env.DB.prepare(
    `SELECT proveedor, COUNT(DISTINCT sku) as total FROM (
       SELECT pr.nombre as proveedor, p.sku as sku FROM proveedores pr LEFT JOIN productos p ON p.proveedor = pr.nombre
       UNION
       SELECT pr.nombre as proveedor, pe.sku as sku FROM proveedores pr JOIN producto_proveedor_extra pe ON pe.proveedor_id = pr.id
       UNION ALL
       SELECT 'SIN PROVEEDOR' as proveedor, sku FROM productos WHERE proveedor IS NULL OR proveedor = ''
     )
     GROUP BY proveedor
     ORDER BY CASE WHEN proveedor='SIN PROVEEDOR' THEN 1 ELSE 0 END, proveedor COLLATE NOCASE`
  ).all();
  // El LEFT JOIN sin match deja sku=NULL — se filtra ese caso de la cuenta pero se
  // conserva el proveedor en la lista (total=0), igual que antes.
  return results.map(r => ({ proveedor: r.proveedor, total: r.total }));
}

async function productosDeProveedor(env, proveedor) {
  proveedor = String(proveedor || "").trim();
  const esSinProveedor = !proveedor || proveedor === "SIN PROVEEDOR";
  if (esSinProveedor) {
    const { results } = await env.DB.prepare(
      "SELECT sku, nombre, barcode, precio, costo, stock, sold_by_weight, track_stock FROM productos WHERE proveedor IS NULL OR proveedor = '' ORDER BY nombre"
    ).all();
    return results;
  }
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT p.sku, p.nombre, p.barcode, p.precio, p.costo, p.stock, p.sold_by_weight, p.track_stock
     FROM productos p
     LEFT JOIN producto_proveedor_extra pe ON pe.sku = p.sku
     LEFT JOIN proveedores pv ON pv.id = pe.proveedor_id
     WHERE p.proveedor = ? OR pv.nombre = ?
     ORDER BY p.nombre`
  ).bind(proveedor, proveedor).all();
  return results;
}

// POST { action:'agregar_proveedor_extra', payload:{sku,proveedor} } — asigna un
// proveedor ADICIONAL a un producto (además de su proveedor principal). Crea el
// proveedor en el catálogo si no existía todavía, igual que el proveedor principal.
async function accionAgregarProveedorExtra(env, payload) {
  payload = payload || {};
  const sku = String(payload.sku || "").trim();
  const nombre = String(payload.proveedor || "").trim();
  if (!sku) throw new Error("Falta el SKU");
  if (!nombre) throw new Error("Falta el nombre del proveedor");
  const it = await get(env, "SELECT sku FROM productos WHERE sku = ?", sku);
  if (!it) throw new Error("Producto no encontrado: " + sku);

  await run(env, "INSERT OR IGNORE INTO proveedores (nombre) VALUES (?)", nombre);
  const prov = await get(env, "SELECT id FROM proveedores WHERE nombre = ?", nombre);
  await run(env, "INSERT OR IGNORE INTO producto_proveedor_extra (sku, proveedor_id) VALUES (?, ?)", sku, prov.id);
  return { sku, proveedor: nombre };
}

// POST { action:'quitar_proveedor_extra', payload:{sku,proveedor} } — quita un
// proveedor adicional de un producto (no toca el proveedor principal).
async function accionQuitarProveedorExtra(env, payload) {
  payload = payload || {};
  const sku = String(payload.sku || "").trim();
  const nombre = String(payload.proveedor || "").trim();
  if (!sku) throw new Error("Falta el SKU");
  if (!nombre) throw new Error("Falta el nombre del proveedor");
  const prov = await get(env, "SELECT id FROM proveedores WHERE nombre = ?", nombre);
  if (!prov) return { sku, proveedor: nombre }; // no existía, nada que quitar
  await run(env, "DELETE FROM producto_proveedor_extra WHERE sku = ? AND proveedor_id = ?", sku, prov.id);
  return { sku, proveedor: nombre };
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
      if (action === "sync" || action === "full") {
        // Marín espera de vuelta el payload completo del dashboard (con synced/syncMsg),
        // no solo el resultado del sync — así el mismo botón "Sincronizar" reemplaza los
        // datos en pantalla sin necesitar un segundo request.
        let synced = false, syncMsg = "";
        try {
          const resultado = await sincronizarCatalogo(env);
          await marcarCatalogoActualizado(env);
          synced = true;
          syncMsg = "Catálogo sincronizado" + (resultado && resultado.total != null ? ": " + resultado.total + " productos" : "");
        } catch (err) { syncMsg = err.message; }
        return json(await payloadDashboard(env, synced, syncMsg));
      }

      // GET /?action=catalogo  →  devuelve TODO el catálogo compacto desde D1 (sin tocar
      // Loyverse) — esto es lo que el frontend carga una vez al abrir la app.
      if (action === "catalogo") {
        const items = await catalogoCompacto(env);
        // Mínimos/empaques de pedido configurados a mano (Proveedores → Configuración)
        // — se mandan siempre junto al catálogo para que el frontend los aplique sin
        // pedir nada aparte, mismo criterio que usa Marín 376.
        let multiplos = {}, empaques = {}, palabras = {};
        try { ({ multiplos, empaques, palabras } = await obtenerMultiplosProducto(env)); } catch (e) { /* tabla recién creada, sin filas todavía */ }
        // "Ya pedido a X" — pedidos confirmados que todavía no se recibieron.
        let pendientes = {};
        try { pendientes = await obtenerPedidosPendientesPorSku(env); } catch (e) { /* columna recién migrada, sin filas todavía */ }
        return json({ ok: true, items, total: items.length, multiplos, empaques, palabras, pendientes });
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

      // GET /?action=historial_producto&sku=XXXXX[&limit=N]  →  últimos movimientos
      // (recepciones, ajustes, ediciones) de un producto, para mostrar el historial en
      // la app. limit es opcional (default 30) — Caja surtida lo usa con limit=1 para
      // traer solo el último movimiento sin pedir de más.
      if (action === "historial_producto") {
        const sku = String(url.searchParams.get("sku") || "").trim();
        if (!sku) return json({ ok: false, error: "Falta el parámetro sku" }, 400);
        const limitParam = Number(url.searchParams.get("limit"));
        const historial = await historialProducto(env, sku, limitParam > 0 ? limitParam : null);
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

      // POST { action:'renombrar_proveedor', payload:{id,nombre} }
      if (action === "renombrar_proveedor") {
        const resultado = await accionRenombrarProveedor(env, payload);
        await marcarCatalogoActualizado(env);
        return json({ ok: true, ...resultado });
      }

      // POST { action:'renombrar_sector', payload:{actual,nuevo} }
      if (action === "renombrar_sector") {
        const resultado = await accionRenombrarSector(env, payload);
        await marcarCatalogoActualizado(env);
        return json({ ok: true, ...resultado });
      }

      // POST { action:'crear_categoria', payload:{nombre} } → crea una categoría
      // nueva directo en Loyverse (sin duplicar si ya existe).
      if (action === "crear_categoria") {
        const resultado = await accionCrearCategoria(env, payload);
        return json({ ok: true, ...resultado });
      }

      // GET /?action=vencimientos[&estado=Pendiente|Revisado|todos][&sku=XXXX]
      // → lotes con fecha de vencimiento, con días restantes y urgencia calculados.
      if (action === "vencimientos") {
        const estado = url.searchParams.get("estado") || "";
        const sku = url.searchParams.get("sku") || "";
        const lista = await listaVencimientos(env, { estado, sku });
        // `lotes` (además de `lista`) — Marín Pedidos espera esta clave; se manda la
        // misma lista con los nombres de campo que su frontend usa (filaIndex/etc).
        const lotes = lista.map(r => ({
          filaIndex: r.id, sku: r.sku, nombre: r.producto, categoria: r.categoria, unidad: r.unidad,
          lote: r.lote, cantidad: r.cantidad, fechaVencimiento: r.fecha_vencimiento, estado: r.estado,
          prioridad: r.prioridad, accion: r.accion, precioRecomendado: r.precio_recomendado || null,
          costoUsado: r.costo_usado || null, costoOrigen: r.costo_origen
        }));
        return json({ ok: true, lista, lotes });
      }

      // GET /?action=recalcular_vencimientos → recalcula estado/prioridad/acción/precio
      // recomendado de todos los lotes activos (motor de Marín 376, ver calcularLote).
      if (action === "recalcular_vencimientos") {
        const recalculados = await recalcularVencimientosD1(env);
        await marcarCatalogoActualizado(env);
        return json({ ok: true, recalculados });
      }

      // POST { action:'vencimiento_estado', payload:{id,estado,responsable,retirarStock,cantidadRetiro} }
      // → cambia el estado de un lote (Revisado/Cambiado/Descuento recibido/Desechado),
      //   descontando stock en Loyverse si corresponde retiro de góndola.
      if (action === "vencimiento_estado") {
        const resultado = await accionVencimientoEstado(env, payload);
        await marcarCatalogoActualizado(env);
        return json({ ok: true, ...resultado });
      }

      // POST { action:'vencimiento_eliminar', payload:{id,responsable} } → borra un
      // lote de vencimientos (no toca stock ni Loyverse).
      if (action === "vencimiento_eliminar") {
        const resultado = await accionEliminarLoteVencimiento(env, payload);
        await marcarCatalogoActualizado(env);
        return json({ ok: true, ...resultado });
      }

      // POST { action:'marcar_descuento_factura', payload:{filaIndex,montoDescuento,revisadoPor} }
      // → cierra un lote "Retirado" cuando el proveedor lo cambió con descuento en la
      // factura en vez de reponer el producto físico.
      if (action === "marcar_descuento_factura") {
        const resultado = await accionMarcarDescuentoFactura(env, payload);
        await marcarCatalogoActualizado(env);
        return json({ ok: true, ...resultado });
      }

      // POST { action:'vencimiento_fecha', payload:{id,fechaVencimiento,responsable} }
      // → corrige la fecha de vencimiento de un lote ya creado.
      if (action === "vencimiento_fecha" || action === "editar_fecha_venc") {
        const resultado = await accionEditarFechaVencimiento(env, payload);
        await marcarCatalogoActualizado(env);
        return json({ ok: true, ...resultado });
      }

      // POST { action:'registrar_merma', payload:{sku,cantidad,costoManual,motivo,responsable,lote} }
      // → registra una merma (pérdida): guarda el registro en `mermas` con el costo
      //   de Loyverse (o el digitado a mano si el producto no lo tiene cargado) y
      //   descuenta el stock en Loyverse, igual que un ajuste negativo.
      if (action === "registrar_merma" || action === "merma") {
        const resultado = await accionMerma(env, payload);
        await marcarCatalogoActualizado(env);
        return json({ ok: true, ...resultado });
      }

      // POST { action:'consumo_interno', payload:{items:[{sku,cantidad,costoManual}],responsable} }
      // → registra varias mermas de una con motivo fijo "consumo_interno".
      if (action === "consumo_interno") {
        const resultado = await accionConsumoInterno(env, payload);
        await marcarCatalogoActualizado(env);
        return json({ ok: true, ...resultado });
      }

      // GET /?action=historial_mermas[&sku=XXXX][&dias=30][&limit=200]  →  historial
      // de mermas registradas, más reciente primero, con total de costo y cantidad.
      if (action === "historial_mermas") {
        const sku = url.searchParams.get("sku") || "";
        const dias = url.searchParams.get("dias") || "";
        const limit = url.searchParams.get("limit") || "";
        const resultado = await historialMermas(env, { sku, dias, limit });
        return json({ ok: true, ...resultado });
      }

      // POST { action:'merma_motivo', payload:{id,motivo,responsable} } → corrige el
      // motivo de una merma ya registrada (no vuelve a tocar el stock).
      if (action === "merma_motivo" || action === "corregir_motivo_merma") {
        const resultado = await accionMermaMotivo(env, payload);
        return json({ ok: true, ...resultado });
      }

      // GET /?action=llegadas → productos con stock que subió directo en Loyverse
      // (sin pasar por Recibir mercadería ni un ajuste de la app) y todavía no
      // tienen fecha de vencimiento asignada.
      if (action === "llegadas") {
        const lista = await repLlegadasPendientes(env);
        return json({ ok: true, llegadas: lista });
      }

      // POST { action:'asignar_llegada', payload:{filaIndex,fechaVencimiento} } →
      // crea el lote de vencimiento para esa llegada (el stock ya estaba sumado).
      if (action === "asignar_llegada") {
        const resultado = await accionAsignarLlegada(env, payload);
        await marcarCatalogoActualizado(env);
        return json({ ok: true, ...resultado });
      }

      // POST { action:'ignorar_llegada', payload:{filaIndex} } → descarta la
      // llegada sin asignarle fecha.
      if (action === "ignorar_llegada") {
        const resultado = await accionIgnorarLlegada(env, payload);
        await marcarCatalogoActualizado(env);
        return json({ ok: true, ...resultado });
      }

      // GET /?action=historial_prestamos[&limite=100] → préstamos de mercadería con
      // Marín 376 (pendientes y devueltos) + resumen de valor pendiente.
      if (action === "historial_prestamos") {
        const limite = url.searchParams.get("limite") || "";
        const resultado = await repHistorialPrestamos(env, Number(limite) || undefined);
        return json({ ok: true, ...resultado });
      }

      // POST { action:'registrar_prestamo', payload:{sku,direccion,cantidad,costoManual,responsable,nota} }
      if (action === "registrar_prestamo") {
        const resultado = await accionRegistrarPrestamo(env, payload);
        await marcarCatalogoActualizado(env);
        return json({ ok: true, ...resultado });
      }

      // POST { action:'devolver_prestamo', payload:{id} }
      if (action === "devolver_prestamo") {
        const resultado = await accionDevolverPrestamo(env, payload);
        await marcarCatalogoActualizado(env);
        return json({ ok: true, ...resultado });
      }

      // GET /?action=listar_calculos_factura → historial de la Calculadora de precios,
      // agrupado por factura_id.
      if (action === "listar_calculos_factura") {
        const resultado = await accionListarCalculosFactura(env);
        return json({ ok: true, ...resultado });
      }

      // POST { action:'guardar_calculo_precio', payload:{factura_id?,items,responsable} }
      if (action === "guardar_calculo_precio") {
        const resultado = await accionGuardarCalculoPrecio(env, payload);
        return json({ ok: true, ...resultado });
      }

      // POST { action:'eliminar_calculo_factura', payload:{factura_id} }
      if (action === "eliminar_calculo_factura") {
        const resultado = await accionEliminarCalculoFactura(env, payload);
        return json({ ok: true, ...resultado });
      }

      // GET /?action=abc  →  última clasificación ABC calculada (sku, clase, % de
      // participación, venta total). Vacío hasta el primer "abc_calcular".
      if (action === "abc") {
        const lista = await repABC(env);
        return json({ ok: true, abc: lista });
      }

      // GET /?action=abc_calcular[&periodo=30]  →  recalcula la clasificación ABC
      // sobre las ventas de los últimos N días (por defecto 30) y la deja guardada.
      if (action === "abc_calcular") {
        const periodo = url.searchParams.get("periodo") || 30;
        const resultado = await calcularABC(env, periodo);
        return json({ ok: true, ...resultado });
      }

      // POST { action:'aplicar_precio_abc', payload:{sku,margen,usar_psicologico,responsable} }
      // → calcula el precio sugerido (costo / (1 - margen), redondeado a .90/.50 si
      //   corresponde) y lo aplica en Loyverse + D1.
      if (action === "aplicar_precio_abc") {
        const resultado = await accionAplicarPrecioABC(env, payload);
        await marcarCatalogoActualizado(env);
        return json({ ok: true, ...resultado });
      }

      // GET /?action=sincosto  →  productos con seguimiento de inventario activo
      // pero sin costo cargado en Loyverse (usa 'editar_producto' para guardarlo).
      if (action === "sincosto") {
        const reporte = await repSinCosto(env);
        return json({ ok: true, reporte });
      }

      // GET /?action=config_categorias  →  categorías marcadas para gestionarse
      // por "cambio con proveedor" al vencer.
      if (action === "config_categorias") {
        const categoriasCambio = await repCategoriasCambio(env);
        return json({ ok: true, categoriasCambio });
      }

      // POST { action:'config_categoria_cambio', payload:{categoria,activo} } →
      // marca/desmarca una categoría como "cambio con proveedor".
      if (action === "config_categoria_cambio") {
        const resultado = await accionConfigCategoriaCambio(env, payload);
        return json({ ok: true, ...resultado });
      }

      // GET /?action=consumo_categoria[&dias=30]  →  costo total de mermas por
      // "consumo_interno", agrupado por categoría, en los últimos N días.
      if (action === "consumo_categoria") {
        const dias = url.searchParams.get("dias") || 30;
        const resumen = await repConsumoCategoria(env, dias);
        return json({ ok: true, resumen });
      }

      // GET /?action=riesgo_excluidos  →  SKUs excluidos a mano del módulo
      // "Riesgo de quiebre" (el resto del cálculo lo hace el frontend con
      // DB.items, igual que Armar pedido).
      if (action === "riesgo_excluidos") {
        const skus = await repRiesgoExcluidos(env);
        return json({ ok: true, skus });
      }

      // POST { action:'riesgo_excluir', payload:{sku,excluido} } → marca/
      // desmarca un producto como excluido de "Riesgo de quiebre".
      if (action === "riesgo_excluir" || action === "excluir_riesgo" || action === "incluir_riesgo") {
        // Marín usa dos acciones separadas (excluir_riesgo/incluir_riesgo) en vez de un
        // flag `excluido` en el payload — se traduce acá para reusar accionRiesgoExcluir.
        const p = action === "excluir_riesgo" ? { ...payload, excluido: true }
          : action === "incluir_riesgo" ? { ...payload, excluido: false }
          : payload;
        const resultado = await accionRiesgoExcluir(env, p);
        return json({ ok: true, ...resultado });
      }

      // GET /?action=favoritos  →  lista de SKUs marcados como favoritos
      // en Armar pedido.
      if (action === "favoritos") {
        const skus = await repFavoritos(env);
        return json({ ok: true, skus });
      }

      // POST { action:'favorito', payload:{sku,favorito} } → marca/desmarca
      // un producto como favorito en Armar pedido.
      if (action === "favorito") {
        const resultado = await accionFavorito(env, payload);
        return json({ ok: true, ...resultado });
      }

      // GET /?action=descuentos_activos  →  lista de lotes con descuento aplicado
      // y todavía en gestión (sin cerrar).
      if (action === "descuentos_activos") {
        const lista = await repDescuentosActivos(env);
        // `lotes` (además de `lista`) — mismo criterio que ?action=vencimientos; acá
        // los nombres de campo ya coinciden, solo cambia `id` por `filaIndex`.
        const lotes = lista.map(r => ({ ...r, filaIndex: r.id }));
        return json({ ok: true, lista, lotes });
      }

      // POST { action:'aplicar_descuento_vencimiento', payload:{id,precio,responsable} }
      // → rebaja el precio en Loyverse y marca el lote con descuento activo.
      if (action === "aplicar_descuento_vencimiento") {
        const resultado = await accionAplicarDescuentoVencimiento(env, payload);
        await marcarCatalogoActualizado(env);
        return json({ ok: true, ...resultado });
      }

      // POST { action:'registrar_gestion_descuento', payload:{id,cantidadVendida,cantidadMerma,responsable} }
      // → anota venta/merma parcial sobre un lote con descuento activo (cierra
      //   automático si se agota la cantidad total).
      if (action === "registrar_gestion_descuento") {
        const resultado = await accionRegistrarGestionDescuento(env, payload);
        await marcarCatalogoActualizado(env);
        return json({ ok: true, ...resultado });
      }

      // POST { action:'cerrar_gestion_descuento', payload:{id,responsable} } →
      // cierre manual de un lote con descuento activo, sin esperar a que se agote.
      if (action === "cerrar_gestion_descuento") {
        const resultado = await accionCerrarGestionDescuento(env, payload);
        return json({ ok: true, ...resultado });
      }

      // GET /?action=precios_pendientes_restaurar → lotes cerrados cuyo precio de
      // descuento nunca volvió a Loyverse (ver repPreciosPendientesRestaurar).
      if (action === "precios_pendientes_restaurar") {
        const lotes = await repPreciosPendientesRestaurar(env);
        return json({ ok: true, lotes });
      }

      // POST { action:'restaurar_precio_descuento', payload:{filaIndex,responsable} }
      if (action === "restaurar_precio_descuento") {
        const resultado = await accionRestaurarPrecioDescuento(env, payload);
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

      // GET /?action=ficha_producto&sku=XXXX  →  ficha completa de un producto
      // (incluye proveedoresExtra: proveedores adicionales, además del principal).
      if (action === "ficha_producto") {
        const sku = url.searchParams.get("sku") || "";
        const it = await fichaProducto(env, sku);
        const ficha = await repFichaProducto(env, sku);
        return json({ ok: true, item: it, ficha });
      }

      // POST { action:'agregar_proveedor_extra', payload:{sku,proveedor} } → asigna
      // un proveedor ADICIONAL a un producto (no reemplaza el principal).
      if (action === "agregar_proveedor_extra" || action === "agregar_proveedor_id_extra") {
        // Marín usa proveedor_id (FK) para esta variante; Argomedo resuelve por nombre
        // — se traduce acá para reusar accionAgregarProveedorExtra sin duplicar lógica.
        let p = payload;
        if (action === "agregar_proveedor_id_extra") {
          const prov = await get(env, "SELECT nombre FROM proveedores WHERE id = ?", Number(payload && payload.proveedor_id));
          if (!prov) return json({ ok: false, error: "Ese proveedor no existe" }, 400);
          p = { sku: payload && payload.sku, proveedor: prov.nombre };
        }
        const resultado = await accionAgregarProveedorExtra(env, p);
        return json({ ok: true, ...resultado });
      }

      // POST { action:'quitar_proveedor_extra', payload:{sku,proveedor} } → quita
      // un proveedor adicional de un producto.
      if (action === "quitar_proveedor_extra" || action === "quitar_proveedor_id_extra") {
        let p = payload;
        if (action === "quitar_proveedor_id_extra") {
          const prov = await get(env, "SELECT nombre FROM proveedores WHERE id = ?", Number(payload && payload.proveedor_id));
          p = { sku: payload && payload.sku, proveedor: prov ? prov.nombre : "" };
        }
        const resultado = await accionQuitarProveedorExtra(env, p);
        return json({ ok: true, ...resultado });
      }

      // POST { action:'editar_producto', payload:{sku,...} }  →  edita nombre, barcode,
      // precio, costo, proveedor, sector, peso — reenvía a Loyverse y actualiza D1.
      if (action === "editar_producto") {
        const resultado = await accionEditarProducto(env, payload);
        await marcarCatalogoActualizado(env);
        return json({ ok: true, ...resultado });
      }

      // POST { action:'editar_codigo_barras', payload:{sku,barcode} } → reusa
      // accionEditarProducto (valida duplicados y reenvía a Loyverse).
      if (action === "editar_codigo_barras") {
        const resultado = await accionEditarCodigoBarras(env, payload);
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

      // POST { action:'eliminar_productos', payload:{items:[{sku,...}]} } → variante en
      // lote de Marín (varios productos de una): reusa accionEliminarProducto por sku,
      // sin duplicar la lógica de borrado en Loyverse.
      if (action === "eliminar_productos") {
        const items = Array.isArray(payload && payload.items) ? payload.items : [];
        if (!items.length) return json({ ok: false, error: "No hay productos para eliminar" }, 400);
        let eliminados = 0;
        const errores = [];
        for (const it of items) {
          try { await accionEliminarProducto(env, { sku: it && it.sku }); eliminados++; }
          catch (e) { errores.push({ sku: it && it.sku, error: e.message }); }
        }
        await marcarCatalogoActualizado(env);
        return json({ ok: true, eliminados, errores });
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

      // GET /?action=proveedores  →  acción combinada que espera Marín (Argomedo la
      // tenía partida en proveedores_conteo + proveedores_sectores). Trae proveedores
      // con id + cantidad de productos (principal o extra), y sectores combinados
      // (catálogo + creados a mano).
      if (action === "proveedores") {
        const { results: proveedoresRows } = await env.DB.prepare(
          `SELECT pr.id, pr.nombre, COUNT(DISTINCT t.sku) AS productos
           FROM proveedores pr
           LEFT JOIN (
             SELECT proveedor AS nombre, sku FROM productos WHERE proveedor IS NOT NULL AND proveedor != ''
             UNION ALL
             SELECT pv.nombre AS nombre, pe.sku FROM producto_proveedor_extra pe JOIN proveedores pv ON pv.id = pe.proveedor_id
           ) t ON t.nombre = pr.nombre
           GROUP BY pr.id, pr.nombre ORDER BY pr.nombre`
        ).all();
        const { sectores } = await catalogoProveedoresSectores(env);
        const { results: sectoresPersRows } = await env.DB.prepare("SELECT nombre FROM sectores_personalizados").all();
        const sectoresCombinados = [...new Set([...sectores, ...sectoresPersRows.map(r => r.nombre)])].sort((a, b) => a.localeCompare(b, "es"));
        return json({ ok: true, proveedores: proveedoresRows, sectores: sectoresCombinados });
      }

      // POST { action:'guardar_multiplo_producto', payload:{sku,multiplo,empaque,palabra} }
      // → mínimo de pedido / empaque manual de un producto (Proveedores → Configuración).
      // multiplo=0 y empaque=0 borra el override (vuelve al cálculo automático del frontend).
      if (action === "guardar_multiplo_producto") {
        const resultado = await accionGuardarMultiploProducto(env, payload);
        return json({ ok: true, ...resultado });
      }

      // POST { action:'marcar_pedido_realizado', payload:{items:[{sku,barcode,
      // producto,proveedor,cantidad}]} } → guarda cada línea del pedido recién
      // confirmado como "en camino" (estado='confirmado'), para avisar "Ya
      // pedido a X" en Armar pedido hasta que llegue por Recepción.
      if (action === "marcar_pedido_realizado") {
        const resultado = await accionMarcarPedidoRealizado(env, payload);
        return json({ ok: true, ...resultado });
      }

      // POST { action:'eliminar_proveedor', payload:{nombre} }  →  borra un proveedor
      // del catálogo, solo si no tiene productos asignados.
      if (action === "eliminar_proveedor") {
        const resultado = await accionEliminarProveedor(env, payload);
        return json({ ok: true, ...resultado });
      }

      // GET /?action=vapid_public_key  →  clave pública VAPID para que el frontend
      // pueda suscribirse a notificaciones push.
      if (action === "vapid_public_key") {
        return json({ ok: true, key: env.VAPID_PUBLIC_KEY || null });
      }

      // POST { action:'guardar_suscripcion_push', payload:{subscription} }  →
      // guarda/actualiza la suscripción push de este celular.
      if (action === "guardar_suscripcion_push") {
        const resultado = await accionGuardarSuscripcionPush(env, payload);
        return json(resultado);
      }

      // POST { action:'quitar_suscripcion_push', payload:{endpoint} }  →  borra la
      // suscripción push de este celular (ej. el usuario desactivó notificaciones).
      if (action === "quitar_suscripcion_push") {
        const resultado = await accionQuitarSuscripcionPush(env, payload);
        return json(resultado);
      }

      // GET /?action=probar_push  →  envía una notificación de prueba a todos los
      // celulares suscritos, para confirmar que la configuración VAPID funciona.
      if (action === "probar_push") {
        const resultado = await webPushEnviarATodos(env, "🔔 Notificación de prueba", "Si ves esto, las notificaciones de Los Cumpas están funcionando.", "./");
        return json({ ok: true, ...resultado });
      }

      // GET sin `action` → payload completo del dashboard (bootstrap de Marín Pedidos,
      // ver plan "FASE 1"). Antes de esto no había equivalente: un GET sin action solo
      // devolvía el mensaje de bienvenida de más abajo.
      if (request.method === "GET" && !action) {
        const resultado = await payloadDashboard(env, false, "");
        return json(resultado);
      }

      // Sin acción reconocida (POST sin action, u otra no listada): mensaje de bienvenida.
      return json({
        ok: true,
        mensaje: "Worker Argomedo455 activo. GET: ?action=setup, test_loyverse, store_id, reset_store_id, sync, catalogo, ultima_actualizacion, historial_producto, proveedores_sectores, vencimientos, sync_ventas, buscar_barcode, ficha_producto, proveedores_conteo, productos_proveedor, vapid_public_key, probar_push, descuentos_activos, historial_mermas, llegadas, abc, abc_calcular, sincosto, config_categorias, consumo_categoria, riesgo_excluidos, favoritos. POST: lote_nuevo, crear_producto, habilitar_track_stock, activar_iva, ajustar_stock, crear_proveedor, crear_sector, vencimiento_estado, vencimiento_eliminar, vencimiento_fecha, editar_producto, eliminar_producto, eliminar_proveedor, guardar_suscripcion_push, quitar_suscripcion_push, aplicar_descuento_vencimiento, registrar_gestion_descuento, cerrar_gestion_descuento, agregar_proveedor_extra, quitar_proveedor_extra, registrar_merma, merma_motivo, asignar_llegada, ignorar_llegada, aplicar_precio_abc, config_categoria_cambio, riesgo_excluir, guardar_multiplo_producto, favorito, marcar_pedido_realizado. Webhook Loyverse: POST /webhook/loyverse",
      });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  },

  // ============================================================
  //  CRON TRIGGER — se ejecuta automáticamente según el horario
  //  configurado en Cloudflare (Settings → Triggers → Cron Triggers).
  //  Configurar dos triggers: "0 11 * * *" y "0 18 * * *" en UTC,
  //  que equivalen a las 8:00 y 15:00 hora Chile (UTC-3 en horario
  //  de verano / UTC-4 en invierno — ajustar si Cloudflare no
  //  resuelve el huso horario automáticamente).
  // ============================================================
  async scheduled(event, env, ctx) {
    try {
      await asegurarTablas(env);
      // Recalcula la clasificación ABC antes de los demás chequeos: tanto el badge
      // ABC de Armar pedido/Precio sugerido como Riesgo de quiebre dependen de que
      // `clasificacion_abc` tenga datos — antes solo se llenaba si alguien tocaba
      // "Recalcular" a mano en el módulo, así que quedaba vacía indefinidamente.
      try { await calcularABC(env, 30); } catch (e) { await logMsg(env, "⚠️ No se pudo recalcular ABC: " + e.message); }
      await chequearYNotificarVencimientos(env);
      await chequearYRevertirDescuentosVencidos(env);
      await chequearYNotificarRiesgoQuiebre(env);
    } catch (e) {
      await logMsg(env, "❌ Error en scheduled(): " + e.message);
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

