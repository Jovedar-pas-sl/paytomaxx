# ATM guide: loading balance with the OxioPay API (pilot)

**There is no refund and no cash withdrawal of the balance.** No call in this API takes money out of a wallet.

This guide is for whoever programs the ATM platform. The ATMs stand inside the venues and **only load balance**: they never pay with balance and never hand out cash from a wallet.

- **The contract is `openapi-piloto.yaml`** (in English). If this guide and the YAML disagree, the YAML wins. The examples here are the same as the YAML's: same ids, amounts and codes. The code blocks are identical to those of the Spanish guide, so their comments are in Spanish.
- **Addresses.** They are not chosen yet. Everything ending in `.example` is a placeholder:

| What | Live | Demo (testing) |
|---|---|---|
| API | `https://api.oxiopay.example/v1/partner` | `https://demo-api.oxiopay.example/v1/partner` |
| Link written on the fichas (NFC tags) | `https://<app host>/?ficha=<code>` | `https://demo-operator.oxiopay.example/?ficha=<code>` |
| Documentation (error types) | `https://docs.oxiopay.example` | |

- **Standing rules.** JSON in UTF-8. Amounts in **cents** and always in euros (`2000` = 20.00 €). Times in UTC (`Z`). The venue's "night" runs from 08:00 to 08:00 (Madrid time) and is named after the day it starts (`business_date`). No response carries the wallet's id, the customer's name or phone number, their 6-character code or their ficha's number. If a response brings a field or a code you do not know, ignore it (or handle it by its HTTP status, chapter 5): the API only grows, it never changes what is already there. On the other hand, an extra field in what you send is refused (`422 validation_failed`). Every response carries `Cache-Control: no-store`.
- **Not in the pilot**: paying with balance, charges, notifications (webhooks) and events, and reports. They will come later without breaking anything.

---

## 1. Get started: three calls on the demo

You need a test key (`oxp_test_…`). On the demo the IP list is optional; if OxioPay sets one, call from those IPs. The three calls: the connection (`GET /me`), the balance of a test ficha (`POST /wallet/balance`) and a 20.00 € cash load (`POST /wallet/loads`).

### With curl

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

`GET /me` response (`200`):

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

`POST /wallet/balance` response (`200`):

```json
{ "object": "wallet_balance", "available": 5000, "currency": "EUR", "livemode": false }
```

`POST /wallet/loads` response (`201`):

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

If you repeat the third call unchanged (same `Idempotency-Key`, same body) you get the same response with the header `Idempotent-Replayed: true`: nothing is loaded twice. For another load, use another transaction id. If the test ficha already had other loads you will see a different balance: `POST /test/fixtures/reset` puts it back as it was at the start (chapter 7).

### With Node (18 or later)

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

## 2. Keys and security

**Where the key lives.** On the ATM platform's servers, in their secrets manager or in an environment variable. **Never inside each ATM**: the ATMs talk to your servers, and it is your servers that call OxioPay. A key serves **one venue** (one connection = the ATM platform × one venue): if your ATMs are in two venues, there are two keys, and each ATM uses its own venue's key.

**What it can do.** The ATM key holds only `wallet:balance` (read the balance) and `wallet:load` (load, void its own load, list its loads and their summary). It cannot pay with balance, charge, or read sales. It only reaches the wallets of its venue's group (the same check the venue's own staff make) whose home venue, where the wallet was created, belongs to the same company (same tax id, CIF) as its venue; a home venue without a company counts as another company. Any other wallet answers `404 wallet_not_found`, exactly like one that does not exist.

**How it is sent.** Only in the header `Authorization: Bearer oxp_live_…` (live) or `Bearer oxp_test_…` (demo).
- Never in the URL (`400 api_key_in_url`, and the owner gets an alert to rotate it) nor in the body (`400 api_key_in_body`).
- No `Origin` header: the API is server to server, and a request with `Origin` gets `403 browser_not_allowed`.
- A body of 16 KB at most (`413 body_too_large`). A POST without a body (a void without a reason) goes without `Content-Type`.
- Live does not accept test keys, nor does the demo accept live keys (`401 wrong_environment`).

**Transport.** Only `https://`, TLS 1.2 or later, with certificate verification on. Never `http://` (a key sent over http must be rotated) and never through a proxy that opens TLS or logs the `Authorization` header or request bodies; fixed outbound IPs often come from such a proxy, so check it. The link between each ATM and your servers carries the same secrets (ficha link, chip UID, phone code): encrypt it too, and switch off any logging of scanned text or UIDs in the ATM, its NFC and QR reader SDKs and its crash reports.

