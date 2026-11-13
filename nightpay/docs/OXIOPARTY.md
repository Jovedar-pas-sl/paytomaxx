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
  - `GET /v1/admin/party/staff` y `PATCH /v1/admin/party/staff/:userId`
    (`{ stallId }` o `null`): la caseta de cada persona (solo casetas activas).
- **Ajustes de la fiesta**: `GET /v1/admin/party/settings` (dueño y
  encargado) y `PATCH` (solo el dueño; 2FA si la tiene): fechas, plazo de
  devolución, donar sí o no y umbral de efectivo.
- **La caseta en cada cobro**: el cobro con tarjeta o QR, su cobro del saldo
  enlazado, el cobro con QR del saldo (cuenta con varias líneas incluida) y el
  consumo al pagarse (saldo, pulsera NFC, PIN o Face ID) llevan la caseta de
  quien lo cobró, fijada al crearlo. Las recargas no llevan caseta (no son
  venta: el consumo ya la llevará). `GET /v1/venues/me` devuelve `stall`
  (`{ id, name }` o `null`).
- **Fiesta terminada**: con `eventEndsAt` ya pasado, crear cobros, cobros del
  saldo o recargas (tarjeta, efectivo, desde casa, datáfono) da **423
  `EVENT_ENDED`** con un mensaje claro. Las consultas, los cierres y las
  devoluciones siguen funcionando.

Código: `apps/api/src/modules/party/` (casetas, ajustes, `stall-seal.ts`,
`event-window.ts`), `apps/api/src/config/edition.ts` y
`packages/contracts/src/{edition,party}.ts`.
