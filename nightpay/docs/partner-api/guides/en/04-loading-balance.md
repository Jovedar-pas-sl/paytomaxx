## 4. Loading balance at an ATM

### 4.1 Before serving anyone

- Call `GET /me` at start-up and every hour. Keep in memory: `issuer` and `venue_name` (for the ticket), `limits.loads`, `terms`, `paused_scopes` and `key`. If a load response carries a different `terms.version`, read `GET /me` again before the next customer.
- If `GET /me` answers `401`, `403` or `404`, the ATM does not load: «Cajero fuera de servicio. Recarga en recepción.» / "This machine is out of service. Please top up at reception." If it cannot be read (no response, `429`, `5xx`), keep using the last good copy for up to 2 hours; with no copy, the ATM stays out of service.
- In live, if `GET /me` answers `livemode: false`, the ATM does not load («Cajero fuera de servicio»): it is pointed at the demo.
- Each ATM transaction has **its own id, unique forever** in that venue, created on the ATM when the escrow opens, for example `ATM0042-20261205-000731-K7QM` (ATM, date, counter and 4 random characters, so that nobody can guess the next one). It serves both as `Idempotency-Key` and as `reference`, so it must fit both: 8 to 64 characters from `A-Z a-z 0-9 _ -`. Your servers accept each id once, so a double tap or a retry from the ATM to your servers carries the same id. If the counter restarts (for example after a reinstall), the id must still never repeat (4.2 explains how a repeated id is caught).

### 4.2 The flow, step by step (cash with escrow)