**Fixed IPs, mandatory in live.** In live, a key with `wallet:load` only works from the IPs of your servers that the owner registered (optional on the demo): up to 10, each one a single address (IPv4, or one IPv6 /64 block if your provider gives that whole /64 to you alone; otherwise the single address), within the ones OxioPay has on record for your company. The address compared is the public address your request reaches OxioPay's edge from: after your own NAT, outbound proxy or cloud gateway, not your server's private address. From another IP: `403 ip_not_allowed`, the owner gets an alert for each new address, and calls from 3 unregistered addresses within 24 hours stop new loads at every ATM of the venue (4.6). So never try the live key from a laptop, CI or a staging server. If one of your servers gets `ip_not_allowed`, ask the owner: their panel shows the address that was refused. Also give your IPv6 addresses if your servers go out over IPv6, or force IPv4 in the client: otherwise the call may leave from an address that is not on the list.

**Rotation.** Done by the owner, with their 2FA. The new key is shown only once: OxioPay emails a **one-time link** (valid 24 hours) to your company's registered contact email, or the owner hands it to you directly. Open the link only when you are about to store the key, on the machine that stores it; never screenshot it or paste it into a chat or an email. If the link says it is no longer valid and nobody on your team opened it, tell the owner at once: someone else saw the key and it must be rotated with no overlap. The old key keeps working during the overlap the owner chooses (none if there was a leak, 24 hours by default, or 7 days); meanwhile `GET /me` with the old key shows `key.replaced: true` and `key.expires_at` at the end of the overlap: alert your operators as soon as you see it. After the overlap it answers `401 api_key_rotated` for 30 days, so you can see why it fails. A rotation keeps the connection: the same `pc_` id, your loads and your transaction ids.

**Revocation.** By the owner or the manager, with one tap. It applies from the next request: `401 api_key_revoked`. If you ever suspect the key has leaked, tell the owner so they rotate it with no overlap.

**Expiry and dormancy.** A key with `wallet:load` expires after 365 days at most (`key.expires_at` in `GET /me`; after that, `401 api_key_expired`): alert your operators 30 days before and ask the owner for a rotation with a 7-day overlap. A key that makes no wallet call (balance, loads, voids, `/wallet/operations`, `/statement`) for 90 days is suspended (`401 api_key_suspended`) and the owner reactivates it; `GET /me` alone does not keep it alive.

**What is never logged or stored:**
- **The key**: not in logs, in the code, in the repository, in the ATMs or in URLs.
- **The raw QR text** (the phone code or the ficha link).
- **The chip number (UID)** beyond the transaction.
- **The live codes** (`OXC1:…`).
- **Customers' balances** (`available`, `balance_after`): only on the screen and the ticket.
- And nothing personal in `description` or in `reference`: no phone numbers, no emails, no long numbers.

What is logged, on every call: the response's `Request-Id` header, the load id (`wl_…`), your `reference`, the amount and the error code. From an error, log `code`, `status`, `request_id`, `param` and `limit`, never the whole body. If you send `X-Request-Id` (letters, digits and `-`, up to 64), OxioPay echoes it back as `Request-Id`.

---

## 3. Identifying the customer

The ATM reads **one of these two things** and sends it as is in `qr`. It never sends a typed code, a phone number, an internal id or a PIN. Send only texts that start with `OXC1:`, `NPF:` or `https://`, or that are exactly 6 letters or digits; anything else (contact cards, Wi-Fi codes, other payment QRs, plain text) is not OxioPay's: show the «No reconocemos este código» text without calling.

**1. The phone code (live code).** The customer opens their balance page on their phone and taps «Pagar o recargar en otro sistema». The button follows the language of the customer's page: in English, "Pay or top up in another system". A QR appears holding the text `OXC1:` + 26 characters, for example `OXC1:K3J7Q2M9X4T8R6V1N5B0C2D7F9`.
- In the pilot this code **only identifies**: it serves to read the balance and to load. Reading the balance or loading does not use it up.
- Each code is valid for **60 seconds**. The page renews it every 45 seconds for 5 minutes from when the customer tapped the button; after that they have to tap it again.
- The reader must read QR codes from a phone screen (QR in alphanumeric mode, uppercase). Set the scanner to serial mode (virtual COM / USB-CDC, or its SDK), not keyboard emulation, and turn off any prefix or suffix it adds: with keyboard emulation `:` and `/` can come out as other characters, and the text passes through the operating system's keyboard input.

