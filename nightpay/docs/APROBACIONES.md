# «Por aprobar»: el encargado pide, el dueño aprueba

Pagos a las chicas y devoluciones grandes que pide el encargado y aprueba el
dueño con su 2FA. Reglas por local (las pone el super-admin, ver
[SUPERADMIN.md](SUPERADMIN.md)): `payoutRequiresApproval` (sí por defecto) y
`refundApprovalThresholdCents` (100 € por defecto).

## Quién hace qué

| Quién | Pago a una chica | Devolución por la pasarela |
|---|---|---|
| Dueño | Directo, con 2FA si la tiene (como siempre). | Directa, con 2FA por lo devuelto acumulado (como siempre). |
| Encargado, local con aprobación | **Lo pide** (202). | Desde el umbral (incluido): **la pide** (202). Por debajo, directa. |
| Encargado, local sin aprobación | Directo, con **2FA obligatoria**. | Igual que arriba. |
| Camarero, chica | No. | No. |

- **Quien pide nunca aprueba ni rechaza**, tampoco si es dueño o super-admin
  (403 `APPROVAL_OWN_REQUEST`). La base lo asegura también (CHECK
  `approval_requests_decider_not_requester`).
- Aprobar pide la 2FA del dueño (sin 2FA activada: 403 `TOTP_NOT_ENROLLED`).
  Rechazar pide el motivo, que ve el encargado.
- Las devoluciones de Redsys (se hacen en el portal de BBVA) y las recargas de
  saldo no se piden: van por su sitio de siempre.

## API

Los endpoints de siempre, cuando el encargado tiene que pedirlo, no lo hacen:
responden **202** con

```json
{ "approvalRequestId": "…", "status": "PENDING", "kind": "PAYOUT", "amountCents": 14000,
  "message": "Pedido al dueño. Te avisamos cuando lo apruebe." }
```

- `POST /v1/admin/operators/:id/payouts` (ahora también `MANAGER`).
- `POST /v1/payments/:id/refunds`.

Nuevos (contratos en `packages/contracts/src/approvals.ts`):

| Método y ruta | Quién | Qué hace |
|---|---|---|
| `GET /v1/approvals?status=PENDING&limit=50` | Dueño (todas las del local), encargado (las suyas) | Tarjetas: importe, quién y cuándo, chica y cuenta tapada o cobro y tarjeta, motivo, cuándo caduca y si quien mira puede decidir. |
| `GET /v1/approvals/rules` | Dueño, encargado | Qué le toca a quien mira: `payout` (`direct`, `direct_2fa`, `request`) y desde cuánto pide devoluciones. |
| `POST /v1/approvals/:id/approve` `{ totpCode }` | Dueño | Hace lo pedido con los servicios de siempre. Idempotente: aprobar dos veces (o dos dueños a la vez) paga una sola vez y devuelve cómo quedó. |
| `POST /v1/approvals/:id/reject` `{ note }` | Dueño | Rechaza con el motivo (mínimo 3 letras). |

Errores propios (409 salvo que se diga): `APPROVAL_ALREADY_PENDING` (ya hay un
pago pedido para esa chica), `APPROVAL_NOT_PENDING`, `APPROVAL_EXPIRED`,
`APPROVAL_FAILED` (no se pudo hacer: la solicitud queda fallida con la razón),
`APPROVAL_OWN_REQUEST` / `APPROVAL_FORBIDDEN` (403).

## Cómo se reserva

- **Pago a una chica.** Al pedirlo se fijan las comisiones (las que ya pasaron
  los días de espera del local) y la deuda abierta, con sus filas bloqueadas, y
  el total. Al aprobarlo se pagan **exactamente esas** y por ese total: si
  alguna ya se pagó, si cambió el importe (una devolución entretanto) o si la
  cuenta de cobro de la chica cambió desde que se pidió, no se paga nada y la
  solicitud queda `FAILED` con la razón. Una sola petición pendiente por chica
  (candado por chica + índice único parcial) y, mientras está pendiente, nadie
  le paga por otro lado (el pago directo responde `APPROVAL_ALREADY_PENDING`).
- **Devolución.** Lo pedido cuenta como reservado del cobro, igual que una
  devolución en curso (`reservedRefundCents`): dos peticiones a la vez, o el
  dueño devolviendo por su cuenta, no pasan de lo cobrado. Al aprobarla, la
  solicitud deja de reservar en la misma transacción en que se reserva la
  devolución. Si la pasarela la rechaza, la solicitud queda `FAILED`; si no
  contesta, queda aprobada y la devolución pendiente (se resuelve en el cobro,
  como siempre).
- **Idempotencia.** La solicitud pasa de `PENDING` a `APPROVED` dentro de la
  transacción que paga o reserva; quien llega tarde no hace nada.

## Caducidad, avisos y registro

- Sin decidir en **24 h** → `EXPIRED`: deja de reservar y ya no se aprueba. Se
  marca al leerlas y en un repaso cada 10 min.
- **Telegram**: al pedirla, un aviso al chat del dueño («🔔 Local: Ana
  (encargado/a) pide pagar 140 € a Lola. Aprueba en el panel (Por aprobar).»).
  Sin datos del cliente; el nombre de la chica sí (decisión del dueño). Una
  sola vez: la marca es la misma que la de la incidencia.
- **Incidencias**: `approval_pending` a los 30 min sin decidir; se quita sola
  al decidirla o caducar.
- **Registro**: `approval.requested`, `approval.approved`, `approval.rejected`,
  `approval.failed`, `approval.expired` (y lo de siempre: `operator.payout.created`
  y `refund.created`, con el id de la solicitud).

## Base de datos

Tabla `approval_requests` (migración `20261016300000_aprobaciones`), con
**FORCE RLS** como `operator_payouts`: una fila es un permiso para mover
dinero, así que una consulta sin el local en la sesión (o sin el bypass) no ve
nada, también con el rol dueño de las tablas, y los guardas del API
(`rls.ts`, `rls-guard.spec.ts`, `TENANCY_UNSCOPED_QUERIES=throw`) cortan el
acceso fuera de una transacción.

## Panel

- Dueño: pestaña **Por aprobar** (y «Aprobar» en la barra de abajo del móvil)
  con globo de pendientes. «Aprobar» enseña la frase de confirmación y pide el
  código (al sexto número se aprueba); «Rechazar» pide el motivo. Un pago que
  el encargado pidió con su hash o referencia se verifica al aprobarlo, como
  en «Marcar pagado».
- Encargado: **Mis solicitudes** (en «Más») con su estado. Los modales de pago
  y devolución le dicen «Pedido al dueño», nunca «hecho».
