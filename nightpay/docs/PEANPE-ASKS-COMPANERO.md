# Asks Peanpe — preguntas para el compañero

**Fecha**: 2026-05-29
**Estado**: lista completa generada tras audit + estabilización del adapter (rama `fix-peanpe-stabilize`).
**Objetivo**: en una sola conversación con el compañero, desbloquear todo lo pendiente de Peanpe sin volver a molestarle.

---

## Cómo usar este documento

- Bloque **🔴 P0** = bloquea cobros nuevos o seguridad → preguntar primero.
- Bloque **🟡 P1** = mejora UX/operativa actual → preguntar si hay tiempo.
- Bloque **🟢 P2** = NP Solución / Phase 2 (futuro recurrente con PIN) → preguntar si la conversación va bien.

Cada item incluye: **pregunta literal** + **por qué lo necesitas** + **qué hacer con la respuesta**.

---

## 🔴 P0 — Bloquean producción / verificar HOY

### 1. Formato de `cantidad` — céntimos o euros enteros

**Pregunta literal**:
> "En el campo `cantidad` de la URL `accion=pagar`, ¿se envía el importe en céntimos (50€ = `5000`) o en euros enteros (50€ = `50`)? La doc no lo especifica claramente."

**Por qué importa**: si yo asumo céntimos y Peanpe espera euros, **cobramos al cliente ×100** (un cobro de 50€ se carga como 5.000€). Es el riesgo más crítico abierto ahora mismo.

**Qué hacer con la respuesta**:
- Si dice **céntimos** → set env `PEANPE_AMOUNT_FORMAT_VERIFIED=cents` en Dokploy.
- Si dice **euros** → set env `PEANPE_AMOUNT_FORMAT_VERIFIED=euros`.
- Verificar con endpoint `GET /v1/debug/peanpe/dry-run?amount=100&format=<la respuesta>` + tarjeta debug `4548812049400004` por 1€.

**Mientras no se responda**: el código BLOQUEA cobros ≥500€. Cobros <500€ se procesan asumiendo céntimos (riesgo silencioso ×100 si la asunción es errónea).

---

### 2. Webhook URL configurada en el panel

**Pregunta literal**:
> "¿Puedes verificar/configurar en el panel peanpe.com que el **Webservice URL** (la que Peanpe llama tras el pago) apunte a:
> `https://api.paytomaxx.com/v1/webhooks/peanpe/notify`
> (sin trailing slash). Y que el **ThankYou URL** apunte a:
> `https://api.paytomaxx.com/pay/result`"

**Por qué importa**: la doc oficial dice que **estas URLs NO se pueden cambiar por API — solo soporte Peanpe**. Si no están bien configuradas, cuando un cliente paga, Peanpe llama a otra URL (la del tokenea.com antiguo o vacía) → el cobro queda en AUTHORIZING para siempre.

**Qué hacer con la respuesta**:
- Si confirma: probar un cobro pequeño y verificar en logs NightPay que entra `POST /v1/webhooks/peanpe/notify` + `GET ...notify?...`.
- Si tiene otra URL configurada: pedirle el cambio y confirmar timeline (suelen tardar 1-2 días).

---

### 3. Apikey y account_id — están bien?

**Pregunta literal**:
> "Hago verificación de las credenciales con un endpoint debug. ¿Puedes confirmar:
> - apikey actual es hex de 64 caracteres? (longitud 64, solo `0-9a-f`)
> - account_id es numérico?
> - ¿Tienen periodo de validez o son permanentes?
> - ¿Hay rotación automática planeada? Si sí, ¿cómo nos avisan?"

**Por qué importa**: si la apikey rota sin avisar, los cobros se rompen silenciosamente (firma HMAC inválida → Peanpe rechaza la URL). El endpoint `/v1/debug/peanpe/keycheck` valida formato sin exponer el valor.

**Qué hacer con la respuesta**:
- Si rota: pedirle un canal de notificación (email, WhatsApp al admin).
- Si las apikey actuales no cumplen formato: pedir nuevas.

---

### 4. Códigos de error completos en el callback

