# NightPay — Estado del proyecto

**Documento para reunión con colegas · v1 · Mayo 2026**

Resumen ejecutivo de lo que hay construido, cómo funciona, y qué falta para
producción. Pensado para que alguien que no haya tocado el código entienda
el sistema en 10 minutos.

---

## Tabla de contenidos

1. [Qué es NightPay (1 párrafo)](#qué-es-nightpay)
2. [Arquitectura — vista de pájaro](#arquitectura)
3. [Lo que está hecho](#lo-que-está-hecho)
4. [Lo que falta para producción](#lo-que-falta-para-producción)
5. [Cómo correrlo en local](#cómo-correrlo-en-local)
6. [Decisiones de diseño importantes](#decisiones-de-diseño-importantes)
7. [Riesgos abiertos](#riesgos-abiertos)

---

## Qué es NightPay

Plataforma de cobros para venues nocturnos en España. El cliente paga vía
**QR escaneado desde su móvil** (sin app instalada). La **chica/operadora**
crea cada cobro, el sistema se queda con un **10% de comisión** automático y
el **90% se acumula como saldo pendiente** para ella. Periódicamente el admin
le **paga sus comisiones** en **USDT (cripto)** porque la mayoría son LatAm
con solo pasaporte y los bancos españoles no las aceptan.

**Phase 1B** añadió un modo **prepago**: el cliente carga un saldo UNA vez al
entrar (como una pulsera de hotel all-inclusive) y la chica consume contra
ese saldo durante la noche **sin volver a molestarlo**. Cero PSP roundtrip por
consumición → cobros instant.

---

## Arquitectura

```
                      ┌──────────────────────────────┐
                      │       Cliente (móvil)         │
                      │  - Escanea QR del venue       │
                      │  - Paga UNA vez (top-up)      │
                      │  - Ve su balance live         │
                      └────────────┬──────────────────┘
                                   │ HTTPS
                                   ▼
┌────────────────┐         ┌──────────────────────┐         ┌────────────────┐
│ Admin (OWNER)  │ HTTPS   │   NightPay API       │  HTTPS  │ Operadora       │
│ apps/admin     │────────▶│   apps/api  (Nest)   │◀────────│ (chica) móvil   │
│ - Pagos        │         │   - FSM XState pagos │         │ apps/operator   │
│ - Operadoras   │         │   - Multi-tenant RLS │         │ - Crea cobros   │
│ - Treasury     │         │   - Adapter pasarela │         │ - Cobra wallet  │
│ - Wallets      │         │   - Audit log        │         │ - Ve ganancias  │
│ - Ajustes      │         │   - WebSocket RT     │         └────────────────┘
└────────────────┘         └──────┬───────────────┘
                                   │
        ┌──────────────────────────┼──────────────────────────┐
        ▼                          ▼                          ▼
┌────────────────┐         ┌────────────────┐        ┌────────────────┐
│  Postgres 16   │         │   Redis 7      │        │  Pasarelas PSP  │
│  - Multi-tenant│         │  - Lockout     │        │  - Wipay        │
│  - RLS forced  │         │  - WS pub/sub  │        │  - Peanpe       │
│  - 9 migrations│         │  - BullMQ      │        │  - Stripe (op.) │
└────────────────┘         └────────────────┘        └────────────────┘
                                                              │
                            ┌─────────────────────────────────┘
                            ▼
                    ┌────────────────────────┐
                    │  Treasury (verifiers)   │
                    │  - Tronscan API         │
                    │  - BscScan API          │
                    │  - Polygonscan API      │
                    │  - Helius (Solana)      │
                    │  - Binance EURUSDT      │
                    └────────────────────────┘
```

### Stack

| Capa | Producto | Por qué |
|---|---|---|
| Backend | NestJS 10 + Fastify | Mejor performance que Express; modular y type-safe |
| ORM | Prisma 5 | Migrations versionadas + type-safe queries |
| DB | Postgres 16 | RLS robusto + extensiones cripto + transacciones DDL |
| FSM pagos | XState 5 | Pagos tienen muchos estados con transiciones complejas |
| Cola | BullMQ | Reintentos de webhooks + reconciliación nocturna |
| Realtime | Socket.io + Redis adapter | Multi-instancia, ya probado en producción |
| Frontends | Next.js 14 (3 apps) | SSR + mismo stack en admin/operator/cliente |
| Tests | Vitest + Playwright | Unit fast + E2E browser |
| Observability | Prometheus + Grafana + Sentry | Metrics + alerts + error tracking |
| Deploy | Dokploy (planeado) | Docker-based, self-hosted, simple |

### Apps

| App | Puerto | Para quién | Tech |
|---|---|---|---|
| `apps/api` | 4100 | Backend único | NestJS + Fastify |
| `apps/admin` | 4103 | Dueño del venue | Next.js 14 |
| `apps/operator` | 4101/4104 | Chica (móvil PWA) | Next.js 14 mobile-first |
| `apps/web-client` | 4102 | Cliente final (móvil) | Next.js 14 — SSR + balance live |
| `apps/e2e` | — | Tests Playwright | Playwright 1.49 |

---

## Lo que está hecho

### 1. Foundation (multi-tenant + RLS + auth)

Cualquier operación lleva un `tenantId` (UUID del venue). El middleware Prisma
inyecta `WHERE tenantId = current` automático en cada query. **Row-Level
Security** está habilitado a nivel de Postgres: aunque alguien se cuele a la
DB, no puede leer datos de otro venue sin el contexto correcto.

JWT con `issuer=nightpay, audience=nightpay-internal`. Roles:
**OWNER > MANAGER > WAITER > OPERATOR**. Lockout brute-force vía Redis (5 fails
en 15 min = bloqueo 15 min) + rate-limit IP estricto en `/auth/login`,
`/auth/refresh`, `/operators/accept-invite`.

### 2. Cobros — QR clásico

Flow estándar:

1. Chica (o cualquier role) → operator app → introduce importe → terminal del venue.
2. API crea `Payment(status=CREATED)` + `qrToken` único + TTL 5 min.
3. La chica enseña el QR a la pantalla del cliente.
4. Cliente escanea → `localhost:4102/pay/<qrToken>` → ve detalles → paga.
5. Web-client llama a `/start-authorization` → API redirige al PSP (Wipay/Peanpe).
6. Cliente confirma con su banco → PSP envía webhook a `/v1/webhooks/<provider>`.
7. API valida HMAC + idempotencia + FSM transition → `AUTHORIZED`.
8. Hook auto: si el creador del Payment es OPERATOR, crea `OperatorEarning`
   con snapshot de su `commissionBps` (default 9000 = 90%) → 90% para ella,
   10% para NightPay/venue.
9. WebSocket emite `payment:completed` → chica ve "✓ Cobrado" en su app sin recargar.

**FSM completa**: `CREATED → AWAITING_CAPTURE → AUTHORIZING → AUTHORIZED |
FAILED | EXPIRED | CANCELED`. Cada transición persiste un `PaymentEvent`
inmutable con traceId.

### 3. Phase 1A — Multi-rail payout

19 métodos de payout soportados, agrupados en 5 categorías:

- **Cripto on-chain**: USDT-TRC20, USDT-BEP20, USDC-POLY, USDC-SOL.
  Reconciliación automática llamando al explorer del blockchain (Tronscan,
  BscScan, Polygonscan, Helius/Solana). Tolerancia ±2% en importe.
- **Exchange interno**: Binance Pay ID, OKX, Bybit (transferencia interna entre cuentas del exchange).
- **E-wallet**: FasterPay, PayQuicker, Hyperwallet, Revolut, Payoneer.
- **Banco wire**: SEPA, SWIFT internacional (Georgia TBC, Belize, etc.).
- **Wallet LatAm**: MercadoPago CVU, Pix, Nequi, Daviplata.
- **Manual cash**.

Por método se persiste:
- `User.payoutMethod` + `payoutAddress` + `payoutMetadata` (bankName, swiftBic, country) + `payoutLabel`
- `OperatorPayout.externalTxId` + `externalRail` + `reconciliationStatus`
  (UNRECONCILED → MATCHED | MANUAL_OK | MISMATCH) + `receiptUrl` (S3/R2)
  + `reconciledAt` + `reconciledByUserId`

**Verificación**: `PayoutVerifierFactory.forMethod()` resuelve el verifier:
- Métodos cripto: hace una llamada al explorer (~10s timeout) y verifica
  contrato + destino + importe ± tolerancia.
- Métodos manuales: devuelve UNRECONCILED + el admin pega receipt URL +
  marca MANUAL_OK desde la UI.

Cron nocturno `reconcilePending` revisa todos los UNRECONCILED con
`externalTxId` set y reintenta. Batch de 5 con `Promise.allSettled`, cap 100/run.

### 4. Phase 1A.1 — Onboarding tracker

14 campos en `User` para tracking de cada chica:

- Datos personales: `phone`, `passportCountry`, `passportLast4` (PII mínima)
- Docs España: `hasEmpadronamiento`, `hasNie`, `hasTie`
- Wallet/Exchange: `walletProvider` (BINANCE, BYBIT, OKX, Trust Wallet,
  FasterPay, etc.), `walletStatus` (NOT_STARTED → REGISTERED → KYC_PENDING
  → KYC_VERIFIED → KYC_REJECTED), `walletTestPassed`, `walletTestAt`
- Flags ayuda: `needsHelpWallet`, `needsHelpDocs`
- Estado general: `onboardingStatus` (NEW → PROFILE_CREATED →
  INVITE_ACTIVATED → BINANCE_PENDING → READY | BLOCKED)
- Notas libres: `onboardingNotes` (max 2000 chars)

**UI admin**: tab "Onboarding" dentro de cada operadora con 5 secciones,
checkboxes warn cuando "necesita ayuda" + filtro lista "Solo las que necesitan ayuda".

**Documentación operativa**: `docs/onboarding-chicas-binance.md` con 7 pasos
(crear chica → invite → KYC Binance → address USDT-TRC20 → test 1 USDT →
operativa) + 3 apéndices (alternativas Bybit/OKX/Trust/e-wallets/LatAm,
templates WhatsApp para el admin, estado del flow).

### 5. Phase 1A.2 — Self-onboarding link (recién shippeado)

El admin puede generar un **link único 72h** y mandárselo a la chica por
WhatsApp. La chica abre el link **sin login** (JWT en path es la cred) y
rellena ella misma su perfil — datos personales, docs, wallet, método de
payout. Coexiste con el flow manual del admin: si la chica no es tech-savvy,
el admin rellena por ella desde su tab Onboarding como siempre.

- JWT con `purpose='operator-self-onboarding'` + hash sha256 persistido →
  rotación efectiva al regenerar.
- Rate limit: 30 GET + 20 POST por minuto/IP.
- La chica NO puede tocar campos financieros (commission, active, payoutMetadata).

### 6. Phase 1B — Wallet cash-in-advance (closed-loop prepago)

**Por qué importa**: la regla #1 es no molestar al cliente. En el modelo
clásico, cada vez que la chica le quería cobrar algo le pedía el móvil para
escanear su QR — pésima UX. Con wallet, el cliente paga **UNA vez** al entrar
y la chica le cobra desde su lado el resto de la noche.

**Legal**: closed-loop prepaid exemption (EMD2 art. 1.5(k)). El saldo solo
se gasta dentro del venue, sin convertirse en cash, refund solo a la tarjeta
original. Mismo modelo que casinos con chips, parques con pulseras, hoteles
all-inclusive.

**Flow**:

```
21:00  Cliente A llega → la chica le dice "carga lo que quieras"
       → escanea QR (top-up) → paga 500€ → wallet creado con
         identifier "Mesa 3" + balance 500€
       → cliente recibe URL móvil con balance live (puede cerrarlo)

22:30  Cliente A pide cervezas → la chica → tab Wallet → click "Mesa 3"
       → introduce 24€ "bar" → confirma
       → balance: 476€. Su comisión: +21.60€ instant (90%).
       Cliente sigue charlando, ni saca el móvil.

23:15  Cliente A sube a habitación → recepción → tab Wallet → "Mesa 3"
       → 100€ "room" → balance 376€.

01:00  Cliente A paga "tiempo" → chica → "Mesa 3" → 200€ "time"
       → balance 176€ + comisión chica +180€.

03:00  Cliente A se va → admin → tab Wallets → click "Mesa 3"
       → Refund 176€ → tarjeta original (T+1).
       Cliente solo metió la tarjeta UNA vez en toda la noche.
```

**Implementación**:

- `ClientWallet` (id, tenantId, identifier ej. "Mesa 3", balanceCents,
  status ACTIVE/EXPIRED/REFUNDED/DEPLETED, qrToken, expiresAt).
- `WalletConsumption` (walletId, amountCents, providedByUserId, category,
  idempotencyKey, reversedAt).
- `Payment.walletId` nullable → cuando hace AUTHORIZED + walletId set,
  hook atómico en `transition()` suma al balance vía SELECT FOR UPDATE.
- `OperatorEarning.consumptionId` nullable → si el provider del consume
  es OPERATOR, genera earning paralelo con snapshot de `commissionBps`.
  CHECK constraint XOR entre paymentId y consumptionId.

**UIs**:

- **Operator app, tab Inicio**: toggle "Cobro directo" / "Cargar wallet" →
  al cargar, la chica pone una **etiqueta** ("Mesa 3", "Pulsera azul")
  + importe → el cliente escanea UN QR.
- **Operator app, tab Wallet**: lista de wallets activos del venue con
  etiqueta + balance + tiempo desde creación + búsqueda. Click → form
  amount + categoría → cobra. Auto-refresh 8s.
- **Web-client (móvil del cliente)**: balance grande + lista de consumos
  por categoría + total acumulado + polling 5s.
- **Admin, tab Wallets**: 4 tiles (activas, balance total, top-ups hoy,
  consumido hoy) + split por categoría + tabla con filtro status + botón
  Refund con modal CARD vs CREDIT.

### 7. Comisión configurable + ajustes venue

`Venue.platformCommissionBps` (default 1000 = 10% NightPay / 90% chica) +
`Venue.operatorMaxCobroCents` (cap por cobro creado por OPERATOR). Ambos
editables desde admin → tab Ajustes (OWNER-only).

### 8. Code review fixes — 11 items

Tras un code review propio detallado, se resolvieron:

- CLS context middleware (estaba como guard → no aplicaba tenant filtering)
- 9× `@ts-expect-error` removidos del treasury service
- Warning al boot si faltan API keys de blockchain (Tronscan/BscScan/Polygonscan/Helius)
- Solana verifier: derivar ATA owner desde `postTokenBalances` (antes
  comparaba contra el wallet directamente, nunca matcheaba)
- EUR/USDT rate con flag `degraded` cuando Binance está caído, fallback en cascada
- Polygon: 64 → 128 confirmaciones para alinear con Binance finality
- Verify endpoint idempotente
- MANAGER bloqueado de campos financieros (commissionBps, payoutMethod/Address)
- confirmManual exige al menos un artifact (txId/receiptUrl/notes)
- Reconciliation batch con allSettled
- OnboardingBadge cubre todos los status

### 9. Quality — rate-limit, E2E, observability

- **Rate-limit IP per-endpoint**: 10/min login, 30/min refresh,
  10/min accept-invite (Redis-backed guard). Global 100/min.
- **E2E Playwright**: `apps/e2e` con api-smoke (8 specs) + admin-ui (4 specs).
  Mintea JWTs directos para acelerar tests.
- **Sentry**: soft-dependency (no crashea sin `@sentry/node`). Scrubbing PII
  automático (password, passportLast4, payoutAddress, tokens).
- **Grafana dashboard JSON** + **Prometheus rules YAML** con 5 alertas
  críticas (APIDown, HighErrorRate, GatewayCircuitOpen, PayoutsReconcileBacklog,
  AuthBruteForce).

### Cobertura de tests

| Módulo | Tests | Status |
|---|---|---|
| Auth (login + refresh) | 5 | ✅ |
| RefreshTokenService | 6 | ✅ |
| Payment FSM | 17 | ✅ |
| Refunds | 26 | ✅ |
| Wipay adapter | 14 | ✅ |
| Peanpe adapter | 15 | ✅ |
| Webhooks | 9 | ✅ |
| Prisma RLS | 5 | ✅ |
| Health | 2 | ✅ |
| Tron verifier | 13 | ✅ |
| PayoutVerifierFactory | 7 | ✅ |
| IP rate-limit guard | 8 | ✅ |
| Wallets service | 16 | ✅ |
| **Total** | **143** | **143/143 verde** |

---

## Lo que falta para producción

### Bloqueantes operativos

| # | Item | Esfuerzo | Bloqueado por |
|---|---|---|---|
| 1 | **Credenciales sandbox Wipay/Peanpe** | 0 (admin) | KYB pendiente con los PSPs |
| 2 | **Wallet refund CARD → disparar PSP refund real** | 1 día | Item 1 |
| 3 | **Webhook E2E con PSP sandbox** | 1 día | Item 1 |
| 4 | **Onboarding real de una chica a Binance** | 30 min con ella delante | Tú + chica |
| 5 | **Resend API key (envío real de invites por email)** | 2h + key | Cuenta Resend |
| 6 | **Deploy Dokploy + DNS + SSL + env vars prod** | 3-5 días | Decisión + KYB |

### Operativos / contables

| # | Item | Esfuerzo |
|---|---|---|
| 7 | CSV export mensual de payouts (para el contable) | 4-6h |
| 8 | Operator pool — chicas comparten un fondo común (escenario D del plan) | 2 días |
| 9 | Notification policy: emails a chicas cuando reciben payout | 1 día |
| 10 | Reporte fiscal automático: Modelo 100 + Modelo 721 helper | 2-3 días |

### Calidad / hardening

| # | Item | Esfuerzo |
|---|---|---|
| 11 | Tests del top-up flow end-to-end (vitest) | 1 día |
| 12 | Tests del self-onboarding flow | 0.5 día |
| 13 | Backup automatizado Postgres + restore drill | 1 día |
| 14 | Soft-delete vs hard-delete de wallets antiguas | 0.5 día |
| 15 | Branch `feature-operators` → PR review oficial → merge a `main` | 1 día (review) |

### Phase 2 — escalar (post 6 meses)

| Item | Cuándo |
|---|---|
| Escalar a venues de terceros (multi-tenant comercial) | Tras 6 meses funcionando solo en venues propios |
| API Binance automatizada (no manual desde admin) | Phase 2 |
| AISP del banco para reconciliación settlement automático | Phase 2 |
| Licencia VASP si se custodia para terceros | Phase 2 (si aplica) |
| Smart contract on-chain splitter | Phase C aspiracional |

---

## Cómo correrlo en local

```bash
# 1. Levanta Postgres + Redis
cd nightpay
docker compose up -d postgres redis

# 2. Instala deps
pnpm install

# 3. Aplica migraciones + genera Prisma client
pnpm --filter @nightpay/db migrate:deploy
pnpm --filter @nightpay/db generate

# 4. Seed inicial (crea venue luna-vlc + owner)
pnpm --filter @nightpay/db cli create-owner \
  --venue luna-vlc \
  --email owner@nightpay.local \
  --password "TuPasswordSegura!2026"

# 5. Crea una chica de prueba
pnpm --filter @nightpay/db cli create-operator \
  --venue luna-vlc \
  --email ana@local.test \
  --display-name "Ana" \
  --commission 90

# 6. Arranca todo (4 terminales)
pnpm --filter @nightpay/api dev          # :4100
pnpm --filter @nightpay/admin dev        # :4103
pnpm --filter @nightpay/operator dev     # :4101
pnpm --filter @nightpay/web-client dev   # :4102
```

Abre `http://localhost:4103` con el owner que creaste.

### Tests

```bash
pnpm --filter @nightpay/api test         # 143 unit + integration
pnpm --filter @nightpay/e2e test         # Playwright (necesita apps corriendo)
```

---

## Decisiones de diseño importantes

### 1. Multi-tenant con RLS hard-enforced

Cada query Prisma pasa por un middleware que inyecta `WHERE tenantId =
current` desde el contexto CLS. **Adicionalmente** Postgres tiene RLS
habilitado en todas las tablas tenant-scoped. Si alguien se cuela en la DB
con el role de la app, sigue sin poder leer datos cross-tenant.

### 2. Adapter pattern para pasarelas

`apps/api/src/modules/gateways/*.adapter.ts` — cada pasarela implementa
`GatewayAdapter` con `initializePayment`, `verifyWebhook`, `handleWebhookEvent`.
Añadir Stripe o Mollie es escribir un nuevo adapter, sin tocar el resto.

### 3. FSM para pagos con XState 5

Los pagos tienen muchos estados con transiciones complejas. XState formaliza
las transiciones permitidas. Antes de un UPDATE en DB, `applyEvent()` valida
que la transición es legal o tira `InvalidTransitionError`.

### 4. Earnings con snapshot de bps

Cuando una chica cobra y el Payment va a AUTHORIZED, se crea un
`OperatorEarning` con un **snapshot del commissionBps actual**. Si el OWNER
cambia su comisión después de eso, los earnings ya creados no se ven afectados.
**No hay reescritura histórica**.

### 5. Idempotency keys obligatorios

Tanto en `POST /payments` como en `POST /wallets/:id/consume`. El camarero
puede pulsar 2 veces "Cobrar" sin generar 2 cobros — la 2ª llamada con la
misma key devuelve el resultado de la 1ª.

### 6. Closed-loop prepaid = no licencia EMI

Phase 1B opera bajo la **closed-loop exemption** de EMD2 art. 1.5(k). El
saldo solo se gasta dentro del venue, sin convertirse en cash, refund solo
a la tarjeta original. Es el mismo modelo legal que casinos con chips o
hoteles all-inclusive con pulseras. **No necesita licencia EMI**.

Cuando se escale a multi-venue (Phase 2), si el saldo es cross-venue se
rompe el closed-loop y habrá que evaluar licencia.

### 7. Phase 1C SoftPOS descartada

Se evaluó usar Viva.com / SumUp para que la chica cobre con el móvil como
datáfono (tap-to-phone). Se descartó por complejidad operativa (KYB con
otro PSP, hardware Android NFC, certificación). El QR clásico + wallet
prepago cubren el caso de uso.

---

## Riesgos abiertos

### AML banco español

El pattern "PSP settlement → SEPA outgoing a Binance" puede generar review
del banco del venue. Mitigación:
- Mantener ratio sano (no convertir 100% a cripto)
- Documentar contabilidad como "pagos a colaboradoras autónomas"
- Las chicas idealmente dadas de alta como autónomas / con factura

### Fiscalidad de las chicas

Si residen >183 días en España, los ingresos USDT son rendimiento gravable.
Modelo 100 + Modelo 721 si saldo cripto >50k€ a 31/dic. Responsabilidad de
cada chica, NO de NightPay, pero éticamente conviene avisarles.

### MCC vs operativa real

El registro hostelero (5813/5812/7011) tiene que coincidir con la operativa.
Si el local opera como escort y se registra como hostelería, el PSP eventualmente
detecta (review periódico, denuncia, redes sociales) → cierre de cuenta.
Mitigación: **fachada y operativa coherentes** (bar/copas/habitaciones reales
y declarados).

### Travel Rule cripto

Binance pide info del receptor para envíos >1.000€ a self-custody. Entre
cuentas Binance es trivial. Para self-custody (Trust Wallet) preparar los
datos.

### Chargebacks

Por ahora ningún cliente nos ha hecho chargeback porque no hay tráfico real.
Cuando lleguen, el PSP retiene del settlement. Mitigación: tracking de
disputas + fondo de reserva.

---

## Contacto / repo

- Branch activo: `feature-operators` (30 commits ahead de `main` — pendiente PR)
- Estructura monorepo pnpm + Turborepo
- Stack productivo: NestJS + Next.js + Postgres + Redis + Prisma + XState

Para correr la suite completa:

```bash
pnpm --filter @nightpay/api test    # 143 tests, ~8s
```
