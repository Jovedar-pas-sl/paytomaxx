# Consola del super-admin (`/v1/superadmin/*`)

API para que el dueño de la plataforma (usuario con `users.isSuperAdmin = true`)
lo controle todo desde un sitio: negocios clientes, locales, personal, cuentas
de cobro de las chicas, clientes con saldo y el registro. El panel la usará más
adelante; los contratos (zod + tipos) están en
`packages/contracts/src/superadmin.ts` (`@nightpay/contracts`).

Código: `apps/api/src/modules/superadmin/`. Migraciones:
`20261016100000_superadmin_negocios` y `20261016100100_saldo_bloqueado`.

## Reglas comunes

- **Acceso.** Sesión normal (Bearer) y además `SuperAdminGuard`: lee
  `isSuperAdmin` y la baja (`deletedAt`) de la base **en cada petición**. Un JWT
  emitido antes de quitarle el permiso no sirve. Fallo → 403 `Solo para super-admins`.
- **Todos los locales.** El super-admin tiene su local activo en la sesión; la
  consola consulta con `acrossVenues` (sin filtro de local y con bypass de RLS),
  así que ve todo, también las tablas con FORCE RLS (saldos, consumos…).
- **2FA obligatoria.** Un super-admin sin 2FA no abre sesión con la contraseña:
  el login da 401 `TOTP_SETUP_REQUIRED` con un ticket (10 min) que solo sirve
  para activarla (`POST /v1/auth/login/totp/setup` → QR; `POST
  /v1/auth/login/totp/enroll` con un código → la guarda y entra). El panel lo
  hace en la misma pantalla de entrar. También se puede dar de alta con
  `pnpm cli enroll-totp` o, tras un `totp/reset` de otro super-admin, en el
  siguiente login. Activarla en un super-admin queda en el registro
  (`auth.totp.enabled` con `superAdmin: true`) y avisa por Telegram (chat de
  `TELEGRAM_CHAT_ID`). Una sesión de super-admin que no entró con la 2FA (de
  antes) o cuya 2FA se quitó se cierra al refrescar (`auth.refresh.two_factor_required`).
- **Step-up 2FA.** Las escrituras que mueven dinero o identidades piden
  `totpCode` (código de 6 cifras de la app del propio super-admin) en el cuerpo,
  aunque la sesión esté abierta. Errores (`code` en la respuesta):
  - `TOTP_NOT_ENROLLED` 403: el super-admin no tiene 2FA → tiene que activarla
    antes (perfil).
  - `TOTP_REQUIRED` 403: falta el código.
  - `TOTP_INVALID` 403: código malo o ya usado (cada código vale una vez).
  - `TOTP_LOCKED` 429: demasiados códigos malos; esperar.
  Cada fallo queda en el registro (`superadmin.step_up.failed`, con la acción intentada).
- **Registro.** Toda escritura deja una fila en `audit_events` con acción
  `superadmin.*`, quién (id, email, IP, navegador), el local afectado, antes y
  después y el motivo. Contraseñas, tokens y secretos 2FA no se guardan nunca;
  IBAN y cuentas van tapados (`ES12 •••• •••• 1234`, `T…9f2a`, `a•••@dominio`).
- **Límites.** Además del global (600/min por persona): escrituras 30/min, ver una
  cuenta de cobro entera 10/min, búsqueda de clientes 60/min.
- **Validación.** Cuerpos y filtros con zod: 400 con `issues` si algo no vale.

En la tabla: **2FA** = pide `totpCode`; **Motivo** = pide `reason` (3–500 letras).

## Vista general

| Método y ruta | Qué hace | 2FA | Registro |
|---|---|---|---|
| `GET /superadmin/overview` | Por negocio y por local: cobrado hoy (desde las 00:00 de Madrid) y en la semana (hoy + 7 días), cobros de hoy, a pagar ya a las chicas (con los días de espera de **cada** local, como Tesorería), en espera, deuda de las chicas, saldo vivo de clientes (ACTIVE) e incidencias abiertas (la misma bandeja del local). Locales sin negocio, en «Sin negocio». | — | — |

El dinero sale de 5 consultas agregadas para todos los locales a la vez; las
incidencias se cuentan con la bandeja de cada local (4 locales a la vez).

