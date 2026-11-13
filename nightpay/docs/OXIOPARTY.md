# OxioParty

La edición de OxioPay para fiestas (peñas, Fallas, bares): pago con pulsera
NFC y saldo prepago, con casetas. **Es el mismo código**: se instala aparte
(otro despliegue, otra base) y se activa con una variable de entorno. Con la
edición por defecto (`club`) OxioPay funciona exactamente como siempre.

## Variables de entorno

| Variable | Dónde | Valores | Para qué |
|---|---|---|---|
| `EDITION` | API (al arrancar) | `club` (por defecto) · `party` | La edición del API. Otro valor: el API no arranca. |
| `NEXT_PUBLIC_EDITION` | admin, operator, tpv (build arg, se hornea al construir) | `club` (por defecto) · `party` | La edición de las webs. Tiene que ser la misma que `EDITION`. |

En Dokploy: `EDITION=party` en el entorno del API y el build arg
`NEXT_PUBLIC_EDITION=party` en las webs (y reconstruir). El API también la
devuelve en el login (`user.edition`) y en `GET /v1/venues/me` (`edition`).

## Modelo de datos (migración `20261115100000_oxioparty_base`)

- **`venues`** (la fiesta): `eventStartsAt`, `eventEndsAt` (timestamptz,
  nulos), `refundDeadline` (date, nulo: último día para pedir la devolución
  del saldo), `allowDonation` (bool, `true`: donar lo que sobra) y
  `cashAlertCents` (int, `200000` = 2.000 €: umbral del aviso de efectivo).
  CHECK: fin después del inicio; umbral de 0 a 1.000.000 €.
- **`stalls`** (las casetas, FORCE RLS por local): `name`, `managerName`,
  `managerContact` (nulo), `organizerBps` (0–10000, CHECK: lo que se queda el
  organizador; `10000` = «barra propia»), `iban` (nulo; sin espacios y en
  mayúsculas, mod-97 en el API), `active`, `sortOrder`, `createdAt`, `updatedAt`.
- **`users.stallId`**: la caseta de cada persona del personal.
- **`payments.stallId`**, **`wallet_charge_requests.stallId`** y
  **`wallet_consumptions.stallId`**: la caseta del cobro, del cobro del saldo y
  del consumo, fijada al crearlos.

Todas las claves ajenas a `stalls` llevan el local (`stallId`, `tenantId`):
una caseta nunca es de otro local. `ON DELETE RESTRICT`: una caseta con cobros
no se borra, se desactiva. Todo es nulable o tiene valor por defecto: OxioPay
no cambia.

## Qué cambia con `EDITION=party`

- **Casetas** (dueño y encargado; con `club`, 404):
  - `GET/POST /v1/admin/party/stalls`, `PATCH/DELETE /v1/admin/party/stalls/:id`.
    Crear o cambiar la parte del organizador o el IBAN pide la 2FA si la
    persona la tiene activada. Borrar una con cobros: 409 `STALL_IN_USE`.
    Con la fiesta terminada (`eventEndsAt` pasado), cambiar el `organizerBps`
    de una caseta da 409 `STALL_BPS_LOCKED` (antes de pedir la 2FA): así el
    cierre ya no cambia. El resto de campos se sigue cambiando, y el panel
    (Casetas) lo avisa y bloquea el % al editar.
  - `GET /v1/admin/party/staff` y `PATCH /v1/admin/party/staff/:userId`
    (`{ stallId }` o `null`): la caseta de cada persona (solo casetas activas).
- **Ajustes de la fiesta**: `GET /v1/admin/party/settings` (dueño y
  encargado) y `PATCH` (solo el dueño; 2FA si la tiene): fechas, plazo de
  devolución, donar sí o no y umbral de efectivo. Con la fiesta terminada, el
  fin no se puede quitar ni poner más tarde: 409 **`EVENT_LOCKED`** antes de
  pedir la 2FA (reabrirla dejaría cambiar otra vez el % de las casetas y el
  cierre). Adelantarlo y el resto de ajustes, sí; Ajustes lo dice junto a
  «Termina».
- **La caseta en cada cobro**: el cobro con tarjeta o QR, su cobro del saldo
  enlazado, el cobro con QR del saldo (cuenta con varias líneas incluida) y el
  consumo al pagarse (saldo, pulsera NFC, PIN o Face ID) llevan la caseta de
  quien lo cobró, fijada al crearlo. Las recargas no llevan caseta (no son
  venta: el consumo ya la llevará). `GET /v1/venues/me` devuelve `stall`
  (`{ id, name }` o `null`).