**2. The ficha by NFC.** The ficha (the venue's NFC tag) carries a link `https://<host>/?ficha=<code>` written in an NDEF record of type URI.
- Send in `qr` the full link, with the record's prefix already expanded (`https://…`), exactly as a phone would open it.
- Send in `nfc_uid` the chip's serial number (UID) in hexadecimal, in the order the chip sends it: the order Android (`Tag.getId()`) and PC/SC `GET DATA` (`FF CA 00 00 00`) give, and the one OxioPay stores. The venues' NTAG213/215/216 fichas have 7 bytes starting with `04` (`04A1B2C3D4E5F6`). With or without `:`, `-` or spaces between bytes. **Never reversed and never as a decimal number**: some readers give it that way, and then every genuine ficha with a stored number answers `409 ficha_copy_suspected` and the owner gets an alert. Send it whenever you read the ficha by NFC, and only then: with a phone code it is an error (`422 validation_failed`).
- If OxioPay has a different number stored for that ficha, it is a copy: `409 ficha_copy_suspected` (and the owner gets an alert). A ficha with no stored number, or a ficha link sent without `nfc_uid`, is accepted as a plain link (a copy cannot be detected then). OxioPay never stores the number you send.
- A ficha printed as a QR (the same link) also works, as a plain link.

**Before asking for the money**, identify with `POST /wallet/balance`: the refusals of the wallet and of the ficha arrive before the customer inserts any notes. The venue's refusals (its switches, pauses and night limit) and the per-wallet limits only come with the load; the escrow then gives the notes back (4.2).

**What is refused and what to tell the customer.** OxioPay refuses anything that is not one of those two. With `422 wallet_ref_not_accepted`, the field `reason` says what the customer showed. The refusal depends only on the shape of the text: the answer is the same whether the link is valid, unknown or of another company.

| What they showed | Response | Text for the customer (ES) | Text for the customer (EN) |
|---|---|---|---|
| The Google Wallet card (`https://<host>/c/…`) | `422 wallet_ref_not_accepted`, `reason: wallet_pass` | La tarjeta de Google Wallet no sirve en el cajero. Abre tu página del saldo y pulsa «Pagar o recargar en otro sistema», o acerca tu ficha. | The Google Wallet card does not work at this machine. Open your balance page and tap "Pay or top up in another system", or tap your NFC tag. |
| The private link to their wallet (`…/w/<code>` or one of its pages) | `reason: private_link` (the owner gets an alert) | Ese es el enlace privado de tu saldo: no lo enseñes a nadie. Abre tu página y pulsa «Pagar o recargar en otro sistema». | That is the private link to your balance: never show it to anyone. Open your page and tap "Pay or top up in another system". |
| The reception QR (`NPF:…`) | `reason: reception_qr` | Ese QR es para recoger tu ficha en recepción. Acerca tu ficha o enseña el código de «Pagar o recargar en otro sistema». | That QR is for collecting your NFC tag at reception. Tap your NFC tag or show the code from "Pay or top up in another system". |
| The 6-character code (or a link with `?saldo=`) | `reason: short_code` | El código de 6 letras no sirve en el cajero. Acerca tu ficha o enseña el código de tu página del saldo. | The 6-character code does not work at this machine. Tap your NFC tag or show the code on your balance page. |
| A charge link (`/s/…`, `/pay/…`) | `reason: charge_link` | Eso es un cobro, no tu saldo. Enseña el código de «Pagar o recargar en otro sistema». | That is a payment request, not your balance. Show the code from "Pay or top up in another system". |
| An activation, reservation or gift link, or another `/w/` link (`/w/a/…`, `/w/card/…`, `/w/salida/…`, `/w/no/…`) | `reason: other_link` | Ese enlace no es tu saldo. Abre tu página del saldo y pulsa «Pagar o recargar en otro sistema». | That link is not your balance. Open your balance page and tap "Pay or top up in another system". |
| Anything else | `422 wallet_ref_unrecognized` | No reconocemos este código. Acerca tu ficha o enseña el código de tu página del saldo. | We do not recognise this code. Tap your NFC tag or show the code on your balance page. |
| An expired or unknown phone code | `422 live_code_invalid` | El código ha caducado. Vuelve a enseñarlo. | The code has expired. Please show it again. |

And the refusals of the wallet or the ficha (with the same text in chapter 5):

| Response | What is going on | Text for the customer (ES) | Text for the customer (EN) |
|---|---|---|---|
| `404 wallet_not_found` | It does not exist, or it belongs to another group, or to a venue of another company | Este saldo no se puede cargar en este cajero. | This balance cannot be topped up at this machine. |
| `409 wallet_blocked` | Wallet blocked | Este saldo está bloqueado. Habla con el personal. | This balance is blocked. Please speak to the staff. |
| `409 wallet_closed` | Wallet closed | Este saldo está cerrado. Habla con el personal. | This balance is closed. Please speak to the staff. |
| `409 ficha_lost` | Ficha reported lost | Esta ficha está dada de baja. Si es tuya, ve a recepción. | This NFC tag has been reported lost. If it is yours, please go to reception. |
| `409 ficha_blocked` | Ficha blocked | Esta ficha está bloqueada. Ve a recepción. | This NFC tag is blocked. Please go to reception. |
| `409 ficha_copy_suspected` | The chip number is not the ficha's | Esta ficha no se puede usar aquí. Ve a recepción. | This NFC tag cannot be used here. Please go to reception. |

An empty wallet is not an error: `available: 0`, and a load reopens it.

---

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

---

## 5. Errors and retries

Errors come as `application/problem+json`:

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

Always decide by `code`, never by `title` or `detail`. `detail` is for you (in Spanish with `Accept-Language: es`) and never repeats a value you sent; the customer is shown the text from this table. Extra fields depending on the code: `param` (`invalid_request`, `validation_failed`), `required_scope` (`scope_missing`), `limit` and `remaining` (`limit_exceeded`), `method` and `reason` (`method_disabled`), `reason` (`wallet_ref_not_accepted`), `available` (`balance_already_spent`), `operation` (`idempotency_key_reused`).

**Retry** means: the same request, with the same `Idempotency-Key` and the same body, after `Retry-After`. Any other `4xx` is never repeated unchanged.

Fixed texts the table uses:
- **[fuera de servicio]** / **[out of service]**: «Cajero fuera de servicio. Recarga en recepción.» / "This machine is out of service. Please top up at reception."
- **[espera]** / **[one moment]**: «Un momento, por favor…» / "One moment, please…"
- If the escrow held notes and the result is a definitive refusal, add: «Recoge tu dinero.» / "Please take your money."

| Code | HTTP | What it means | Retry? | Text for the customer (ES) | Text for the customer (EN) |
|---|---|---|---|---|---|
| `invalid_request` | 400 | Unreadable request: a body that is not a JSON object, a `Content-Type` other than `application/json`, a badly formatted `Idempotency-Key` | No: a bug in your code | [fuera de servicio] | [out of service] |
| `idempotency_key_missing` | 400 | A load without `Idempotency-Key` | No | [fuera de servicio] | [out of service] |
| `api_key_in_url` | 400 | The key was in the URL; the owner gets an alert to rotate it | No: fix it and ask for a new key | [fuera de servicio] | [out of service] |
| `api_key_in_body` | 400 | The key was in the body | No | [fuera de servicio] | [out of service] |
| `invalid_api_key` | 401 | Unknown key (or blocked for 15 minutes after 20 failures) | No | [fuera de servicio] | [out of service] |
| `api_key_rotated` | 401 | The key was replaced by another one and the overlap is over | No: put in the new one | [fuera de servicio] | [out of service] |
| `api_key_revoked` | 401 | Key revoked | No | [fuera de servicio] | [out of service] |
| `api_key_expired` | 401 | Key expired | No: ask for a new one | [fuera de servicio] | [out of service] |
| `api_key_suspended` | 401 | 90 days without wallet calls; the owner reactivates it | No | [fuera de servicio] | [out of service] |
| `wrong_environment` | 401 | A test key in live or a live key on the demo | No | [fuera de servicio] | [out of service] |
| `limit_exceeded` + `per_operation` | 402 | More than the maximum per top-up | No (another amount = another transaction) | Como mucho {remaining} € por recarga. | At most {remaining} € per top-up. |
| `limit_exceeded` + `wallet_24h` | 402 | This wallet's 24 h limit at these ATMs | No | Ahora puedes cargar como mucho {remaining} € más en este saldo. (Si es 0: Este saldo ha llegado al tope de recargas de 24 horas.) | Right now you can top up at most {remaining} € more on this balance. (If 0: This balance has reached its 24-hour top-up limit.) |
| `limit_exceeded` + `wallet_24h_all_partners` | 402 | This wallet's 24 h limit across all partners | No | Este saldo ha llegado al tope de recargas de 24 horas. | This balance has reached its 24-hour top-up limit. |
| `limit_exceeded` + `unnamed_wallet_30d` | 402 | 1,500 € in 30 days on a wallet without a phone | No | Este saldo ha llegado al tope de 1.500 € en 30 días. Para cargar más, pide al encargado que apunte tu teléfono. | This balance has reached the 1,500 € limit for 30 days. To top up more, ask the manager to add your phone number. |
| `limit_exceeded` + `connection_night` | 402 | The night limit of all the venue's ATMs | No (4.2) | Los cajeros no admiten más recargas esta noche. Recarga en recepción. | The machines take no more top-ups tonight. Please top up at reception. |
| `cash_limit_reached` | 402 | This wallet's cash would reach 1,000 € in 24 h (reception and ATMs together) | No | Por ley, este saldo no admite más efectivo ahora. Habla con recepción. | By law, this balance cannot take more cash right now. Please speak to reception. |
| `scope_missing` | 403 | The key lacks that permission (`required_scope`) | No | [fuera de servicio] | [out of service] |
| `scope_paused` | 403 | New loads paused (automatic pause); the owner resumes them | No (4.2) | Las recargas en este cajero están paradas. Recarga en recepción. | Top-ups at this machine are stopped. Please top up at reception. |
| `ip_not_allowed` | 403 | A call from an unregistered IP; the owner gets an alert | No | [fuera de servicio] | [out of service] |
| `browser_not_allowed` | 403 | The request carried an `Origin` header | No | [fuera de servicio] | [out of service] |
| `partner_suspended` | 403 | OxioPay suspended your company as a partner | No | [fuera de servicio] | [out of service] |
| `connection_paused` | 403 | The owner or OxioPay paused the connection, or the venue is no longer in the key's company with its tax id (until OxioPay fixes it) | No | [fuera de servicio] | [out of service] |
| `partner_api_frozen` | 403 | OxioPay froze loads and voids | No (4.2) | Las recargas no están disponibles ahora. Recarga en recepción. | Top-ups are not available right now. Please top up at reception. |
| `wallet_not_found` | 404 | No wallet within your reach has that reference (it does not exist, another group or another company) | No | Este saldo no se puede cargar en este cajero. | This balance cannot be topped up at this machine. |
| `load_not_found` | 404 | That load is not this connection's | No | (no se enseña) | (not shown) |
| `not_found` | 404 | API switched off or entirely frozen, or a route that does not exist. With the API switched off the body may not be JSON | No (check `GET /me` later) | [fuera de servicio] | [out of service] |
| `wallet_blocked` | 409 | Wallet blocked | No | Este saldo está bloqueado. Habla con el personal. | This balance is blocked. Please speak to the staff. |
| `wallet_closed` | 409 | Wallet closed | No | Este saldo está cerrado. Habla con el personal. | This balance is closed. Please speak to the staff. |
| `ficha_lost` | 409 | Ficha reported lost | No | Esta ficha está dada de baja. Si es tuya, ve a recepción. | This NFC tag has been reported lost. If it is yours, please go to reception. |
| `ficha_blocked` | 409 | Ficha blocked | No | Esta ficha está bloqueada. Ve a recepción. | This NFC tag is blocked. Please go to reception. |
| `ficha_copy_suspected` | 409 | The chip number is not the ficha's; the owner gets an alert | No | Esta ficha no se puede usar aquí. Ve a recepción. | This NFC tag cannot be used here. Please go to reception. |
| `method_disabled` + `wallet` | 409 | The venue switched balance off in its settings (`reason: venue_setting`) | No (4.2) | Este local no admite recargas de saldo ahora. | This venue is not taking balance top-ups right now. |
| `method_disabled` + `cash_top_up` | 409 | The venue switched cash top-ups off in its settings (`reason: venue_setting`) | No (4.2) | Este local no admite ahora recargas en efectivo. | This venue is not taking cash top-ups right now. |
| `void_window_passed` | 409 | A void after the 10 minutes | No | (no se enseña: incidencia para el local) | (not shown) |
| `balance_already_spent` | 409 | The wallet no longer covers the load you wanted to void (`available`) | No | (no se enseña: incidencia para el local) | (not shown) |
| `body_too_large` | 413 | Body over 16 KB | No | [fuera de servicio] | [out of service] |
| `validation_failed` | 422 | A field breaks its rule (`param`), an extra field, `nfc_uid` with a phone code, or a card number in `reference` | No | [fuera de servicio] | [out of service] |
| `wallet_ref_unrecognized` | 422 | What was read is nothing of OxioPay's | No (read something else) | No reconocemos este código. Acerca tu ficha o enseña el código de tu página del saldo. | We do not recognise this code. Tap your NFC tag or show the code on your balance page. |
| `wallet_ref_not_accepted` | 422 | It is OxioPay's but does not work here (`reason`, chapter 3) | No | El texto de su `reason` (capítulo 3) | The text for its `reason` (chapter 3) |
| `live_code_invalid` | 422 | Phone code expired or unknown | Yes, after reading the code again and checking the balance with the customer (4.2), with the same transaction id | El código ha caducado. Vuelve a enseñarlo. | The code has expired. Please show it again. |
| `description_invalid` | 422 | `description` with characters or links that are not allowed | No: fix the text | [fuera de servicio] | [out of service] |
| `description_personal_data` | 422 | `description` looks like personal data (an email, 9 or more digits, a card) | No: fix the text | [fuera de servicio] | [out of service] |
| `funding_not_allowed` | 422 | Payment method not accepted (in the pilot, anything other than `cash`) | No | Este cajero solo admite efectivo. | This machine only takes cash. |
| `idempotency_key_reused` | 422 | That `Idempotency-Key` already holds another operation (`operation`) | No: check the operation (4.2) | (no se enseña) | (not shown) |
| `range_too_long` | 422 | Period too long in the reconciliation | No | (no se enseña) | (not shown) |
| `venue_paused` | 423 | The venue (or its company) is paused | No (4.2) | El local no admite recargas ahora. | The venue is not taking top-ups right now. |
| `rate_limited` | 429 | Too many requests; nothing was done | Yes, after `Retry-After` (above 15 seconds: 4.2 and 4.3) | [espera] | [one moment] |
| `try_later` | 503 | OxioPay cannot answer safely right now; nothing was done | Yes, after `Retry-After` (above 15 seconds: 4.3) | [espera] | [one moment] |
| `internal_error` | 500 | Unexpected OxioPay failure: it is unknown whether it was loaded | Yes (4.3) | [espera] | [one moment] |
| another `5xx`, no response or timeout | — | Network or OxioPay failure: it is unknown whether it was loaded | Yes (4.3); if it is still unknown, reconcile | [espera] | [one moment] |

`{remaining}` is in cents: show it in euros (`remaining / 100`, two decimals, «300,00» in Spanish), rounded down to an amount your ATM can take in notes.

**A `code`, `limit` or `reason` you do not know** (the API only grows): use the text for its HTTP status. `402`: «Este saldo no admite esta recarga ahora. Recarga en recepción.» / "This balance cannot take this top-up right now. Please top up at reception." `409` or `423`: «Este saldo no se puede cargar ahora. Habla con el personal.» / "This balance cannot be topped up right now. Please speak to the staff." Any other `4xx`: [fuera de servicio] / [out of service].

---

## 6. Reconciliation

**The venue's night.** It runs from 08:00 to 08:00 (Madrid time) and is named after the day it starts: the night `2026-12-05` runs from 5 December at 08:00 to 6 December at 08:00. In UTC: in winter from 07:00Z to 07:00Z, in summer from 06:00Z to 06:00Z. The night of the clock change lasts 23 or 25 hours. A load at 00:41 on Saturday belongs to Friday's night.

**The loads of a night**: `GET /wallet/operations?business_date=2026-12-05`. Only this connection's (this venue's), oldest first, up to 100 per page (`limit`), with `next_cursor` for the next page (send it as `cursor` with the same filters). Each load appears once, in the night it was made, with its current status (`succeeded` or `voided`, and `voided_at`, whether you or the venue voided it). Instead of `business_date` you can give `from` and `to` (up to 31 days, `to` excluded); both, neither, only one of them, or a `to` not after `from` → `422 validation_failed`. With `reference` you look up one specific transaction:

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

