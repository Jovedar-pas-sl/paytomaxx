# Guía para los cajeros: cargar saldo con la API de OxioPay (piloto)

**No hay devolución ni retirada en efectivo del saldo.** Ninguna llamada de esta API saca dinero de un saldo.

Esta guía es para quien programa la plataforma de cajeros. Los cajeros están dentro de los locales y **solo cargan saldo**: nunca pagan con saldo ni dan efectivo de un saldo.

- **El contrato es `openapi-piloto.yaml`** (en inglés). Si esta guía y el YAML no dicen lo mismo, manda el YAML. Los ejemplos de aquí son los mismos que los del YAML: mismos ids, importes y códigos.
- **Direcciones.** Todavía no están elegidas. Todo lo que acaba en `.example` es provisional:

| Qué | Real | Demo (pruebas) |
|---|---|---|
| API | `https://api.oxiopay.example/v1/partner` | `https://demo-api.oxiopay.example/v1/partner` |
| Enlace grabado en las fichas | `https://<host de la app>/?ficha=<código>` | `https://demo-operator.oxiopay.example/?ficha=<código>` |
| Documentación (tipos de error) | `https://docs.oxiopay.example` | |

- **Reglas de siempre.** JSON en UTF-8. Importes en **céntimos** y siempre en euros (`2000` = 20,00 €). Horas en UTC (`Z`). La «noche» del local va de 08:00 a 08:00 (hora de Madrid) y se llama por el día en que empieza (`business_date`). Ninguna respuesta lleva el id del saldo, el nombre ni el teléfono del cliente, su código de 6 letras ni el número de su ficha. Si una respuesta trae un campo o un código que no conoces, ignóralo (o trátalo por su estado HTTP, capítulo 5): la API solo crece, nunca cambia lo que ya hay. En cambio, un campo de más en lo que tú envías se rechaza (`422 validation_failed`). Toda respuesta lleva `Cache-Control: no-store`.
- **Lo que no entra en el piloto**: pagar con saldo, cobros, avisos (webhooks) y eventos, e informes. Llegarán después sin romper nada.

---

## 1. Empieza: tres llamadas en la demo

Necesitas una clave de prueba (`oxp_test_…`). En la demo la lista de IP es opcional; si OxioPay la pone, llama desde esas IP. Las tres llamadas: la conexión (`GET /me`), el saldo de una ficha de prueba (`POST /wallet/balance`) y una carga de 20,00 € en efectivo (`POST /wallet/loads`).

### Con curl

```bash
export OXP_BASE="https://demo-api.oxiopay.example/v1/partner"
export OXP_KEY="oxp_test_0123456789abcdef0123456789abcdef0123456789abcdef"   # tu clave de prueba

# 1) La conexión
curl -sS "$OXP_BASE/me" -H "Authorization: Bearer $OXP_KEY"

# 2) El saldo de la ficha de prueba «ficha_uid», leída por NFC (enlace NDEF + número del chip)
curl -sS "$OXP_BASE/wallet/balance" \
  -H "Authorization: Bearer $OXP_KEY" \
  -H "Content-Type: application/json" \
  -d '{"qr":"https://demo-operator.oxiopay.example/?ficha=demo-ficha-uid-0000001","nfc_uid":"04A1B2C3D4E5F6"}'

# 3) Cargar 20,00 € en efectivo en esa ficha
curl -sS "$OXP_BASE/wallet/loads" \
  -H "Authorization: Bearer $OXP_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: ATM0042-20261205-000731-K7QM" \
  -d '{"qr":"https://demo-operator.oxiopay.example/?ficha=demo-ficha-uid-0000001","nfc_uid":"04A1B2C3D4E5F6","amount":2000,"description":"Recarga en cajero 0042","reference":"ATM0042-20261205-000731-K7QM","funding":"cash","device":"ATM0042"}'
```

Respuesta de `GET /me` (`200`):

```json
{
  "object": "connection",
  "id": "pc_3f1c9a7e2b5d4c8e9f0a1b2c3d4e5f60",
  "partner_name": "Cajeros Demo",
  "venue_name": "Local Demo Centro",
  "issuer": { "legal_name": "Empresa Demo S.L.", "tax_id": "B00000000" },
  "collection_model": "venue_collects",
  "channel": "in_venue",
  "status": "active",
  "scopes": ["wallet:balance", "wallet:load"],
  "paused_scopes": [],
  "livemode": false,
  "key": { "hint": "oxp_test_…cdef", "expires_at": "2027-11-26T23:00:00Z", "replaced": false },
  "limits": {
    "loads": {
      "per_operation": 30000,
      "wallet_24h": 60000,
      "wallet_24h_all_partners": 99999,
      "unnamed_wallet_30d": 150000,
      "connection_night": 500000,
      "cash_wallet_24h": 99999
    }
  },
  "terms": {
    "url": "https://demo-api.oxiopay.example/legal/condiciones#saldo",
    "version": "2026-11-17",
    "summary_es": "El saldo se gasta en este local y en los de su grupo que lo aceptan. No se devuelve en dinero, ni en efectivo ni a la tarjeta.",
    "summary_en": "The balance is spent at this venue and at the venues of its group that accept it. It is not refunded in money, neither in cash nor to a card."
  }
}
```

Respuesta de `POST /wallet/balance` (`200`):

```json
{ "object": "wallet_balance", "available": 5000, "currency": "EUR", "livemode": false }
```

Respuesta de `POST /wallet/loads` (`201`):

```json
{
  "object": "wallet_load",
  "id": "wl_8b2e6f1a9c3d4e5f8a7b6c5d4e3f2a1b",
  "status": "succeeded",
  "amount": 2000,
  "currency": "EUR",
  "description": "Recarga en cajero 0042",
  "reference": "ATM0042-20261205-000731-K7QM",
  "funding": "cash",
  "device": "ATM0042",
  "created_at": "2026-12-05T22:41:07Z",
  "void_until": "2026-12-05T22:51:07Z",
  "balance_after": 7000,
  "terms": {
    "url": "https://demo-api.oxiopay.example/legal/condiciones#saldo",
    "version": "2026-11-17",
    "summary_es": "El saldo se gasta en este local y en los de su grupo que lo aceptan. No se devuelve en dinero, ni en efectivo ni a la tarjeta.",
    "summary_en": "The balance is spent at this venue and at the venues of its group that accept it. It is not refunded in money, neither in cash nor to a card."
  },
  "livemode": false
}
```

Si repites la tercera llamada igual (misma `Idempotency-Key`, mismo cuerpo) recibes la misma respuesta con la cabecera `Idempotent-Replayed: true`: no se carga dos veces. Para otra carga, usa otro id de transacción. Si la ficha de prueba ya tenía otras cargas verás otro saldo: `POST /test/fixtures/reset` la deja como al principio (capítulo 7).

### Con Node (18 o superior)

```js
// oxp.mjs — la llamada a OxioPay. OXP_BASE y OXP_KEY como en curl.
const BASE = process.env.OXP_BASE;
const KEY = process.env.OXP_KEY;

export async function oxp(method, path, { body, idempotencyKey } = {}) {
  const headers = { Authorization: `Bearer ${KEY}` };
  if (body) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000), // sin respuesta en 10 s: lanza un error
  });
  let data = null;
  try { data = await res.json(); } catch { /* 204, o un 5xx sin JSON */ }
  return {
    status: res.status,
    data,
    requestId: res.headers.get('request-id'),
    replayed: res.headers.get('idempotent-replayed') === 'true',
    retryAfter: Number(res.headers.get('retry-after')) || 0,
  };
}
```

```js
// tres-llamadas.mjs — node tres-llamadas.mjs
import { oxp } from './oxp.mjs';

const ficha = { qr: 'https://demo-operator.oxiopay.example/?ficha=demo-ficha-uid-0000001', nfc_uid: '04A1B2C3D4E5F6' };

const me = await oxp('GET', '/me');
console.log(me.status, me.data.venue_name, me.requestId);

const saldo = await oxp('POST', '/wallet/balance', { body: ficha });
console.log(saldo.status, saldo.requestId); // nunca el saldo en el log

const carga = await oxp('POST', '/wallet/loads', {
  idempotencyKey: 'ATM0042-20261205-000731-K7QM',
  body: { ...ficha, amount: 2000, description: 'Recarga en cajero 0042', reference: 'ATM0042-20261205-000731-K7QM', funding: 'cash', device: 'ATM0042' },
});
console.log(carga.status, carga.data.id, carga.requestId);
```

---

## 2. Claves y seguridad

**Dónde vive la clave.** En los servidores de la plataforma de cajeros, en su gestor de secretos o en una variable de entorno. **Nunca dentro de cada cajero**: los cajeros hablan con vuestros servidores y son vuestros servidores los que llaman a OxioPay. Una clave sirve para **un local** (una conexión = la plataforma de cajeros × un local): si los cajeros están en dos locales, hay dos claves, y cada cajero usa la de su local.

**Qué puede hacer.** La clave de los cajeros tiene solo `wallet:balance` (ver el saldo) y `wallet:load` (cargar, anular su propia carga, listar sus cargas y su resumen). No puede pagar con saldo, ni cobrar, ni leer ventas. Solo llega a saldos del grupo de su local (la misma comprobación que hace el personal del local) cuyo local de origen, donde se creó el saldo, es de la misma sociedad (mismo CIF) que su local; un local de origen sin sociedad cuenta como otra. Cualquier otro saldo responde `404 wallet_not_found`, igual que uno que no existe.