- **Fiesta terminada**: con `eventEndsAt` ya pasado, crear cobros, cobros del
  saldo o recargas (tarjeta, efectivo, desde casa, datáfono) da **423
  `EVENT_ENDED`** con un mensaje claro. Tampoco se paga después uno creado
  antes: el cobro del saldo con Face ID, PIN (app y datáfono), pulsera sin PIN
  o el del encargado sin Face ID (todos pasan por `bindAndSettle`; se mira
  antes de gastar un intento de PIN, de leer la pulsera en el datáfono o de
  pedir la 2FA), el cobro con tarjeta o la recarga al ir al banco
  (`assertVenueStillCharges`) y la ficha nueva por perdida cobrada del saldo.
  Las consultas, los cierres y las devoluciones siguen funcionando.

Código: `apps/api/src/modules/party/` (casetas, ajustes, `stall-seal.ts`,
`event-window.ts`), `apps/api/src/config/edition.ts` y
`packages/contracts/src/{edition,party}.ts`.

## El panel del organizador (`apps/api/src/modules/party/party-panel.*`)

Con `EDITION=party` (con `club`, 404). Las noches van de las 08:00 a las 08:00
de Madrid (como el cierre automático): «la noche del 23» empieza el 23 a las
08:00. «La fiesta entera» es todo lo de esta instalación (cada fiesta va en la
suya), también lo cargado desde casa antes de empezar.

- `GET /v1/party/live?scope=night|event&night=AAAA-MM-DD&idleMin=15` (dueño y
  encargado): cargado (efectivo, tarjeta en taquilla y desde el móvil),
  vendido, lo que queda en las pulseras (saldos vivos), pulseras activas (con
  saldo o que ya han pagado), ventas por hora, casetas (vendido, cobros y hora
  del último), taquillas (por persona o datáfono de recepción: efectivo,
  tarjeta y el efectivo de su caja) y avisos.
  - **Vendido** (reglas del mapa del dinero, sin contar dos veces): cobros
    pagados que no son recargas + consumos del saldo no anulados, con su
    propina y sin la «Comisión del servicio», menos lo devuelto de esos cobros
    (sin la comisión devuelta). Las recargas son «cargado», nunca venta. Lo
    devuelto cuenta en la noche en que se devuelve (`refundAt`: cuando lo
    devolvió el banco o, sin esa fecha, cuando se pidió), no en la del cobro.
  - **Avisos**, solo en la noche en curso y con la fiesta en marcha: el
    efectivo de una caja por encima de `cashAlertCents` (0 = sin aviso) y las
    casetas «sin cobros desde hace N min» (las que ya cobraron esa noche,
    mientras otras siguen cobrando). No hay latido de conexión.
- `GET /v1/party/cash-desk/me` (todo el personal): el efectivo de la caja de
  quien lo pide en la noche de ahora (recargas en efectivo con su comisión −
  saldo devuelto en efectivo) y si pasa del umbral. Para la taquilla del operator.
- `GET /v1/party/settlement?from=AAAA-MM-DD&to=AAAA-MM-DD` (noches; sin
  fechas, la fiesta entera), `…/settlement/csv` y `…/settlement/sepa` (dueño y
  encargado; descargar no mueve dinero, como los demás CSV: sin 2FA). Por
  caseta: vendido, `organizerBps`, parte del organizador =
  round(vendido · bps / 10000), a pagar = vendido − parte, y si tiene IBAN. La
  parte es la de la caseta **ahora** (no se fija en cada cobro); con la fiesta
  terminada ya no se puede cambiar (`STALL_BPS_LOCKED`) ni reabrir la fiesta
  (`EVENT_LOCKED`), así que el cierre queda fijo. **Liquidación por noches**:
  cada noche lleva lo vendido y lo devuelto en ella; una devolución cuenta en
  la noche en que se hace, aunque el cobro fuera de otra (puede dejar una
  noche de una caseta por debajo de lo que vendió esa noche). El SEPA
  (pain.001.001.03, `sepa.ts` → `buildPain001`, reutilizable): el deudor es
  el local (`settlementIban`, que pone OxioPay; sin él, 409 `NO_DEBTOR_IBAN`)
  y los acreedores, las casetas con IBAN y algo que pagar («barra propia» y lo
  vendido sin caseta, fuera; ninguna, 409 `NO_TRANSFERS`). Concepto
  «OxioParty <fiesta> <caseta>». Cada descarga queda en el registro
  (`party.settlement.sepa_exported`, con `fromNight` y `toNight`).
