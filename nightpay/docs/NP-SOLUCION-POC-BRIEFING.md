# NP Solución — Briefing de Contexto para Agente

> Documento de handoff. Cualquier agente que vaya a trabajar en NP Solución debe leer esto primero. Es autocontenido — no asume conversación previa.

---

## 1. Visión rápida

**NP Solución** es la capa cliente de un sistema de cobros digital, montado sobre la infraestructura **NightPay** (producto existente en producción) y operado por **DSR** (Dinero Sin Riesgos S.L., entidad española con licencia regulatoria).

El objetivo de NP Solución es permitir que un cliente final pague servicios en locales de ocio nocturno español en **menos de 10 segundos**, sin sacar la tarjeta cada vez ni usar el móvil más allá de teclear un PIN.

---

## 2. Las tres entidades del negocio

### DSR (Dinero Sin Riesgos S.L.)
- Empresa española, operativa desde 2018
- **Licencia regulatoria: Entidad de Pago Exenta (EPE) registrada en Banco de España** bajo Art. 14 del RDL 19/2018
- Opera una red de **91 cajeros + 101 TPVs** en salones de juego y ocio nocturno
- Volumen 2025: 23,5M€ procesados, 1,67M€ en comisiones
- Es la entidad legal bajo la cual operan tanto NightPay como NP Solución
- KYC/AML, monitorización de transacciones y relaciones con adquirentes ya activos

### NightPay
- Plataforma de pagos en producción
- Backend: NestJS + Prisma + Postgres + XState saga
- Frontends: app operadora, app TPV, web cliente actual, admin
- Multi-tenant (cada local = un tenant)
- Integraciones de pasarela existentes:
  - **Redsys** (banca española estándar)
  - **Paytef** (middleware hospitality)
  - **Peanpe** (gateway propio, ver abajo)
- Tiene FSM de pagos (XState), circuit breakers en gateways, webhook handlers con HMAC, ledger interno

### NP Solución (NUEVA — a construir)
- Capa cliente final: registro, identidad, PIN, Apple Wallet pass
- Se montará dentro del monorepo NightPay como módulo nuevo
- **Antes de portar, se construye como POC independiente** para validar que la pasarela soporta el flujo

---

## 3. El stack de pago — cómo encajan Peanpe y BBVA

Este punto es crítico de entender porque la arquitectura completa depende de cómo se relacionan.

```
┌────────────────────────┐
│   Cliente final paga   │
│   con tarjeta Visa/MC  │
└───────────┬────────────┘
            │
            ▼
┌────────────────────────┐
│   Peanpe (Gateway)     │  ← Marca propia del operador DSR
│   peanpe.com           │     Recibe el pago, expone la API
└───────────┬────────────┘
            │ subagrega bajo su contrato
            ▼
┌────────────────────────┐
│   BBVA (Acquirer real) │  ← El banco que liquida con Visa/MC
│   procesa la tarjeta   │
└───────────┬────────────┘
            │
            ▼
┌────────────────────────┐
│   Cuenta IBAN de DSR   │  ← Donde acaba el dinero
└────────────────────────┘
```

**Implicaciones clave:**

1. **Peanpe es marca propia, no proveedor externo.** El operador DSR opera Peanpe como su propio gateway de marca blanca. Por eso pueden negociar internamente cosas como el descriptor en extracto o el MCC asignado.

2. **BBVA es el adquirente real.** Visa y Mastercard liquidan a BBVA, y BBVA paga a Peanpe (o directamente a DSR según el contrato comercial). BBVA solo ve a Peanpe como su cliente — no ve a cada chica/operadora individual.

3. **Por qué no se usa BBVA directamente:** los locales (bares, salones de juego, salas nocturnas) tienen sus propios TPVs BBVA para cobros de bebidas/habitaciones. Pero para los cobros de servicios personales (escort, acompañantes — negocio legal en España), BBVA no asignaría el MCC adecuado directamente al local. Peanpe, como intermediario, sí lo gestiona bajo su contrato con BBVA. Esto se llama "sub-aggregation".

4. **MoR (Merchant of Record) ante Visa/MC = Peanpe.** Los clientes finales (chicas/operadoras) son sub-merchants de Peanpe a nivel comercial. A nivel interno NightPay/NP Solución, son sub-cuentas del ledger interno de DSR.

5. **Descriptor en extracto bancario:** lo que el cliente ve en su extracto cuando paga depende de cómo BBVA lo configure para Peanpe. Como Peanpe es marca propia del operador, esto es negociable.