**Cómo se envía.** Solo en la cabecera `Authorization: Bearer oxp_live_…` (real) o `Bearer oxp_test_…` (demo).
- Nunca en la URL (`400 api_key_in_url`, y al dueño le llega aviso para rotarla) ni en el cuerpo (`400 api_key_in_body`).
- Sin cabecera `Origin`: la API es de servidor a servidor y una petición con `Origin` recibe `403 browser_not_allowed`.
- Cuerpo de 16 KB como mucho (`413 body_too_large`). Un POST sin cuerpo (una anulación sin motivo) va sin `Content-Type`.
- La real no acepta claves de prueba ni la demo claves reales (`401 wrong_environment`).

**Transporte.** Solo `https://`, TLS 1.2 o superior, con la comprobación del certificado encendida. Nunca `http://` (una clave que ha ido por http hay que rotarla) y nunca a través de un proxy que abra el TLS o registre la cabecera `Authorization` o los cuerpos; las IP fijas de salida suelen venir de un proxy así, así que revisadlo. El enlace entre cada cajero y vuestros servidores lleva los mismos secretos (enlace de la ficha, UID del chip, código del móvil): cifradlo también, y apagad cualquier registro del texto leído o de los UID en el cajero, en los SDK de sus lectores NFC y QR y en sus informes de fallos.

**IP fijas, obligatorias en real.** En real, una clave con `wallet:load` solo funciona desde las IP de vuestros servidores que el dueño registró (en la demo es opcional): hasta 10, cada una una sola dirección (IPv4, o un bloque IPv6 /64 si vuestro proveedor os da ese /64 entero solo a vosotros; si no, la dirección suelta), dentro de las que OxioPay tiene declaradas para vuestra empresa. La dirección que se compara es la pública con la que vuestra petición llega al borde de OxioPay: después de vuestro NAT, proxy de salida o pasarela de la nube, no la privada del servidor. Desde otra IP: `403 ip_not_allowed`, el dueño recibe aviso por cada dirección nueva, y con 3 direcciones ajenas en 24 horas se paran las cargas nuevas en todos los cajeros del local (4.6). Así que nunca probéis la clave real desde un portátil, la CI o un servidor de pruebas. Si uno de vuestros servidores recibe `ip_not_allowed`, preguntad al dueño: su panel enseña la dirección rechazada. Da también vuestras IPv6 si vuestros servidores salen por IPv6, o fuerza IPv4 en el cliente: si no, la llamada puede salir por una dirección que no está en la lista.

**Rotación.** La hace el dueño, con su 2FA. La clave nueva se ve una sola vez: OxioPay manda un **enlace de un solo uso** (24 horas) al correo de contacto que vuestra empresa tiene registrado, o el dueño os la da en mano. Abrid el enlace solo cuando vayáis a guardar la clave, en la máquina que la guarda; nunca le hagáis captura ni la peguéis en un chat o un correo. Si el enlace dice que ya no vale y nadie de vuestro equipo lo abrió, avisad al dueño en seguida: otro ha visto la clave y hay que rotarla sin solape. La vieja sigue funcionando durante el solape que elija el dueño (nada si hubo una fuga, 24 horas por defecto, o 7 días); mientras tanto `GET /me` con la clave vieja enseña `key.replaced: true` y `key.expires_at` al final del solape: avisad a vuestros operadores en cuanto lo veáis. Después responde `401 api_key_rotated` durante 30 días, para que veáis por qué falla. Una rotación mantiene la conexión: el mismo id `pc_`, vuestras cargas y vuestros ids de transacción.

**Revocación.** El dueño o el encargado, de un toque. Vale desde la siguiente petición: `401 api_key_revoked`. Si alguna vez sospecháis que la clave se ha filtrado, avisad al dueño para que la rote sin solape.

**Caducidad y reposo.** Una clave con `wallet:load` caduca como mucho a los 365 días (`key.expires_at` en `GET /me`; después `401 api_key_expired`): avisad a vuestros operadores 30 días antes y pedid al dueño una rotación con 7 días de solape. Una clave que no hace ninguna llamada de saldo (saldo, cargas, anulaciones, `/wallet/operations`, `/statement`) en 90 días se suspende (`401 api_key_suspended`) y el dueño la reactiva; `GET /me` solo no la mantiene viva.

**Lo que nunca se registra ni se guarda:**
- **La clave**: ni en logs, ni en el código, ni en el repositorio, ni en los cajeros, ni en URLs.
- **El texto crudo del QR** (el código del móvil o el enlace de la ficha).
- **El número del chip (UID)** más allá de la transacción.
- **Los códigos en vivo** (`OXC1:…`).
- **Los saldos de los clientes** (`available`, `balance_after`): solo en la pantalla y en el tique.
- Y en `description` y en `reference` nada personal: ni teléfonos, ni correos, ni números largos.

Sí se registra, en cada llamada: la cabecera `Request-Id` de la respuesta, el id de la carga (`wl_…`), vuestra `reference`, el importe y el código de error. De un error, registrad `code`, `status`, `request_id`, `param` y `limit`, nunca el cuerpo entero. Si mandáis `X-Request-Id` (letras, cifras y `-`, hasta 64), OxioPay os lo devuelve como `Request-Id`.

---

## 3. Identificar al cliente

El cajero lee **una de estas dos cosas** y la manda tal cual en `qr`. Nunca manda un código tecleado, un teléfono, un id interno ni un PIN. Manda solo textos que empiecen por `OXC1:`, `NPF:` o `https://`, o que sean exactamente 6 letras o cifras; lo demás (tarjetas de contacto, códigos de wifi, QR de otros pagos, texto suelto) no es de OxioPay: enseña el texto «No reconocemos este código» sin llamar.

**1. El código del móvil (código en vivo).** El cliente abre su página del saldo en el móvil y pulsa «Pagar o recargar en otro sistema». El botón sale en el idioma de la página del cliente: en inglés, "Pay or top up in another system". Sale un QR con un texto `OXC1:` + 26 caracteres, por ejemplo `OXC1:K3J7Q2M9X4T8R6V1N5B0C2D7F9`.
- En el piloto este código **solo identifica**: sirve para ver el saldo y cargar. Ver el saldo o cargar no lo gastan.
- Cada código vale **60 segundos**. La página lo renueva cada 45 segundos durante 5 minutos desde que el cliente pulsó el botón; después tiene que volver a pulsarlo.
- El lector debe leer QR en la pantalla de un móvil (QR en modo alfanumérico, en mayúsculas). Pon el lector en modo serie (COM virtual / USB-CDC, o su SDK), no como teclado, y quítale el prefijo o sufijo que añada: como teclado, `:` y `/` pueden salir como otros caracteres, y el texto pasa por la entrada de teclado del sistema operativo.

**2. La ficha por NFC.** La ficha lleva grabado un enlace `https://<host>/?ficha=<código>` en un registro NDEF de tipo URI.
- Manda en `qr` el enlace completo, con el prefijo del registro ya expandido (`https://…`), tal como lo abriría un móvil.
- Manda en `nfc_uid` el número de serie del chip (UID) en hexadecimal, en el orden en que lo envía el chip: el que dan Android (`Tag.getId()`) y PC/SC `GET DATA` (`FF CA 00 00 00`), y el que guarda OxioPay. Las fichas NTAG213/215/216 de los locales tienen 7 bytes que empiezan por `04` (`04A1B2C3D4E5F6`). Con o sin `:`, `-` o espacios entre bytes. **Nunca al revés ni en decimal**: algunos lectores lo dan así, y entonces cada ficha buena con número guardado responde `409 ficha_copy_suspected` y el dueño recibe aviso. Mándalo siempre que leas la ficha por NFC, y solo entonces: con un código del móvil es un error (`422 validation_failed`).
- Si OxioPay tiene guardado otro número para esa ficha, es una copia: `409 ficha_copy_suspected` (y el dueño recibe aviso). Una ficha sin número guardado, o un enlace de ficha mandado sin `nfc_uid`, se acepta como un enlace normal (entonces no se puede detectar una copia). OxioPay nunca guarda el número que mandas.
- Una ficha impresa como QR (el mismo enlace) también vale, como enlace normal.

**Antes de pedir el dinero**, identifica con `POST /wallet/balance`: los rechazos del saldo y de la ficha llegan antes de que el cliente meta billetes. Los del local (sus interruptores, pausas y tope de la noche) y los topes de cada saldo solo llegan con la carga; entonces el depósito devuelve los billetes (4.2).

**Lo que se rechaza y qué decirle al cliente.** OxioPay rechaza todo lo que no sea uno de esos dos. Con `422 wallet_ref_not_accepted` el campo `reason` dice qué enseñó el cliente. El rechazo depende solo de la forma del texto: la respuesta es la misma tanto si el enlace vale como si es desconocido o de otra sociedad.

