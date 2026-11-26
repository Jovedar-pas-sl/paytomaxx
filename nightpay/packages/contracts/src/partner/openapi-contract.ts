// Lo del contrato que el documento copia tal cual (docs/partner-api/pilot/openapi-piloto.yaml):
// info, servers, tags, el esquema de seguridad y el ejemplo de la conexión. Si cambia el
// contrato, se cambia aquí (openapi.spec.ts compara las rutas comunes con el contrato).

export const PARTNER_OPENAPI_INFO = {
  "title": "OxioPay Partner API - ATM pilot",
  "version": "1.0.0-pilot",
  "summary": "Identify a customer's wallet, read its balance and load it from the venue's own ATMs.",
  "description": "**There is no refund and no cash withdrawal of the balance.** No route of this API pays money out of a wallet.\n\nThis is the contract for the **ATM pilot** of the OxioPay Partner API v1. The ATM network is a partner whose\nATMs stand inside the venues and only **load** balance. The ATM team builds against this document; the API is\nimplemented to match it, and the OpenAPI document the API serves at `GET /openapi.json` must be equivalent for\nthese routes.\n\nNot in this pilot (each arrives later without breaking anything): paying with balance, charges, webhooks and the\nevents feed, reports, loads collected by the partner itself (agent models). Their routes are not described here; a\nfew of their enum values (`transfer`, `bank_app`, `partner_agent`, `licensed_psp`, `online` and the scopes other\nthan `wallet:balance` and `wallet:load`) appear so that clients accept them; in this pilot they are refused or\nnever returned.\n\n**Hosts.** Every host name ending in `.example` is a placeholder until OxioPay confirms the real one.\n\n**Marked decisions.** `x-decided-in-contract: true` marks a rule fixed by this contract.\n\n## Conventions\n- JSON in UTF-8. Amounts are integer **cents**; `currency` is always `EUR`.\n- Times in answers are RFC 3339 in UTC (`Z`); accept fractional seconds. Times in requests may use `Z` or an offset.\n- `business_date` is the venue's night: from 08:00 to 08:00 Europe/Madrid, named after the day the night starts.\n- Public ids are a prefix plus 32 lowercase hex characters: `pc_` connection, `wl_` load. A wallet never has a\n  public id. No answer carries a wallet id, a customer name, a phone, a wallet code or a ficha number.\n- Lists: `?limit=1..100` (default 25) and `?cursor=` → `{object: \"list\", data, has_more, next_cursor}`.\n- Changes inside v1 are additive: ignore fields, enum values and error codes you do not know (handle an unknown\n  code by its HTTP status). Request bodies are strict: an unknown field is refused with `422 validation_failed`.\n  Unknown query parameters are ignored.\n- Every answer carries the header `Request-Id`. Send `X-Request-Id` (letters, digits and `-`, up to 64) to have\n  your own id echoed; otherwise OxioPay generates a UUID. Log it with every call.\n- Every answer carries `Cache-Control: no-store`.\n- A POST without a body (a void without `reason`, the demo reset) is sent without `Content-Type`;\n  `Content-Type: application/json` with an empty body → `400 invalid_request`.\n\n## Authentication\n- Server to server only. The key lives on the ATM platform's servers, never inside an ATM.\n- Send the key **only** as `Authorization: Bearer oxp_live_…` (live) or `Bearer oxp_test_…` (demo). A key in the\n  URL → `400 api_key_in_url` (and the owner is told to rotate it); a key in the body → `400 api_key_in_body`.\n- A request with an `Origin` header → `403 browser_not_allowed`. Bodies above 16 KB → `413 body_too_large`.\n- In live, the partner API answers only requests that reach it through OxioPay's own edge (its CDN), and the IP\n  list is compared with the address that edge reports for your connection: your public address after your own\n  NAT, outbound proxy or cloud gateway.\n- In live, a key with `wallet:load` must have an IP list, and a key with a list works only from it, on every\n  route (`403 ip_not_allowed`). On the demo the list is optional; when it is set, it applies the same way. Every\n  new address outside the list alerts the owner, and calls from 3 such addresses within 24 hours pause new loads\n  (see `POST /wallet/loads`).\n- One key per venue (a connection = partner × venue). It reaches only the wallets of its venue's wallet group (the\n  same check the venue's own staff use) whose home venue (the venue where the wallet was created) belongs to the\n  same company (tax id) as the key's venue; a home venue without a company counts as another company.\n- Reach is checked before anything else about the reference. Outside it the answer is `404 wallet_not_found`,\n  with the same body as for an unknown ficha, even when the ficha is lost or blocked, its chip serial differs or\n  its wallet is blocked or closed, and nothing is recorded or alerted. A valid live code of a wallet outside reach\n  also answers `404 wallet_not_found`; an expired or unknown live code answers `422 live_code_invalid`.\n- The ATM key holds `wallet:balance` and `wallet:load` only.\n- `x-required-scope` on each operation lists the scopes that allow it (one is enough); `any` means any valid key;\n  an empty list means no key.\n\n## Idempotency\n- `POST /wallet/loads` requires `Idempotency-Key` (8–200 of `[A-Za-z0-9_-]`). Use the ATM's own transaction id;\n  as it is also your `reference`, keep it to 8–64 of `[A-Za-z0-9_-]`. Keys live per connection, forever, also\n  across key rotations: never reuse one for another load.\n- \"The same request\" means the same `amount`, `funding`, `reference`, `device`, `description` (after\n  normalisation), `qr` (after trimming) and `nfc_uid` (without separators, uppercase), compared after JSON\n  parsing: key order, spacing and every header other than `Idempotency-Key` do not matter.\n- Same key and same request → the stored original answer (same status, same `balance_after`) with\n  `Idempotent-Replayed: true`. Same key, different request → `422 idempotency_key_reused`, whose `operation`\n  member is the load that holds the key.\n- OxioPay handles one request per Idempotency-Key at a time: a request whose key is still being processed waits\n  for it (up to 10 seconds, else `503 try_later`), then gets its stored answer, or runs itself if that request was\n  refused. A stored success is replayed before the `qr` is resolved and before the wallet, venue and limit checks.\n- A load either commits within 30 seconds of reaching OxioPay's API or is abandoned; it never commits later.\n- `401`, `403`, `404 not_found`, `429` and `503 try_later` never come from what is stored for the Idempotency-Key:\n  after an attempt whose answer you did not get, they say nothing about that attempt.\n- Only successes are stored: after a definitive refusal the same key may be sent again and runs again.\n- The void is naturally idempotent: repeating it returns the same voided load.\n\n## Errors and retries\nErrors are `application/problem+json` with a stable `code`. Branch on `code`, never on `title` or `detail`.\n`detail` follows `Accept-Language` (`en` by default, `es`) and never repeats a value you sent. Retry `429`, `503`,\nany other `5xx` and timeouts **with the same Idempotency-Key and the same body**, after `Retry-After` when present.\nNever retry any other `4xx` unchanged. `500 internal_error` is an unexpected failure: its body carries only the\nproblem fields and `request_id`. Another `5xx` may come from OxioPay's edge without a JSON body.\n\n## Rate limits (per connection unless said otherwise)\n| Bucket | Limit |\n|---|---|\n| all calls | 600 a minute |\n| money writes (loads and voids) | 120 a minute |\n| balance reads per wallet | 12 a minute; per venue night (`business_date`) 120 with a live code and 20 with a ficha; only reads that answered `200` count |\n| loads per wallet | 6 a minute |\n| `qr` texts that are neither a live code nor a ficha link | 30 a minute; once full, only those texts get `429`: live codes and ficha links keep working |\n| failed authentication | per key string: 20 failures in 10 minutes, then that string gets `401 invalid_api_key` for 15 minutes without being looked up; per IP: 20 distinct bad keys in 10 minutes, then `429 rate_limited` for 15 minutes, never for a valid key whose IP list holds that address |\n\nFailures are `invalid_api_key` and `wrong_environment` only. Over a limit → `429 rate_limited` with `Retry-After`,\nthe seconds until a call is allowed again (over a per-night limit, until 08:00 Madrid). If a limiter cannot be read\n→ `503 try_later`. `429 rate_limited` and `503 try_later` are answered before anything is done.\n"
} as const;