A load appears once OxioPay has finished saving it (at most 30 seconds after it arrived): to get the complete night, read it once the night is over (from 08:05). Reading your loads and the totals keeps working during an automatic pause.

**The totals**: `GET /statement?from=2026-12-05T07:00:00Z&to=2026-12-06T07:00:00Z` (up to 92 days, `to` excluded). They are the same figures the owner sees in «Movimientos» for this connection. Loads count at the moment they were made and voids at the moment of the void, also when the venue voids from its panel (so a load at 07:58 voided at 08:03 falls into two different nights). `net_loads` = loads − voids.

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

**The money.** It belongs to the venue, like the money in the reception till: OxioPay owes you nothing and you owe OxioPay nothing. The ATMs' cash is not part of the reception drawer: the night-close cash count does not expect it there, and the venue's night close (Z report) shows it on its own line, «Caja · Cajeros Demo», which is counted by whoever empties the ATMs. Each ATM's cash is counted every night against `net_loads`, and a shortfall goes to the owner the same day. For each venue and each night, your ATMs' cash must match `net_loads` of `GET /statement` for the same `from` and `to` (in the pilot every load is cash). It matches the «Caja · …» line of the venue's Z when the venue closed the night at 08:00; if it closed earlier, loads made between the close and 08:00 appear in the next Z, and a load voided after 08:00 is subtracted in the night of the void. The split between the ATM company and the venue is handled outside the API. Totals per ATM come from your own records (the API gives totals per venue).