| Lo que enseñó | Respuesta | Texto al cliente (ES) | Texto al cliente (EN) |
|---|---|---|---|
| La tarjeta de Google Wallet (`https://<host>/c/…`) | `422 wallet_ref_not_accepted`, `reason: wallet_pass` | La tarjeta de Google Wallet no sirve en el cajero. Abre tu página del saldo y pulsa «Pagar o recargar en otro sistema», o acerca tu ficha. | The Google Wallet card does not work at this machine. Open your balance page and tap "Pay or top up in another system", or tap your NFC tag. |
| El enlace privado de su saldo (`…/w/<código>` o una de sus páginas) | `reason: private_link` (el dueño recibe aviso) | Ese es el enlace privado de tu saldo: no lo enseñes a nadie. Abre tu página y pulsa «Pagar o recargar en otro sistema». | That is the private link to your balance: never show it to anyone. Open your page and tap "Pay or top up in another system". |
| El QR de recepción (`NPF:…`) | `reason: reception_qr` | Ese QR es para recoger tu ficha en recepción. Acerca tu ficha o enseña el código de «Pagar o recargar en otro sistema». | That QR is for collecting your NFC tag at reception. Tap your NFC tag or show the code from "Pay or top up in another system". |
| El código de 6 letras (o un enlace con `?saldo=`) | `reason: short_code` | El código de 6 letras no sirve en el cajero. Acerca tu ficha o enseña el código de tu página del saldo. | The 6-character code does not work at this machine. Tap your NFC tag or show the code on your balance page. |
| El enlace de un cobro (`/s/…`, `/pay/…`) | `reason: charge_link` | Eso es un cobro, no tu saldo. Enseña el código de «Pagar o recargar en otro sistema». | That is a payment request, not your balance. Show the code from "Pay or top up in another system". |
| Un enlace de activación, de reserva o de regalo, u otro enlace `/w/` (`/w/a/…`, `/w/card/…`, `/w/salida/…`, `/w/no/…`) | `reason: other_link` | Ese enlace no es tu saldo. Abre tu página del saldo y pulsa «Pagar o recargar en otro sistema». | That link is not your balance. Open your balance page and tap "Pay or top up in another system". |
| Cualquier otra cosa | `422 wallet_ref_unrecognized` | No reconocemos este código. Acerca tu ficha o enseña el código de tu página del saldo. | We do not recognise this code. Tap your NFC tag or show the code on your balance page. |
| Un código del móvil caducado o desconocido | `422 live_code_invalid` | El código ha caducado. Vuelve a enseñarlo. | The code has expired. Please show it again. |

Y los rechazos del saldo o de la ficha (con el mismo texto en el capítulo 5):

| Respuesta | Qué pasa | Texto al cliente (ES) | Texto al cliente (EN) |
|---|---|---|---|
| `404 wallet_not_found` | No existe, o es de otro grupo, o de un local de otra sociedad | Este saldo no se puede cargar en este cajero. | This balance cannot be topped up at this machine. |
| `409 wallet_blocked` | Saldo bloqueado | Este saldo está bloqueado. Habla con el personal. | This balance is blocked. Please speak to the staff. |
| `409 wallet_closed` | Saldo cerrado | Este saldo está cerrado. Habla con el personal. | This balance is closed. Please speak to the staff. |
| `409 ficha_lost` | Ficha dada como perdida | Esta ficha está dada de baja. Si es tuya, ve a recepción. | This NFC tag has been reported lost. If it is yours, please go to reception. |
| `409 ficha_blocked` | Ficha bloqueada | Esta ficha está bloqueada. Ve a recepción. | This NFC tag is blocked. Please go to reception. |
| `409 ficha_copy_suspected` | El número del chip no es el de la ficha | Esta ficha no se puede usar aquí. Ve a recepción. | This NFC tag cannot be used here. Please go to reception. |

Un saldo vacío no es un error: `available: 0`, y una carga lo vuelve a abrir.

---

## 4. Cargar saldo en un cajero

### 4.1 Antes de atender a nadie

- Llama a `GET /me` al arrancar y cada hora. Guarda en memoria: `issuer` y `venue_name` (para el tique), `limits.loads`, `terms`, `paused_scopes` y `key`. Si una respuesta de carga trae otra `terms.version`, vuelve a leer `GET /me` antes del siguiente cliente.
- Si `GET /me` responde `401`, `403` o `404`, el cajero no carga: «Cajero fuera de servicio. Recarga en recepción.» Si no se puede leer (sin respuesta, `429`, `5xx`), sigue con la última copia buena hasta 2 horas; sin copia, el cajero queda fuera de servicio.
- En real, si `GET /me` responde `livemode: false`, el cajero no carga («Cajero fuera de servicio»): está apuntando a la demo.
- Cada transacción del cajero tiene un **id propio, único para siempre** en ese local, creado en el cajero al abrir el depósito, por ejemplo `ATM0042-20261205-000731-K7QM` (cajero, fecha, contador y 4 caracteres al azar, para que nadie pueda adivinar el siguiente). Sirve a la vez de `Idempotency-Key` y de `reference`, así que tiene que valer para los dos: de 8 a 64 caracteres de `A-Z a-z 0-9 _ -`. Vuestros servidores aceptan cada id una sola vez, así que un doble toque o un reintento del cajero a vuestros servidores lleva el mismo id. Si el contador se reinicia (por ejemplo, al reinstalar), el id tiene que seguir sin repetirse (en 4.2 está cómo se detecta un id repetido).

### 4.2 El flujo, paso a paso (efectivo con depósito)

1. **Identificar.** Lee el código del móvil o la ficha y llama a `POST /wallet/balance` con `{qr}` o `{qr, nfc_uid}`. Con `200`: si enseñó el código del móvil, enseña el saldo (`available`); si fue una ficha (NFC o QR impreso), enseña «Ficha reconocida» sin el importe, porque cualquiera puede acercar una ficha que se ha encontrado; el tique lleva el saldo después de la carga. Con un error, enseña el texto del capítulo 5 y termina: todavía no has cogido dinero. Con `429` y un `Retry-After` de más de 15 segundos (por ejemplo, una ficha que ya gastó sus consultas de la noche), no esperes: sigue sin enseñar el saldo, porque la carga identifica el saldo por sí misma.
2. **Condiciones.** Enseña en pantalla `terms.summary_es` (o `summary_en`, según el idioma del cliente) de `GET /me`, la sociedad que emite el saldo (`issuer.legal_name`) y el máximo por recarga (`limits.loads.per_operation`). El cliente acepta con un botón. Sin aceptar, no se sigue.
3. **Coger el dinero en depósito.** El cajero recibe los billetes en el depósito (escrow), sin pasarlos todavía a la caja, y los cuenta. Si el total pasa de `limits.loads.per_operation`, devuelve los billetes y pide menos **antes** de llamar a OxioPay (esos rechazos cuentan para la pausa automática, 4.6).
4. **Cargar.** Apunta la transacción en un almacenamiento que no se borre (4.3) y llama a `POST /wallet/loads` con `Idempotency-Key` = id de la transacción y el cuerpo `{qr, nfc_uid?, amount, description, reference, funding: "cash", device}`, con `reference` = el mismo id y `device` = el cajero. Espera la respuesta hasta 10 segundos.
5. **Según la respuesta:**
   - **`201` sin `Idempotent-Replayed`** → pasa los billetes del depósito a la caja e imprime el tique (4.7).
   - **`201` con `Idempotent-Replayed: true`, o `422 idempotency_key_reused`** → ese id ya tiene una carga (el cuerpo del `201`, o `operation`). Es la de esta transacción solo si está `succeeded`, su `amount` es este importe y su `created_at` no es anterior a 1 minuto antes de empezar esta transacción: entonces paso a caja y tique (con `idempotency_key_reused`, léela antes con `GET /wallet/loads/{id}` para el tique). Si no, otra transacción anterior usó ese id: devuelve los billetes, deja el cajero fuera de servicio y arregla la numeración. Nunca decidas por `reference`: es el mismo texto que la clave.
   - **`422 live_code_invalid`** → el código del móvil caducó mientras el cliente metía billetes. No devuelvas nada todavía: pide «Vuelve a enseñar el código», llama a `POST /wallet/balance` con el código nuevo, enseña el saldo y sigue solo si el cliente confirma que es el suyo; después repite el paso 4 con el código nuevo y **el mismo id de transacción**. Si en 60 segundos no enseña un código nuevo: devuelve los billetes si todos los intentos de esta transacción tuvieron respuesta; si no, concilia antes (4.3).
   - **Un rechazo definitivo** (`400`, `401`, `402`, `403`, `404`, `409`, `413`, `422`, `423`, salvo los casos de arriba y la excepción de abajo) → devuelve los billetes del depósito y enseña el texto del capítulo 5.
   - **Excepción:** si un intento de esta transacción se quedó sin respuesta (tiempo agotado, error de red, o un `5xx` que no es `503 try_later`), un `401`, `403` o `404 not_found` posterior no dice si ese intento cargó: deja los billetes en el depósito y concilia (4.3).
   - **Sin respuesta, tiempo agotado, `429`, `503` u otro `5xx`** → no sabes si se cargó. **No devuelvas el dinero.** Reintenta (4.3).

**Rechazos que afectan a todo el local.** Tras `403 scope_paused`, deja de ofrecer recargas en los cajeros del local hasta que `GET /me` ya no tenga `wallet:load` en `paused_scopes`. Tras `409 method_disabled`, `423 venue_paused` o `403 partner_api_frozen`, deja de ofrecerlas 10 minutos. Tras `402 limit_exceeded` con `limit: connection_night`, deja de ofrecerlas hasta las 08:00 si `remaining` es menor que tu billete más pequeño.

### 4.3 Reintentos y resultado desconocido