- **Fichero SEPA ya descargado** (el del cierre y el de las transferencias de
  devolución; `sepa-exports.ts`, sin migración: lo dice el registro): subir el
  mismo dos veces al banco paga dos veces. Si ya se descargó uno con las
  mismas noches (cierre) o con alguna de las mismas transferencias
  (devoluciones: el registro guarda los ids de las peticiones), 409
  **`ALREADY_EXPORTED`** con `exportedAt` y `exportedBy`, salvo `?again=1`.
  La comprobación y el registro van en una transacción con un candado por
  local y fichero (sin registro no hay fichero); la repetida queda con
  `again` y `previousAt`. El panel pregunta «Ya descargaste este fichero el …
  por … ¿Descargarlo otra vez? Cuidado: si lo subes dos veces al banco,
  pagarás dos veces» y, si se confirma, lo pide con `again=1`.

## El panel (`apps/admin`, `NEXT_PUBLIC_EDITION=party`)

Seis secciones con el `?s=` de siempre (`lib/roles.ts` → `PARTY_TABS`,
`lib/nav-url.ts`): **En directo** (`?s=directo`: el directo, Cobros y Avisos;
es donde se empieza), **Casetas** (alta, cambios y archivo con % o «barra
propia» e IBAN, y el personal de cada una), **Pulseras** y **Devoluciones**
(más abajo), **Cierre** (la liquidación por caseta, el fichero
SEPA y el CSV) y **Ajustes** (La fiesta, Formas de cobro sin bitcoin, Pulseras
y PIN, Datáfonos, Seguridad). No salen las compañeras ni sus pagos, saldos y
fichas, informes, reglas, secciones, permisos, Telegram ni las liquidaciones
de OxioPay. Código en `components/party/` y `lib/party-*.ts`; estilos en
`styles/panel-party.css` (tokens Grafito). Con `club`, el panel es el de siempre.

## Pulseras, página del asistente y «Lo que sobra» (migración `20261115200000_oxioparty_devoluciones`)

### Pulseras (panel → Pulseras, dueño y encargado)

Las pulseras son las fichas NFC del saldo (`wallet_cards`), con el número de
siempre escrito **P-0412**.

- `GET /v1/admin/party/pulseras?q=&status=`: recuento por estado (en stock,
  entregadas, devueltas, perdidas, bloqueadas) y la lista (100; el buscador
  acepta «P-0412», «412» o el código del saldo).
- `POST /v1/admin/party/pulseras/lote` `{ count }` (1–500): N códigos nuevos ya
  en el stock, con números seguidos.
- `GET /v1/admin/party/pulseras/hoja?desde=&hasta=`: hoja HTML para imprimir
  (A4, número y QR), **solo con las pulseras sin entregar** del rango (sin
  saldo, en el stock o devueltas: `SHEET_PRINTABLE`; ninguna, 404). El QR
  lleva **el mismo enlace que el chip** (`OPERATOR_BASE_URL/?ficha=…`): quien
  lo fotografíe tiene el enlace, pero pagar sin PIN pide el chip leído por NFC
  (número de serie) y ver el saldo pide Face ID o PIN.
- `POST /v1/admin/party/pulseras/:id/sustituir` `{ nueva }`: la perdida se
  bloquea y su saldo pasa a otra del stock (el saldo vive en el saldo; es
  `attachCardInTx`). La nueva, dada desde el panel, no tiene número de serie:
  hasta leerla una vez por NFC en la taquilla, paga con PIN.
- Bloquear sin más: lo de siempre, `POST /v1/wallet-cards/:id/block`.

### Página del asistente (`/w/:token` con `EDITION=party`)

La del saldo de siempre con tema de día, la marca (`BRAND_NAME` o
«OxioParty») y la fiesta arriba, el saldo grande con la pulsera y los días,
tres botones (Recargar, «Lo que sobra», «La perdí» → ve a la taquilla, o
bloquearla ya con Face ID), los movimientos con el nombre de la caseta
(`ClientWalletState.movements[].stallName`, `pulsera`) y abajo el plazo
(«pídelo hasta el …», `refundDeadline`). Con `club`, la página es idéntica a
la de antes.

### «Lo que sobra» (`party_refund_requests`, FORCE RLS)

