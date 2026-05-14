# Integración Paytef Payment LINK — NightPay

**Versión:** 2026-05-14 · Track B sprint dual
**Estado:** implementación lista; pendiente config en panel Paytef + ngrok para webhook en dev.

---

## 1. Qué hace

Paytef es una **pasarela omnicanal española** (orquesta cobros vía acquirers como Wipay/Redsys). Hoy es el único PSP de NightPay con claves reales — la empresa **"Rapido Sin Riesgos"** está dada de alta.

NightPay integra el **API Payment LINK** de Paytef (`https://api.paytef.es/gcf/payment-link/...`), NO el JSON API (`/json/api/transaction`). Razones:

- Payment LINK redirige al **checkout hosted de Paytef** → cero PCI DSS scope para NightPay.
- El `paymentURL` que devuelve `/save` sirve **dos casos a la vez**:
  - Cliente confiado: escanea el QR con su móvil, paga en su navegador.
  - Cliente sin confianza: el camarero escanea el QR **con el PAX A920 Pro**, el PAX abre el link y el cliente paga insertando su tarjeta.
- Cuando el cliente termina, Paytef llama a NightPay vía `notifyResultURL` → webhook que cierra el `Payment` en estado AUTHORIZED.

---

## 2. Setup paso a paso

### 2.1 Panel Paytef — habilitar API + generar token

1. Login en https://my.paytef.es
2. Sidebar → **API de Payment LINK**
3. Toggle **"Habilitar API"** = ON
4. Click **"GENERAR NUEVO TOKEN"**
5. Copiar el token (NO incluir el prefijo `PAYTEF-TOKEN`)
6. **No exponer ese token nunca al frontend** — solo server-to-server

### 2.2 Configurar `.env.local` de NightPay API

```bash
PAYTEF_API_URL=https://api.paytef.es/gcf
PAYTEF_API_TOKEN=<token copiado del panel>
PAYTEF_WEBHOOK_SECRET=<generar con: openssl rand -hex 32>
PAYTEF_WEBHOOK_URL=https://<dominio público de NightPay>/v1/webhooks/paytef
# Opcional: URL del frontend cliente para redirect tras pago
PAYTEF_RETURN_URL=https://pay.nightpay.example/result
```

**Para dev local con webhook funcionando:**

```bash
# Terminal 1 — NightPay API
pnpm -F @nightpay/api dev

# Terminal 2 — ngrok para webhook público
ngrok http 4100
# Copia la URL https://xxxx.ngrok-free.app
# Setea PAYTEF_WEBHOOK_URL=https://xxxx.ngrok-free.app/v1/webhooks/paytef
```

### 2.3 Crear GatewayCredential en DB

```sql
-- Conectar a la DB local
docker exec -i nightpay_postgres psql -U np -d nightpay

-- Activar Paytef para luna-vlc (o el venue que toque)
INSERT INTO gateway_credentials ("tenantId", provider, "credentialsEncrypted", active)
SELECT id, 'PAYTEF', 'managed-via-env', true FROM venues WHERE slug = 'luna-vlc';
```

### 2.4 Reiniciar API

```bash
pnpm -F @nightpay/api dev
```

Logs esperados:
- `[PaytefAdapter] adapter initialized` (si lo añades al constructor)
- En el primer cobro: `[PaytefAdapter] Paytef authorized: paymentID=... url=https://link.paytef.es/link/...`

---

## 3. Flujo end-to-end

### 3.1 Modo cliente con móvil

```
Chica → operator app → "Cobrar 50€"
NightPay API → POST /v1/payments
  → resolver venue.gatewayCredential.provider = 'PAYTEF'
  → PaytefAdapter.authorize()
    → POST https://api.paytef.es/gcf/payment-link/save
    → POST https://api.paytef.es/gcf/payment-link/publish
  → response: providerTxId = paymentID
  → guarda en Payment + genera QR de NightPay
Chica → muestra QR al cliente
Cliente → escanea QR con su móvil
  → abre https://link.paytef.es/link/<paymentID>
  → checkout hosted Paytef (Apple Pay / Google Pay / formulario tarjeta)
  → cliente paga
Paytef → POST a notifyResultURL
  = https://api.tudominio.com/v1/webhooks/paytef/<PAYTEF_WEBHOOK_SECRET>
NightPay API → webhooks.controller.receivePaytef()
  → verify URL secret + adapter.verifyWebhook()
  → encola job → processor llama transition(AUTHORIZED)
  → Payment AUTHORIZED + OperatorEarning chica generado
```

### 3.2 Modo cliente sin confianza (PAX A920 Pro)

Mismo flow, pero el QR lo escanea **el PAX en lugar del móvil del cliente**:

```
Chica → operator app → "Cobrar 50€"
[mismo flow backend hasta tener paymentURL]
Chica → pasa el QR al camarero
Camarero → escanea el QR con la cámara del PAX
  → el PAX abre el link en su browser nativo
  → cliente inserta tarjeta físicamente en el PAX
Paytef → notifyResultURL → Payment AUTHORIZED [igual que arriba]
```

---