- Reintenta **con la misma `Idempotency-Key` y el mismo cuerpo**, como mucho 4 veces, esperando 1, 2, 4 y 8 segundos, o lo que diga `Retry-After` (en segundos) si es más. Dale a la carga entera 60 segundos como mucho. Nunca generes una clave nueva para la misma transacción.
- OxioPay atiende una sola petición por `Idempotency-Key` a la vez: un reintento que llega mientras un intento anterior sigue en marcha lo espera y recibe su respuesta. Así que el reintento resuelve el resultado: si la carga ya se había hecho, recibes la respuesta original (`201` con `Idempotent-Replayed: true`; compruébala como en 4.2); si no se había hecho, se hace ahora. Si el código del móvil ya caducó y la carga no se hizo, recibes `422 live_code_invalid`: no se cargó nada (4.2).
- Si `Retry-After` pasa de 15 segundos, no hagas esperar al cliente: si todos los intentos tuvieron respuesta, devuelve los billetes (`429` y `503 try_later` se contestan antes de hacer nada); si no, concilia.
- **Concilia por referencia** cuando los billetes tienen que salir del depósito sin resultado (se acabaron los 60 segundos, o el cliente se va). OxioPay nunca guarda una carga más de 30 segundos después de recibirla, así que espera 60 segundos tras tu último intento y lee:

  `GET /wallet/operations?from=<inicio de la transacción − 1 min>&to=<ahora + 2 min>&reference=<id de la transacción>`

  - Aparece con `status: "succeeded"`, tu importe y un `created_at` no anterior al inicio de la transacción menos 1 minuto → paso a caja y tique.
  - No aparece (y OxioPay ha contestado `200`) → la carga no se hizo: devuelve los billetes. Vuelve a leerla 2 minutos después; si aparece al final, anúlala en seguida (4.8) con el motivo «Billetes devueltos al cliente» y avisa a OxioPay.
  - OxioPay no contesta, o contesta `401`, `403` o `404` → no devuelvas el dinero. Pasa los billetes a la caja, imprime un tique «Recarga pendiente de confirmar» con el id de la transacción y el importe, **sin saldo**, y anota una incidencia para el local. Sigue conciliando esa referencia cada 5 minutos. Si la carga existe, el tique ya no vale: el cliente ya tiene su saldo. Si OxioPay contesta `200` sin ella, el local resuelve el tique una vez, dándole al cliente ese saldo, y vuestra plataforma marca la transacción como resuelta para que el mismo tique no se resuelva dos veces.
- **Reinicios y depósitos que devuelven solos.** Antes de llamar a `POST /wallet/loads`, apunta en un almacenamiento de vuestros servidores que no se borre el id de la transacción, el cajero, el importe, la hora de inicio y el estado `enviada`; nunca el texto del QR ni el UID. Tras cualquier reinicio de vuestros servidores o del cajero, resuelve cada transacción que siga `enviada`: mira dónde están sus billetes y, 60 segundos después del reinicio, busca la carga por referencia como arriba. Billetes todavía en el depósito → paso a caja y tique si la carga existe; devuélvelos si no existe. Billetes en la caja y sin carga → una incidencia para el local (y el tique pendiente si el cliente sigue ahí). Billetes devueltos y la carga existe → anúlala antes de `void_until` (4.8), o anota una incidencia para el local si ya pasó. Lo mismo cuando el depósito devuelve los billetes él solo.
- Mientras la transacción esté abierta puedes tener en memoria el texto del QR y el UID para reintentar; al cerrarla, bórralos.

### 4.4 Tarjeta en el piloto

En el piloto el cajero **solo carga efectivo** (`funding: "cash"`). `funding: "card"` está en el contrato pero hoy responde `422 funding_not_allowed`. OxioPay lo activará para la conexión cuando se confirme que el lector del cajero cobra **para el local**, igual que sus datáfonos; un lector que cobra con el contrato de la propia empresa de los cajeros es otro modelo y no entra en el piloto. Entonces el flujo será el mismo con la tarjeta: autorizar el pago en el lector, llamar a `POST /wallet/loads` con `funding: "card"`, y anular la autorización si la carga se rechaza. `transfer` y `bank_app` responden siempre `422 funding_not_allowed` en esta conexión.

### 4.5 El texto de `description`

Lo ve el cliente en sus movimientos como «Carga · Cajeros Demo: Recarga en cajero 0042» (en una página en inglés, "Top-up · Cajeros Demo: Recarga en cajero 0042"), y el dueño en su panel. Reglas: de 1 a 60 caracteres, sin `<` ni `>`, sin enlaces ni dominios, sin caracteres de control. **Sin 9 cifras o más seguidas** (aunque vayan separadas por espacios, puntos, guiones, `·` o `/`): se rechaza como dato personal (`422 description_personal_data`). Así que nada de números de serie largos ni fechas con hora; usa algo como `Recarga en cajero 0042`. Nunca nada que hable de un servicio personal. Lo mismo vale para `reference` y `device`: solo vuestro id de transacción y el nombre de vuestro cajero, nunca datos personales (un número de tarjeta en `reference` se rechaza con `422 validation_failed`).

### 4.6 Topes

Todos se cuentan en céntimos, cargas menos anulaciones, y sobre el saldo junto con los saldos sumados a él. `GET /me` → `limits.loads` da los valores de tu conexión. Las cargas a un mismo saldo se comprueban de una en una, así que dos cargas a la vez (dos cajeros, o un cajero y recepción) nunca pueden pasarse de un tope entre las dos.

| Tope | Valor | Si se pasa | `remaining` |
|---|---|---|---|
| Por recarga | 300 € (el dueño puede subirlo hasta 999,99 €) | `402 limit_exceeded`, `limit: per_operation` | sí |
| Por saldo, esta conexión, últimas 24 horas | 600 € (el dueño, hasta 999,99 €) | `limit: wallet_24h` | sí |
| Por saldo, todos los socios, últimas 24 horas | 999,99 €, fijo | `limit: wallet_24h_all_partners` | no |
| Por saldo **sin teléfono**, este socio (todos sus locales), últimos 30 días | 1.500 €, fijo | `limit: unnamed_wallet_30d` | sí |
| Por noche del local, esta conexión (todos los cajeros del local) | 5.000 € (el dueño, hasta 50.000 €) | `limit: connection_night` | sí |
| **Efectivo** en un saldo en 24 horas, **sumando recepción y todos los socios** | nunca 1.000 € o más (máximo 999,99 €), fijo por ley | `402 cash_limit_reached` | no |

- `remaining` es lo que ese tope todavía deja cargar ahora, en céntimos. Cuando no viene, no lo calcules ni lo adivines.
- Si saltan varios a la vez, la respuesta nombra uno, en este orden: `per_operation`, `wallet_24h`, `wallet_24h_all_partners`, `unnamed_wallet_30d`, `connection_night`; el de efectivo se mira el último.
- «Sin teléfono» quiere decir que el local no ha apuntado el teléfono del cliente en su saldo. Por encima de 1.500 € en 30 días, el cliente pide al encargado que se lo apunte (recepción solo puede en los 15 minutos después de darle una ficha nueva).
- El tope de la noche es también lo máximo que podría cargar en una noche en el local una clave filtrada; OxioPay avisa al dueño cuando las cargas de la noche llegan a la mitad, y otra vez cuando llegan al tope.
- **Topes de llamadas** (`429 rate_limited`, con `Retry-After` en segundos). `429` y `503 try_later` se contestan antes de hacer nada.

| Qué | Tope |
|---|---|
| Todas las llamadas de la conexión | 600 por minuto |
| Cargas y anulaciones de la conexión | 120 por minuto |
| Consultas del saldo de un saldo | 12 por minuto; por noche del local, 120 con código del móvil y 20 con ficha (solo cuentan las que respondieron `200`) |
| Cargas a un saldo | 6 por minuto |
| Textos en `qr` que no son ni un código del móvil ni un enlace de ficha | 30 por minuto; lleno, solo se rechazan esos textos |
| Autenticación fallida | por clave: 20 fallos en 10 minutos, y esa clave recibe `401 invalid_api_key` 15 minutos; por IP: 20 claves malas distintas en 10 minutos, y `429` durante 15 minutos, nunca para una clave buena cuya lista de IP tenga esa dirección |

- **Pausa automática** de las cargas nuevas en toda la conexión (todos los cajeros del local) hasta que el dueño la reanude con su 2FA: 3 rechazos por `per_operation` en 10 minutos (la misma petición rechazada, repetida, cuenta una vez), más de 30 cargas nuevas en un minuto, 3 anulaciones vuestras (por la API) en una noche (las que hace el local desde su panel no cuentan), o llamadas con la clave desde 3 direcciones no registradas en 24 horas. Los topes de cada saldo, el de la noche y la regla del efectivo no cuentan. Mientras tanto las cargas responden `403 scope_paused` y `GET /me` lo muestra en `paused_scopes`; leer tus cargas, anular y conciliar siguen funcionando. Por eso: comprueba el máximo por recarga antes de llamar.

### 4.7 El tique

Imprime, con los datos de `GET /me` y de la respuesta `201`:

- la sociedad que emite el saldo y su NIF (`issuer.legal_name`, `issuer.tax_id`) y la frase «OxioPay es su proveedor técnico»;
- el local (`venue_name`);
- el importe (`amount`) y la forma de pago (efectivo);
- el saldo después (`balance_after`), que viene porque la clave tiene `wallet:balance`;
- la fecha y la hora en hora de Madrid (de `created_at`);
- el id de la carga (`id`) y el de tu transacción (`reference`);
- la línea de condiciones con los `terms` de la respuesta `201`: `summary_es` (o `summary_en`), con `url` y `version`.

Ejemplo con la carga del capítulo 1 (`created_at` 22:41 UTC = 23:41 en Madrid):

