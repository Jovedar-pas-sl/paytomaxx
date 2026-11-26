# Errores de la API de socios / Partner API errors

<!-- generated: pnpm --filter @nightpay/api partner:docs, de packages/contracts/src/partner/errors.ts. No se edita a mano. -->

Decide por `code`, nunca por `title` ni `detail`. `detail` sale en inglés o, con `Accept-Language: es`, en español.
Branch on `code`, never on `title` or `detail`. `detail` is English, or Spanish with `Accept-Language: es`.

| code | HTTP | title | detail (en) | detail (es) |
|---|---|---|---|---|
| `invalid_request` | 400 | Invalid request | Unreadable request: a body that is not a JSON object, a `Content-Type` other than `application/json`, a badly formatted `Idempotency-Key` | Petición ilegible: cuerpo que no es un objeto JSON, `Content-Type` distinto de `application/json`, `Idempotency-Key` con formato malo |
| `api_key_in_url` | 400 | API key in URL | Send the key only in the Authorization header. Ask the owner to rotate this key. | La clave iba en la URL; el dueño recibe aviso para rotarla |
| `api_key_in_body` | 400 | API key in body | The key was in the body | La clave iba en el cuerpo |
| `invalid_api_key` | 401 | Invalid API key | This key is not valid. | Clave desconocida (o bloqueada 15 minutos tras 20 fallos) |
| `api_key_rotated` | 401 | API key rotated | The key was replaced by another one and the overlap is over | La clave se cambió por otra y el solape acabó |
| `api_key_revoked` | 401 | API key revoked | Key revoked | Clave revocada |
| `api_key_expired` | 401 | API key expired | Key expired | Clave caducada |
| `api_key_suspended` | 401 | API key suspended | 90 days without wallet calls; the owner reactivates it | 90 días sin llamadas de saldo; el dueño la reactiva |
| `wrong_environment` | 401 | Wrong environment | A test key in live or a live key on the demo | Clave de prueba en real o real en la demo |
| `scope_missing` | 403 | Scope missing | This key does not hold the scope this route needs. | La clave no tiene ese permiso (`required_scope`) |
| `scope_paused` | 403 | Scope paused | This scope is paused for this connection until the owner resumes it. | Ese permiso está en pausa en esta conexión hasta que el dueño lo reanude. |
| `ip_not_allowed` | 403 | IP not allowed | This key cannot be used from this address. | Llamada desde una IP no registrada; el dueño recibe aviso |
| `browser_not_allowed` | 403 | Browser not allowed | The request carried an `Origin` header | La petición llevaba cabecera `Origin` |
| `partner_suspended` | 403 | Partner suspended | OxioPay suspended your company as a partner | OxioPay suspendió a vuestra empresa como socio |
| `connection_paused` | 403 | Connection paused | The owner or OxioPay paused the connection | El dueño u OxioPay pausaron la conexión |
| `partner_api_frozen` | 403 | Partner API frozen | OxioPay has frozen loads and voids for now. Reading and reconciling still work. | OxioPay congeló las cargas y las anulaciones |
| `not_found` | 404 | Not found | Not found. | API apagada o congelada del todo, o ruta que no existe. Con la API apagada el cuerpo puede no ser JSON |
| `wallet_not_found` | 404 | Wallet not found | No wallet within this key's reach matches this reference. | No hay saldo a vuestro alcance con esa referencia (no existe, otro grupo u otra sociedad) |
| `wallet_blocked` | 409 | Wallet blocked | Wallet blocked | Saldo bloqueado |
| `wallet_closed` | 409 | Wallet closed | Wallet closed | Saldo cerrado |
| `ficha_lost` | 409 | Ficha lost | Ficha reported lost | Ficha dada como perdida |
| `ficha_blocked` | 409 | Ficha blocked | Ficha blocked | Ficha bloqueada |
| `ficha_copy_suspected` | 409 | Ficha copy suspected | The chip's serial does not match this ficha. | El número del chip no es el de la ficha; el dueño recibe aviso |
| `body_too_large` | 413 | Body too large | Body over 16 KB | Cuerpo de más de 16 KB |
| `validation_failed` | 422 | Validation failed | A field breaks its rule (`param`), an extra field, `nfc_uid` with a phone code, or a card number in `reference` | Un campo incumple su regla (`param`), un campo de más, `nfc_uid` con un código del móvil, o un número de tarjeta en `reference` |
| `wallet_ref_unrecognized` | 422 | Wallet reference unrecognized | What was read is nothing of OxioPay's | Lo leído no es nada de OxioPay |
| `wallet_ref_not_accepted` | 422 | Wallet reference not accepted | It is OxioPay's but does not work here (`reason`, chapter 3) | Es de OxioPay pero no sirve aquí (`reason`, capítulo 3) |
| `live_code_invalid` | 422 | Live code invalid | This live code is expired or unknown. Ask the customer to show the code again. | Código del móvil caducado o desconocido |
| `rate_limited` | 429 | Rate limited | Too many requests. Retry after the time in Retry-After. | Demasiadas peticiones; no se hizo nada |
| `internal_error` | 500 | Internal error | Unexpected OxioPay failure: it is unknown whether it was loaded | Fallo inesperado de OxioPay: no se sabe si se cargó |
| `try_later` | 503 | Try later | OxioPay cannot answer safely right now; nothing was done | OxioPay no puede contestar con seguridad ahora; no se hizo nada |