---

## 4. Peanpe v2.0 — qué hace HOY (con la doc actual)

Documentación de referencia en el repo: [nightpay/docs/PEANPE-INTEGRATION.md](../nightpay/docs/PEANPE-INTEGRATION.md)
Adapter implementado: [nightpay/apps/api/src/modules/gateways/peanpe.adapter.ts](../nightpay/apps/api/src/modules/gateways/peanpe.adapter.ts)

**Protocolo Peanpe v2.0 (la versión actualmente integrada):**

- **Modo de cobro único soportado:** `accion=pagar` (cobro one-shot vía formulario hosted)
- **Flujo:**
  1. Backend genera un identificador único de llamada (6 chars alfanuméricos) + un security token de 10 dígitos
  2. Persiste el mapping `id_llamada → paymentId` en tabla `peanpe_calls`
  3. Construye URL hosted con firma HMAC-SHA256: `concat(id_llamada, account_id, cantidad)` firmado con `apikey` (hex → bytes raw)
  4. Cliente accede a la URL → introduce datos de tarjeta en formulario en `peanpe.com`
  5. Peanpe llama a NightPay vía **challenge-response**:
     - Primero POST con `identificador_llamada` → NightPay responde con `securityToken` en plain text
     - Después GET con `seguridad=<securityToken>` + `status` + `msg` → NightPay valida la seguridad timing-safe y transita FSM
  6. Peanpe redirige al cliente a ThankYou URL

- **Tarjeta de prueba:** `4548812049400004` con cualquier expiración/CVV + `debug=1` en la URL
- **DNI de prueba:** `123456`

**Limitaciones documentadas de Peanpe v2.0:**
- Sin API de status (el orphan-reconcile no funciona)
- Sin API de refund (anulación manual en panel `peanpe.com`)
- URL base es HTTP (no HTTPS) — mitigado por la firma HMAC
- Identificador de llamada limitado a 6 caracteres
- La doc menciona `accion=suscribirse` y `accion=cancelar` para pagos recurrentes, pero NightPay aún NO los implementa y hay incertidumbre sobre el alcance real (ver sección 10)

---

## 5. El problema que NP Solución resuelve

**UX actual con Peanpe v2.0:**
- Cada cobro requiere que el cliente teclee PAN completo + expiry + CVV en el formulario hosted
- Tiempo total: 30-60 segundos
- Cliente abandona con frecuencia
- Reincidente: vuelve la siguiente semana al mismo local y tiene que volver a teclear todo

**UX objetivo de NP Solución:**
- Primer cobro: igual que ahora (formulario hosted) + alta opcional al final
- Segundo cobro y siguientes: cliente teclea solo un PIN de 4 dígitos
- Tiempo total cobro recurrente: <10 segundos
- Tarjeta tokenizada en Peanpe (NUNCA en NightPay — restricción PCI)

---

## 6. Diseño de NP Solución — los dos flujos

### Flujo 1: Alta del cliente (una sola vez)

```
1. Cliente paga primera vez con formulario Peanpe (flujo existente, accion=pagar)
2. Tras pago OK, NightPay ofrece: "¿Quieres pagar más rápido la próxima vez?"
3. Cliente acepta → introduce su móvil → recibe SMS OTP → confirma
4. Cliente elige un PIN de 4 dígitos
5. Backend NightPay llama a Peanpe API: accion=suscribirse para tokenizar la tarjeta usada
6. Peanpe responde con un subscriptionId / token
7. NightPay persiste en tabla Customer:
   - phoneHash (sha256 del E.164)
   - pinHash (argon2id, NUNCA texto plano)
   - peanpeSubscriptionId
   - cardLast4, cardBrand, cardExpiry (datos no sensibles, para UX)
8. (Opcional) Cliente recibe botón "Añadir a Apple Wallet" → genera pase .pkpass con QR único
```

### Flujo 2: Cobro recurrente (a partir de la segunda visita)