```text
Empresa Demo S.L. · NIF B00000000
Saldo emitido por Empresa Demo S.L.; OxioPay es su proveedor técnico.
Local Demo Centro
Recarga de saldo en efectivo          20,00 €
Saldo después                         70,00 €
05/12/2026 23:41
Carga: wl_8b2e6f1a9c3d4e5f8a7b6c5d4e3f2a1b
Operación: ATM0042-20261205-000731-K7QM
El saldo se gasta en este local y en los de su grupo que lo aceptan.
No se devuelve en dinero, ni en efectivo ni a la tarjeta.
Condiciones (2026-11-17): https://demo-api.oxiopay.example/legal/condiciones#saldo
```

Las etiquetas y la frase «Saldo emitido por {issuer.legal_name}; OxioPay es su proveedor técnico.» / "Balance issued by {issuer.legal_name}; OxioPay is its technical provider." son textos fijos que guardáis vosotros. El resumen de las condiciones, su dirección y su versión vienen siempre de OxioPay, nunca de una copia guardada en el cajero: OxioPay puede cambiarlos. Imprime el tique en el idioma del cliente, con `summary_es` o `summary_en`.

### 4.8 Anular una carga (10 minutos)

`POST /wallet/loads/{id}/void`, con un motivo opcional para el local (`{"reason": "Billetes devueltos al cliente"}`, hasta 140 caracteres, con las mismas reglas que `description`; el cliente no lo ve). Sin motivo, no mandes cuerpo ni `Content-Type`.

- **Cuándo**: solo cuando el dinero de esa carga **no se quedó** en el local. Por ejemplo: la carga dio `201` pero la caja no pudo coger los billetes. Anula **antes** de devolver los billetes siempre que el cajero aún los tenga, y devuélvelos solo cuando la anulación conteste `200`. Si el depósito ya los devolvió solo, anula en ese momento. Si la anulación no contesta `200`, quédate los billetes si aún los tienes (el cliente tiene el saldo) y anota una incidencia para el local. Si los billetes se quedaron atascados dentro del cajero, el dinero está en el local: no anules.
- **Nunca** para «devolver» saldo a un cliente que cambia de idea: el saldo no se devuelve.
- Solo cargas de esta conexión (`404 load_not_found` si no), hasta `void_until` (10 minutos después de `created_at`) y si el saldo todavía cubre la carga; un saldo o una ficha bloqueados, o un local en pausa, no lo impiden. Si no: `409 void_window_passed` o `409 balance_already_spent` (con `available`, el saldo de ahora). En esos casos, y con `403 partner_api_frozen`, no devuelvas nada desde el cajero: anota una incidencia para el local, que lo corrige desde su panel. Una anulación hecha por el local también sale en la carga (`voided`, `voided_at`) y en el resumen.
- Repetir la anulación devuelve la misma carga anulada (`200`), en cualquier momento. Una pausa automática de las cargas no impide anular.
- El cliente recibe el aviso «Carga anulada · Cajeros Demo» (en una página en inglés, "Top-up cancelled · Cajeros Demo"), y el dueño ve cada anulación al momento. Tres anulaciones vuestras (por la API) en una noche paran las cargas nuevas (4.6).

Respuesta (`200`):

```json
{
  "object": "wallet_load",
  "id": "wl_2a4c6e8f0b1d3f5a7c9e1b3d5f7a9c0e",
  "status": "voided",
  "amount": 5000,
  "currency": "EUR",
  "description": "Recarga en cajero 0042",
  "reference": "ATM0042-20261205-000733-P2XD",
  "funding": "cash",
  "device": "ATM0042",
  "created_at": "2026-12-05T23:02:15Z",
  "void_until": "2026-12-05T23:12:15Z",
  "balance_after": 10000,
  "terms": {
    "url": "https://demo-api.oxiopay.example/legal/condiciones#saldo",
    "version": "2026-11-17",
    "summary_es": "El saldo se gasta en este local y en los de su grupo que lo aceptan. No se devuelve en dinero, ni en efectivo ni a la tarjeta.",
    "summary_en": "The balance is spent at this venue and at the venues of its group that accept it. It is not refunded in money, neither in cash nor to a card."
  },
  "voided_at": "2026-12-05T23:04:50Z",
  "livemode": false
}
```

`balance_after` es el saldo justo después de hacerse la carga, tal como se guardó entonces: la anulación y las lecturas posteriores lo repiten. No es el saldo de ahora.

### 4.9 Ejemplo en Node: cargar con reintentos

`cargar()` devuelve una de cuatro acciones: `cobrar` (pasar los billetes a la caja e imprimir el tique), `devolver` (devolver los billetes), `releer` (pedir otra vez el código del móvil, comprobar el saldo con el cliente y volver a llamar con el mismo `tx`) o `pendiente` (no devolver nada todavía y conciliar por referencia, 4.3). `buscarPorReferencia()` hace esa conciliación.

```js
// cargar.mjs — usa oxp() del capítulo 1.
import { oxp } from './oxp.mjs';

const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));
const reintentable = (r) => r.status === 0 || r.status === 429 || r.status >= 500; // 0 = sin respuesta
// Sin respuesta: error de red, tiempo agotado o un 5xx que no es el 503 try_later de OxioPay.
const sinContestar = (r) => r.status === 0 || (r.status >= 500 && r.data?.code !== 'try_later');
// ¿Es la carga de esta transacción? Nunca por `reference`: es el mismo texto que la clave.
const esDeEstaTx = (c, tx) =>
  c.status === 'succeeded' && c.amount === tx.amount && Date.parse(c.created_at) >= tx.inicio.getTime() - 60_000;

/**
 * tx = { id, amount, qr, nfcUid?, inicio, sinRespuesta }: id = id de la transacción (único para siempre);
 * inicio = Date en que se abrió el depósito; sinRespuesta = false al empezar (cargar() la pone a true
 * si un intento se queda sin respuesta). Usa el mismo tx toda la transacción, también tras 'releer'.
 * Devuelve la acción del cajero:
 *   'cobrar'    → pasar los billetes a la caja e imprimir el tique (con `carga`)
 *   'devolver'  → devolver los billetes (con `error`: el código de OxioPay)
 *   'releer'    → pedir otra vez el código del móvil (4.2) y volver a llamar con el mismo tx
 *   'pendiente' → no devolver nada todavía y buscar la carga por referencia (4.3)
 */
export async function cargar(tx) {
  const body = { qr: tx.qr, amount: tx.amount, description: 'Recarga en cajero 0042', reference: tx.id, funding: 'cash', device: 'ATM0042' };
  if (tx.nfcUid) body.nfc_uid = tx.nfcUid;
  const hasta = Date.now() + 60_000; // la carga entera, como mucho 60 s
  for (let intento = 0; ; intento++) {
    const r = await oxp('POST', '/wallet/loads', { body, idempotencyKey: tx.id }).catch(() => ({ status: 0, retryAfter: 0 }));
    if (sinContestar(r)) tx.sinRespuesta = true;
    if (r.status === 201) {
      return !r.replayed || esDeEstaTx(r.data, tx) ? { accion: 'cobrar', carga: r.data } : { accion: 'devolver', error: 'id_repetido' };
    }
    if (reintentable(r)) {
      const espera = Math.max(r.retryAfter * 1000, 1000 * 2 ** intento);
      if (intento < 4 && r.retryAfter <= 15 && Date.now() + espera < hasta) { await esperar(espera); continue; }
      return tx.sinRespuesta ? { accion: 'pendiente' } : { accion: 'devolver', error: r.data?.code ?? `http_${r.status}` };
    }
    const code = r.data?.code;
    if (code === 'live_code_invalid') return { accion: 'releer' };
    if (code === 'idempotency_key_reused') {
      return esDeEstaTx(r.data.operation, tx) ? leerCarga(r.data.operation.id) : { accion: 'devolver', error: 'id_repetido' };
    }
    if (tx.sinRespuesta && (r.status === 401 || r.status === 403 || (r.status === 404 && code !== 'wallet_not_found'))) {
      return { accion: 'pendiente' };
    }
    return { accion: 'devolver', error: code ?? `http_${r.status}` };
  }
}

/** La carga entera, para el tique. Sin respuesta: buscarla luego por referencia (4.3). */
async function leerCarga(id) {
  const r = await oxp('GET', `/wallet/loads/${id}`).catch(() => ({ status: 0 }));
  return r.status === 200 ? { accion: 'cobrar', carga: r.data } : { accion: 'pendiente' };
}

/** Busca la carga por referencia, 60 s después del último intento. Devuelve la carga, 'no_existe' o 'desconocido'. */
export async function buscarPorReferencia(tx) {
  const q = new URLSearchParams({
    from: new Date(tx.inicio.getTime() - 60_000).toISOString(),
    to: new Date(Date.now() + 2 * 60_000).toISOString(),
    reference: tx.id,
  });
  const r = await oxp('GET', `/wallet/operations?${q}`).catch(() => ({ status: 0 }));
  if (r.status !== 200) return 'desconocido';
  return r.data.data.find((c) => esDeEstaTx(c, tx)) ?? 'no_existe';
}
```

---

## 5. Errores y reintentos

Los errores llegan como `application/problem+json`:

```json
{
  "type": "https://docs.oxiopay.example/errors/limit_exceeded",
  "title": "Limit exceeded",
  "status": 402,
  "code": "limit_exceeded",
  "detail": "This load is above this connection's limit per operation (300.00 EUR).",
  "limit": "per_operation",
  "remaining": 30000,
  "request_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479"
}
```

