# Alta de la compañera con tres caminos (19-nov-2026)

Su nombre legal y su fecha de nacimiento, y cómo cobra: su IBAN, la OxioCard o
abrir una cuenta de pago básica. Va encima de la cuenta de cobro segura
([CUENTA-COBRO-SEGURA.md](CUENTA-COBRO-SEGURA.md)).

## Qué cambia

| Qué | Cómo |
|---|---|
| **Nombre legal completo** | Lo pone ella en el enlace de alta **si aún no está**, o el dueño en su ficha (Onboarding). Uno ya guardado solo lo cambia el dueño: el enlace lo ignora (queda en el registro como `identityIgnored`, sin el valor). Se guarda **cifrado** (`pa1:…`, con `ENCRYPTION_KEK`, como la cuenta). En el panel solo se ve tapado (`M••• L•••`); en el registro, tapado. |
| **Fecha de nacimiento** | Igual: el enlace no cambia una ya guardada (tampoco la de una menor). En la base, como fecha; no va al registro (pone «cambiada»). |
| **Menor de 18 años** | No activa la cuenta: aceptar la invitación, contraseña nueva u otra invitación dan 403 `MINOR_CANNOT_ACTIVATE`. Si ya entraba, deja de entrar (contraseña que no vale, sesiones cerradas, «Pendiente de activar» y «Bloqueada»). Al dueño le sale en Incidencias (y Telegram) «Menor de edad: cuenta sin activar». Si la fecha estaba mal, el dueño la corrige y le manda otra invitación. |
| **Sin fecha no activa** | Una compañera sin fecha guardada no activa su cuenta: al activar, la pantalla se la pide (409 `BIRTH_DATE_REQUIRED`) y se guarda; si es de menor, lo mismo que arriba. El resto del personal activa como siempre, y en OxioParty (`EDITION=party`, sin compañeras) también el personal de las casetas. «Resetear contraseña» (solo el dueño) no la pide: es él quien activa a mano. |
| **Su IBAN, a su nombre** | El titular se compara con su **nombre legal**. Si no coincide: aviso a ella en el alta, aviso al dueño (Incidencias) y **no se le paga a esa cuenta** (ni se pide en «Por aprobar»: 409 `PAYOUT_HOLDER_UNCONFIRMED`) hasta que el dueño pulsa «La cuenta es suya: confirmar» en Editar, con su 2FA. En efectivo, sí. Otra cuenta, otro titular u otro nombre legal lo vuelven a pedir. Sin nombre legal, como antes (aviso contra el nombre del panel). |
| **OxioCard** | Solo con `OXIOCARD_ENABLED`. «Abrir mi OxioCard» (en el alta o en «Ganancias») apunta la petición; el estado (no solicitada, solicitada, en verificación, aprobada, rechazada) lo cambia el dueño a mano en su ficha (Onboarding); el super-admin, entrando en el local. Ella lo ve en «Ganancias». **Sin documentos ni emisor.** |
| **Cuenta de pago básica** | Guía en `/cuenta-basica` (app del personal, sin sesión): qué es, quién tiene derecho (RDL 19/2017), qué llevar, 3 € al mes como mucho, 10 días hábiles y cómo reclamar. La carta del local **no está** (espera al abogado). |

Nombre legal, fecha, «la cuenta es suya» y la OxioCard son **solo del dueño**
en el panel (el encargado los ve, no los cambia).

## Publicar

1. **`nightpay-api`**. Al arrancar aplica `20261120500000_alta_tres_caminos`
   (5 columnas en `users`; la de la OxioCard con valor de fábrica, sin
   reescribir la tabla, y su CHECK). No hay relleno.
2. **`nightpay-admin`** y **`nightpay-operator-2`**, seguidos.
3. La OxioCard sale **apagada**: para encenderla, `OXIOCARD_ENABLED=true` en
   `nightpay-api` y reiniciarlo (las webs lo leen del API).

Variables nuevas: `OXIOCARD_ENABLED` (apagada si no está). Usa `ENCRYPTION_KEK`,
que ya existe.

## Ojo

- Al poner el nombre legal de quien ya cobra por IBAN, si el titular no
  coincide, **sus pagos a esa cuenta se paran** hasta confirmarla (en
  efectivo, sí). Es lo pedido; conviene avisar al dueño.
- Invitaciones pendientes al publicar: la pantalla nueva de activar pide la
  fecha a quien no la tiene; la de antes no tiene el campo y solo enseña «Pon
  tu fecha de nacimiento…». Publica `nightpay-operator-2` justo después del API.
- Volver a la versión anterior del API: las columnas nuevas se quedan (no
  molestan), pero la anterior no frena a las menores ni los titulares sin
  confirmar.

## Dónde está

- Reglas compartidas: `packages/contracts/src/alta.ts`.
- API: `apps/api/src/modules/operators/alta-identity.ts` (cifrado, menor,
  titular) y `operators.service.ts`.
- Pruebas: `apps/api/test/integration/alta-tres-caminos.int.spec.ts`.
