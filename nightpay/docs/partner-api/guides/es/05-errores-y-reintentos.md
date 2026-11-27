---
en_sha256: 0845c49438f9f0250a0a93a1525fb4c1644c019382c89c3c85155458092f07ce
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
