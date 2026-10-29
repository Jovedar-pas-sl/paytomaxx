# Carta de las losetas A y mapa ampliado

El usuario aporta las dos capturas A y confirma expresamente: copiar diseño,
productos y precios de la carta; ampliar el mapa con detalles desplegables.

## Carta

Conservar OxioCard, dos columnas, colores por sección, cantidades ×N, cuenta y
acción de cobro fija. Carta confirmada: Copa 10 €, Copa premium 14 €, Botella
120 €, Chupito 5 €; Tabla ibérica 30 €, Ración del día 12 €; Entrada 15 €,
Entrada VIP 30 €; Servicios 30 min 80 €, 45 min 100 €, 1 h 120 €, 2 h 220 €.
Propinas de Barra 5 € y de Sala 5/10 €. Habitación sigue siendo de recepción.

Los productos son datos del local, no importes incrustados en el cobro. Añadir
en Ajustes → Carta una lista con los precios y una acción para aplicar esa carta
al local autenticado. La operación es transaccional y repetible, conserva IDs
coincidentes y el historial; no borra productos. Mostrar explícitamente si se
desactivan otros productos y permitir conservarlos. No se ejecuta al desplegar ni
cambia otros locales. Los permisos existentes de mantener la carta siguen activos.
Las propinas por puesto son opcionales; sin configuración nueva se conserva la
configuración global actual. Mostrar duración de servicios sin duplicar 1 h/60 min.

## Mapa del dinero

Conservar barras A, identidad, colores y lectura de arriba abajo. Aprovechar
MoneyMap existente sin nueva contabilidad ni tablas: ventas y número de cobros;
detalle de tarjeta/móvil/POS y saldo; recargas por origen/cantidad; reparto entre
local, chicas, camareros y costes conocidos; caja con fondo/entradas/salidas;
movimiento de tarjeta; saldo real de clientes y deudas actuales cuando existan;
pagos realizados, pendientes y devoluciones, separados y con cantidades.

Detalle accesible desplegable por bloque, porcentaje y cantidad por sección,
selector de periodo con consulta existente y actualización explícita. Conservar
el Z congelado, informar su fecha y no consultar datos actuales para fingir un
desglose histórico. Usar generatedAt como frescura del dato, no el reloj actual.

No llamar «BBVA, mañana» a movimientos sin conciliación ni fecha de abono; no
llamar «saldo vivo» al cambio de saldo del periodo; importes negativos deben
seguir visibles y explicados aunque no entren en barras proporcionales. Lo del
local es una parte del reparto, no beneficio neto disponible. Ventas brutas y
devoluciones se muestran por separado.

La regla nueva de OxioPay continúa pendiente; no cambiar cálculos. Comisión BBVA
desconocida conserva null y su indicador, nunca se presenta como cero conocido.
IVA y conciliación bancaria quedan fuera de este cambio.

## Validación y entrega

Pruebas útiles del lote idempotente/aislamiento/permisos y precios confirmados;
propinas por puesto y etiquetas de duración; mapa con negativos, costes
desconocidos, estado congelado y totales. Tipos/lint y suites afectadas. Validar
pantallas en móvil y escritorio con datos simulados, sin pagos reales. Nueva rama
feat/carta-mapa-ampliado; main 0a2f519 permanece como entrega anterior hasta revisión.