```
1. La chica/operadora genera un cobro de N€ en su app NightPay
2. La app genera un QR de cobro → cliente lo escanea con su teléfono
3. Cliente abre URL /pay/<qrToken> → identifica al cliente de dos formas alternativas:
   a) Ruta QR (preferida): cliente abre su Apple Wallet → muestra pase NightPay con QR estático
      → la chica escanea el QR del cliente con su app → cliente identificado en 1s
   b) Ruta teléfono: cliente teclea su móvil registrado → backend identifica por phoneHash
4. NightPay muestra: "Pago de N€ a tu tarjeta •••• XXXX. Introduce tu PIN: ____"
5. Cliente teclea 4 dígitos
6. Backend valida pinHash (timing-safe, con rate limit anti-brute-force)
7. Backend llama Peanpe API: cobrar al peanpeSubscriptionId con flag MIT
8. Peanpe procesa cobro vía BBVA sin exigir SCA por transacción
9. Push WS a la chica: "+N€ confirmado"
10. Tiempo total: ~8-12s
```

---

## 7. Conceptos de pagos que el agente debe entender

Para hacer su trabajo, el agente necesita comprender estos términos:

| Término | Significado relevante aquí |
|---|---|
| **Acquirer** | Banco que liquida con Visa/MC. En este sistema: BBVA |
| **Gateway** | Middleware técnico entre comercio y acquirer. Aquí: Peanpe |
| **Processor** | Quien procesa la transacción a nivel de red. Aquí: BBVA/Redsys |
| **MoR (Merchant of Record)** | Quien aparece ante Visa/MC como responsable comercial. Aquí: Peanpe (sub-aggregation) |
| **Sub-merchant** | Comerciante operando bajo el contrato de otro. Aquí: las chicas/operadoras bajo Peanpe |
| **Tokenización** | Sustituir el PAN real por un token irreversible. Lo hace Peanpe, NUNCA NightPay |
| **PAN** | Primary Account Number = número de tarjeta. PCI prohíbe que NightPay lo almacene |
| **CVV/CVC** | Código verificación tarjeta. PCI prohíbe almacenarlo NUNCA, ni siquiera el procesador |
| **PCI DSS** | Estándar de seguridad de tarjetas. Hay distintos niveles de cumplimiento (SAQ-A, SAQ-D, etc.) |
| **SAQ-A** | Cuestionario PCI más simple. Aplica cuando NO se ve PAN/CVV nunca. NightPay debe quedarse aquí. |
| **SAQ-D** | Cuestionario PCI completo. Requiere auditoría externa anual costosa. Evitar. |
| **SCA** | Strong Customer Authentication. Requisito PSD2: 2 factores de 3 (algo sabes/tienes/eres) |
| **3DS / 3DS2** | Protocolo para implementar SCA. Banco del cliente lanza challenge (FaceID, OTP, etc.) |
| **MIT** | Merchant Initiated Transaction. Cobro iniciado por el comercio (no por el cliente). Exento de SCA por transacción si ya hubo SCA inicial al crear el mandato |
| **CIT** | Customer Initiated Transaction. Cobro iniciado por el cliente. Suele requerir SCA |
| **Chargeback** | Reclamación del titular de tarjeta. El dinero vuelve. Riesgo principal para el comercio |
| **MCC** | Merchant Category Code. Código Visa/MC que clasifica el negocio. 7299 = personal services. Sensible en este caso |
| **Descriptor** | Texto que aparece en el extracto bancario del cliente. Importante por reputación |
| **Idempotencia de webhook** | Garantía de que llamadas duplicadas del PSP no producen efectos duplicados |

---

## 8. Estado del repo NightPay (lo que ya existe)