**Pregunta literal**:
> "El callback GET trae `status=<codigo>` y `msg=<texto>`. ¿Me puedes pasar la lista completa de códigos posibles con su significado oficial? La doc que tengo cubre:
> - 200 (correcto)
> - 401, 402, 403 (security/call/params)
> - 101, 111, 121, 201, 701-703 (card error)
> - 151, 251 (payment error)
> - 500-503, 950, 960, 970, 999 (sistema)
> - 731, 751-757, 771, 776 (blocked)
> - 550-553 (cancelled/expired/denied)
>
> ¿Faltan otros? ¿Algún código que requiera acción especial del comercio (ej: chargeback inminente, fraude detectado)?"

**Por qué importa**: hoy mapeamos cualquier status ≠ 200 a `FAILED` con razón `peanpe_<status>_<msg>`. Si hay códigos que requieren acción específica (ej: bloquear cliente, contactar Peanpe), los estamos ignorando.

**Qué hacer con la respuesta**:
- Crear tabla en código con códigos críticos.
- Si algún código indica "cliente fraudulento", añadir lógica de blocking.

---

## 🟡 P1 — Importante para operativa diaria

### 5. Export de transacciones para reconciliación diaria

**Pregunta literal**:
> "Para reconciliar diariamente nuestros cobros con lo que Peanpe ha procesado realmente, necesito:
> - ¿Hay endpoint API para exportar transacciones de un día? (no encuentro en doc)
> - Si no, ¿hay export CSV desde panel? ¿En qué formato? ¿Se puede automatizar?
> - ¿Hay webhook diario tipo 'daily_summary'?
>
> Lo necesito porque ahora nuestro reconcile-daily marca todo como OK por defecto (no podemos comparar con realidad)."

**Por qué importa**: sin export, la reconciliación es teatro — no detectamos cobros perdidos, doble cargos, refunds mal hechos. Si surge una disputa con un cliente, no podemos validar internamente lo que Peanpe registra.

**Qué hacer con la respuesta**:
- Si hay API: implementar cliente + reconcile-daily real.
- Si solo panel: scheduler diario que descargue + parsee.
- Si nada: documentar como riesgo operacional + verificación manual semanal.

---

### 6. Refund — proceso real

**Pregunta literal**:
> "Cuando un cliente pide devolución:
> - ¿Hay API para refund? La doc dice que no, pero confirmar.
> - Si solo panel: ¿cuánto tarda en aparecer en el extracto del cliente?
> - ¿Hay límite de tiempo desde el cobro original (típicamente 180 días)?
> - ¿El refund parcial está soportado? ¿O solo refund total?
> - ¿Cómo nos notifica Peanpe que el refund se ha procesado? ¿Hay webhook específico para refunds?"

**Por qué importa**: ahora marcamos los refunds manualmente en NightPay tras tocarlos en el panel. Sin webhook de confirmación, si Peanpe rechaza el refund (insuficiencia de fondos, etc.) NightPay queda inconsistente.

**Qué hacer con la respuesta**:
- Si hay API refund: implementar `doRefund` real (hoy lanza error con mensaje "manual required").
- Si hay webhook: registrarlo en panel.
- Documentar SLA del refund para soporte interno.

---

### 7. HTTPS oficial — cuándo

**Pregunta literal**:
> "La URL base actual es `http://peanpe.com/api` (HTTP, no HTTPS). Los navegadores modernos avisan al cliente que la página es 'no segura' cuando llega al formulario. ¿Hay roadmap para HTTPS oficial? ¿Cuándo?"

**Por qué importa**: aunque la firma HMAC protege la integridad, el cliente final ve advertencia de "Conexión no segura" en su móvil → muchos abandonan el cobro. Esto reduce conversión significativamente.

**Qué hacer con la respuesta**:
- Si hay timeline: planificar migración (basta cambiar env `PEANPE_API_BASE_URL`).
- Si no hay: considerar proxy HTTPS propio que reescriba a HTTP solo para Peanpe.

---

### 8. Sandbox vs producción

**Pregunta literal**:
> "Para hacer tests sin riesgo:
> - ¿Hay entorno sandbox separado con cuenta de prueba? ¿O todo es producción con `debug=1` en URL?
> - La tarjeta `4548812049400004` con DNI `123456` — ¿funciona en producción con `debug=1` o solo en sandbox?
> - Si producción con debug: ¿los cobros debug aparecen en el extracto del cliente o se silencian?"

