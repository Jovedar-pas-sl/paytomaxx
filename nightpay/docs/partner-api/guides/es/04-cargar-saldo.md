---
en_sha256: ebfc402df121c2f361bea5742706047c71e3ea519e90f70578f7062f38ed34e5
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