## Negocios

| Método y ruta | Qué hace | 2FA | Registro |
|---|---|---|---|
| `GET /superadmin/businesses?q=&status=` | Lista (busca por nombre, NIF/CIF o email). | — | — |
| `GET /superadmin/businesses/:id` | Ficha con sus locales. | — | — |
| `POST /superadmin/businesses` | Alta: razón social, NIF/CIF (único, se guarda sin espacios ni guiones), contacto, notas, comisión por defecto para sus locales nuevos. | Solo con `defaultPlatformCommissionBps` (no null) | `business.created` |
| `PATCH /superadmin/businesses/:id` | Cambiar esos datos. | Solo si cambia `defaultPlatformCommissionBps` | `business.updated` (solo lo que cambia) |
| `POST /superadmin/businesses/:id/pause` | Pausa el negocio: **ninguno de sus locales** acepta cobros nuevos. Motivo. | Sí | `business.paused` (con los locales afectados) |
| `POST /superadmin/businesses/:id/resume` | Quita la pausa (motivo opcional). | Sí | `business.resumed` |
| `POST /superadmin/businesses/:id/venues` | Mete locales en el negocio (`venueIds`; si estaban en otro, se cambian: también de uno en pausa). Si un local lleva un grupo del saldo que usa otro negocio o un local sin negocio: 409 con sus nombres y no entra ninguno. | Sí | `venue.business_assigned` por local |
| `POST /superadmin/businesses/:id/venues/:venueId/unassign` | Saca un local del negocio (si el negocio está en pausa, el local vuelve a cobrar). Si comparte su grupo del saldo con otro local: 409 y no sale (antes, otro grupo). Cuerpo `{ totpCode }`. | Sí | `venue.business_assigned` |

## Locales

| Método y ruta | Qué hace | 2FA | Registro |
|---|---|---|---|
| `GET /superadmin/venues?q=&businessId=&paused=` | Todos los locales con su negocio, pausa e IBAN tapado. | — | — |
| `GET /superadmin/venues/:id` | Ficha: perfil, IBAN completo y titular, reglas (con los días de espera que se aplican hoy), número de usuarios, chicas y datáfonos. | — | — |
| `POST /superadmin/venues` | Alta (nombre, slug único, zona, negocio, grupo del saldo, comisión; sin comisión: la del negocio o la general). `GET/POST /v1/admin/venues` siguen igual para el desplegable del panel. | Solo con `walletGroup` o `platformCommissionBps` | `venue.created` |
| `PATCH /superadmin/venues/:id/profile` | Nombre, zona horaria, IVA (`vatBps`, `vatRegime`) y grupo del saldo (`walletGroup`, null = sin grupo). El grupo, solo entre locales del mismo negocio: si ya lo usa uno de otro negocio o uno sin negocio, 409 con sus nombres (también en el alta). Un local sin negocio no comparte grupo con ninguno: antes, a su negocio. | Solo si toca `walletGroup`, `vatBps` o `vatRegime` | `venue.profile_updated` |
| `PATCH /superadmin/venues/:id/rules` | Reglas: tope por cobro de la chica, comisión de la plataforma, comisiones por categoría (parciales; se mezclan con las guardadas), días de espera para pagar a las chicas (0–60, null = `PAYOUT_HOLD_DAYS`), umbral de aprobación de devoluciones y si los pagos a chicas necesitan aprobación. La chica + la plataforma no pueden pasar del 100 % en ninguna categoría, tampoco con el % propio más alto de una chica del local (400). | Sí | `venue.rules_updated` |
| `PUT /superadmin/venues/:id/settlement-account` | IBAN donde el banco liquida los cobros con tarjeta y su titular (mod-97; se guarda sin espacios). Para cuadre e informes. | Sí | `venue.settlement_account_set` (tapado) |
| `POST /superadmin/venues/:id/settlement-account/clear` | Quita el IBAN. Motivo. | Sí | `venue.settlement_account_cleared` |
| `POST /superadmin/venues/:id/pause` | Pausa el local. Motivo. | Sí | `venue.paused` |
| `POST /superadmin/venues/:id/resume` | Quita la pausa (si su negocio sigue en pausa, sigue sin cobrar). | Sí | `venue.resumed` |