To compute a night's `from` and `to` in Node, without libraries (there is never a clock change at 08:00):

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

## 7. Testing on the demo

**The demo** is a separate OxioPay installation in test mode: `oxp_test_…` keys, responses with `livemode: false`, made-up data and no real money. Live refuses test keys and the demo refuses live keys (`401 wrong_environment`). On the demo the IP list is optional; if OxioPay sets one, it works the same as in live. OxioPay will let you know when the demo is ready.

**Test fichas.** Always the same ones. Their link is `https://demo-operator.oxiopay.example/?ficha=<code>` (you can write it to your own NTAG fichas to test with the real reader). None of them has a phone number. Test keys are for the demo venue «Local Demo Centro» (or another venue of its company and group), the only ones that reach these fichas, and everyone testing on the demo shares them: run limit tests right after `POST /test/fixtures/reset`, and expect loads by other testers.

| Ficha (`fixture`) | Code | Stored UID | Balance | What it answers |
|---|---|---|---|---|
| `active` | `demo-ficha-active-0001` | none | 50.00 € | Works |
| `empty` | `demo-ficha-empty-00001` | none | 0.00 € | Balance 0; loading works |
| `ficha_uid` | `demo-ficha-uid-0000001` | `04A1B2C3D4E5F6` | 50.00 € | Works; with another UID → `409 ficha_copy_suspected` |
| `blocked` | `demo-ficha-blocked-001` | none | 50.00 € | `409 wallet_blocked` |
| `closed` | `demo-ficha-closed-0001` | none | 0.00 € | `409 wallet_closed` |
| `lost_ficha` | `demo-ficha-lost-000001` | none | 50.00 € | The ficha → `409 ficha_lost`; a phone code for its wallet works |
| `ficha_blocked` | `demo-ficha-fblocked-01` | none | 50.00 € | The ficha → `409 ficha_blocked`; a phone code for its wallet works |
| `other_group` | `demo-ficha-othergroup1` | none | 50.00 € | `404 wallet_not_found` (another group of venues) |
| `other_company` | `demo-ficha-othercomp01` | none | 50.00 € | `404 wallet_not_found` (same group, another company) |