1. **Identify.** Read the phone code or the ficha and call `POST /wallet/balance` with `{qr}` or `{qr, nfc_uid}`. With `200`: if it was the phone code, show the balance (`available`); if it was a ficha (NFC or printed QR), show «Ficha reconocida» ("NFC tag recognised") without the amount, because anyone can tap a ficha they found; the ticket carries the balance after the load. With an error, show the text from chapter 5 and stop: you have not taken any money yet. With `429` and a `Retry-After` above 15 seconds (for example a ficha that has used up its reads for the night), do not wait: go on without showing the balance, as the load identifies the wallet itself.
2. **Terms.** Show on screen `terms.summary_es` (or `summary_en`, depending on the customer's language) from `GET /me`, the company that issues the balance (`issuer.legal_name`) and the maximum per top-up (`limits.loads.per_operation`). The customer accepts with a button. Without acceptance, do not go on.
3. **Take the money into escrow.** The ATM takes the notes into escrow, without moving them to the cash box yet, and counts them. If the total is above `limits.loads.per_operation`, give the notes back and ask for less **before** calling OxioPay (those refusals count toward the automatic pause, 4.6).
4. **Load.** Write the transaction to durable storage (4.3), then call `POST /wallet/loads` with `Idempotency-Key` = the transaction id and the body `{qr, nfc_uid?, amount, description, reference, funding: "cash", device}`, with `reference` = the same id and `device` = the ATM. Wait up to 10 seconds for the response.
5. **Depending on the response:**
   - **`201` without `Idempotent-Replayed`** → move the notes from escrow to the cash box and print the ticket (4.7).
   - **`201` with `Idempotent-Replayed: true`, or `422 idempotency_key_reused`** → this id already holds a load (the `201` body, or `operation`). It is this transaction's only if its `status` is `succeeded`, its `amount` is this amount and its `created_at` is not earlier than 1 minute before this transaction started: then cash box and ticket (with `idempotency_key_reused`, read it first with `GET /wallet/loads/{id}` for the ticket). Otherwise an earlier transaction used this id: give the notes back, put the ATM out of service and fix the numbering. Never decide by `reference`: it is the same text as the key.
   - **`422 live_code_invalid`** → the phone code expired while the customer was inserting notes. Do not give anything back yet: ask them to show the code again («Vuelve a enseñar el código»), call `POST /wallet/balance` with the new code, show the balance and go on only if the customer confirms it is theirs; then repeat step 4 with the new code and **the same transaction id**. If no new code arrives within 60 seconds: give the notes back if every attempt of this transaction got a response; otherwise reconcile first (4.3).
   - **A definitive refusal** (`400`, `401`, `402`, `403`, `404`, `409`, `413`, `422`, `423`, except the cases above and the exception below) → give back the notes in escrow and show the text from chapter 5.
   - **Exception:** once an attempt of this transaction got no response (timeout, network error, or a `5xx` other than `503 try_later`), a later `401`, `403` or `404 not_found` does not tell you whether that attempt loaded: keep the notes in escrow and reconcile (4.3).
   - **No response, timeout, `429`, `503` or another `5xx`** → you do not know whether it was loaded. **Do not give the money back.** Retry (4.3).

**Refusals that affect the whole venue.** After `403 scope_paused`, stop offering top-ups at the venue's ATMs until `GET /me` no longer lists `wallet:load` in `paused_scopes`. After `409 method_disabled`, `423 venue_paused` or `403 partner_api_frozen`, stop offering them for 10 minutes. After `402 limit_exceeded` with `limit: connection_night`, stop offering them until 08:00 if `remaining` is below your smallest note.

### 4.3 Retries and unknown outcome

- Retry **with the same `Idempotency-Key` and the same body**, at most 4 times, waiting 1, 2, 4 and 8 seconds, or what `Retry-After` says (in seconds) when it is longer. Give the whole load at most 60 seconds. Never generate a new key for the same transaction.
- OxioPay handles one request per `Idempotency-Key` at a time: a retry that arrives while an earlier attempt is still running waits for it and gets its response. So a retry settles the result: if the load had already been made, you get the original response (`201` with `Idempotent-Replayed: true`; check it as in 4.2); if it had not been made, it is made now. If the phone code has already expired and the load was not made, you get `422 live_code_invalid`: nothing was loaded (4.2).
- If `Retry-After` is above 15 seconds, do not keep the customer waiting: if every attempt got a response, give the notes back (`429` and `503 try_later` are answered before anything is done); otherwise reconcile.
- **Reconcile by reference** when the notes must leave the escrow without a result (the 60 seconds are over, or the customer leaves). OxioPay never commits a load more than 30 seconds after it arrived, so wait 60 seconds after your last attempt, then read:

  `GET /wallet/operations?from=<transaction start − 1 min>&to=<now + 2 min>&reference=<transaction id>`

  - It appears with `status: "succeeded"`, your amount and a `created_at` not earlier than the transaction start minus 1 minute → cash box and ticket.
  - It does not appear (and OxioPay answered `200`) → the load was not made: give the notes back. Read it once more 2 minutes later; if it has appeared after all, void it at once (4.8) with the reason «Billetes devueltos al cliente» and tell OxioPay.
  - OxioPay does not answer, or answers `401`, `403` or `404` → do not give the money back. Move the notes to the cash box, print a «Recarga pendiente de confirmar» ("top-up pending confirmation") ticket with the transaction id and the amount, **without a balance**, and log an incident for the venue. Keep reconciling that reference every 5 minutes. If the load exists, the ticket is void: the customer already has their balance. If OxioPay answers `200` without it, the venue settles the ticket once, giving the customer that balance, and your platform marks the transaction as settled so that the same ticket is never settled twice.
- **Restarts and escrow time-outs.** Before calling `POST /wallet/loads`, write to durable storage on your servers the transaction id, the ATM, the amount, the start time and the state `sent`; never the QR text or the UID. After any restart of your servers or of the ATM, settle each transaction still marked `sent`: find where its notes are and, 60 seconds after the restart, look the load up by reference as above. Notes still in escrow → cash box and ticket if the load exists; give them back if it does not. Notes in the cash box and no load → an incident for the venue (and the pending ticket if the customer is still there). Notes given back and the load exists → void it before `void_until` (4.8), or log an incident for the venue if that has passed. The same applies when the escrow gives the notes back by itself.
- While the transaction is open you may keep the QR text and the UID in memory to retry; when you close it, delete them.

### 4.4 Card in the pilot

In the pilot the ATM **loads cash only** (`funding: "cash"`). `funding: "card"` is in the contract but today answers `422 funding_not_allowed`. OxioPay will enable it for the connection once it is confirmed that the ATM's reader charges **for the venue**, just like the venue's card terminals; a reader that charges under the ATM company's own contract is a different model, not offered in the pilot. The flow will then be the same with the card: authorise the payment on the reader, call `POST /wallet/loads` with `funding: "card"`, and cancel the authorisation if the load is refused. `transfer` and `bank_app` always answer `422 funding_not_allowed` on this connection.

### 4.5 The `description` text

The customer sees it in their movements as «Carga · Cajeros Demo: Recarga en cajero 0042» (on a page in English, "Top-up · Cajeros Demo: Recarga en cajero 0042"), and the owner sees it in their panel. Rules: 1 to 60 characters, no `<` or `>`, no links or domains, no control characters. **No 9 or more digits in a row** (even if they are separated by spaces, dots, dashes, `·` or `/`): it is refused as personal data (`422 description_personal_data`). So no long serial numbers and no dates with a time; use something like `Recarga en cajero 0042`. Never anything that refers to a personal service. The same goes for `reference` and `device`: only your transaction id and your ATM's name, never personal data (a card number in `reference` is refused with `422 validation_failed`).

### 4.6 Limits

All of them are counted in cents, as loads minus voids, and on the wallet together with the wallets merged into it. `GET /me` → `limits.loads` gives your connection's values. Loads into one wallet are checked one at a time, so two loads at the same moment (two ATMs, or an ATM and reception) can never pass a limit together.

| Limit | Value | When exceeded | `remaining` |
|---|---|---|---|
| Per top-up | 300 € (the owner can raise it up to 999.99 €) | `402 limit_exceeded`, `limit: per_operation` | yes |
| Per wallet, this connection, last 24 hours | 600 € (the owner, up to 999.99 €) | `limit: wallet_24h` | yes |
| Per wallet, all partners, last 24 hours | 999.99 €, fixed | `limit: wallet_24h_all_partners` | no |
| Per wallet **without a phone**, this partner (all its venues), last 30 days | 1,500 €, fixed | `limit: unnamed_wallet_30d` | yes |
| Per venue night, this connection (all the venue's ATMs) | 5,000 € (the owner, up to 50,000 €) | `limit: connection_night` | yes |
| **Cash** into one wallet in 24 hours, **counting reception and every partner** | never 1,000 € or more (999.99 € at most), fixed by law | `402 cash_limit_reached` | no |

- `remaining` is what that limit still allows to be loaded now, in cents. When it is missing, do not compute or guess it.
- If several are hit at once, the response names one, in this order: `per_operation`, `wallet_24h`, `wallet_24h_all_partners`, `unnamed_wallet_30d`, `connection_night`; the cash one is checked last.
- "Without a phone" means the venue has not recorded the customer's phone number on their wallet. Above 1,500 € in 30 days, the customer asks the manager to record it (reception can only do it within 15 minutes of giving a new ficha).
- The night limit is also the most a leaked key could load in one night at the venue; OxioPay alerts the owner when the night's loads reach half of it, and again when they reach it.
- **Call limits** (`429 rate_limited`, with `Retry-After` in seconds). `429` and `503 try_later` are answered before anything is done.

| What | Limit |
|---|---|
| All calls of the connection | 600 a minute |
| Loads and voids of the connection | 120 a minute |
| Balance reads of one wallet | 12 a minute; per venue night, 120 with a phone code and 20 with a ficha (only reads that answered `200` count) |
| Loads into one wallet | 6 a minute |
| `qr` texts that are neither a phone code nor a ficha link | 30 a minute; once full, only those texts are refused |
| Failed authentication | per key: 20 failures in 10 minutes, then that key gets `401 invalid_api_key` for 15 minutes; per IP: 20 different bad keys in 10 minutes, then `429` for 15 minutes, never for a valid key whose IP list holds that address |

- **Automatic pause** of new loads on the whole connection (all the venue's ATMs) until the owner resumes it with their 2FA: 3 refusals by `per_operation` within 10 minutes (the same refused request repeated counts once), more than 30 new loads in one minute, 3 voids of yours (through the API) in one night (the venue's voids from its panel do not count), or calls with the key from 3 unregistered addresses within 24 hours. The per-wallet limits, the night limit and the cash rule do not count. Meanwhile loads answer `403 scope_paused` and `GET /me` shows it in `paused_scopes`; reading your loads, voiding and reconciling keep working. Hence: check the maximum per top-up before calling.

### 4.7 The ticket

Print, with the data from `GET /me` and from the `201` response:

- the company that issues the balance and its tax id (`issuer.legal_name`, `issuer.tax_id`) and the sentence «OxioPay es su proveedor técnico» ("OxioPay is its technical provider");
- the venue (`venue_name`);
- the amount (`amount`) and the payment method (cash);
- the balance afterwards (`balance_after`), present because the key holds `wallet:balance`;
- the date and time in Madrid time (from `created_at`);
- the load id (`id`) and your transaction's id (`reference`);
- the terms line from the `terms` of the `201` response: `summary_es` (or `summary_en`), with `url` and `version`.

Example with the load from chapter 1 (`created_at` 22:41 UTC = 23:41 in Madrid):

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

The labels and the sentence «Saldo emitido por {issuer.legal_name}; OxioPay es su proveedor técnico.» / "Balance issued by {issuer.legal_name}; OxioPay is its technical provider." are fixed texts that you keep. The terms summary, URL and version always come from OxioPay, never from a copy in the ATM: OxioPay may change them. Print the ticket in the customer's language, with `summary_es` or `summary_en`.

### 4.8 Voiding a load (10 minutes)

`POST /wallet/loads/{id}/void`, with an optional reason for the venue (`{"reason": "Billetes devueltos al cliente"}`, up to 140 characters, with the same rules as `description`; the customer does not see it). Without a reason, send no body and no `Content-Type`.

- **When**: only when the money of that load **did not stay** with the venue. For example: the load got `201` but the cash box could not take the notes. Void **before** giving the notes back whenever the ATM can still hold them, and hand them back only after the void answers `200`. If the escrow already gave them back by itself, void at once. If the void does not answer `200`, keep the notes if you still have them (the customer has the balance) and log an incident for the venue. If the notes got stuck inside the ATM, the money is with the venue: do not void.
- **Never** to "give back" balance to a customer who changes their mind: the balance is not refunded.
- Only this connection's loads (`404 load_not_found` otherwise), until `void_until` (10 minutes after `created_at`) and only if the wallet still covers the load; a blocked wallet or ficha, or a paused venue, does not stop it. Otherwise: `409 void_window_passed` or `409 balance_already_spent` (with `available`, the current balance). In those cases, and with `403 partner_api_frozen`, do not give anything back from the ATM: log an incident for the venue, which corrects it from its panel. A void made by the venue also shows on the load (`voided`, `voided_at`) and in the summary.
- Repeating the void returns the same voided load (`200`), at any time. An automatic pause of loads does not stop voids.
- The customer receives the notice «Carga anulada · Cajeros Demo» ("Top-up cancelled · Cajeros Demo" on a page in English), and the owner sees every void at once. Three voids of yours (through the API) in one night pause new loads (4.6).

Response (`200`):

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

`balance_after` is the balance right after the load was made, as it was stored then: the void and later reads repeat it. It is not the balance now.

### 4.9 Node example: loading with retries

`cargar()` returns one of four actions: `cobrar` (move the notes to the cash box and print the ticket), `devolver` (give the notes back), `releer` (ask for the phone code again, check the balance with the customer and call again with the same `tx`) or `pendiente` (give nothing back yet and reconcile by reference, 4.3). `buscarPorReferencia()` does that reconciliation.

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