## 4. Endpoints implementados

### NightPay → Paytef

| Método NightPay | Llama a Paytef | Notas |
|---|---|---|
| `PaytefAdapter.authorize()` | `POST /payment-link/save` + `POST /payment-link/publish` | Crea solicitud + la publica para que sea visible al cliente |
| `PaytefAdapter.getStatus()` | `GET /payment-link/get/{paymentID}` | Para orphan-reconcile cuando no llega webhook |
| `PaytefAdapter.refund()` | **NO existe** en Paytef API | Lanza error `paytef-refund-manual-required`; admin refundea desde my.paytef.es |

### Paytef → NightPay

| Endpoint NightPay | Disparado por | Auth |
|---|---|---|
| `POST /v1/webhooks/paytef/<PAYTEF_WEBHOOK_SECRET>` | Paytef llama `notifyResultURL` tras cerrar transacción | URL secreta (path param) + validación de payload |

---

## 5. Mapeo de status

| Paytef field | Status NightPay | FSM event |
|---|---|---|
| `data.lastResult.isApproved = true` | AUTHORIZED | `AUTHORIZED` |
| `data.isCanceled = true` | FAILED | `FAILED` (reason: canceled) |
| `data.isExpired = true` | FAILED | `FAILED` (reason: expired) |
| `data.lastResult.isApproved = false` | FAILED | `FAILED` (reason: resultReason o resultCode) |
| Otros (lifecycle interno) | PROCESSING | ignorado |

---

## 6. Seguridad del webhook

Paytef **NO firma webhooks** con HMAC estándar a fecha de mayo 2026. Para protegernos:

1. **URL secreta** (`/v1/webhooks/paytef/<secret>`): solo Paytef conoce esta URL porque se configura en `notifyResultURL`. Filtra 99% del tráfico atacante.
2. **Validación cruzada**: el processor del webhook puede re-leer el `paymentID` via `GET /payment-link/get/{id}` para confirmar estado (Paytef = fuente de verdad).
3. **Idempotency**: `externalEventId = paymentID_<txnKey>` en `webhookDeliveries` evita duplicados.
4. **Replay window**: si Paytef añade `X-Paytef-Timestamp` en el futuro, el adapter ya valida ±5 min.

Cuando Paytef añada firma HMAC (PR pedido), descomentar/usar el camino HMAC en `paytef.adapter.ts:verifyWebhook()`.

---

## 7. Troubleshooting

### "PAYTEF_API_TOKEN not configured"
→ Falta `PAYTEF_API_TOKEN` en `.env.local`. Pegar el token del panel Paytef.

### Webhook no llega
1. ¿`PAYTEF_WEBHOOK_URL` apunta a una URL pública (no localhost)? Usa ngrok en dev.
2. ¿`notifyResultURL` en el body del save coincide con la URL en `.env`? (lo construye el adapter automáticamente).
3. Logs de Paytef en my.paytef.es → Transacciones → ver el "estado de notificación".

### "Paytef refund manual required"
Esperado. Paytef no expone refund por API. Solución:
1. Admin entra a my.paytef.es → Transacciones → busca la txn → click "Anular".
2. En NightPay, marcar manualmente el `Refund` como SUCCEEDED via panel admin (o SQL).

### El cobro queda en PROCESSING aunque el cliente pagó
- Webhook no llegó → orphan-reconcile (cron 30 min) llama `getStatus()` y cierra el Payment.
- Si pasa frecuentemente, revisar configuración del webhook.

### Apple Pay / Google Pay no aparecen en el checkout Paytef
- Verificar con Paytef si el commerce tiene esos métodos habilitados (suelen requerir activación específica).
- Si no se puede activar, escalar a Plan B: construir checkout propio en `web-client/src/app/pay/[token]/page.tsx` usando Payment Request API + Paytef JSON API (`/json/api/transaction`) — requiere PCI DSS scope adicional.

---

## 8. Métrica UX objetivo

| Métrica | Objetivo | Cómo medir |
|---|---|---|
| Tiempo escaneo QR → AUTHORIZED | < 60s | Diff entre `payment.createdAt` y `payment.updatedAt` (cuando llega AUTHORIZED) |
| % cobros con contactless (Apple/Google Pay) | > 50% | Inspeccionar `data.lastResult.cardBrand` cuando indique tap (Paytef debería distinguirlo) |
| % AUTHORIZED dentro del primer minuto | > 80% | Misma diff anterior, agrupada |

Si las métricas no cumplen → activar Plan B (checkout propio).

---

## 9. Diferido / pendiente

- **Refund automático por API** — esperando que Paytef lo añada.
- **Firma HMAC del webhook** — esperando que Paytef la añada.
- **Statement descriptor personalizado** — confirmar con Paytef soporte que el campo `description` del save aparece en el extracto del cliente.
- **Apple/Google Pay como botón primario** — verificar que el checkout Paytef los ofrece prominentemente. Si no, Plan B.
- **DCC (Dynamic Currency Conversion)** — el campo `dccData` viene en GET. Hoy no lo procesamos; futuro: exponer al admin la opción.