### Qué hace la pausa

Local en pausa, o local de un negocio en pausa → **423** con
`code: "VENUE_PAUSED"`, `pausedBy: "venue" | "business"` y el texto en español:

- crear cobros (`POST /v1/payments`), también recargas de saldo;
- cobros del saldo: crear el QR del cobro y cobrarlo (Face ID, código/ficha +
  PIN, aprobado por el encargado), aunque el QR se hiciera antes de la pausa.

Siguen funcionando: devoluciones, incidencias, cierre de la noche, entrar en
las apps, devolver el saldo al cliente.

### Días de espera por local

`venues.payoutHoldDays` manda sobre `PAYOUT_HOLD_DAYS` en el saldo de la chica,
en el pago (`createPayout`) y en Tesorería. `null` = el del entorno. `0` = se
les paga al cierre de la noche (todo lo cobrado ya se puede liquidar).

### Reglas de aprobación

`refundApprovalThresholdCents` (100 € por defecto) y `payoutRequiresApproval`
(sí por defecto) las aplica «Por aprobar»: el encargado pide los pagos a las
chicas (si el local lo exige; si no, paga él con 2FA) y las devoluciones desde
el umbral; el dueño las aprueba con 2FA y quien pide no aprueba. Ver
[APROBACIONES.md](APROBACIONES.md).

## Personal y administradores

| Método y ruta | Qué hace | 2FA | Registro |
|---|---|---|---|
| `GET /superadmin/users?venueId=&role=&q=&active=&superAdmin=&cursor=&limit=` | Todos los usuarios: local, rol, activo, invitación pendiente, 2FA activada, super-admin, último login (del registro). Paginado por cursor. | — | — |
| `GET /superadmin/users/:id` | Uno. | — | — |
| `POST /superadmin/users` | Alta de OWNER, MANAGER, WAITER u OPERATOR en un local. **Nunca devuelve contraseña**: enlace de invitación de 24 h (`/accept-invite` de la app de las chicas, el mismo de siempre) y se intenta mandar por email. Chica: el alta de siempre (nombre y % propio opcional). Email ya usado → 409. | Sí | `user.created` |
| `POST /superadmin/users/:id/reset-password` | Como el de la chica hoy: sin activar → invitación nueva; activada → contraseña temporal de 12 caracteres que se ve **una vez**. Cierra sus sesiones. Motivo. | Sí | `user.password_reset` (sin la contraseña) |
| `POST /superadmin/users/:id/disable` | Baja: no entra y se cierran sus sesiones. No a uno mismo ni al último super-admin. Motivo. | Sí | `user.disabled` |
| `POST /superadmin/users/:id/enable` | Vuelve a darle de alta. Motivo. | Sí | `user.enabled` |
| `POST /superadmin/users/:id/revoke-sessions` | Cierra todas sus sesiones: refresh, token de acceso vivo (401 al momento) y tiempo real. Motivo. | — | `user.sessions_revoked` |
| `POST /superadmin/users/:id/totp/reset` | Borra su 2FA: tendrá que activarla otra vez. Cierra sus sesiones. No la propia (se cambia en el perfil). Motivo. | Sí | `user.totp_reset` |
| `POST /superadmin/users/:id/super-admin` | Dar (`enabled: true`, solo a un OWNER activo) o quitar el permiso (quitarlo cierra sus sesiones; también `pnpm cli set-super-admin --revoke true`). Nunca deja la plataforma sin super-admins (tampoco quitándotelo tú si eres el último): 409. Motivo. | Sí | `user.super_admin_granted` / `user.super_admin_revoked` |

La CLI (`pnpm cli …`) sigue igual.

## Cuentas de cobro de las chicas

