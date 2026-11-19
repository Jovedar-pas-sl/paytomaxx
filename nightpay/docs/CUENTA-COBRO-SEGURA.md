# Cuenta de cobro segura (19-nov-2026)

La cuenta de cobro de cada compañera (IBAN, cartera cripto, email…) y su
titular. Qué se guarda, quién lo ve y cómo se publica.

## Qué cambia

| Antes | Ahora |
|---|---|
| La cuenta se guardaba en claro en `users.payoutAddress`. | Se guarda **cifrada** (`pa1:…`, AES-256-GCM con `ENCRYPTION_KEK`), y aparte una versión **tapada** para enseñar (`ES91 •••• •••• 1332`). El titular, igual. |
| El encargado veía la cuenta entera en el panel. | El panel solo la enseña tapada. El dueño la ve entera con **«Ver cuenta para pagar»**: pide su 2FA, se ve un minuto y queda en el registro (sin la cuenta). |
| El registro guardaba la cuenta entera en cada cambio. | El registro guarda la cuenta y el titular tapados. |
| El titular solo se pedía en la transferencia internacional. | También en el **IBAN SEPA**. Si no se parece al nombre de la compañera, se avisa al dueño (no bloquea). |
| Cambiar la cuenta pedía la 2FA solo si el dueño la tenía. | La pide **siempre**. Sin 2FA activada no se cambia: el mensaje dice dónde activarla. |
| Nadie se enteraba del cambio. | **Correo** a la compañera, **aviso en su app** al entrar, **incidencia** «Cuenta de cobro cambiada» y Telegram. |
| Se podía pagar al momento a la cuenta nueva. | **48 h de espera**: no se marca pagado (ni se pide) a una cuenta cambiada hace menos de 48 h. En efectivo, sí. La primera cuenta no espera. |

Vale igual por los tres caminos: el panel del dueño, el enlace de alta y la
consola de OxioPay.

## Publicar

1. **`nightpay-api`** primero. Al arrancar aplica la migración
   `20261119100000_cuenta_cobro_segura` (5 columnas nuevas en `users`, sin
   reescribir la tabla).
2. **El relleno se lanza solo.** Nada más arrancar (por detrás, sin retrasar
   el arranque), el API cifra las cuentas y los titulares que estaban en
   claro, y la cuenta guardada en cada pago ya hecho
   (`operator_payouts.paidToAddress`). No hay que hacer nada a mano. Tarda
   unos segundos.
   - En el registro del API sale: `Cuentas de cobro cifradas: N personas y M pagos (0 sin poder)`.
     Si no había nada que cifrar, no dice nada.
   - **Se repite en cada arranque** y lo ya cifrado no se toca. Para lanzarlo
     otra vez: reiniciar el API (o volver a pulsar Deploy).
   - Si falla, el API arranca igual y lee las dos formas (cifrada y en claro).
   - No cuenta como un cambio de cuenta: ni correo, ni aviso, ni espera.
3. **`nightpay-admin`** y **`nightpay-operator-2`**, seguidos. Hasta
   publicarlos, el panel anterior no enseña la cuenta y el alta anterior no
   deja guardar un IBAN SEPA (le falta el campo del titular).

Variables nuevas: **ninguna**. Usa `ENCRYPTION_KEK`, que ya existe.

Para comprobarlo (con la base de producción, solo lectura):

```sql
SELECT count(*) FROM users
 WHERE "payoutAddress" IS NOT NULL AND "payoutAddress" NOT LIKE 'pa1:%';   -- tiene que dar 0
```

## Ojo

- **`ENCRYPTION_KEK` no se puede perder ni cambiar.** Sin ella las cuentas
  guardadas no se pueden abrir (lo tapado sí se sigue viendo): habría que
  volver a escribirlas una a una en Editar. Guárdala en dos sitios.
- **No volver a la versión anterior del API** una vez publicada: no entiende
  las cuentas cifradas (enseñaría `pa1:…` en vez de la cuenta).
- Publica a una hora sin pagos al personal: durante el minuto en que conviven
  el API anterior y el nuevo, el panel anterior puede enseñar `pa1:…`.
- El correo a la compañera solo sale si el API tiene `RESEND_API_KEY` (como
  las invitaciones). Sin ella queda el aviso en su app y la incidencia.

## Decisiones del dueño pendientes

1. **Lo que ya está en el registro.** Las filas antiguas de `audit_events`
   (`operator.updated`, `operator.payout_account_changed` y las propuestas del
   enlace de alta) llevan cuentas en claro. La tabla solo admite añadir, así
   que **no se han tocado**. Borrarlas o taparlas exige quitar ese candado a
   mano: lo decide el dueño.
2. **El nombre legal de la compañera.** Hoy el titular se compara con el
   nombre que tiene en el panel (a menudo un apodo). Cuando exista su ficha
   con el nombre legal, el aviso se hará contra él.

## Dónde está

- Cifrado: `apps/api/src/modules/operators/payout-account-crypto.ts`.
- Guardar, tapar y la espera: `payout-account.ts`. Avisos: `payout-account-notices.ts`.
- Relleno: `payout-account-backfill.ts`.
- Pruebas: `apps/api/test/integration/cuenta-cobro-segura.int.spec.ts`.