**Por qué importa**: necesito poder probar regresiones del adapter sin afectar contabilidad real. Si todo es producción, cada test es un cobro real (aunque sea de prueba).

**Qué hacer con la respuesta**:
- Si hay sandbox: pedir credenciales sandbox separadas (`PEANPE_API_KEY_SANDBOX`).
- Si no: documentar que tests E2E requieren ventana de pruebas + reversión manual.

---

### 9. Descriptor en extracto bancario

**Pregunta literal**:
> "¿Qué texto aparece en el extracto del cliente cuando paga? ¿Se puede personalizar?
> - Hoy queremos algo neutro tipo 'PAY-NP' o 'DSR-PAGOS' (no algo que delate el local físico).
> - ¿Quién lo configura — Peanpe, BBVA, o yo en panel?
> - ¿Plazo para cambios?"

**Por qué importa**: el descriptor lo ven todos los clientes en su banca móvil. Si pone "ESCORT XYZ" o el nombre del local, hay riesgo reputacional y consultas innecesarias del banco del cliente.

**Qué hacer con la respuesta**:
- Si es Peanpe/BBVA: pedir cambio (ej. "DSR Servicios" o similar neutro).
- Si es panel: configurarlo nosotros.

---

### 10. MCC (Merchant Category Code)

**Pregunta literal**:
> "¿Qué MCC tenemos asignado en Peanpe/BBVA? Para el tipo de servicios que cobramos (acompañantes/escort, negocio legal en España bajo Art. 14 RDL 19/2018):
> - El MCC típico sería 7299 (Personal Services - Other).
> - ¿Es el que tenemos o nos asignaron otro?
> - ¿Hay restricciones extra de Visa/MC para este MCC (límites, monitoring)?"

**Por qué importa**: MCC mal asignado puede causar rechazos de tarjeta del lado del emisor (banco del cliente), aunque BBVA acepte. Algunos bancos bloquean ciertos MCCs por política antifraude.

**Qué hacer con la respuesta**:
- Si MCC no es 7299: confirmar que es el correcto para el negocio.
- Si hay restricciones: ajustar UX (ej: avisar al cliente "si tu tarjeta es rechazada, prueba con otro banco").

---

## 🟢 P2 — NP Solución / futuro recurrente con PIN

Estas preguntas son para la **Fase 2** del producto (cliente paga con PIN tras alta inicial — ver [nightpay/../np-solucion-poc/BRIEFING.md](../../np-solucion-poc/BRIEFING.md) si existe). **Solo preguntar si la conversación va bien y hay tiempo.**

### 11. ¿`accion=suscribirse` funciona realmente?

**Pregunta literal**:
> "La doc menciona `accion=suscribirse` para tokenizar tarjeta del cliente y luego cobrarle más veces sin volver a pedir PAN. ¿Está implementado y disponible?
> - ¿Request exacto? (qué params extra vs `accion=pagar`)
> - ¿Response? ¿Devuelve un `subscriptionId` / token?
> - ¿Cómo cobramos a una suscripción ya creada? ¿Es `accion=cobrar_suscripcion`?
> - ¿Cuánto cuesta extra esta funcionalidad?"

**Por qué importa**: es el bloqueante #1 para el flujo "cliente paga primera vez con tarjeta, segundas veces solo con PIN de 4 dígitos en <10 segundos". Si no existe, hay que pivotar a otro PSP para esta capa.

---

### 12. MIT (Merchant Initiated Transactions) — exención SCA por transacción

**Pregunta literal**:
> "Cuando cobramos a una suscripción ya creada (segunda visita y siguientes):
> - ¿Se puede marcar el cobro como **MIT (Merchant Initiated Transaction)** para exentar SCA (3DS) en cada cobro?
> - ¿Qué flag/param se manda?
> - El primer cobro de alta (que sí lleva SCA) — ¿queda registrado como 'mandato' para los MIT posteriores?
> - ¿Hay texto legal de mandato que debamos mostrar al cliente al hacer el alta?"