Since `active` has no stored UID, any ficha of yours with that link written on it serves to test the real NFC reader. `ficha_uid` only tests the format, sending the UID by hand. To check your reader's byte order, ask OxioPay to register one of your own NTAG fichas on the demo, read by an Android phone at the demo reception: read it with your ATM; it must answer `200`, never `ficha_copy_suspected`.

**Sample refused texts.** The refusal depends only on the shape of the text, so these made-up texts give these answers:

| `qr` | Response |
|---|---|
| `https://demo-api.oxiopay.example/c/demoGoogleWalletPass00000000000000000000001` | `422 wallet_ref_not_accepted`, `reason: wallet_pass` |
| `https://demo-api.oxiopay.example/w/demoPrivateLink000000001` | `reason: private_link` |
| `NPF:K7Q4M2:demoReceptionProof0001` | `reason: reception_qr` |
| `K7Q4M2` | `reason: short_code` |
| `https://demo-api.oxiopay.example/pay/demoChargeLink000000000000000001` | `reason: charge_link` |
| `https://demo-api.oxiopay.example/w/a/demoActivationLink000001` | `reason: other_link` |
| `https://example.org/carta` | `422 wallet_ref_unrecognized` |

**Test helpers** (they only exist on the demo; in live they give `404`):

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

- You can send the code directly in `qr`, or draw it as a QR (alphanumeric mode) on a phone or a screen to test the ATM's scanner.
- The reset gives each test ficha a fresh wallet with its starting balance and state, with the same links and UIDs. Loads already made stay in `/wallet/operations` and `/statement`, but no longer count toward the fichas' limits; your connection's night limit still counts them. Earlier phone codes stop working.
- On request, OxioPay puts your test connection or the demo venue in the states that answer `method_disabled`, `venue_paused`, `partner_api_frozen`, `connection_paused` and `scope_paused`, and back.