export const PARTNER_OPENAPI_SERVERS = [
  {
    "url": "https://{api_host}/v1/partner",
    "description": "Live. Only `oxp_live_` keys. Real money.",
    "variables": {
      "api_host": {
        "default": "api.oxiopay.example",
        "description": "Placeholder until OxioPay confirms the host.",
        "x-decided-in-contract": true
      }
    }
  },
  {
    "url": "https://{demo_api_host}/v1/partner",
    "description": "Demo deployment in test mode. Only `oxp_test_` keys. Made-up data, no real money.",
    "variables": {
      "demo_api_host": {
        "default": "demo-api.oxiopay.example",
        "description": "Placeholder until OxioPay confirms the host.",
        "x-decided-in-contract": true
      }
    }
  }
] as const;

export const PARTNER_OPENAPI_TAGS = [
  {
    "name": "Connection",
    "description": "The key and its connection."
  },
  {
    "name": "Wallet",
    "description": "Identify a wallet, read its balance, load it and void a load."
  },
  {
    "name": "Reconciliation",
    "description": "The connection's own loads and its totals."
  },
  {
    "name": "Reference",
    "description": "This document."
  },
  {
    "name": "Test helpers (demo only)",
    "description": "**Demo only.** These routes exist only on the demo deployment (test mode with test helpers switched on). In live\nthey do not exist (404). They act only on the demo fixtures, which hold made-up data.\n"
  }
] as const;