| Método y ruta | Qué hace | 2FA | Registro |
|---|---|---|---|
| `GET /superadmin/payout-accounts?venueId=&method=&q=&missing=&includeInactive=` | Chicas de todos los locales con su cuenta **tapada** (`ES12 •••• •••• 1234`, `T…9f2a`, `a•••@dominio`). | — | — |
| `POST /superadmin/payout-accounts/:userId/reveal` | La cuenta entera. Motivo. | Sí | `payout_account.revealed` |
| `PUT /superadmin/payout-accounts/:userId` | Cambiarla (o quitarla con método y cuenta a null). Validada según el método con las reglas del panel: TRC20, EVM (BEP20/Polygon), Solana, IBAN mod-97, email; en SEPA y SWIFT, con titular. Motivo. Se guarda cifrada, avisa al local (Incidencias y Telegram, «OxioPay ha cambiado una cuenta de cobro») y a la compañera por correo, y la cuenta nueva espera 48 h ([CUENTA-COBRO-SEGURA.md](CUENTA-COBRO-SEGURA.md)). | Sí | `payout_account.updated` (antes/después tapados) y, en el registro del local, `operator.payout_account_changed` |

## Clientes con saldo

| Método y ruta | Qué hace | 2FA | Registro |
|---|---|---|---|
| `GET /superadmin/customers/search?q=` | Busca en **todos** los locales por código del cliente (`K7Q-4M2`), ficha NFC (código grabado o número de serie), id del saldo o id de un cobro (recarga). | — | — |
| `GET /superadmin/customers/:walletId` | Saldo, estado, grupo, local de origen, bloqueo, «Me voy», llaves (Face ID), fichas, PIN (tiene, bloqueado, fallos) y los últimos 50 movimientos (recargas, consumos, devoluciones) con su local. | — | — |
| `POST /superadmin/customers/:walletId/block` | Bloquea el saldo: **no paga** (Face ID, PIN, sin Face ID). Se le puede seguir devolviendo. Motivo. | — | `wallet.blocked` |
| `POST /superadmin/customers/:walletId/unblock` | Desbloquea. Motivo. | Sí | `wallet.unblocked` |
| `POST /superadmin/customers/:walletId/unlock-pin` | Tras 5 PIN fallidos, deja probar otra vez (como el encargado). Motivo. | Sí | `wallet.pin_unlocked` |
| `POST /superadmin/customers/:walletId/relink` | Enlace nuevo del saldo (`path: /w/<token>`): el viejo deja de valer y sus llaves (Face ID) se borran. El enlace no va al registro. Motivo. | Sí | `wallet.relinked` |

## Registro

| Método y ruta | Qué hace | 2FA | Registro |
|---|---|---|---|
| `GET /superadmin/audit?venueId=&actorId=&action=&from=&to=&cursor=&limit=` | `audit_events` de todos los locales, del más reciente al más antiguo. `action` es un prefijo (`superadmin.`, `auth.login`, `refund.`…). `from`/`to` en ISO; `cursor` = id de la última fila. El payload sale con lo secreto tapado. | — | — |

## Liquidaciones OxioPay

Lo que cada local debe a OxioPay por semana, **de lunes 08:00 a lunes 08:00
de Madrid** (el corte de las noches; con el cambio de hora la semana dura 169
o 167 h). Es lo que el mapa del dinero pone como de OxioPay en esa ventana —
la comisión del servicio cobrada a los clientes (pagos directos y recargas,
con tarjeta y en efectivo) menos la devuelta, y la comisión de plataforma de
siempre donde no hay comisión del servicio (interruptor apagado, saldo cargado
antes de encenderla) — con la misma cuenta (`MoneyMapService.oxioPayOwed`,
`money-map-rules.oxioPayOwedOf`): **el total de la semana cuadra con el mapa
del dinero de esa ventana**. Desglose por noche (08:00 → 08:00) y por concepto.
Es un resumen, **no una factura**.

Código: `apps/api/src/modules/oxiopay-settlements/` (generación, repaso, panel
del dueño, documento y CSV) y `apps/api/src/modules/superadmin/settlements.*`
(consola). Contratos: `packages/contracts/src/oxiopay-settlement.ts`. Migraciones:
`20261031100000_liquidacion_oxiopay` y `20261031110000_liquidacion_revision`
(semana de inicio y más CHECK).

- **Semana de inicio.** Un ajuste de la plataforma en la base
  (`oxiopay_settlement_settings`, una fila): la primera semana que se liquida.
  Si está vacía, al arrancar el API se fija sola en la primera semana
  **completa** siguiente (el próximo lunes 08:00 de Madrid; con dos réplicas,
  la primera gana y queda en el registro como
  `superadmin.settlement.start_week_set`): nunca se liquida nada anterior al
  despliegue. El arrastre de semanas negativas y los ajustes cuentan desde
  ella (no desde la liquidación más antigua del local) y generar a mano una
  semana anterior da 400 (antes de gastar el 2FA). Solo el super-admin la
  cambia, con 2FA y motivo. La consola la enseña encima de la cuenta de OxioPay.