**What to test before asking to go live:**

1. The three calls from chapter 1.
2. Each test ficha, by NFC (link + UID) and with a phone code, and each text from chapter 3.
3. Each sample refused text above, and a text your ATM must not send (a Wi-Fi QR): it shows «No reconocemos este código» without calling.
4. An expired phone code (wait more than 60 seconds): `live_code_invalid` → show it again, balance confirmed by the customer → same transaction.
5. A load above the maximum per top-up (your ATM should never get as far as calling) and two loads of 300 € and one of 0.01 € on the same wallet (`limit_exceeded`, `limit: wallet_24h`). `cash_limit_reached` only triggers if the same wallet already holds cash from reception: to see it, ask OxioPay to load cash at reception onto a test ficha; otherwise, treat it like any `402` refusal.
6. `funding: "card"` → `422 funding_not_allowed`.
7. A retry with the same `Idempotency-Key` and the same body → `Idempotent-Replayed: true`, recognised as this transaction's; the same key with another body → `idempotency_key_reused`; an id already used by an earlier transaction → notes given back.
8. A simulated timeout (cut the network after sending): retry, and reconciliation by `reference`.
9. A restart of your servers and of an ATM in the middle of a transaction, and an escrow that gives the notes back by itself (4.3).
10. A void within the 10 minutes, made before giving the notes back and repeated (same response), and after the 10 minutes (`void_window_passed`). `balance_already_spent` needs the customer to spend at the venue: on the demo it cannot be triggered from the ATM.
11. Each venue state that OxioPay sets on request: the ATM shows the chapter 5 text, and with `scope_paused` you can still look up and void your loads.
12. A night's reconciliation with `/wallet/operations` and `/statement`, and that your totals match.
13. A request without `Idempotency-Key`, with the key in the URL, and with the key expired or revoked (ask OxioPay for it): the ATM goes "out of service".
14. Your own NTAG ficha, registered by OxioPay on the demo: it answers `200`, never `ficha_copy_suspected`.

