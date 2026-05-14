# Integración Peanpe API v2.0 — NightPay

**Versión:** 2026-05-14 · adapter rehecho según doc oficial Peanpe v2.0
**Estado:** implementación lista; pendiente claves Peanpe (`PEANPE_API_KEY` + `PEANPE_ACCOUNT_ID`).

---

## 1. Qué es

Peanpe es una pasarela de cobros online española. Modelo: el cliente paga en el **formulario hosted de peanpe.com** (URL GET con firma HMAC-SHA256), Peanpe llama a nuestro Webservice cuando el pago se completa.

## 2. Diferencias con Paytef y Wipay (importantes)

| Aspecto | Wipay | Paytef | **Peanpe v2.0** |
|---|---|---|---|
| Modo authorize | POST JSON server-to-server | POST `/save` + `/publish` | **No POST** — redirect al usuario via URL GET con firma |
| `providerTxId` | Inmediato | Inmediato | Generado por NightPay (mapping table `peanpe_calls`) |
| Webhook | POST JSON con HMAC en headers | POST JSON URL secreta | **Challenge-response**: POST → respondemos token → GET con seguridad |
| Refund por API | Sí | No | **No** — manual desde panel peanpe.com |
| Status por API | Sí (`GET /transactions/:id`) | Sí (`GET /payment-link/get/:id`) | **No** — orphan-reconcile no funciona |
| Protocolo | HTTPS | HTTPS | **HTTP** (doc oficial — bandera roja, mitigado por HMAC) |
| Identificador externo | UUID (36 chars) | string | **6 chars max** alfanumérico |

## 3. Setup

### 3.1 Credenciales

Peanpe te entrega (1 vez al activar cuenta):
- `apikey`: cadena hexadecimal (~64 chars hex = 32 bytes raw)
- `identificador_cuenta_peanpe`: número entero
- Usuario + password para panel backoffice peanpe.com
- Configurar en su panel la URL de tu "Webservice Comunicación" y "ThankYou page"

### 3.2 Variables de entorno

```bash
PEANPE_API_BASE_URL=http://peanpe.com         # default
PEANPE_API_KEY=<HEX entregado por Peanpe>     # ej "00112233...ff" (64 chars)
PEANPE_ACCOUNT_ID=<número entero>              # ej "91816"
# URL pública NightPay que pones en panel Peanpe como "Webservice":
PEANPE_WEBHOOK_URL=https://api.tudominio.com/v1/webhooks/peanpe/notify
# URL del cliente tras pagar:
PEANPE_THANKYOU_URL=https://pay.tudominio.com/result
```

### 3.3 Activar Peanpe como gateway del venue

```sql
docker exec -i nightpay_postgres psql -U np -d nightpay -c "
INSERT INTO gateway_credentials (\"tenantId\", provider, \"credentialsEncrypted\", active)
SELECT id, 'PEANPE', 'managed-via-env', true FROM venues WHERE slug = 'luna-vlc';
"
```

### 3.4 Configurar webhook + thankyou URLs en panel Peanpe

1. Login en peanpe.com con tus credenciales
2. Comunicar a soporte Peanpe:
   - **Webservice URL**: `https://api.tudominio.com/v1/webhooks/peanpe/notify`
   - **ThankYou URL**: `https://pay.tudominio.com/result`

Peanpe **NO permite cambiar estas URLs por API** — solo lo configura su soporte.

---

## 4. Flujo end-to-end

```
1. Chica genera cobro NightPay (POST /v1/payments).
2. Cliente entra a /pay/<qrToken> (web-client) → POST /start-authorization
3. NightPay backend:
   a. PaymentsService.startAuthorization → transition AUTHORIZING
   b. Llama PeanpeAdapter.authorize() → genera id_llamada 6 chars + securityToken
      10 dígitos. Persiste en `peanpe_calls`. NO hace HTTP a Peanpe.
   c. Frontend pide GET /v1/payments/public/<qrToken>/peanpe-redirect-url
   d. Recibe { provider: 'PEANPE', url: 'http://peanpe.com/api?...&firma=...' }
   e. window.location.assign(url) → redirige al cliente al formulario hosted.
4. Cliente paga en peanpe.com (tarjeta).
5. Peanpe → NightPay (challenge-response):
   a. POST https://api.tudominio.com/v1/webhooks/peanpe/notify
      Body: { identificador_llamada: "ABC123" }
      NightPay responde "1234567890" (texto plano, securityToken persistido).
   b. GET https://api.tudominio.com/v1/webhooks/peanpe/notify?
      identificador_llamada=ABC123&seguridad=1234567890&status=200&msg=correcto
      &accion=pagar&debug=0
      NightPay valida `seguridad === securityToken`, encola job, transita FSM
      → AUTHORIZED + earning chica creado.
6. Peanpe → Cliente: redirect a PEANPE_THANKYOU_URL con
   identificador_llamada + debug + c=1 (ok) o c=2 (ko).
```

---

## 5. Firma HMAC (anti-forgery)

Doc Peanpe: la firma garantiza que los parámetros no fueron alterados.