- El asistente: `GET /w/:token/sobra`, `POST /w/:token/sobra/challenge` y
  `POST /w/:token/sobra` `{ method, iban?, holderName?, email?, expectedAmountCents? }`.
  Credencial: el enlace y, con Face ID, su sesión y su llave (como «Me voy»).
  Topes por IP y por pulsera. Quien solo tenga **una foto del QR** tiene el
  enlace: por internet, `CARD` sí (el dinero vuelve a la tarjeta que pagó),
  pero `TRANSFER` y `DONATE` solo si el saldo tiene Face ID y su llave se
  verifica en esa misma petición; sin Face ID, 409 **`REFUND_NEEDS_FACE_ID`**
  y la página lo dice: «Para transferencia o donar, activa Face ID o pásate
  por la taquilla» (allí se devuelve el efectivo como siempre). La vista
  trae `faceId`. Activar Face ID no cambia.
  - `CARD`: solo lo cargado con tarjeta que sigue en el saldo (lo gastado
    cuenta antes como tarjeta, `wallet-cash-limits.ts`). El organizador la
    hace **a mano en el portal del banco** (Redsys no devuelve por API) y la
    marca «Hecha».
  - `TRANSFER`: lo cargado en efectivo, a su IBAN (mod-97) y a nombre del
    **titular** de la cuenta (`holderName`, obligatorio: sin caracteres de
    control, solo letras y `. , ' ’ -`, de 2 a 70; desde 2025 el banco
    comprueba que nombre e IBAN coinciden). Se guarda lo mínimo: el IBAN, el
    titular y, si quiere, un correo para el justificante.
  - `DONATE`: todo lo que queda, solo con `allowDonation`; hecha al momento
    (el correo, si lo da, solo para el justificante: no se guarda).
  - Pasado `refundDeadline` (último día, hora de Madrid): 409 `REFUND_CLOSED`.
  - Con una recarga del saldo a medias (un cobro de recarga en `CREATED`,
    `AWAITING_CAPTURE` o `AUTHORIZING`: el banco aún puede sumarla), 409
    **`TOPUP_IN_PROGRESS`**.
  - **Datos personales**: al pasar a `DONE` o `CANCELED` se borran `iban`,
    `holderName` y `email` (el justificante sale antes, con el IBAN tapado).
    En la base: el IBAN y el titular solo en `TRANSFER` y obligatorios solo en
    `PENDING`; `party_refund_requests_personal_data_check` exige que una
    hecha o anulada no los tenga. El registro (`party.refund.*`) no lleva ni
    el IBAN, ni el titular, ni el correo.
  - Al pedirla, el saldo queda **bloqueado** (`client_wallets.blockedAt` con el
    motivo «OxioParty: devolución pedida»: pagos y recargas ya lo respetan).
    «Me voy» (`closeRequestedAt`) no se usa: no impide gastar. Una pendiente
    por vía (índice parcial).
- El organizador (panel → Devoluciones, dueño y encargado):
  `GET /v1/admin/party/refunds?status=&method=` (lista y totales, lo donado
  aparte), `POST …/refunds/:id/done` («Hecha»: el importe sale del saldo; a
  cero, el saldo se cierra) y `POST …/refunds/:id/cancel` (no sale nada y el
  saldo se desbloquea). `GET …/refunds/transferencias.csv`: las
  transferencias pendientes con el titular y el IBAN entero. `GET
  …/refunds/transferencias.sepa`: las mismas (pendientes con IBAN) en un
  fichero SEPA pain.001.001.03 para subirlas de una vez (`buildPain001` de
  `sepa.ts`, como el cierre; `party-refund-sepa.ts`): el deudor es el local
  (`settlementIban`; sin él, 409 `NO_DEBTOR_IBAN`), cada transferencia lleva
  el id de la petición como referencia y «Devolución <marca> P-0412» como
  concepto, y el acreedor es el titular que escribió el asistente. Solo dueño
  y encargado; cada descarga queda en el registro
  (`party.refunds.sepa_exported`, con los ids de las peticiones) y, si alguna
  ya iba en un fichero descargado, 409 `ALREADY_EXPORTED` salvo `?again=1`
  (más arriba). Subirlo no marca nada: después, «Hecha» en el panel.
- Pendiente: lo hecho no crea `wallet_payouts` ni `refunds` de OxioPay (el
  cuadre con el banco no enlaza una devolución a la tarjeta hecha a mano con
  su recarga) y el cierre debería contar lo pendiente de devolver como deuda
  con los asistentes.

### El estado del cobro del saldo (app del personal)

`GET /v1/wallet-charges/:id` pagado, con `party`: además `pulsera` («P-0412»:
la acercada o, pagado con el QR, la que tiene dada) y `balanceLeftCents` (lo
que le queda; el mismo valor que `newBalanceCents`). Contrato:
`SaldoChargePartyExtras`. Con `club` no van.