The 1,500 € limit in 30 days is not reached quickly on the demo (the 24-hour ones come first): treat any `limit_exceeded` the same way.

Watch out: the automatic pause also works on the demo. Three refusals by the maximum per top-up within 10 minutes stop your test connection's loads until OxioPay resumes them: space those tests at least 10 minutes apart.

---

## 8. Before going live

**What OxioPay must have done:**

- [ ] OxioPay confirms the live host and the go-live date.
- [ ] The partner agreement and the data processing agreement are signed.
- [ ] Your company is registered as a partner, with its outbound IPs.
- [ ] The pilot venue's company has its legal name and tax id in OxioPay (they appear on the ticket).
- [ ] One connection is set up: the pilot venue, `venue_collects`, `wallet:balance` and `wallet:load`, your fixed IPs, default limits, card off.
- [ ] OxioPay switches the live API on for that venue and confirms it to you in writing.

**What the ATM side must have done:**

- [ ] The live key only on your servers (secrets manager), never in the ATMs, in the code or in the logs. It arrives through the one-time link, opened only when storing it.
- [ ] Calls go out only from the registered IPs (IPv6 too, or IPv4 forced), over TLS with certificate checks, with no proxy that opens TLS or logs headers. No `Origin` header. The key only in `Authorization`.
- [ ] `GET /me` at start-up and every hour; terms, issuer and limits taken from there; an internal alert as soon as `key.replaced` is `true` and 30 days before `key.expires_at`; out of service with `livemode: false` in live.
- [ ] A transaction id unique forever per venue (8 to 64 characters, ending in random characters), used as `Idempotency-Key` and as `reference`, and `device` on every load.
- [ ] Each transaction written to durable storage before the call; restarts and escrow time-outs recovered (4.3).
- [ ] The escrow flow tested: `201` → cash box and ticket (replays checked); refusal → give back; no response → retry with the same `Idempotency-Key`; if still unknown → reconcile by `reference` before giving anything back; "pending" ticket if OxioPay does not answer.
- [ ] Expired phone code → read again, balance confirmed by the customer, and repeat with the same id.
- [ ] Maximum per top-up checked before calling.
- [ ] Cash only (`funding: "cash"`).
- [ ] The scanner in serial mode; only `OXC1:`, `NPF:`, `https://` and 6-character texts sent.
- [ ] Your reader's serial is the one an Android phone reads (tested on the demo with your own ficha); before opening to customers, three real fichas of the pilot venue tapped on a live ATM with the manager: none answers `ficha_copy_suspected`.
- [ ] Terms on screen, with acceptance, before taking the money; complete ticket (4.7).
- [ ] The chapter 5 texts in Spanish and English.
- [ ] Void only when the money did not stay with the venue, within the 10 minutes, before giving the notes back.
- [ ] Reconciliation per night and per venue with `/wallet/operations` and `/statement`, equal to your cash count.
- [ ] In the logs: `Request-Id`, `wl_…`, `reference`, amount and error code. Never the key, the QR text, the UID, the phone codes or balances.
- [ ] All the tests from chapter 7, done on the demo.
