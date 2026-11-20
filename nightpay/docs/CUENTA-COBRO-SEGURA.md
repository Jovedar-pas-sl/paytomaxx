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

Qué cuenta como «cambiar la cuenta»:

- El método o el número de cuenta: avisos y 48 h de espera.
- En una transferencia internacional, también **el banco, el SWIFT o el país**
  aunque el número y el titular sean los mismos (con otro banco, el dinero va
  a otro sitio): avisos y 48 h de espera. En el registro quedan el banco de
  antes y el de ahora.
- Solo el titular: avisos, sin espera (el dinero va al mismo sitio).
- Solo el alias, o guardar otra vez los mismos datos: nada.

Cuando dos cosas llegan a la vez:

- Dos cambios de la misma cuenta no se pisan (panel y consola de OxioPay): el
  segundo recibe «acaba de cambiar por otro lado» y lo repite con la cuenta
  de ahora delante.
- «Marcar pagado» mira la espera en el momento de apuntar el pago (con el
  turno de esa persona ya tomado), no al empezar: si la cuenta cambia
  mientras tanto, ese cambio cuenta.

## Publicar

1. **`nightpay-api`** primero. Al arrancar aplica la migración
   `20261120310000_cuenta_cobro_segura` (5 columnas nuevas en `users`, sin
   reescribir la tabla).
2. **El relleno se lanza solo.** Nada más arrancar (por detrás, sin retrasar
   el arranque), el API cifra las cuentas y los titulares que estaban en
   claro, y la cuenta guardada en cada pago ya hecho
   (`operator_payouts.paidToAddress`). No hay que hacer nada a mano. Tarda
   unos segundos.
   - En el registro del API sale `Cuentas de cobro cifradas: N personas y M pagos (0 sin poder)`
     (si había algo que cifrar) y, siempre, cómo ha quedado:
     - `Cuentas de cobro: ninguna en claro` → bien.
     - `Cuentas de cobro EN CLARO tras el relleno: N…` (como error; también
       llega a Sentry si está puesto) → mal: mira el paso 4.
   - **Se repite en cada arranque** y lo ya cifrado no se toca. Para lanzarlo
     otra vez: reiniciar el API (o volver a pulsar Deploy).
   - Si falla, el API arranca igual y lee las dos formas (cifrada y en claro).
   - No cuenta como un cambio de cuenta: ni correo, ni aviso, ni espera.
3. **`nightpay-admin`** y **`nightpay-operator-2`**, seguidos. Hasta
   publicarlos, el panel anterior no enseña la cuenta y el alta anterior no
   deja guardar un IBAN SEPA (le falta el campo del titular).
4. **Comprobar el relleno (no te lo saltes).** Mientras se publica, el API
   anterior y el nuevo conviven cerca de un minuto, y el anterior todavía
   guarda en claro: si alguien cambia una cuenta justo entonces, se queda en
   claro hasta el siguiente arranque. Por eso:
   1. Cuando solo quede el API nuevo, **reinícialo una vez** (el relleno
      vuelve a pasar, ya sin el anterior).
   2. En su registro tiene que salir `Cuentas de cobro: ninguna en claro`.
   3. Si sale `Cuentas de cobro EN CLARO…`, lo normal es que `ENCRYPTION_KEK`
      falte o no sea la buena: corrígela y reinicia. Mientras tanto la app
      funciona (lee las dos formas), pero esas cuentas siguen sin cifrar.

   Lo mismo, con la base delante (solo lectura); las dos cifras tienen que
   dar 0:

   ```sql
   SELECT
     (SELECT count(*) FROM users
       WHERE (btrim(COALESCE("payoutAddress", '')) <> '' AND "payoutAddress" NOT LIKE 'pa1:%')
          OR (btrim(COALESCE("payoutMetadata" ->> 'accountHolder', '')) <> ''
              AND "payoutMetadata" ->> 'accountHolder' NOT LIKE 'pa1:%')) AS personas_en_claro,
     (SELECT count(*) FROM operator_payouts
       WHERE btrim(COALESCE("paidToAddress", '')) <> '' AND "paidToAddress" NOT LIKE 'pa1:%') AS pagos_en_claro;
   ```

Variables nuevas: **ninguna**. Usa `ENCRYPTION_KEK`, que ya existe.

## Ojo

- **El dueño necesita la 2FA activada antes de publicar** (Ajustes →
  Seguridad). Sin ella ya no puede ver una cuenta entera para pagar ni
  cambiarla: el panel le dice que la active.
- **`ENCRYPTION_KEK` no se puede perder ni cambiar.** Sin ella las cuentas
  guardadas no se pueden abrir (lo tapado sí se sigue viendo): habría que
  volver a escribirlas una a una en Editar. Guárdala en dos sitios.
- **No se vuelve a la versión anterior del API sin descifrar antes.** La
  anterior no entiende las cuentas cifradas: enseñaría `pa1:…` como si fuera
  la cuenta, daría error al cambiar el método de cobro y apuntaría `pa1:…` en
  los pagos. **Hoy no hay herramienta para descifrar** (habría que hacerla:
  abrir cada cuenta con `ENCRYPTION_KEK` y guardarla otra vez en claro, en
  `users` y en `operator_payouts`). Si algo falla tras publicar, se arregla
  hacia delante, con otro Deploy; si de verdad hay que volver atrás, primero
  se pide esa herramienta y se pasa.
- Publica a una hora sin pagos al personal ni cambios de cuenta: durante el
  minuto en que conviven el API anterior y el nuevo, el anterior puede enseñar
  `pa1:…`, rechazar un cambio de cuenta (400) o guardar una cuenta en claro
  (por eso el paso 4).
- El correo a la compañera solo sale si el API tiene `RESEND_API_KEY` (como
  las invitaciones). Sin ella queda el aviso en su app y la incidencia, que
  entonces no dice «por email».

## Decisiones del dueño pendientes

1. **Lo que ya está en el registro.** Las filas antiguas de `audit_events`
   (`operator.updated`, `operator.payout_account_changed` y las propuestas del
   enlace de alta) llevan cuentas en claro. La tabla solo admite añadir, así
   que **no se han tocado**. Borrarlas o taparlas exige quitar ese candado a
   mano: lo decide el dueño.
2. ~~**El nombre legal de la compañera.**~~ Hecho en el alta con tres
   caminos ([ALTA-TRES-CAMINOS.md](ALTA-TRES-CAMINOS.md)): con nombre legal, el
   titular se compara con él y, si no coincide, no se le paga a esa cuenta
   hasta que el dueño confirma que es suya. Sin nombre legal, como antes.
3. **De efectivo a una cuenta.** Quien cobraba en efectivo y pasa a tener
   cuenta también espera 48 h (cuenta como cambio: es lo más seguro, y se le
   puede seguir pagando en efectivo). Solo no espera quien nunca tuvo nada
   puesto. Si el dueño prefiere que tampoco espere, es una línea
   (`first` en `payout-account.ts`).

## Dónde está

- Cifrado: `apps/api/src/modules/operators/payout-account-crypto.ts`.
- Guardar, tapar y la espera: `payout-account.ts`. Avisos: `payout-account-notices.ts`.
- Relleno: `payout-account-backfill.ts`.
- Pruebas: `apps/api/test/integration/cuenta-cobro-segura.int.spec.ts`.
