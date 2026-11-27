---
en_sha256: 5e0c8ae7f6e55789a2d8fcea938e77a03b284837526f472c5340f0a2dabcc7a5
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
