# Consulta NFC con passkey e historial del camarero

## Cliente

Las fichas existentes conservan su enlace `operator…/?ficha=…`: no hay que
reescribirlas. Un visitante sin sesión de personal se redirige a
`/w/card/:token` del API. Quien tiene sesión de personal conserva el recorrido
de cobro actual.

La pantalla inicial no recibe saldo, movimientos ni el enlace privado de la
wallet. «Ver mi saldo» pide la passkey vinculada al saldo, con verificación de
usuario obligatoria. El sistema operativo elige Face ID, huella o código del
teléfono; la web no solicita ni almacena ese código. La ficha identifica el
saldo; por sí sola no autoriza consultar ni registrar una passkey.

La primera activación se hace desde el enlace privado de la recarga (flujo
existente), no desde el enlace público de una ficha. Quien solo tiene la ficha
sin haber activado su llave debe recuperar ese enlace con ayuda de recepción.
El dueño ya dispone de «Crear enlace nuevo» en Clientes → Saldos; puede mostrar
su QR al cliente para que lo abra y active la llave. Esa acción invalida el
enlace y las passkeys anteriores, por lo que se reserva para entrega o recuperación
comprobadas, no para cada consulta.
Un dispositivo incompatible no recibe una alternativa que pida el código del
teléfono en un formulario.

Los retos se atan a ficha y wallet y se consumen con una firma válida una sola
vez. Se comprueba la asignación de la ficha otra vez después de verificar. Una
ficha en stock, devuelta, perdida, bloqueada, sin saldo vinculado o con wallet
bloqueada no abre la consulta. Se puede consultar un saldo cero si la ficha
sigue entregada; no se reactiva una ficha devuelta.

Tras verificar la llave se emite una cookie de consulta firmada de cinco
minutos, HttpOnly, SameSite=Strict, Secure en producción y limitada a la ruta
de ese saldo y vinculada al enlace vigente. Regenerar el enlace invalida también
la sesión anterior. No autoriza pagos ni cambios. La página y `/state` exigen esta
sesión si el saldo tiene passkey, de modo que copiar el enlace privado no evita
el desbloqueo. Cuando el sondeo recibe 401, retira los datos y vuelve a la
pantalla de desbloqueo. Las operaciones de dinero conservan sus confirmaciones
previas. HTML y respuestas de consulta usan `no-store`; el acceso nuevo usa
`no-referrer` y no indexación.

## Camarero

El rol tiene la pestaña Cobros. `/v1/staff/me/cobros` fija usuario y local a
partir de la sesión y solo acepta paginación. Incluye tarjeta, datáfono y pagos
del saldo, con estado, referencia, fecha, forma de pago y chica invitada. No
expone los datos bancarios internos de la vista de administración ni permite
consultar cobros de otro usuario con filtros. No concede permisos para devolver.

La carta de referencia añade «Invitar a una copa» por 20 €. La entrada se
muestra destacada, sin depender de tocar una copa primero. Abre la pantalla de
la referencia; luego se escanea el QR de la chica, se crea el cobro con ella
como beneficiaria y se muestra el resultado. La copa sola sigue disponible.

Los productos y el reparto son ajustes por local. Tras desplegar:

1. Carta → Carta de referencia → Aplicar productos y precios. Si los doce
   productos anteriores ya coinciden, solo añade la invitación pendiente.
2. Ajustes → Secciones → Invitaciones permite preparar el reparto de referencia
   50 % chica / 50 % camarero y guardarlo expresamente: a 20 €, 10 € para cada
   uno y 0 € para el local. Otros repartos guardados se conservan al desplegar.

## Verificación y despliegue

- Cobertura API: 86,02 % de líneas, 89,74 % de ramas y 83,37 % de funciones; umbrales aprobados.
- Builds de producción de API, administración y operador aprobados.
- 3.019 pruebas de API aprobadas; 4 omitidas por la suite existente.
- 15 pruebas de integración del mapa/reparto/historial en PostgreSQL 16 con
  propietario sin superusuario y RLS forzado, en base de pruebas dedicada.
- 324 pruebas de operador y 369 de administración aprobadas.
- Chromium: activación y autenticación WebAuthn con autenticador virtual real,
  API, Redis y PostgreSQL locales. NFC por apertura de su enlace → pantalla
  bloqueada → verificación → saldo y movimientos. Otro navegador y la
  cancelación no exponen datos.
- Componentes reales de camarero con respuestas API simuladas: entrada de
  invitación, pantalla 20 €/10 €/10 €, QR de Lola, creación del cobro e historial
  con tarjeta/saldo/invitaciones y paginación. Sin errores JavaScript ni
  desbordamiento móvil. No es una prueba de lectura física NFC ni de Face ID
  en un iPhone.

No hay migraciones nuevas ni cambios de dependencias. Desplegar primero API y
luego administración y operador desde el mismo commit, una vez aprobado el CI.
No se han modificado datos de producción. Hace falta una prueba final con ficha
real y el teléfono del cliente después de desplegar.
