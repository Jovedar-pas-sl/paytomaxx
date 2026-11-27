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