Ubicación: `c:\Users\mehdi\Documents\GitHub\first_tries\nightpay\`

**Backend funcional:**
- Adapter Peanpe completo: [nightpay/apps/api/src/modules/gateways/peanpe.adapter.ts](../nightpay/apps/api/src/modules/gateways/peanpe.adapter.ts) — implementa `accion=pagar`, falta `accion=suscribirse` y cobro a suscripción
- Adapter Paytef completo
- Adapter Redsys completo
- FSM de pagos XState (ADR-003)
- Webhook controller con verificación HMAC genérica + challenge-response Peanpe específica
- Circuit breaker en cada gateway (ADR-005)
- Migrations Prisma aplicadas: `peanpe_calls`, `paytef_*`, RLS hardening
- Mock server Peanpe: `nightpay/apps/mock-peanpe`
- Multi-tenancy via Prisma + RLS Postgres

**Frontends existentes:**
- `nightpay/apps/operator` — app de la chica/operadora
- `nightpay/apps/web-client` — flujo cliente actual
- `nightpay/apps/tpv` — app para TPV físico
- `nightpay/apps/admin` — panel admin

**Documentación clave:**
- [nightpay/docs/PEANPE-INTEGRATION.md](../nightpay/docs/PEANPE-INTEGRATION.md) — protocolo Peanpe v2.0 detallado
- [nightpay/docs/PAYTEF-INTEGRATION.md](../nightpay/docs/PAYTEF-INTEGRATION.md)
- [nightpay/docs/MASTER_PLAN_V2.md](../nightpay/docs/MASTER_PLAN_V2.md)
- [nightpay/docs/treasury-payout-strategy.md](../nightpay/docs/treasury-payout-strategy.md)
- [nightpay/docs/checklists/onboarding-local.md](../nightpay/docs/checklists/onboarding-local.md)
- Runbooks P0/P1 en [nightpay/docs/runbooks/](../nightpay/docs/runbooks/)
- ADRs en [nightpay/docs/adr/](../nightpay/docs/adr/)

---

## 9. NP Solución POC — qué hay que construir

**Ubicación propuesta:** `c:\Users\mehdi\Documents\GitHub\first_tries\np-solucion-poc\` (hermano de nightpay/, independiente)

**Stack recomendado:**
- Backend: Hono (TypeScript) o NestJS slim
- DB: Postgres vía Docker Compose
- ORM: Prisma
- SMS OTP: Twilio trial
- Frontend: Next.js minimal o HTML estático
- Túnel webhook: cloudflared tunnel con subdominio estable
- Tests: Vitest

**Modelo de datos mínimo:**
- `Customer` (phoneHash, pinHash, peanpeSubscriptionId, cardLast4, status)
- `Payment` (paymentId, customerId, amount, status, peanpeCallId, isRecurringCharge)
- `PeanpeCall` (identificador 6 chars, securityToken, accion, result)
- `OtpChallenge` (phoneE164, codeHash, expiresAt)
- `SessionToken` (customerId, tokenHash, 5min TTL)

**8 endpoints necesarios:**
1. `POST /v1/payments` — chica genera cobro
2. `GET /v1/payments/:token` — cliente abre y ve opciones
3. `POST /v1/payments/:token/start-form` — flujo formulario Peanpe (Fase 1)
4. `GET+POST /v1/webhooks/peanpe/notify` — challenge-response
5. `POST /v1/customers/signup-otp` — pedir OTP por móvil
6. `POST /v1/customers/verify-otp` — verificar OTP + crear PIN + suscribir tarjeta
7. `POST /v1/customers/authenticate` — phone + PIN → sessionToken
8. `POST /v1/payments/:token/charge-with-pin` — cobro recurrente con sessionToken

**4 páginas frontend mínimas:** `/pay/:token`, `/signup`, `/pay/:token/pin`, `/result`

---

## 10. Las 4 preguntas críticas pendientes a Peanpe (compañero interno)

Estas determinan si el POC es viable tal cual:

1. **¿La API soporta `accion=suscribirse`?** ¿Cuál es el request/response exacto?
2. **¿Podemos cobrar al subscriptionId un importe arbitrario one-shot (no recurrente con frecuencia fija)?**
3. **¿Podemos marcar las transacciones a una suscripción como MIT (Merchant Initiated) para exentar SCA por transacción?**
4. **¿El descriptor del extracto bancario es personalizable por cuenta? ¿Cómo se cambia?**

**Si las respuestas a 1+2+3 son sí → el POC se construye tal cual.**
Si Q3 es no → la UX será ~15-20s con 3DS soft en cada cobro (aún aceptable, pero peor).
Si Q2 es no → hay que rediseñar (pseudo-suscripciones diarias, o pivotar a otro gateway).
Si Q1 es no → Peanpe queda solo para Fase 1 (formulario); Fase 2 requiere otro gateway.

---

## 11. Restricciones no negociables

**Compliance PCI:**
- NightPay y NP Solución NUNCA almacenan, procesan ni transmiten:
  - PAN completo
  - CVV/CVC
  - Datos del chip o banda magnética
  - PIN bancario de la tarjeta
- Lo único que se almacena: `cardLast4` (4 últimos dígitos), `cardBrand`, `cardExpiry`, token Peanpe (referencia opaca)
- Esto mantiene a NightPay en PCI SAQ-A (cuestionario corto, sin auditoría externa)

**Compliance PSD2:**
- Toda autenticación debe ser SCA conforme (2 factores de 3)
- PIN + dispositivo registrado (móvil con SIM verificada en alta) = 2 factores válidos
- MIT exempta SCA por transacción si el mandato inicial sí fue SCA

**Compliance GDPR:**
- Right to be forgotten implementado (DELETE customer + revoca token Peanpe)
- Datos del cliente exportables (JSON)
- Política de retención: customers inactivos > 24 meses → anonimizar

**Seguridad:**
- Brute-force PIN: max 3 intentos seguidos → lock 15min, max 10/24h → lock 24h
- Reset PIN: vía OTP + verificación adicional (last4) para evitar SIM swap
- Timing-safe compare en todas las verificaciones de tokens/PINs
- HMAC en webhooks

---

## 12. Decisiones tomadas

- Peanpe como pasarela primaria (es marca propia)
- BBVA como adquirente real (vía Peanpe)
- Stack 100% español por ahora (no Estonia/Lituania)
- PIN de 4 dígitos para la fase inicial (revisable a 6 si tickets altos)
- POC independiente antes de portar a NightPay
- NP Solución como módulo nuevo dentro del monorepo NightPay (no proyecto separado a largo plazo)
- NightPay nunca toca PAN/CVV — siempre SAQ-A
- Identificación cliente vía teléfono + PIN, con Apple Wallet pass como atajo opcional
- Customer único compartido entre venues (modelo red, no islas)

---

## 13. Decisiones pendientes

| # | Decisión | Cuándo decidir |
|---|---|---|
| 1 | Proveedor SMS OTP (Twilio / Vonage / nacional ES) | Antes de Fase 2 POC |
| 2 | Frontend: Next.js o HTML estático para POC | Antes de empezar POC |
| 3 | Túnel webhook: ngrok o cloudflared | Antes de primer test |
| 4 | Umbral para forzar 3DS soft (>300€?) | Fase 4 hardening |
| 5 | Política retención (12/24/36 meses) | Antes de producción |
| 6 | Google Wallet (Android) además de Apple Wallet | Diferido a Fase 3.5 |

---

## 14. Tareas concretas para el siguiente agente

Si el siguiente agente debe **construir el POC**, los pasos son:

1. Crear estructura `np-solucion-poc/` como monorepo pnpm
2. Setup Docker Compose con Postgres
3. Setup Prisma con el schema descrito en sección 9
4. Portar `peanpe.adapter.ts` desde NightPay, simplificando (sin multi-tenancy, sin XState saga)
5. Implementar los 8 endpoints
6. Implementar el frontend mínimo (4 páginas)
7. Configurar túnel cloudflared
8. Esperar credenciales Peanpe + respuestas a las 4 preguntas (sección 10)
9. Test 1: cobro vía formulario con tarjeta debug
10. Test 2: alta cliente + creación de suscripción
11. Test 3: cobro recurrente con PIN
12. Test 4: edge cases (PIN incorrecto, tarjeta caducada, webhook duplicado)
13. Documentar resultados

Si el siguiente agente debe **portar a NightPay** (después de POC validado):

1. Crear módulo `customers/` en `nightpay/apps/api/src/modules/`
2. Migrar tabla `Customer` + relacionadas vía Prisma migration
3. Extender `peanpe.adapter.ts` con métodos `createSubscription`, `chargeSubscription`, `deleteSubscription`
4. Añadir endpoints customer al API existente
5. Integrar con FSM XState (nuevo estado `RECURRING_CHARGE`)
6. Adaptar webhook handler para idempotencia de cobros a suscripción
7. Frontend `web-client` o nuevo `apps/np-solucion/`
8. RLS de Postgres aplicado a tabla `customers`
9. Tests E2E con Playwright
10. Code review + security review

---

## 15. Referencias rápidas

- Doc Peanpe v2.0 protocolo: [nightpay/docs/PEANPE-INTEGRATION.md](../nightpay/docs/PEANPE-INTEGRATION.md)
- Adapter Peanpe existente: [nightpay/apps/api/src/modules/gateways/peanpe.adapter.ts](../nightpay/apps/api/src/modules/gateways/peanpe.adapter.ts)
- Schema Prisma NightPay: [nightpay/packages/db/prisma/schema.prisma](../nightpay/packages/db/prisma/schema.prisma)
- ADRs arquitectura: [nightpay/docs/adr/](../nightpay/docs/adr/)
- Mock server Peanpe (para tests): [nightpay/apps/mock-peanpe](../nightpay/apps/mock-peanpe)

---

**Fin del briefing.** Cualquier duda conceptual, consultar este documento. Para detalles de implementación del protocolo Peanpe, leer `PEANPE-INTEGRATION.md`. Para el flujo XState de pagos, leer `ADR-003`.
