# Graph Report - tmp.NfDZB1qUrp  (2026-10-31)

## Corpus Check
- 6 files · ~123,828 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1021 nodes · 2834 edges · 65 communities (56 shown, 9 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 27 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- index.html.js
- fiados.html.js
- worker.js
- run
- abrirModal
- mmRenderCart
- cloudSync
- rcValidar
- fpPaneProveedores
- showToast
- render
- logMsg
- accionLoteNuevo
- fechaISO
- renderOrder
- fpPaneGeneral
- obtenerStoreId
- renderTable
- gpRenderProductos
- loyverseGet
- analyze
- fmt1
- calProvRenderLista
- vdRender
- uso.js
- etiquetas.js
- cerrarModal
- etRenderPreview
- crearComboBuscable
- fpGuardarTodo
- persist
- peso
- _gpGuardarMultiplo
- catComboIds
- prValidar
- inRenderCart
- llLoad
- mcCargarCategorias
- mmcRenderChart
- scRenderList
- cgRestaurar
- tag
- parseSales
- _gpCfgProgramarGuardado
- sbAbrir
- hmEliminar
- ajustar
- vcNuevoLoteDe
- wireAjustesFotoProducto
- aplicarAjusteColorProducto
- _cartMaxNeededWidth
- chequearVersion
- inDescartar
- fpMovimientosCombinados
- _idbAbrir
- rkOpenMenu
- currentW
- detenerHold
- mmFindItems
- llHtmlSinClasificar
- mpCartGearHTML
- _provMenuMount
- rzEstadoPush
- viEsc

## God Nodes (most connected - your core abstractions)
1. `showToast()` - 83 edges
2. `run()` - 70 edges
3. `get()` - 66 edges
4. `peso()` - 40 edges
5. `render()` - 35 edges
6. `fechaHoraDDMMAAAA()` - 33 edges
7. `persist()` - 31 edges
8. `normTxt()` - 31 edges
9. `abrirModal()` - 31 edges
10. `sonidoGuardado()` - 29 edges

## Surprising Connections (you probably didn't know these)
- `fetch()` --calls--> `appDe()`  [EXTRACTED]
  worker.js → uso.js
- `fetch()` --calls--> `iniciarMedicion()`  [EXTRACTED]
  worker.js → uso.js

## Import Cycles
- None detected.

## Communities (65 total, 9 thin omitted)

### Community 0 - "index.html.js"
Cohesion: 0.02
Nodes (82): ABC_BY_SKU, ACCION_LABELS, AJUSTAR_FOTO_DEFAULT, Barcode39, BARCODE_LOOKUP_PROVIDERS, BASICOS_REPOSICION, CAL_PROV, CART_COSTO_UNIT (+74 more)

### Community 1 - "fiados.html.js"
Cohesion: 0.08
Nodes (60): FD_TIPOS_DESHACIBLES, fdAbrirDetalle(), fdAbrirHistorial(), fdAbrirReconciliar(), fdActualizarBannerFusion(), fdActualizarNuevoSaldo(), fdAplicarEstado(), fdAsignarCliente() (+52 more)

### Community 2 - "worker.js"
Cohesion: 0.05
Nodes (31): RFC-8291, RFC-8292, accionAplicarPrecioABC(), accionEditarPrecio(), accionFiadosConfigurar(), accionRedondearPreciosComercial(), accionSugerirPrecioABC(), base64UrlToUint8Array() (+23 more)

### Community 3 - "run"
Cohesion: 0.09
Nodes (50): accionAgregarProveedorExtra(), accionAplicarDescuentoVencimiento(), accionCerrarGestionDescuento(), accionConfigCategoriaCambio(), accionConsumoInterno(), accionCrearProveedor(), accionCrearSector(), accionDanadoAPendientes() (+42 more)

### Community 4 - "abrirModal"
Cohesion: 0.07
Nodes (48): abrirConfirmarPedido(), abrirModal(), abrirModalRenombrar(), abrirVencimientosDias(), actualizarBadgeBn(), _actualizarVisibilidadFab(), calcularProveedoresHoy(), calcularProveedoresHoyReal() (+40 more)

### Community 5 - "mmRenderCart"
Cohesion: 0.07
Nodes (46): daActualizarBadge(), daCargar(), daCargarBadgeSolo(), daCargarPendientes(), daCerrar(), daRegistrar(), daRender(), daRenderPendientes() (+38 more)

### Community 6 - "cloudSync"
Cohesion: 0.08
Nodes (44): actualizarIndicadorEnVivo(), aplicarListasCompartidas(), aplicarPanelDeFondo(), aplicarRepintadoDiferido(), autoSyncIfStale(), buildDBfromCloud(), _cacheDelDiaVigente(), cargarABC() (+36 more)

### Community 7 - "rcValidar"
Cohesion: 0.10
Nodes (34): closeRecibir(), openRecibir(), _pesoDecimales(), rcActualizarBotonInventario(), rcActualizarCostoUnitarioHint(), rcAplicarBorrador(), rcAplicarVisibilidad(), rcCalcularCambiosCostoPrecio() (+26 more)

### Community 8 - "fpPaneProveedores"
Cohesion: 0.16
Nodes (29): cpAbrir(), cpAutocompletarPorCodigo(), cpCantidadFinalUnidades(), cpCargarCatalogo(), cpLlenarSelect(), cpMontarPrecio(), cpQtyMas(), cpQtyMenos() (+21 more)

### Community 9 - "showToast"
Cohesion: 0.16
Nodes (25): Calc, cpDescartar(), _dlgAbrir(), dlgConfirm(), _dlgModal(), dlgPrompt(), fpCopiarAOtroLocal(), fpEditarFechaLote() (+17 more)

### Community 10 - "render"
Cohesion: 0.15
Nodes (23): aplicarSugeridos(), buildChips(), openMenu(), opt(), renderProvMenu(), cancelarPedidoConfirmado(), closeScanner(), commitProv() (+15 more)

### Community 11 - "logMsg"
Cohesion: 0.16
Nodes (22): accionAjustarStock(), accionFiadosCobrar(), accionFiadosDeshacerCobro(), accionFiadosEliminarLinea(), accionFiadosFusionarClientes(), accionHabilitarTrackStock(), chequearYNotificarRiesgoQuiebre(), chequearYNotificarVencimientos() (+14 more)

### Community 12 - "accionLoteNuevo"
Cohesion: 0.12
Nodes (22): accionAsignarLlegada(), accionEditarFechaVencimiento(), accionLoteNuevo(), accionMarcarCambiado(), actualizarPrecioCostoLoyverse(), autoResolverSiSinStock(), calcularLote(), chequearYRevertirDescuentosVencidos() (+14 more)

### Community 13 - "fechaISO"
Cohesion: 0.13
Nodes (21): asegurarTablas(), batchRun(), calcularABC(), calcularRiesgoQuiebre(), catalogoCompacto(), fechaISO(), filaItemPanel(), mapaNombresProveedores() (+13 more)

### Community 14 - "renderOrder"
Cohesion: 0.18
Nodes (20): cartApplyQty(), cartSubHtml(), cartUpdateTotals(), colorForProv(), confirmarPedidoConCanal(), covColor(), currentCambios(), currentOrderVisible() (+12 more)

### Community 15 - "fpPaneGeneral"
Cohesion: 0.14
Nodes (19): fpAbrir(), fpBadgeStock(), fpBuscarImagen(), fpCampo(), fpCancelarImagenPreview(), fpConfirmarImagen(), fpGuardarBorrador(), fpGuardarRecuento() (+11 more)

### Community 16 - "obtenerStoreId"
Cohesion: 0.17
Nodes (20): accionCopiarProductoExterno(), accionCrearCategoria(), accionCrearProducto(), accionDisponibilidadMasiva(), accionSyncVentas(), aplicarCambiosInventario(), aplicarCambiosItems(), aplicarVentas() (+12 more)

### Community 17 - "renderTable"
Cohesion: 0.11
Nodes (19): _actualizarAlturaTop(), _actualizarLayout(), _aplicarLayoutCarrito(), _aplicarModo(), _aplicarVistaFilas(), favStarHTML(), _guardarModo(), pcRedondeoComercialSuperior() (+11 more)

### Community 18 - "gpRenderProductos"
Cohesion: 0.12
Nodes (18): gpAbrir(), gpAbrirProductos(), gpAbrirProductosPorSector(), gpAbrirReasignar(), _gpCambiarModo(), gpCargar(), gpConfirmarEliminacion(), gpEliminar() (+10 more)

### Community 19 - "loyverseGet"
Cohesion: 0.14
Nodes (15): accionActivarIva(), accionBuscarImagenProducto(), accionClasificarProducto(), copiarImagenSiCorresponde(), accionEliminarProducto(), accionQuitarFondoProducto(), accionSubirImagenProducto(), catalogoProveedoresSectores() (+7 more)

### Community 20 - "analyze"
Cohesion: 0.21
Nodes (16): analyze(), ccuMixedPacks(), ccuTierIdx(), currentOrder(), formulaBasico(), itemsForCategoria(), packsOf(), qOf() (+8 more)

### Community 21 - "fmt1"
Cohesion: 0.16
Nodes (16): fmt1(), fpBadgeLote(), fpHtmlLotesCerrados(), fpPaneLotes(), fpPaneMovimientos(), plFiltrados(), plGuardarFila(), plRender() (+8 more)

### Community 22 - "calProvRenderLista"
Cohesion: 0.30
Nodes (15): calProvAbrir(), calProvAgregarDia(), calProvAgregarProveedor(), calProvEfectivo(), calProvEliminarProv(), _calProvGetR(), calProvGuardarOverride(), _calProvGuardarR() (+7 more)

### Community 23 - "vdRender"
Cohesion: 0.17
Nodes (15): fmt, vdAbrir(), vdActualizarNavSemana(), vdCargar(), vdFechasDisponibles(), vdFiltrados(), vdMaxOffsetSemana(), vdPoblarSelects() (+7 more)

### Community 24 - "uso.js"
Cohesion: 0.21
Nodes (14): APP_ETIQUETAS, appDe(), asegurarTabla(), chicas, dia(), formatoDia, iniciarMedicion(), medirUso() (+6 more)

### Community 25 - "etiquetas.js"
Cohesion: 0.32
Nodes (11): ACENTOS, atenderEtiquetas(), buscarEtiquetas(), catalogoEtiquetas(), categoriasEtiquetas(), ddmmaaaaOrdenable(), fichaEtiqueta(), filaEtiqueta() (+3 more)

### Community 26 - "cerrarModal"
Cohesion: 0.18
Nodes (12): aplicarPrecioABC(), cerrarModal(), closeMerma(), closeVenc(), ejecutarRenombrar(), etCerrar(), mmDescartar(), stkCorregirGuardar() (+4 more)

### Community 27 - "etRenderPreview"
Cohesion: 0.24
Nodes (12): etAbrir(), etBarcodeSvg(), etCargarTamano(), etCodigoDe(), etImportarFechaVencimiento(), etImprimir(), etPick(), etRefrescarCodigoDesdeServidor() (+4 more)

### Community 28 - "crearComboBuscable"
Cohesion: 0.29
Nodes (10): crearComboBuscable(), close(), destroy(), items(), mount(), open(), position(), render() (+2 more)

### Community 29 - "fpGuardarTodo"
Cohesion: 0.22
Nodes (11): edAbrir(), fpEliminarProducto(), fpGuardarTodo(), fpLimpiarBorrador(), llSiguienteClasificar(), psGuardarAprendizaje(), smActualizarBoton(), smCalcular() (+3 more)

### Community 30 - "persist"
Cohesion: 0.27
Nodes (11): _getAudioCtx(), persist(), rkAbrir(), rkActivarInventario(), rkActualizarAvance(), rkEliminarProducto(), rkFiltrados(), rkGuardarFila() (+3 more)

### Community 31 - "peso"
Cohesion: 0.24
Nodes (10): _abcListaFiltrada(), _abcRecalcularPreview(), abrirModalPrecioABC(), edRenderResultados(), lvFilaBusqueda(), peso(), _redondeoPsicologicoLocal(), renderABCResumen() (+2 more)

### Community 32 - "_gpGuardarMultiplo"
Cohesion: 0.24
Nodes (10): avisoYaPedidoEnOtroProveedor(), cargarPedidoConfirmadoEnCarrito(), esDelProveedor(), fpPaneMinimo(), _gpFilaConfig(), _gpGuardarMultiplo(), itemsFor(), itemsPedidoConfirmadoActual() (+2 more)

### Community 33 - "catComboIds"
Cohesion: 0.44
Nodes (10): catComboChoose(), catComboClose(), catComboIds(), catComboItems(), catComboMount(), catComboOpen(), catComboPosition(), catComboRender() (+2 more)

### Community 34 - "prValidar"
Cohesion: 0.25
Nodes (9): fmtDateInputToDDMMAAAA(), prAbrir(), prActual(), prPick(), prPintarLista(), prQtyMas(), prQtyMenos(), prSetDireccion() (+1 more)

### Community 35 - "inRenderCart"
Cohesion: 0.28
Nodes (9): inAdd(), inCostoUnit(), inGuardarBorrador(), inRemove(), inRenderCart(), inReset(), inUpdateTotal(), inValidar() (+1 more)

### Community 36 - "llLoad"
Cohesion: 0.31
Nodes (8): llCablearSinClasificar(), llCargarSinClasificar(), llCheckBadge(), llGuardarFecha(), llIgnorar(), llLoad(), llUpdateBadge(), wireFechaSegmentada()

### Community 37 - "mcCargarCategorias"
Cohesion: 0.31
Nodes (9): mcActualizarContadorSeleccion(), mcCargarCategorias(), mcEliminarProducto(), mcPintarDesglose(), mcRefrescarChipActivo(), mcRefrescarDesgloseGeneral(), mcRenderChips(), mcRenderLista() (+1 more)

### Community 38 - "mmcRenderChart"
Cohesion: 0.28
Nodes (9): mmcAbrir(), mmcCargar(), mmcFiltrados(), mmcPoblarSelects(), mmcPorCategoria(), mmcPorDia(), mmcRender(), mmcRenderChart() (+1 more)

### Community 39 - "scRenderList"
Cohesion: 0.36
Nodes (9): scDraftClear(), scDraftGet(), scDraftSaveVal(), scDraftSet(), scDraftSkip(), scGuardar(), scLoad(), scPoblarFiltroCat() (+1 more)

### Community 40 - "cgRestaurar"
Cohesion: 0.36
Nodes (8): cgCargarTodos(), cgFechaTxt(), cgGuardarCarritoActual(), cgGuardarTodos(), cgProvId(), cgProvLabel(), cgRenderLista(), cgRestaurar()

### Community 41 - "tag"
Cohesion: 0.29
Nodes (6): aggregate(), cpAgregarLocal(), retagAll(), sopMin(), tag(), tagConOverride()

### Community 42 - "parseSales"
Cohesion: 0.47
Nodes (6): findCol(), num(), parseCSV(), parseDate(), parseInventory(), parseSales()

### Community 43 - "_gpCfgProgramarGuardado"
Cohesion: 0.47
Nodes (6): _gpCfgAjustar(), _gpCfgCambiarUnidad(), _gpCfgFmtActual(), _gpCfgOnChange(), _gpCfgOnClick(), _gpCfgProgramarGuardado()

### Community 44 - "sbAbrir"
Cohesion: 0.40
Nodes (6): sbAbrir(), sbCopiar(), _sbFmt(), _sbMB(), sbRevisar(), sbUso()

### Community 45 - "hmEliminar"
Cohesion: 0.60
Nodes (5): hmAplicarFiltro(), hmCorregir(), hmEliminar(), hmLoad(), hmPintar()

### Community 46 - "ajustar"
Cohesion: 0.50
Nodes (4): ajustar(), programarAjuste(), rcOvAbierto(), restaurar()

### Community 47 - "vcNuevoLoteDe"
Cohesion: 0.50
Nodes (4): vcNuevoLoteDe(), vcPick(), vcShowForm(), vcValidar()

### Community 48 - "wireAjustesFotoProducto"
Cohesion: 0.67
Nodes (3): wireAjustesFotoProducto(), actualizarEtiquetas(), restablecer()

### Community 49 - "aplicarAjusteColorProducto"
Cohesion: 0.67
Nodes (3): aplicarAjusteColorProducto(), aplicarNitidezSuave(), _cpAjustesFotoUI

### Community 50 - "_cartMaxNeededWidth"
Cohesion: 0.67
Nodes (3): _cartMaxNeededWidth(), _cartWLimits(), _restoreCartW()

### Community 51 - "chequearVersion"
Cohesion: 0.67
Nodes (3): chequearVersion(), hayAlgoAbierto(), limpiarCacheYActualizarSW()

### Community 52 - "inDescartar"
Cohesion: 0.67
Nodes (3): closeInsumos(), inDescartar(), inLimpiarBorrador()

### Community 53 - "fpMovimientosCombinados"
Cohesion: 0.67
Nodes (3): _fpIsoADDMMAAAA(), fpMovimientosCombinados(), _fpParseFechaHora()

### Community 54 - "_idbAbrir"
Cohesion: 0.67
Nodes (3): _idbAbrir(), _idbGet(), _idbSet()

### Community 55 - "rkOpenMenu"
Cohesion: 0.67
Nodes (3): rkOpenMenu(), rkOpt(), rkPick()

## Knowledge Gaps
- **2 isolated node(s):** `RFC-8291`, `RFC-8292`
  These have ≤1 connection - possible missing edges. (Counts symbols only; 164 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **9 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `crearComboBuscable()` connect `crearComboBuscable` to `index.html.js`, `showToast`, `fpPaneProveedores`?**
  _High betweenness centrality (0.019) - this node is a cross-community bridge._
- **What connects `RFC-8291`, `RFC-8292` to the rest of the system?**
  _2 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `index.html.js` be split into smaller, more focused modules?**
  _Cohesion score 0.018691588785046728 - nodes in this community are weakly interconnected._
- **Why does `showToast()` connect `showToast` to `index.html.js`, `abrirModal`, `mmRenderCart`, `cloudSync`, `rcValidar`, `fpPaneProveedores`, `render`, `renderOrder`, `fpPaneGeneral`, `renderTable`, `gpRenderProductos`, `fmt1`, `calProvRenderLista`, `cerrarModal`, `crearComboBuscable`, `fpGuardarTodo`, `persist`, `peso`, `_gpGuardarMultiplo`, `inRenderCart`, `llLoad`, `mcCargarCategorias`, `scRenderList`, `cgRestaurar`, `hmEliminar`, `chequearVersion`?**
  _High betweenness centrality (0.003) - this node is a cross-community bridge._
- **Should `fiados.html.js` be split into smaller, more focused modules?**
  _Cohesion score 0.08499743983614952 - nodes in this community are weakly interconnected._
- **Should `worker.js` be split into smaller, more focused modules?**
  _Cohesion score 0.04644412191582003 - nodes in this community are weakly interconnected._
- **Should `run` be split into smaller, more focused modules?**
  _Cohesion score 0.09224489795918367 - nodes in this community are weakly interconnected._