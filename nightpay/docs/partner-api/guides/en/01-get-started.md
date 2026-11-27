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