Decide siempre por `code`, nunca por `title` ni `detail`. `detail` es para vosotros (en español con `Accept-Language: es`) y nunca repite un valor que mandasteis; al cliente se le enseña el texto de esta tabla. Campos extra según el código: `param` (`invalid_request`, `validation_failed`), `required_scope` (`scope_missing`), `limit` y `remaining` (`limit_exceeded`), `method` y `reason` (`method_disabled`), `reason` (`wallet_ref_not_accepted`), `available` (`balance_already_spent`), `operation` (`idempotency_key_reused`).

**Reintentar** quiere decir: la misma petición, con la misma `Idempotency-Key` y el mismo cuerpo, después de `Retry-After`. Cualquier otro `4xx` no se repite igual.

Textos fijos que usa la tabla:
- **[fuera de servicio]**: «Cajero fuera de servicio. Recarga en recepción.» / "This machine is out of service. Please top up at reception."
- **[espera]**: «Un momento, por favor…» / "One moment, please…"
- Si el depósito tenía billetes y el resultado es un rechazo definitivo, añade: «Recoge tu dinero.» / "Please take your money."

| Código | HTTP | Qué significa | ¿Reintentar? | Texto al cliente (ES) | Texto al cliente (EN) |
|---|---|---|---|---|---|
| `invalid_request` | 400 | Petición ilegible: cuerpo que no es un objeto JSON, `Content-Type` distinto de `application/json`, `Idempotency-Key` con formato malo | No: fallo de vuestro código | [fuera de servicio] | [out of service] |
| `idempotency_key_missing` | 400 | Carga sin `Idempotency-Key` | No | [fuera de servicio] | [out of service] |
| `api_key_in_url` | 400 | La clave iba en la URL; el dueño recibe aviso para rotarla | No: corregid y pedid clave nueva | [fuera de servicio] | [out of service] |
| `api_key_in_body` | 400 | La clave iba en el cuerpo | No | [fuera de servicio] | [out of service] |
| `invalid_api_key` | 401 | Clave desconocida (o bloqueada 15 minutos tras 20 fallos) | No | [fuera de servicio] | [out of service] |
| `api_key_rotated` | 401 | La clave se cambió por otra y el solape acabó | No: poned la nueva | [fuera de servicio] | [out of service] |
| `api_key_revoked` | 401 | Clave revocada | No | [fuera de servicio] | [out of service] |
| `api_key_expired` | 401 | Clave caducada | No: pedid una nueva | [fuera de servicio] | [out of service] |
| `api_key_suspended` | 401 | 90 días sin llamadas de saldo; el dueño la reactiva | No | [fuera de servicio] | [out of service] |
| `wrong_environment` | 401 | Clave de prueba en real o real en la demo | No | [fuera de servicio] | [out of service] |
| `limit_exceeded` + `per_operation` | 402 | Más que el máximo por recarga | No (otro importe = otra transacción) | Como mucho {remaining} € por recarga. | At most {remaining} € per top-up. |
| `limit_exceeded` + `wallet_24h` | 402 | Tope de este saldo en 24 h en estos cajeros | No | Ahora puedes cargar como mucho {remaining} € más en este saldo. (Si es 0: Este saldo ha llegado al tope de recargas de 24 horas.) | Right now you can top up at most {remaining} € more on this balance. (If 0: This balance has reached its 24-hour top-up limit.) |
| `limit_exceeded` + `wallet_24h_all_partners` | 402 | Tope de este saldo en 24 h entre todos los socios | No | Este saldo ha llegado al tope de recargas de 24 horas. | This balance has reached its 24-hour top-up limit. |
| `limit_exceeded` + `unnamed_wallet_30d` | 402 | 1.500 € en 30 días en un saldo sin teléfono | No | Este saldo ha llegado al tope de 1.500 € en 30 días. Para cargar más, pide al encargado que apunte tu teléfono. | This balance has reached the 1,500 € limit for 30 days. To top up more, ask the manager to add your phone number. |
| `limit_exceeded` + `connection_night` | 402 | Tope de la noche de todos los cajeros del local | No (4.2) | Los cajeros no admiten más recargas esta noche. Recarga en recepción. | The machines take no more top-ups tonight. Please top up at reception. |
| `cash_limit_reached` | 402 | El efectivo de este saldo llegaría a 1.000 € en 24 h (recepción y cajeros juntos) | No | Por ley, este saldo no admite más efectivo ahora. Habla con recepción. | By law, this balance cannot take more cash right now. Please speak to reception. |
| `scope_missing` | 403 | La clave no tiene ese permiso (`required_scope`) | No | [fuera de servicio] | [out of service] |
| `scope_paused` | 403 | Cargas nuevas en pausa (pausa automática); el dueño las reanuda | No (4.2) | Las recargas en este cajero están paradas. Recarga en recepción. | Top-ups at this machine are stopped. Please top up at reception. |
| `ip_not_allowed` | 403 | Llamada desde una IP no registrada; el dueño recibe aviso | No | [fuera de servicio] | [out of service] |
| `browser_not_allowed` | 403 | La petición llevaba cabecera `Origin` | No | [fuera de servicio] | [out of service] |
| `partner_suspended` | 403 | OxioPay suspendió a vuestra empresa como socio | No | [fuera de servicio] | [out of service] |
| `connection_paused` | 403 | El dueño u OxioPay pausaron la conexión, o el local ya no está en la sociedad de la clave con su NIF (hasta que OxioPay lo arregle) | No | [fuera de servicio] | [out of service] |
| `partner_api_frozen` | 403 | OxioPay congeló las cargas y las anulaciones | No (4.2) | Las recargas no están disponibles ahora. Recarga en recepción. | Top-ups are not available right now. Please top up at reception. |
| `wallet_not_found` | 404 | No hay saldo a vuestro alcance con esa referencia (no existe, otro grupo u otra sociedad) | No | Este saldo no se puede cargar en este cajero. | This balance cannot be topped up at this machine. |
| `load_not_found` | 404 | Esa carga no es de esta conexión | No | (no se enseña) | (not shown) |
| `not_found` | 404 | API apagada o congelada del todo, o ruta que no existe. Con la API apagada el cuerpo puede no ser JSON | No (mirad `GET /me` más tarde) | [fuera de servicio] | [out of service] |
| `wallet_blocked` | 409 | Saldo bloqueado | No | Este saldo está bloqueado. Habla con el personal. | This balance is blocked. Please speak to the staff. |
| `wallet_closed` | 409 | Saldo cerrado | No | Este saldo está cerrado. Habla con el personal. | This balance is closed. Please speak to the staff. |
| `ficha_lost` | 409 | Ficha dada como perdida | No | Esta ficha está dada de baja. Si es tuya, ve a recepción. | This NFC tag has been reported lost. If it is yours, please go to reception. |
| `ficha_blocked` | 409 | Ficha bloqueada | No | Esta ficha está bloqueada. Ve a recepción. | This NFC tag is blocked. Please go to reception. |
| `ficha_copy_suspected` | 409 | El número del chip no es el de la ficha; el dueño recibe aviso | No | Esta ficha no se puede usar aquí. Ve a recepción. | This NFC tag cannot be used here. Please go to reception. |
| `method_disabled` + `wallet` | 409 | El local apagó el saldo en sus ajustes (`reason: venue_setting`) | No (4.2) | Este local no admite recargas de saldo ahora. | This venue is not taking balance top-ups right now. |
| `method_disabled` + `cash_top_up` | 409 | El local apagó las recargas en efectivo en sus ajustes (`reason: venue_setting`) | No (4.2) | Este local no admite ahora recargas en efectivo. | This venue is not taking cash top-ups right now. |
| `void_window_passed` | 409 | Anulación pasados los 10 minutos | No | (no se enseña: incidencia para el local) | (not shown) |
| `balance_already_spent` | 409 | El saldo ya no cubre la carga que se quería anular (`available`) | No | (no se enseña: incidencia para el local) | (not shown) |
| `body_too_large` | 413 | Cuerpo de más de 16 KB | No | [fuera de servicio] | [out of service] |
| `validation_failed` | 422 | Un campo incumple su regla (`param`), un campo de más, `nfc_uid` con un código del móvil, o un número de tarjeta en `reference` | No | [fuera de servicio] | [out of service] |
| `wallet_ref_unrecognized` | 422 | Lo leído no es nada de OxioPay | No (leer otra cosa) | No reconocemos este código. Acerca tu ficha o enseña el código de tu página del saldo. | We do not recognise this code. Tap your NFC tag or show the code on your balance page. |
| `wallet_ref_not_accepted` | 422 | Es de OxioPay pero no sirve aquí (`reason`, capítulo 3) | No | El texto de su `reason` (capítulo 3) | The text for its `reason` (chapter 3) |
| `live_code_invalid` | 422 | Código del móvil caducado o desconocido | Sí, tras leer el código otra vez y comprobar el saldo con el cliente (4.2), con el mismo id de transacción | El código ha caducado. Vuelve a enseñarlo. | The code has expired. Please show it again. |
| `description_invalid` | 422 | `description` con caracteres o enlaces no permitidos | No: corregid el texto | [fuera de servicio] | [out of service] |
| `description_personal_data` | 422 | `description` parece un dato personal (correo, 9 cifras o más, tarjeta) | No: corregid el texto | [fuera de servicio] | [out of service] |
| `funding_not_allowed` | 422 | Forma de pago no aceptada (en el piloto, todo lo que no sea `cash`) | No | Este cajero solo admite efectivo. | This machine only takes cash. |
| `idempotency_key_reused` | 422 | Esa `Idempotency-Key` ya tiene otra operación (`operation`) | No: comprobad la operación (4.2) | (no se enseña) | (not shown) |
| `range_too_long` | 422 | Periodo demasiado largo en el cuadre | No | (no se enseña) | (not shown) |
| `venue_paused` | 423 | El local (o su sociedad) está en pausa | No (4.2) | El local no admite recargas ahora. | The venue is not taking top-ups right now. |
| `rate_limited` | 429 | Demasiadas peticiones; no se hizo nada | Sí, tras `Retry-After` (más de 15 segundos: 4.2 y 4.3) | [espera] | [one moment] |
| `try_later` | 503 | OxioPay no puede contestar con seguridad ahora; no se hizo nada | Sí, tras `Retry-After` (más de 15 segundos: 4.3) | [espera] | [one moment] |
| `internal_error` | 500 | Fallo inesperado de OxioPay: no se sabe si se cargó | Sí (4.3) | [espera] | [one moment] |
| otro `5xx`, sin respuesta o tiempo agotado | — | Fallo de red o de OxioPay: no se sabe si se cargó | Sí (4.3); si sigue sin saberse, conciliar | [espera] | [one moment] |