export const PARTNER_SECURITY_SCHEMES = {
  "bearerAuth": {
    "type": "http",
    "scheme": "bearer",
    "bearerFormat": "oxp_live_ or oxp_test_ followed by 48 lowercase hex characters",
    "description": "`Authorization: Bearer oxp_live_<48 hex>` in live, `Bearer oxp_test_<48 hex>` on the demo. Live refuses test\nkeys and the demo refuses live keys (`401 wrong_environment`). The key is shown only once: when the owner\ncreates or rotates it, OxioPay emails a one-time claim link (valid 24 hours) to the partner's registered\ncontact email, or the owner hands it over directly. A rotation or a renewal keeps the connection: the same\n`pc_` id, the same loads and the same Idempotency-Keys. During a rotation overlap `GET /me` with the old key\nshows `key.replaced: true`. Keep the key on the ATM platform's servers only.\n",
    "x-decided-in-contract": true
  }
} as const;

/** Ejemplo de la conexión de los cajeros en la demo (lo pasa el esquema Connection: openapi.spec.ts). */
export const PARTNER_CONNECTION_EXAMPLE = {
  "summary": "The ATM network's connection on the demo",
  "value": {
    "object": "connection",
    "id": "pc_3f1c9a7e2b5d4c8e9f0a1b2c3d4e5f60",
    "partner_name": "Cajeros Demo",
    "venue_name": "Local Demo Centro",
    "issuer": {
      "legal_name": "Empresa Demo S.L.",
      "tax_id": "B00000000"
    },
    "collection_model": "venue_collects",
    "channel": "in_venue",
    "status": "active",
    "scopes": [
      "wallet:balance",
      "wallet:load"
    ],
    "paused_scopes": [],
    "livemode": false,
    "key": {
      "hint": "oxp_test_…cdef",
      "expires_at": "2027-11-26T23:00:00Z",
      "replaced": false
    },
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
} as const;

/** Los ejemplos de `POST /wallet/balance` (components.examples del contrato). */
export const PARTNER_WALLET_EXAMPLES = {
  BalanceRequestFicha: {
    summary: 'Ficha read by NFC (fixture ficha_uid)',
    value: { qr: 'https://demo-operator.oxiopay.example/?ficha=demo-ficha-uid-0000001', nfc_uid: '04A1B2C3D4E5F6' },
  },
  BalanceRequestLiveCode: {
    summary: 'Live code scanned from the customer\'s phone',
    value: { qr: 'OXC1:K3J7Q2M9X4T8R6V1N5B0C2D7F9' },
  },
  Balance5000: {
    summary: '50.00 € available',
    value: { object: 'wallet_balance', available: 5000, currency: 'EUR', livemode: false },
  },
} as const;