**Por qué importa**: si cada cobro recurrente exige SCA (PIN del banco, FaceID, OTP), el flujo "PIN en <10 segundos" no funciona. PSD2 permite MIT exento si hubo SCA inicial + mandato, pero el PSP tiene que soportarlo.

---

### 13. Cobro recurrente con importe variable

**Pregunta literal**:
> "El cobro a una suscripción — ¿puede ser de importe arbitrario one-shot (ej. 80€ en la primera visita, 150€ en la segunda)?
> - ¿O Peanpe exige importe fijo / frecuencia fija (mensual, etc.)?
> - Necesitamos modelo on-demand (cliente paga cuando vuelve al local, importe distinto cada vez)."

**Por qué importa**: si Peanpe solo soporta recurrencias periódicas con importe fijo (típico de suscripciones SaaS), no encaja con nuestro modelo de ocio nocturno (importe variable por visita).

---

### 14. Cancelación de suscripción

**Pregunta literal**:
> "Cuando el cliente pide darse de baja (right to be forgotten GDPR):
> - ¿Endpoint `accion=cancelar`? ¿Cómo se llama exactamente?
> - ¿Borra los datos de tarjeta de Peanpe o solo desactiva la suscripción?
> - ¿Hay webhook que confirme la cancelación?"

**Por qué importa**: GDPR exige right-to-be-forgotten real. Si Peanpe mantiene la tarjeta tokenizada tras 'cancelar', estamos en incumplimiento.

---

### 15. PCI compliance — qué nivel da Peanpe

**Pregunta literal**:
> "Para mantener NightPay en **SAQ-A** (PCI compliance ligero, sin auditoría externa anual):
> - ¿Peanpe garantiza que NightPay nunca recibe PAN ni CVV? (sí en `accion=pagar` actual)
> - Para `accion=suscribirse`: ¿el flujo es similar (cliente teclea en formulario de Peanpe, NightPay solo recibe token)?
> - ¿Peanpe nos provee documento de attestation que podamos enseñar a un auditor?"

**Por qué importa**: si en algún flujo NightPay viera PAN/CVV (aunque sea transitoriamente), pasaríamos a SAQ-D — auditoría anual de ~10k€/año + más controles.

---

## Cosas que puedes confirmar/pedir tú mismo (sin esperar a Peanpe)

1. **Acceso al panel peanpe.com** — credenciales de login (usuario + password) si aún no las tienes en personal. Útil para verificar transacciones tras los tests.
2. **Periodo de soporte** — confirmar horario habitual del compañero por si surge incidencia (3am en discoteca y los cobros fallan).
3. **Canal de comunicación** — fijar WhatsApp, email, Slack para que las preguntas técnicas no se pierdan.

---

## Después de la conversación

Cuando tengas respuestas, podemos:

1. **Aplicar P0** inmediatamente (set env `PEANPE_AMOUNT_FORMAT_VERIFIED`, ajustar códigos error).
2. **Planificar P1** (refund flow, reconciliación real, HTTPS migration) en siguientes sprints.
3. **Decidir P2** (NP Solución Phase 2) — si las 4 preguntas de subscripción tienen respuesta positiva → arrancar POC. Si no → buscar PSP alternativo (Stripe, Adyen) para la capa recurrente.

---

## Ficha resumen — para llevar al teléfono (1 página)

```
P0 — HOY (5 preguntas, 5 min)
  1. cantidad: ¿céntimos o euros?
  2. webhook URL configurada → https://api.paytomaxx.com/v1/webhooks/peanpe/notify
  3. apikey: ¿formato 64 chars hex? ¿rotación?
  4. códigos error completos
  5. ¿accion=suscribirse existe?

P1 — Si hay tiempo (5 preguntas, 5 min)
  6. export transacciones para reconcile
  7. refund: API o solo panel? webhook?
  8. HTTPS cuándo
  9. sandbox separado o todo prod con debug=1
 10. descriptor extracto + MCC

P2 — Si va bien (5 preguntas para NP Solución)
 11. accion=suscribirse: request/response
 12. MIT exenta SCA: cómo
 13. importe variable on-demand
 14. accion=cancelar: borra datos?
 15. PCI SAQ-A: attestation
```

---

**Suerte con la conversación. Tras hablar, ven con las respuestas y aplicamos los cambios pendientes en NightPay.**