**Inputs:**
- `apikey` en HEX → convertir a bytes raw: `Buffer.from(apiKey, 'hex')`
- `concat` = `identificador_llamada` + `identificador_cuenta_peanpe` + `cantidad`
- Algoritmo: `HMAC-SHA256(bytes_raw, concat).hex()`

Ejemplo PHP (de la doc):
```php
$concat = $param1 . $param2 . $param3;
$sig = hash_hmac('sha256', $concat, hexToStr($api_key));
```

Implementado en `peanpe.adapter.ts:buildPaymentUrl()`.

---

## 6. Modo pruebas (debug)

Doc Peanpe — para entorno test:
- Añadir `debug=1` en la URL GET
- Tarjeta de prueba: `4548812049400004` con cualquier fecha/CVV
- Número de identificación bancaria: `123456`

El adapter NightPay añade `debug=1` automáticamente si `NODE_ENV !== 'production'`.

---

## 7. Códigos de error Peanpe (doc)

| Code | Significado | NightPay FSM |
|---|---|---|
| 200 | Correcto | AUTHORIZED |
| 401 | security not correct | FAILED (anti-spoof — no debería pasar) |
| 402 | the call not exists | FAILED |
| 403 | params incorrect format | FAILED |
| 101, 111, 121, 201, 701-703 | Card Error | FAILED |
| 151, 251 | Payment Error | FAILED |
| 500-503, 950, 960, 970, 999 | Error sistema | FAILED |
| 731, 751, 752, 756, 757, 771, 776 | Blocked | FAILED |
| 550-553 | Execution cancelled/expired/denied | FAILED |

`mapWebhookToFsmEvent` mapea cualquier status != 200 → `FAILED` con reason `peanpe_<status>_<msg>`.

---

## 8. Limitaciones conocidas

- **identificador_llamada max 6 chars**: NightPay usa una tabla mapping (`peanpe_calls`) — 6 chars con charset 32 (excluyendo 0/O/1/l/I) da ~1B combinaciones, suficiente.
- **No status API**: orphan-reconcile no puede consultar Peanpe. Si un webhook se pierde, el cobro queda en AUTHORIZING forever a no ser que se transite manualmente.
  - **Mitigación**: cron de timeout que pase AUTHORIZING > 30min → FAILED, requiere admin confirmar manualmente desde panel Peanpe.
- **No refund API**: el admin refundea en panel peanpe.com → en NightPay debe marcar el refund manualmente vía SQL o futuro endpoint admin "manual refund".
- **HTTP en base URL**: Peanpe oficial es `http://peanpe.com/api`. La firma HMAC protege la integridad de los parámetros aunque la URL viaje en HTTP, pero el cliente final ve una URL HTTP en su navegador. Cuando Peanpe activa HTTPS (TBD), basta cambiar `PEANPE_API_BASE_URL=https://peanpe.com`.
- **Pagos recurrentes**: la doc Peanpe v2.0 expone API para recurrentes (`accion=suscribirse`, `accion=cancelar`). NightPay actualmente NO los usa (todos los cobros son `accion=pagar`). Si en el futuro se quiere, hay que ampliar el adapter.

---

## 9. Troubleshooting

### "PEANPE_API_KEY o PEANPE_ACCOUNT_ID no configurado"
→ Faltan vars en `.env.local`. Pega los valores entregados por soporte Peanpe.

### Peanpe POST recibe 401 (challenge falla)
→ El `identificador_llamada` que envía no está en `peanpe_calls`. Causas:
- El cobro nunca llegó a `startAuthorization` (FSM no movió de CREATED)
- Race: peanpe POST antes de que NightPay haya persistido el mapping
- Mitigación: revisa que `payment.provider === 'PEANPE'` y consulta `peanpe_calls` por el id

### Peanpe GET responde 401 (seguridad mismatch)
→ El `seguridad` recibido no coincide con `securityToken` persistido. Causa:
- Otra request usando el mismo id_llamada (no debería pasar — id es único)
- Posible ataque de replay
- Revisa logs para `seguridad mismatch` warnings

### Cobro queda en AUTHORIZING > 30 min
→ Peanpe no envió webhook. Causas:
- Webhook URL no configurada en panel Peanpe
- NightPay API caído / no público
- Cliente abandonó el formulario antes de pagar
- Mitigación: admin transita manualmente a FAILED + investiga en panel peanpe.com

### Firma HMAC mismatch (cliente recibe error 401 al cargar formulario)
→ Probable causa: `PEANPE_API_KEY` mal copiada (debe ser HEX, no base64). Verifica `Buffer.from(API_KEY, 'hex').length === 32`.

---

## 10. Métrica UX

Misma que Paytef: tiempo `qrToken scan → AUTHORIZED` < 60s. Si el formulario peanpe es más lento que paytef (probable — es PSP más antiguo), considerar Paytef como provider primario y dejar Peanpe como fallback.

---

## 11. Pendiente / futuro

- **Cron timeout AUTHORIZING > 30 min** → mover a FAILED + alert al admin
- **Endpoint admin "manual refund"**: el admin marca refund tras anular en panel peanpe.com
- **Pagos recurrentes** (suscripciones) si surge caso de uso
- **HTTPS oficial**: confirmar con Peanpe cuándo migran de HTTP