- **Repaso del lunes.** Cada 10 min se mira si toca: el lunes desde las 10:00
  de Madrid (después del corte de las 08:00 y del resumen de las 9:00) se
  genera la semana terminada de cada local; si el servidor estuvo parado, en
  la siguiente vuelta. Candado `SET NX` (`np:oxiopay-settlements:lock`, con
  valor propio y borrado condicional) para las dos réplicas de start-first;
  semana hecha sin fallos → marca `np:oxiopay-settlements:done:<lunes>`. Una
  activa (no anulada) por local y semana: lo asegura además la base (índice
  parcial) y el candado de transacción del local. Con 0 € (o menos) no se crea.
  Si las noches no suman lo que da el mapa del dinero para la semana entera,
  se calcula otra vez; si sigue sin cuadrar, **no se emite** (409
  `SETTLEMENT_MAP_MISMATCH`, log de error y Telegram). Los locales que fallan
  se avisan por Telegram (marca `np:oxiopay-settlements:failed:<día>`, una vez
  al día). Al apagarse, el API espera a la vuelta en curso (con tope) y suelta
  el candado. `NIGHTPAY_DISABLE_OXIOPAY_SETTLEMENTS=1` lo apaga.
- **Comprobación acumulada.** En cada repaso, desde la semana de inicio, el
  libro de cada local se compara con lo liquidado: algo apuntado tarde más
  allá de las 12 semanas (no entra solo como ajuste), un local dado de baja
  con liquidaciones sin pagar o con algo sin liquidar, o un local que no se
  pudo comprobar → Telegram una vez por semana (`np:oxiopay-settlements:check:<lunes>`)
  y log.
- **Congelada.** Al generarse, sus cifras (noches × conceptos) quedan guardadas.
  Lo que se apunta después con fecha de una semana ya liquidada (una devolución
  de BBVA con la fecha del banco, un aviso del banco que llega tarde, un consumo
  anulado) entra en la siguiente como **«ajustes de semanas anteriores»**, con
  su semana, su noche, su concepto y la referencia de entonces. Se repasan las
  12 semanas anteriores, nunca antes de la semana de inicio. Lo congelado no se
  recalcula: los ajustes son lo de ahora menos lo guardado, y el % de plataforma
  de cada consumo del saldo queda fijado al gastarlo
  (`wallet_consumptions.platformCommissionBps`, como ya hacían los cobros); los
  consumos de antes (sin él) siguen con el % del local. En el resumen, cada
  concepto es solo de la semana (cuadra con la tabla por noche); lo de antes va
  aparte, en «ajustes de semanas anteriores». Una devolución hecha en
  una semana cuenta en esa semana (como en el mapa y el Z), aunque el cobro sea
  de otra: no es un ajuste.
- **Estados.** Emitida → pagada en parte → pagada; anulada solo sin pagos (2FA y
  motivo). Anulada, lo suyo vuelve a estar sin liquidar: se genera otra vez a
  mano (referencia con `/R2`, `/R3`…) o entra la semana siguiente como ajuste. El
  repaso automático nunca regenera una semana anulada.
- **Motivos internos.** El motivo de una anulación y la nota de un pago solo
  los ve OxioPay (consola y registro): el dueño ve «anulada» y «transferencia
  recibida», y el documento no los imprime.
- **Referencia.** `OXP-<año ISO>-S<semana ISO>-<SLUG DEL LOCAL>`, y `/R2`,
  `/R3`… si se regenera (el slug solo lleva letras, números y guiones: `/` no
  choca y vale en el concepto de una transferencia SEPA); es el concepto de la
  transferencia. La base lo comprueba (CHECK).
- **Aviso.** Más de 7 días sin pagarla entera: Telegram al chat de
  `TELEGRAM_CHAT_ID` una vez al día como mucho (de 10:00 a 22:00, marca SET NX
  `np:oxiopay-settlements:overdue:<día>`) y aviso arriba del panel del dueño.