`{remaining}` va en céntimos: enséñalo en euros (`remaining / 100`, con dos decimales, «300,00» en español), redondeado hacia abajo a un importe que tu cajero pueda coger en billetes.

**Un `code`, `limit` o `reason` que no conoces** (la API solo crece): usa el texto de su estado HTTP. `402`: «Este saldo no admite esta recarga ahora. Recarga en recepción.» / "This balance cannot take this top-up right now. Please top up at reception." `409` o `423`: «Este saldo no se puede cargar ahora. Habla con el personal.» / "This balance cannot be topped up right now. Please speak to the staff." Cualquier otro `4xx`: [fuera de servicio] / [out of service].

---

## 6. Cuadre

**La noche del local.** Va de las 08:00 a las 08:00 (hora de Madrid) y se llama por el día en que empieza: la noche `2026-12-05` va del 5 de diciembre a las 08:00 al 6 de diciembre a las 08:00. En UTC: en invierno de 07:00Z a 07:00Z, en verano de 06:00Z a 06:00Z. La noche del cambio de hora dura 23 o 25 horas. Una carga a las 00:41 del sábado es de la noche del viernes.

**Las cargas de una noche**: `GET /wallet/operations?business_date=2026-12-05`. Solo las de esta conexión (este local), las más antiguas primero, hasta 100 por página (`limit`), con `next_cursor` para la siguiente (mándalo como `cursor` con los mismos filtros). Cada carga sale una vez, en la noche en que se hizo, con su estado de ahora (`succeeded` o `voided`, y `voided_at`, tanto si la anulasteis vosotros como el local). En lugar de `business_date` puedes dar `from` y `to` (hasta 31 días, `to` excluido); los dos, ninguno, solo uno de ellos, o un `to` que no es posterior a `from` → `422 validation_failed`. Con `reference` buscas una transacción concreta:

`GET /wallet/operations?business_date=2026-12-05&reference=ATM0042-20261205-000731-K7QM` (`200`):

```json
{
  "object": "list",
  "data": [
    {
      "object": "wallet_load",
      "id": "wl_8b2e6f1a9c3d4e5f8a7b6c5d4e3f2a1b",
      "status": "succeeded",
      "amount": 2000,
      "currency": "EUR",
      "description": "Recarga en cajero 0042",
      "reference": "ATM0042-20261205-000731-K7QM",
      "funding": "cash",
      "device": "ATM0042",
      "created_at": "2026-12-05T22:41:07Z",
      "void_until": "2026-12-05T22:51:07Z",
      "balance_after": 7000,
      "terms": {
        "url": "https://demo-api.oxiopay.example/legal/condiciones#saldo",
        "version": "2026-11-17",
        "summary_es": "El saldo se gasta en este local y en los de su grupo que lo aceptan. No se devuelve en dinero, ni en efectivo ni a la tarjeta.",
        "summary_en": "The balance is spent at this venue and at the venues of its group that accept it. It is not refunded in money, neither in cash nor to a card."
      },
      "voided_at": null,
      "livemode": false
    }
  ],
  "has_more": false,
  "next_cursor": null
}
```

Una carga aparece cuando OxioPay termina de guardarla (como mucho 30 segundos después de recibirla): para tener la noche completa, léela cuando ya haya terminado (a partir de las 08:05). Leer tus cargas y los totales sigue funcionando durante una pausa automática.

**Los totales**: `GET /statement?from=2026-12-05T07:00:00Z&to=2026-12-06T07:00:00Z` (hasta 92 días, `to` excluido). Son los mismos números que ve el dueño en «Movimientos» para esta conexión. Las cargas cuentan en el momento en que se hicieron y las anulaciones en el momento de la anulación, también cuando el local anula desde su panel (por eso, una carga a las 07:58 anulada a las 08:03 cae en dos noches distintas). `net_loads` = cargas − anulaciones.

```json
{
  "object": "statement",
  "from": "2026-12-05T07:00:00Z",
  "to": "2026-12-06T07:00:00Z",
  "currency": "EUR",
  "livemode": false,
  "loads": {
    "count": 3,
    "amount": 9000,
    "by_funding": {
      "cash": { "count": 3, "amount": 9000 },
      "card": { "count": 0, "amount": 0 },
      "transfer": { "count": 0, "amount": 0 },
      "bank_app": { "count": 0, "amount": 0 }
    }
  },
  "load_voids": { "count": 1, "amount": 5000 },
  "net_loads": 4000
}
```

**El dinero.** Es del local, como el de la caja de recepción: OxioPay no os debe nada ni vosotros a OxioPay. El efectivo de los cajeros no forma parte del cajón de recepción: el arqueo del cierre no lo espera en el cajón, y el cierre de la noche (Z) del local lo enseña en una línea propia, «Caja · Cajeros Demo», que cuenta quien vacía los cajeros. El efectivo de cada cajero se cuenta cada noche contra `net_loads`, y si falta dinero se avisa al dueño ese mismo día. Para cada local y cada noche, el efectivo de vuestros cajeros debe cuadrar con `net_loads` de `GET /statement` para el mismo `from` y `to` (en el piloto todas las cargas son en efectivo). Con la línea «Caja · …» del Z del local cuadra si el local cerró la noche a las 08:00; si la cerró antes, lo cargado entre el cierre y las 08:00 sale en el Z siguiente, y una carga anulada después de las 08:00 resta en la noche de la anulación. El reparto entre la empresa de los cajeros y el local va fuera de la API. Los totales por cajero los sacáis de vuestros registros (la API da totales por local).

Para calcular `from` y `to` de una noche en Node, sin librerías (a las 08:00 nunca hay cambio de hora):

```js
// 08:00 de Madrid del día `fecha` (AAAA-MM-DD), como Date en UTC.
function madrid0800(fecha) {
  const invierno = new Date(`${fecha}T07:00:00Z`);
  const hora = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', hourCycle: 'h23' }).format(invierno);
  return hora === '08' ? invierno : new Date(`${fecha}T06:00:00Z`);
}
const diaSiguiente = (fecha) => new Date(Date.parse(`${fecha}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

const noche = '2026-12-05';
const q = new URLSearchParams({ from: madrid0800(noche).toISOString(), to: madrid0800(diaSiguiente(noche)).toISOString() });
// GET /statement?from=2026-12-05T07:00:00.000Z&to=2026-12-06T07:00:00.000Z
```

---

## 7. Pruebas en la demo

**La demo** es otra instalación de OxioPay en modo prueba: claves `oxp_test_…`, respuestas con `livemode: false`, datos inventados y sin dinero real. La real rechaza las claves de prueba y la demo las reales (`401 wrong_environment`). En la demo la lista de IP es opcional; si OxioPay la pone, funciona igual que en real. OxioPay os avisará cuando la demo esté lista.

**Fichas de prueba.** Siempre las mismas. Su enlace es `https://demo-operator.oxiopay.example/?ficha=<código>` (podéis grabarlo en vuestras propias fichas NTAG para probar con el lector de verdad). Ninguna tiene teléfono. Las claves de prueba son del local de la demo «Local Demo Centro» (o de otro local de su sociedad y su grupo), los únicos que llegan a estas fichas, y todos los que prueban en la demo las comparten: haced las pruebas de topes justo después de `POST /test/fixtures/reset`, y contad con cargas de otros.

| Ficha (`fixture`) | Código | UID guardado | Saldo | Qué responde |
|---|---|---|---|---|
| `active` | `demo-ficha-active-0001` | ninguno | 50,00 € | Funciona |
| `empty` | `demo-ficha-empty-00001` | ninguno | 0,00 € | Saldo 0; cargar funciona |
| `ficha_uid` | `demo-ficha-uid-0000001` | `04A1B2C3D4E5F6` | 50,00 € | Funciona; con otro UID → `409 ficha_copy_suspected` |
| `blocked` | `demo-ficha-blocked-001` | ninguno | 50,00 € | `409 wallet_blocked` |
| `closed` | `demo-ficha-closed-0001` | ninguno | 0,00 € | `409 wallet_closed` |
| `lost_ficha` | `demo-ficha-lost-000001` | ninguno | 50,00 € | La ficha → `409 ficha_lost`; un código del móvil de su saldo funciona |
| `ficha_blocked` | `demo-ficha-fblocked-01` | ninguno | 50,00 € | La ficha → `409 ficha_blocked`; un código del móvil de su saldo funciona |
| `other_group` | `demo-ficha-othergroup1` | ninguno | 50,00 € | `404 wallet_not_found` (otro grupo de locales) |
| `other_company` | `demo-ficha-othercomp01` | ninguno | 50,00 € | `404 wallet_not_found` (mismo grupo, otra sociedad) |

Como `active` no tiene UID guardado, cualquier ficha vuestra con ese enlace grabado sirve para probar el lector NFC de verdad. `ficha_uid` solo prueba el formato, mandando el UID a mano. Para comprobar el orden de los bytes de vuestro lector, pedid a OxioPay que dé de alta en la demo una de vuestras fichas NTAG, leída con un móvil Android en la recepción de la demo: leedla con el cajero; tiene que dar `200`, nunca `ficha_copy_suspected`.

**Textos rechazados de muestra.** El rechazo depende solo de la forma del texto, así que estos textos inventados dan estas respuestas:

| `qr` | Respuesta |
|---|---|
| `https://demo-api.oxiopay.example/c/demoGoogleWalletPass00000000000000000000001` | `422 wallet_ref_not_accepted`, `reason: wallet_pass` |
| `https://demo-api.oxiopay.example/w/demoPrivateLink000000001` | `reason: private_link` |
| `NPF:K7Q4M2:demoReceptionProof0001` | `reason: reception_qr` |
| `K7Q4M2` | `reason: short_code` |
| `https://demo-api.oxiopay.example/pay/demoChargeLink000000000000000001` | `reason: charge_link` |
| `https://demo-api.oxiopay.example/w/a/demoActivationLink000001` | `reason: other_link` |
| `https://example.org/carta` | `422 wallet_ref_unrecognized` |

**Ayudas de prueba** (solo existen en la demo; en la real dan `404`):

```bash
# Un código del móvil para una ficha de prueba: vale 60 segundos y solo identifica
curl -sS "$OXP_BASE/test/live-codes" \
  -H "Authorization: Bearer $OXP_KEY" \
  -H "Content-Type: application/json" \
  -d '{"fixture":"active"}'
# 201 {"object":"test_live_code","code":"OXC1:K3J7Q2M9X4T8R6V1N5B0C2D7F9","expires_in":60,"livemode":false}

# Dejar todas las fichas de prueba como al principio (sin cuerpo ni Content-Type)
curl -sS -X POST "$OXP_BASE/test/fixtures/reset" -H "Authorization: Bearer $OXP_KEY"
# 204, sin cuerpo
```

- El código lo podéis mandar directamente en `qr`, o pintarlo como QR (modo alfanumérico) en un móvil o una pantalla para probar el lector del cajero.
- El reinicio da a cada ficha de prueba un saldo nuevo con su saldo y su estado de partida, con los mismos enlaces y UID. Las cargas ya hechas siguen en `/wallet/operations` y `/statement`, pero dejan de contar para los topes de las fichas; el tope de la noche de vuestra conexión las sigue contando. Los códigos del móvil anteriores dejan de valer.
- Si lo pedís, OxioPay pone vuestra conexión de prueba o el local de la demo en los estados que responden `method_disabled`, `venue_paused`, `partner_api_frozen`, `connection_paused` y `scope_paused`, y los quita después.

**Qué probar antes de pedir la salida:**

1. Las tres llamadas del capítulo 1.
2. Cada ficha de prueba, por NFC (enlace + UID) y con un código del móvil, y cada texto del capítulo 3.
3. Cada texto rechazado de muestra de arriba, y un texto que vuestro cajero no debe mandar (un QR de wifi): enseña «No reconocemos este código» sin llamar.
4. Un código del móvil caducado (esperad más de 60 segundos): `live_code_invalid` → enseñarlo otra vez, saldo confirmado por el cliente → misma transacción.
5. Una carga por encima del máximo por recarga (vuestro cajero no debería llegar a llamar) y dos cargas de 300 € y una de 0,01 € en el mismo saldo (`limit_exceeded`, `limit: wallet_24h`). `cash_limit_reached` solo salta si el mismo saldo ya tiene efectivo de recepción: para verlo, pedid a OxioPay que cargue efectivo en recepción en una ficha de prueba; si no, tratadlo como cualquier rechazo `402`.
6. `funding: "card"` → `422 funding_not_allowed`.
7. Reintento con la misma `Idempotency-Key` y el mismo cuerpo → `Idempotent-Replayed: true`, reconocida como de esta transacción; la misma clave con otro cuerpo → `idempotency_key_reused`; un id ya usado por una transacción anterior → billetes devueltos.
8. Tiempo agotado simulado (cortad la red tras enviar): reintento, y conciliación por `reference`.
9. Un reinicio de vuestros servidores y de un cajero en mitad de una transacción, y un depósito que devuelve los billetes solo (4.3).
10. Anulación dentro de los 10 minutos, hecha antes de devolver los billetes y repetida (misma respuesta), y pasados los 10 minutos (`void_window_passed`). `balance_already_spent` necesita que el cliente gaste en el local: en la demo no se provoca desde el cajero.
11. Cada estado del local que OxioPay pone si se lo pedís: el cajero enseña el texto del capítulo 5, y con `scope_paused` aún podéis buscar y anular vuestras cargas.
12. El cuadre de una noche con `/wallet/operations` y `/statement`, y que vuestros totales coincidan.
13. Una petición sin `Idempotency-Key`, con la clave en la URL, y con la clave caducada o revocada (pedídselo a OxioPay): el cajero queda «fuera de servicio».
14. Vuestra propia ficha NTAG, dada de alta por OxioPay en la demo: responde `200`, nunca `ficha_copy_suspected`.

El tope de 1.500 € en 30 días no se alcanza rápido en la demo (los de 24 horas llegan antes): tratad igual cualquier `limit_exceeded`.

Ojo: la pausa automática también funciona en la demo. Tres rechazos por el máximo por recarga en 10 minutos paran las cargas de vuestra conexión de prueba hasta que OxioPay las reanude: separad esas pruebas al menos 10 minutos.

---

## 8. Antes de salir

**Lo que tiene que haber hecho OxioPay:**

- [ ] OxioPay confirma la dirección real y la fecha de salida.
- [ ] Firmados el contrato de socio y el contrato de encargo de tratamiento de datos.
- [ ] Vuestra empresa, dada de alta como socio, con sus IP de salida.
- [ ] La sociedad del local piloto, con su razón social y su NIF en OxioPay (salen en el tique).
- [ ] Una conexión preparada: el local piloto, `venue_collects`, `wallet:balance` y `wallet:load`, vuestras IP fijas, topes de serie, tarjeta apagada.
- [ ] OxioPay enciende la API real para ese local y os lo confirma por escrito.

**Lo que tiene que estar hecho por parte de los cajeros:**

- [ ] La clave real solo en vuestros servidores (gestor de secretos), nunca en los cajeros, en el código ni en los logs. Llega por el enlace de un solo uso, abierto solo al guardarla.
- [ ] Las llamadas salen solo de las IP registradas (también IPv6, o IPv4 forzado), por TLS con comprobación del certificado, sin un proxy que abra el TLS o registre cabeceras. Sin cabecera `Origin`. La clave solo en `Authorization`.
- [ ] `GET /me` al arrancar y cada hora; condiciones, emisor y topes tomados de ahí; aviso interno en cuanto `key.replaced` sea `true` y 30 días antes de `key.expires_at`; fuera de servicio con `livemode: false` en real.
- [ ] Id de transacción único para siempre por local (de 8 a 64 caracteres, acabado en caracteres al azar), usado como `Idempotency-Key` y como `reference`, y `device` en cada carga.
- [ ] Cada transacción apuntada en un almacenamiento que no se borre antes de llamar; reinicios y depósitos que devuelven solos, resueltos (4.3).
- [ ] Flujo con depósito probado: `201` → caja y tique (repeticiones comprobadas); rechazo → devolver; sin respuesta → reintentar con la misma `Idempotency-Key`; si sigue sin saberse → conciliar por `reference` antes de devolver nada; tique «pendiente» si OxioPay no contesta.
- [ ] Código del móvil caducado → leer otra vez, saldo confirmado por el cliente, y repetir con el mismo id.
- [ ] Máximo por recarga comprobado antes de llamar.
- [ ] Solo efectivo (`funding: "cash"`).
- [ ] El lector de QR en modo serie; solo se mandan textos `OXC1:`, `NPF:`, `https://` y de 6 caracteres.
- [ ] El número de serie que da vuestro lector es el mismo que lee un Android (probado en la demo con una ficha vuestra); antes de abrir a los clientes, tres fichas reales del local piloto acercadas a un cajero en real, con el encargado: ninguna da `ficha_copy_suspected`.
- [ ] Condiciones en pantalla, con aceptación, antes de coger el dinero; tique completo (4.7).
- [ ] Textos del capítulo 5 en español e inglés.
- [ ] Anulación solo cuando el dinero no se quedó en el local, dentro de los 10 minutos, antes de devolver los billetes.
- [ ] Cuadre por noche y por local con `/wallet/operations` y `/statement`, igual a vuestro recuento de efectivo.
- [ ] En los logs: `Request-Id`, `wl_…`, `reference`, importe y código de error. Nunca la clave, el texto del QR, el UID, los códigos del móvil ni los saldos.
- [ ] Todas las pruebas del capítulo 7, hechas en la demo.