- **Cuenta de OxioPay.** Nombre, IBAN (mod-97) y titular, en la base
  (`oxiopay_payee`, una fila). Sin ella las liquidaciones salen igual y lo avisan.
  Cada cambio: al registro en la misma transacción (IBAN tapado) y aviso por
  Telegram (IBAN tapado y quién). La ficha dice desde cuándo es esa cuenta; si
  cambió hace menos de 14 días, el dueño ve un aviso para comprobarla antes de
  transferir.
- **Registro.** Pagos, anulaciones, generaciones, cuenta y semana de inicio se
  escriben al registro **en la misma transacción** que el cambio: o las dos
  cosas o ninguna. Las fechas tienen que existir (`2026-02-31` → 400) y todo se
  comprueba antes de pedir el 2FA, así un error no gasta el código.

| Método y ruta | Qué hace | 2FA | Registro |
|---|---|---|---|
| `GET /superadmin/oxiopay-settlements?venueId=&businessId=&status=&from=&to=&q=` | Lista (200 más recientes; `status` = `ISSUED`, `PARTIALLY_PAID`, `PAID`, `VOID` u `OPEN` = las pendientes; `from`/`to` = días de Madrid en que empiezan; `q` = referencia) y lo **pendiente de cobrar** de todos los locales (y lo que lleva más de 7 días). | — | — |
| `GET /superadmin/oxiopay-settlements/:id` | Ficha: noches × conceptos, ajustes, pagos (con quién los apuntó), local y negocio congelados, lo que daba el mapa al emitirla y la cuenta de OxioPay. | — | — |
| `GET /superadmin/oxiopay-settlements/:id/document` · `/csv` | Página para imprimir / guardar como PDF y CSV. | — | — |
| `POST /superadmin/oxiopay-settlements/:id/payments` | Apunta lo recibido: `amountCents`, `paidOn` (día del abono, no futuro ni anterior a la semana), `bankReference`. Con lo pendiente → pagada; con menos → pagada en parte, con `reason` obligatorio; más que lo pendiente, no (400). La misma referencia del banco otra vez en esa liquidación (sin mirar mayúsculas ni espacios) → 409 `SETTLEMENT_PAYMENT_DUPLICATE`, salvo `confirmDuplicate: true` (la consola lo pide con una casilla y queda en el registro). Los pagos no se cambian ni se borran (trigger). | Sí | `settlement.paid` / `settlement.paid_partially` |
| `POST /superadmin/oxiopay-settlements/:id/void` | Anula una sin pagos (409 si tiene). Motivo. | Sí | `settlement.voided` |
| `POST /superadmin/oxiopay-settlements/generate` | `{ venueId, week (el lunes), reason? }`: genera la de una semana ya terminada (o la regenera tras anularla). 400 si es anterior a la semana de inicio; 409 `SETTLEMENT_EXISTS` si ya hay una activa; 409 `SETTLEMENT_NOTHING` si no hay nada que liquidar; 409 `SETTLEMENT_MAP_MISMATCH` si las noches no cuadran con el mapa. | Sí | `settlement.generated` / `settlement.regenerated` |
| `GET /superadmin/oxiopay-settlements/payee` · `PUT …/payee` | La cuenta de OxioPay (`name`, `iban`, `holder`). | Sí (PUT) | `settlement.payee_updated` (IBAN tapado) |
| `GET /superadmin/oxiopay-settlements/settings` · `PUT …/settings` | La semana de inicio (`{ startWeek }`, un lunes `AAAA-MM-DD`; `null` si aún no está fijada). El PUT pide `startWeek`, `reason` y el código. | Sí (PUT) | `settlement.start_week_updated` |

Las que genera el repaso quedan en el registro como `superadmin.settlement.generated`
con `auto: true` y sin persona.

**Panel del dueño** (Informes → «Liquidaciones OxioPay», solo `OWNER`; ni el
encargado ni el personal; cada local solo las suyas, también con RLS de la
base): `GET /v1/admin/oxiopay-settlements` (lista, cuenta de OxioPay y lo
pendiente), `…/notice` (las de más de 7 días, para el aviso), `…/:id`,
`…/:id/document` y `…/:id/csv`. Solo lectura.
