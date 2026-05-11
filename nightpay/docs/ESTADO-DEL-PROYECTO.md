# NightPay — Estado del proyecto

**Documento para reunión con colegas · v2 · Mayo 2026**

Resumen ejecutivo con **ejemplos concretos** de lo que hay construido, cómo
funciona, y qué falta para producción.

---

## Tabla de contenidos

1. [Qué es NightPay](#1-qué-es-nightpay)
2. [Arquitectura](#2-arquitectura)
3. [Foundation — multi-tenant, RLS, auth](#3-foundation)
4. [Cobros con QR (modelo clásico)](#4-cobros-con-qr)
5. [Phase 1A — Multi-rail payout](#5-phase-1a--multi-rail-payout)
6. [Phase 1A.1 — Onboarding tracker](#6-phase-1a1--onboarding-tracker)
7. [Phase 1A.2 — Self-onboarding link](#7-phase-1a2--self-onboarding-link)
8. [Phase 1B — Wallet cash-in-advance](#8-phase-1b--wallet-cash-in-advance)
9. [Comisiones configurables](#9-comisiones-configurables)
10. [Code review fixes](#10-code-review-fixes)
11. [Quality — rate-limit, E2E, observabilidad](#11-quality)
12. [Lo que falta](#12-lo-que-falta)
13. [Cómo correrlo en local](#13-cómo-correrlo-en-local)
14. [Decisiones de diseño](#14-decisiones-de-diseño)
15. [Riesgos abiertos](#15-riesgos-abiertos)

---

## 1. Qué es NightPay

Plataforma de cobros para venues nocturnos en España. El cliente paga con su
móvil escaneando un **QR** (sin app instalada). La **chica/operadora** crea
cada cobro, el sistema toma un **10% de comisión** automático, y el **90%
se acumula como saldo pendiente** para ella. El admin paga sus comisiones en
**USDT (cripto)** porque la mayoría son LatAm con solo pasaporte y los bancos
españoles no las aceptan.

**Phase 1B** añadió modo **prepago**: el cliente carga un saldo UNA vez al
entrar (como una pulsera de hotel all-inclusive) y la chica consume contra
ese saldo durante la noche **sin volver a molestarlo**.

### Ejemplo simplificado de una noche

> 1. Cliente A llega al venue, paga 500€ vía QR → wallet creado "Mesa 3".
> 2. Durante la noche, Ana le cobra 8€ (cervezas), 100€ (habitación),
>    200€ (tiempo con ella). Cliente nunca vuelve a sacar el móvil.
> 3. Ana acumula 90% de 200€ = **180€ de comisión instant**.
> 4. Cliente A se va. Admin refunda 192€ a su tarjeta original.
> 5. Final del mes, admin paga a Ana sus 180€ × N noches → envío en USDT a
>    su Binance. Tronscan verifica auto → MATCHED.

---

## 2. Arquitectura

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
└────────────────┘         └──────┬───────────────┘         └────────────────┘
                                  │
       ┌──────────────────────────┼──────────────────────────┐
       ▼                          ▼                          ▼
┌────────────────┐         ┌────────────────┐        ┌────────────────┐
│  Postgres 16   │         │   Redis 7      │        │  Pasarelas PSP  │
│  Multi-tenant  │         │  Lockout       │        │  Wipay / Peanpe │
│  RLS forced    │         │  WS pub/sub    │        │  Stripe (op.)   │
│  9 migrations  │         │  BullMQ        │        └────────┬───────┘
└────────────────┘         └────────────────┘                 │
                                                              ▼
                                                  ┌────────────────────────┐
                                                  │  Treasury (verifiers)   │
                                                  │  Tronscan, BscScan,     │
                                                  │  Polygonscan, Helius,   │
                                                  │  Binance EURUSDT        │
                                                  └────────────────────────┘
```

### Apps

| App | Puerto | Para quién | Tech |
|---|---|---|---|
| `apps/api` | 4100 | Backend único | NestJS 10 + Fastify |
| `apps/admin` | 4103 | Dueño del venue (OWNER) | Next.js 14 |
| `apps/operator` | 4101/4104 | Chica (móvil PWA) | Next.js 14 mobile-first |
| `apps/web-client` | 4102 | Cliente final (móvil) | Next.js 14 SSR |
| `apps/e2e` | — | Tests Playwright | Playwright 1.49 |

---

## 3. Foundation

### Multi-tenant + RLS

Cada operación lleva un `tenantId` (UUID del venue). El middleware Prisma
inyecta `WHERE tenantId = current` automático en cada query. **Row-Level
Security** habilitado a nivel Postgres como defensa en profundidad: aunque
alguien se cuele a la DB con el role de la app, no puede leer datos de otro
venue sin el contexto correcto.

#### Ejemplo: tenant isolation

```sql
-- Si un atacante con JWT de venue "luna-vlc" intenta consultar pagos de
-- "luna-mad" haciendo SQL directo:

SELECT * FROM payments WHERE id = '<uuid de luna-mad>';
-- → 0 rows (la RLS policy lo filtra invisible)

-- Sin el current_tenant_id seteado:
RESET app.current_tenant_id;
SELECT * FROM payments;
-- → 0 rows (RLS deny por default)
```

### Auth + roles

JWT con `issuer=nightpay, audience=nightpay-internal`. Roles jerárquicos:
**OWNER** (dueño) → **MANAGER** (encargado) → **WAITER** (camarero) →
**OPERATOR** (chica).

#### Ejemplo: protección anti brute-force

> Un atacante prueba 5 passwords incorrectos contra `ana@local.test`.
> Al 5º intento, Redis guarda `nightpay:lockout:locked:ana@local.test` con
> TTL 15 min. La 6ª llamada con CUALQUIER password (incluso el correcto)
> devuelve `403 Account locked, try in 14 min`.
>
> Adicionalmente, **rate-limit IP**: si la misma IP hace >10 logins en 60s,
> Redis bucket por bucket devuelve `429 Retry-After: 30s`.

---

## 4. Cobros con QR

Flow del modelo clásico (sin wallet):

1. Chica → operator app → introduce 50€ → terminal del venue.
2. API crea `Payment(status=CREATED)` + `qrToken` único + TTL 5 min.
3. La chica enseña el QR a la pantalla del cliente.
4. Cliente escanea → `/pay/<qrToken>` → ve detalles → paga.
5. Web-client llama a `/start-authorization` → API redirige al PSP.
6. Cliente confirma con su banco → PSP envía webhook a `/v1/webhooks/<provider>`.
7. API valida HMAC + idempotencia + FSM transition → `AUTHORIZED`.
8. Hook auto: crea `OperatorEarning` con snapshot de su `commissionBps`.
9. WebSocket emite `payment:completed` → chica ve "✓ Cobrado".

### Ejemplo: cobro real

> 23:47 — Cliente pide una copa, Ana en operator app:
>
> 1. Inicio → "Crear cobro" → 12€ → enseña QR.
> 2. Cliente escanea con su Android → web-client carga en 800ms → "Pagar".
> 3. Wipay redirige al banco del cliente → cliente firma con biometría.
> 4. Banco aprueba → Wipay POST webhook a NightPay con HMAC válido.
> 5. API: `Payment fce4... → AUTHORIZED`. Hook crea `OperatorEarning`:
>    - `paymentAmountCents: 1200`
>    - `commissionBps: 9000` (snapshot — si OWNER cambia el % después,
>      este earning queda con 90%)
>    - `commissionCents: 1080`
> 6. WebSocket `payment:completed` → operator app muestra "✓ +10.80€".
>
> Total elapsed: ~6 segundos del QR a "cobrado". El cliente no nota el
> roundtrip al PSP — solo ve la pantalla de su banco como pago normal.

### FSM completa

```
CREATED ──→ AWAITING_CAPTURE ──→ AUTHORIZING ──→ AUTHORIZED
   │                                  │
   │                                  ├──→ FAILED
   │                                  ├──→ EXPIRED
   └─────────────────────────────────→ CANCELED
```

Cada transición se valida con `applyEvent()` (XState 5). Si alguien intenta
mover un Payment ya AUTHORIZED a otro estado, tira `InvalidTransitionError`.

---

## 5. Phase 1A — Multi-rail payout

**19 métodos** de payout soportados, agrupados en 5 categorías:

| Categoría | Métodos | Reconciliación |
|---|---|---|
| Cripto on-chain | USDT-TRC20, USDT-BEP20, USDC-POLY, USDC-SOL | **Automática** vía explorer API |
| Exchange interno | Binance Pay ID, OKX, Bybit | Semi-manual (admin pega receipt) |
| E-wallet | FasterPay, PayQuicker, Hyperwallet, Revolut, Payoneer | Manual + screenshot |
| Banco wire | SEPA IBAN, SWIFT internacional | Manual + receipt SEPA/SWIFT |
| Wallet LatAm | MercadoPago, Pix, Nequi, Daviplata | Manual + receipt |
| Efectivo | MANUAL_CASH | Admin firma + foto opcional |

### Ejemplo A: Camila cobra vía USDT-TRC20 (reconciliación automática)

> **Setup** (una vez):
>
> 1. Camila tiene Binance con KYC verificado (pasaporte colombiano).
> 2. Admin entra en NightPay admin → Operadoras → Camila → tab Edit:
>    - `payoutMethod`: USDT-TRC20
>    - `payoutAddress`: `TXYZxQwUVqHbvHvgrkqz6T6oyhqcKpuFiV` (su address Binance)
>    - `payoutLabel`: "Binance Camila"
> 3. Admin envía 1 USDT de prueba desde Binance Business → Camila confirma
>    que llegó → marca `walletTestPassed=true`.
>
> **Una noche cualquiera**, Camila cobra 5 clientes a 50€ = 250€.
> Su 90% = 225€ pendientes.
>
> **Pago semanal**:
>
> 1. Admin → Operadoras → Camila → "Marcar pagado 225€".
> 2. Modal muestra: address `TXYZ...`, importe 225€ ≈ **243.7 USDT**
>    (rate Binance EURUSDT live).
> 3. Admin abre Binance Business → envía 243.7 USDT → copia txhash
>    `0xabc123def456...`
> 4. Vuelve al modal → pega el txhash → click "Verificar".
> 5. NightPay backend llama a `https://apilist.tronscanapi.com/api/transaction-info?hash=0xabc...`
> 6. Tronscan responde:
>    ```json
>    {
>      "confirmed": true,
>      "contractRet": "SUCCESS",
>      "trc20TransferInfo": [{
>        "contract_address": "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
>        "to_address": "TXYZxQwUVqHbvHvgrkqz6T6oyhqcKpuFiV",
>        "amount_str": "243700000"
>      }]
>    }
>    ```
> 7. NightPay valida:
>    - Contrato es USDT-TRC20 oficial ✓
>    - to_address coincide ✓
>    - 243.7 USDT actual vs 243.7 USDT esperado (tolerancia ±2%) ✓
> 8. `OperatorPayout.reconciliationStatus = MATCHED`. Audit log persistido.
> 9. Camila refresca su Binance app → ve 243.7 USDT → compra con su Visa
>    Card en cualquier comercio EU sin conversión visible.

### Ejemplo B: Daniela cobra vía SEPA + TBC Bank Georgia (manual)

> Daniela tiene cuenta en TBC Bank (Georgia, abierta con solo pasaporte
> mexicano en un viaje de 1 día a Tbilisi).
>
> - `payoutMethod`: WIRE_INTERNATIONAL
> - `payoutAddress`: `GE12TB7000000123456789` (su IBAN georgiano)
> - `payoutMetadata`: `{bankName: "TBC Bank", swiftBic: "TBCBGE22", country: "Georgia", accountHolder: "Daniela Hernández"}`
>
> Admin envía 500€ vía SEPA → tarda 1-2 días en llegar → admin pega el
> SEPA reference en NightPay + uploads screenshot del banco → marca
> `MANUAL_OK`. Audit log captura quién confirmó y cuándo.

### Reconciliación nocturna

Cron 03:00 UTC procesa solo los rails con verificador automático:

```typescript
// reconcilePending:
const pending = await prisma.operatorPayout.findMany({
  where: { reconciliationStatus: 'UNRECONCILED',
           externalTxId: { not: null },
           externalRail: { in: ['USDT_TRC20', 'USDT_BEP20', 'USDC_POLY', 'USDC_SOL'] } },
  take: 100,
});
// Procesa en batches de 5 con Promise.allSettled → si un explorer falla,
// los demás siguen. Cap 100/run evita backlogs infinitos.
```

---

## 6. Phase 1A.1 — Onboarding tracker

**14 campos** en `User` para tracking de cada chica:

- Personales: `phone`, `passportCountry`, `passportLast4`
- Docs España: `hasEmpadronamiento`, `hasNie`, `hasTie`
- Wallet/Exchange: `walletProvider`, `walletStatus` (NOT_STARTED →
  REGISTERED → KYC_PENDING → KYC_VERIFIED → KYC_REJECTED), `walletTestPassed`,
  `walletTestAt`
- Flags ayuda: `needsHelpWallet`, `needsHelpDocs`
- Estado: `onboardingStatus` (NEW → PROFILE_CREATED → INVITE_ACTIVATED →
  BINANCE_PENDING → READY | BLOCKED)
- Notas: `onboardingNotes` (max 2000 chars)

### Ejemplo: vida de un onboarding

| Día | Evento | Status | Campos llenos |
|---|---|---|---|
| 0 | Admin crea Ana en NightPay | NEW | email, displayName, commissionBps |
| 0 | Invite URL generado y enviado por WhatsApp | PROFILE_CREATED | invitedAt set |
| 1 | Ana acepta invite + pone password | INVITE_ACTIVATED | inviteToken=null |
| 2 | Admin sienta a Ana con Binance KYC | BINANCE_PENDING | walletProvider=BINANCE, walletStatus=KYC_PENDING |
| 3 | KYC aprobado, Ana saca address USDT-TRC20 | BINANCE_PENDING | walletStatus=KYC_VERIFIED, payoutMethod=USDT_TRC20, payoutAddress=TXYZ... |
| 3 | Admin envía 1 USDT de prueba, Ana confirma recepción | READY | walletTestPassed=true, walletTestAt=now |
| 30 | Ana viaja a Colombia, pide ayuda con MercadoPago | READY | needsHelpWallet=true, onboardingNotes="quiere también MercadoPago AR" |

### UI admin

Tab "Onboarding" dentro de cada operadora con 5 secciones (estado, datos
personales, docs, wallet, ayuda) + filtro lista "Solo las que necesitan
ayuda (N)". Filas que tienen `needsHelpWallet||needsHelpDocs` se pintan
amarillas para que el admin no las olvide.

---

## 7. Phase 1A.2 — Self-onboarding link

Admin genera un **link único 72h** y se lo manda a la chica por WhatsApp.
Ella abre el link **sin login** (JWT en path es la cred) y rellena ella misma
su perfil. Coexiste con el flow manual: si la chica no es tech-savvy, el
admin rellena por ella desde su tab Onboarding como siempre.

### Ejemplo: Camila se hace su perfil sola

> **Admin** → Operadoras → Camila → tab Onboarding → banner "¿La chica
> sabe usar la web?" → click **📤 Generar link**.
>
> Backend genera:
> - JWT con `purpose='operator-self-onboarding'`, `sub=camilaId`,
>   `tenantId=lunaVlcId`, TTL 72h.
> - Hash sha256 del JWT persistido en `users.selfOnboardingToken`.
> - URL: `http://operator.paytomaxx.com/onboarding/<jwt-largo>`
>
> Admin click **💬 Compartir WhatsApp** → abre wa.me con texto
> pre-formateado:
> > Hola, este es tu link para rellenar tu perfil en NightPay (válido 72h):
> > http://operator.paytomaxx.com/onboarding/eyJhbGc...
>
> **Camila** abre el link desde su móvil → ve form pre-rellenado con
> lo que el admin ya sabe (su nombre, venue Luna VLC):
>
> - **Datos personales**: pone su móvil +34 6XX..., selecciona "Colombia",
>   últimos 4 del pasaporte "8742".
> - **Docs**: marca "Empadronamiento" (lo tiene), deja NIE/TIE sin marcar.
> - **Wallet**: selecciona "Binance", status "🟢 KYC aprobado, todo OK",
>   marca "Recibí la prueba de 1 USDT".
> - **Payout**: selecciona "USDT en red Tron", pega su address,
>   label "Mi Binance principal".
> - **Ayuda**: deja sin marcar (no necesita).
> - **Notas**: "Viajo a Bogotá en julio 2 semanas, ¿podemos pagar por
>   MercadoPago esos días?"
>
> Click **Guardar mi perfil** → mensaje "✓ Hemos recibido tus datos.
> Puedes cerrar la página."
>
> **Detrás**: backend valida JWT + hash match + actualiza `User` con todos
> los campos. Audit log: `operator.self_onboarding.submitted` con la chica
> como actor. `onboardingStatus` avanza de PROFILE_CREATED → INVITE_ACTIVATED
> automáticamente.
>
> Camila tiene 72h para volver y editar. Si quiere más, admin rota el link
> (el anterior queda invalidado al cambiar el hash).

### Restricciones de seguridad

La chica **NO puede** tocar campos financieros:
- `commissionBps` (su %)
- `active` (dar de baja)
- `payoutMetadata` (datos extra del banco)

Eso queda OWNER-only en el admin. La validación está en el Zod schema +
en el guard del endpoint.

---

## 8. Phase 1B — Wallet cash-in-advance

### Por qué existe

**Regla #1: no molestar al cliente**. En el modelo clásico, cada vez que la
chica quería cobrar algo le pedía el móvil al cliente para escanear su QR
de pago. Pésima UX en un venue nocturno donde el cliente está bebiendo,
hablando, etc.

Con wallet, el cliente paga **UNA vez** al entrar (un cargo en su tarjeta,
descriptor neutro tipo "SERVICIOS LV MADRID") y durante la noche la chica
le cobra sin tocarlo.

### Legal — closed-loop prepaid

Operado bajo **EMD2 art. 1.5(k)**: closed-loop prepaid exemption. El saldo:
- Solo se gasta dentro del venue
- No se convierte en cash directamente
- Refund solo a la tarjeta original

**Mismo modelo legal** que casinos con chips de plástico, parques de
atracciones con pulseras RFID, hoteles all-inclusive. **No requiere
licencia EMI**.

### Ejemplo: noche completa de Cliente A

```
21:00 — Cliente A entra al venue, Ana lo recibe.
       Ana: "¿Quieres cargar saldo y te cobro sin molestarte el resto
        de la noche? Tipo todo-incluido."
       Cliente: "Vale, dame 500€."

       Ana → operator app → tab Inicio → toggle "Cargar wallet" →
        etiqueta "Mesa 3" + importe 500€ → click "Cargar 500 €".

       NightPay crea:
       - ClientWallet(id=w-abc, identifier="Mesa 3", balanceCents=0, status=ACTIVE)
       - Payment(amountCents=50000, walletId=w-abc, captureMethod=WALLET_TOPUP)
       - qrToken para el cliente

       Cliente escanea QR → /pay/<token> → Wipay → tarjeta → "Pagar 500€"
        → cliente firma → PSP webhook → AUTHORIZED.

       Hook atómico en transition():
       UPDATE client_wallets SET balanceCents = 50000 WHERE id = 'w-abc';

       Cliente recibe URL móvil con su balance: 500€ ACTIVA.
        Puede cerrar el navegador y olvidarse.

22:30 — Cliente pide 4 cervezas en barra = 24€.
       Camarero José → operator app → tab Wallet → ve lista de wallets
        activos del venue → click "Mesa 3" → 24€ + categoría "bar".

       Backend (transacción atómica):
       - SELECT FOR UPDATE wallet → balance 500€, ACTIVE ✓
       - Valida 24€ <= 500€ ✓
       - Crea WalletConsumption(amountCents=2400, providedBy=José, category=bar)
       - José es WAITER, no OPERATOR → NO genera earning para él
       - UPDATE wallet SET balanceCents = 47600

       Cliente ve su balance bajar a 476€ en su móvil (polling 5s).
       Sigue charlando.

23:15 — Cliente sube a habitación 3 → 100€.
       Recepción (Marta, MANAGER) → tab Wallet → "Mesa 3" → 100€ "room"
       → balance 376€.

01:00 — Cliente paga "tiempo" con Ana → 200€.
       Ana → tab Wallet → "Mesa 3" → 200€ "time" → confirma.

       Backend:
       - SELECT FOR UPDATE wallet → balance 376€, ACTIVE ✓
       - Valida 200€ <= 376€ ✓
       - Crea WalletConsumption(amountCents=20000, providedBy=Ana, category=time)
       - Ana es OPERATOR con commissionBps=9000 → genera EARNING:
         OperatorEarning(consumptionId=c-xyz, paymentAmountCents=20000,
                        commissionBps=9000, commissionCents=18000)
       - UPDATE wallet SET balanceCents = 17600

       Ana ve +180€ en su saldo pendiente INSTANT.

03:00 — Cliente se va.
       Admin → tab Wallets → click "Mesa 3" → "Refund" → CARD.

       Backend:
       - Lock wallet → balance 176€, ACTIVE ✓
       - UPDATE wallet SET balanceCents=0, status=REFUNDED
       - Audit log: wallet.refund (method=CARD, refundedCents=17600)
       - TODO: disparar PSP refund real (hoy solo marca DB).

       Cliente recibe T+1 en su tarjeta: -176€ "SERVICIOS LV MADRID".

       Cliente solo metió la tarjeta UNA vez en toda la noche.
       Total gastado: 324€. Comisión Ana: 180€ (de los 200€ que él le pagó).
```

### UIs por rol

**Operator (chica)**:
- Tab Inicio → toggle "Cobro directo" / "Cargar wallet". Para wallet pone
  etiqueta + importe.
- Tab Wallet → lista de wallets activos del venue con etiqueta + balance +
  tiempo desde creación. Búsqueda. Click → cobra. Auto-refresh 8s.

**Web-client (móvil del cliente)**:
- `/wallet/<qrToken>` → balance grande, lista de consumos por categoría,
  total acumulado, polling 5s.

**Admin**:
- Tab Wallets → 4 tiles (activas, balance total, top-ups hoy, consumido
  hoy) + split por categoría + tabla con filtro status + botón Refund con
  modal CARD vs CREDIT.

### Esquema

```
ClientWallet {
  id, tenantId, identifier ("Mesa 3"), balanceCents,
  status ACTIVE|EXPIRED|REFUNDED|DEPLETED, expiresAt,
  qrToken (único, ~24 chars base64url)
}

WalletConsumption {
  id, tenantId, walletId, amountCents,
  providedByUserId, category, notes,
  idempotencyKey (unique tenant+key), reversedAt
}

Payment.walletId nullable → si set, captureMethod=WALLET_TOPUP,
   y el hook de AUTHORIZED suma al balance.

OperatorEarning {
  paymentId XOR consumptionId (CHECK constraint)
  // Mismo ledger viene de cobros directos QR o de consumes de wallet.
}
```

---

## 9. Comisiones configurables

`Venue.platformCommissionBps` (default 1000 = 10% NightPay / 90% chica).
`Venue.operatorMaxCobroCents` (cap por cobro creado por OPERATOR, default 200€).
Ambos editables desde admin → tab Ajustes (OWNER-only).

### Ejemplo: cálculo en bps

> Ana tiene `commissionBps=9000` (90%).
>
> Cliente paga 50€ (5000 céntimos).
>
> - Comisión chica: `floor(5000 × 9000 / 10000) = 4500` céntimos = 45€.
> - Comisión NightPay: 5000 - 4500 = 500 céntimos = 5€.
>
> OWNER decide bajar a Ana al 80% (`commissionBps=8000`). Los earnings ya
> existentes mantienen su 90% (snapshot). Los nuevos cobros que haga Ana
> usarán 80%.

---

## 10. Code review fixes

Tras un code review propio detallado, se resolvieron **11 items**:

| # | Bug | Fix |
|---|---|---|
| 1 | CLS context middleware estaba como guard → no aplicaba tenant filtering en endpoints | Movido a middleware (runs antes de guards) |
| 2 | 9× `@ts-expect-error` en treasury service | Removidos (Prisma client regenerado) |
| 3 | Sin API keys, verifiers fallaban silenciosos | Warning explícito al boot listando qué keys faltan |
| 4 | Solana verifier comparaba wallet vs ATA → nunca matcheaba | Deriva ATA owner desde `postTokenBalances` |
| 5 | EUR/USDT fallback hardcoded silencioso | Flag `degraded:true` propagado a UI con cascade fallback |
| 6 | Polygon confirms 64 vs Binance que considera final a 128 | Subido a 128 |
| 7 | Verify endpoint no idempotente | Short-circuit si ya MATCHED/MANUAL_OK con mismo txid |
| 8 | MANAGER podía editar campos financieros | Whitelist OWNER_ONLY_FIELDS + 403 si MANAGER toca |
| 9 | confirmManual sin artifact = audit log hueco | Exige al menos txId, receiptUrl o notes |
| 10 | Reconciliación serial = lenta | Batch allSettled de 5, cap 100/run |
| 11 | OnboardingBadge no cubría PROFILE_CREATED | Caso explícito añadido |

### Ejemplo del bug CLS (item 1)

> **Antes**: cada request tenía en logs:
> ```
> WARN [AuthGuard] CLS context not active — tenant filtering will not apply
> ```
> Significaba que el middleware de Prisma que inyecta `WHERE tenantId =`
> en cada query NO se aplicaba. Cualquier query a través de Prisma podía
> leer datos cross-tenant. **Defensa en profundidad caída**.
>
> **Causa raíz**: `ClsModule` estaba montado con `guard.mount: true`. Los
> guards globales corren en paralelo no determinístico — `AuthGuard`
> ejecutaba antes que `ClsGuard` setease el contexto.
>
> **Fix**: cambiar a `middleware.mount: true`. Middlewares siempre
> corren ANTES de cualquier guard. Después del fix, ya no aparece el warning
> en los logs y la doble defensa (app-level + RLS) está activa.

---

## 11. Quality

### Rate-limit IP per-endpoint

Redis-backed fixed-window INCR. Endpoints sensibles:
- `POST /auth/login` → 10/min/IP
- `POST /auth/refresh` → 30/min/IP
- `POST /operators/accept-invite` → 10/min/IP (token enumeration target)
- `GET /operators/self-onboarding/:token` → 30/min/IP
- Global default → 100/min/IP

### Ejemplo: bloqueo brute-force

> Atacante con IP 203.0.113.5 prueba 12 logins en 60s. Redis bucket
> `nightpay:iprl:auth-login:203.0.113.5:<bucket>` llega a 11 → guard
> devuelve `429 Too Many Requests` con header `Retry-After: 47s`.
> Sin Redis hit pesado, sin tocar la DB, sin verificar JWT.

### E2E Playwright

`apps/e2e/` workspace con specs:
- **api-smoke** (8 tests): metrics, operators con onboarding fields,
  treasury stats, exchange-rate degraded flag, MANAGER 403 on commissionBps,
  rate-limit 429.
- **admin-ui** (4 tests): dashboard, Operadoras, Treasury, Ajustes tabs sin
  crash "Error cargando".

### Observabilidad

- **Sentry** (soft-dependency, no crashea si no instalado). Scrubbing PII
  auto (password, passportLast4, payoutAddress, tokens).
- **Grafana dashboard JSON** + **Prometheus rules YAML** con 5 alertas:
  APIDown, HighErrorRate, GatewayCircuitOpen, PayoutsReconcileBacklog,
  AuthBruteForce.

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

## 12. Lo que falta

### Bloqueantes operativos

| # | Item | Esfuerzo | Bloqueado por |
|---|---|---|---|
| 1 | Credenciales sandbox Wipay/Peanpe | 0 (admin) | KYB pendiente |
| 2 | Wallet refund CARD → disparar PSP refund real | 1 día | Item 1 |
| 3 | Webhook E2E con PSP sandbox | 1 día | Item 1 |
| 4 | Onboarding real de una chica a Binance | 30 min con ella delante | Tú + chica |
| 5 | Resend API key (envío real de invites por email) | 2h + key | Cuenta Resend |
| 6 | Deploy Dokploy + DNS + SSL + env vars prod | 3-5 días | Decisión + KYB |

### Operativos / contables

| # | Item | Esfuerzo |
|---|---|---|
| 7 | CSV export mensual de payouts (contable) | 4-6h |
| 8 | Operator pool — chicas comparten un fondo común | 2 días |
| 9 | Notification policy: emails cuando reciben payout | 1 día |
| 10 | Reporte fiscal: Modelo 100 + Modelo 721 helper | 2-3 días |

### Calidad / hardening

| # | Item | Esfuerzo |
|---|---|---|
| 11 | Tests del top-up flow end-to-end (vitest) | 1 día |
| 12 | Tests del self-onboarding flow | 0.5 día |
| 13 | Backup automatizado Postgres + restore drill | 1 día |
| 14 | Branch `feature-operators` → PR review → merge a `main` | 1 día |

### Phase 2 — escalar (post 6 meses)

| Item | Cuándo |
|---|---|
| Escalar a venues de terceros (multi-tenant comercial) | Tras 6 meses validando |
| API Binance automatizada (no manual desde admin) | Phase 2 |
| AISP del banco para reconciliación settlement automático | Phase 2 |
| Licencia VASP si se custodia para terceros | Phase 2 (si aplica) |

---

## 13. Cómo correrlo en local

```bash
# 1. Postgres + Redis
cd nightpay
docker compose up -d postgres redis

# 2. Deps
pnpm install

# 3. DB
pnpm --filter @nightpay/db migrate:deploy
pnpm --filter @nightpay/db generate

# 4. Seed inicial
pnpm --filter @nightpay/db cli create-owner \
  --venue luna-vlc \
  --email owner@nightpay.local \
  --password "TuPassword!2026"

pnpm --filter @nightpay/db cli create-operator \
  --venue luna-vlc \
  --email ana@local.test \
  --display-name "Ana" \
  --commission 90

# 5. Arranca apps (4 terminales)
pnpm --filter @nightpay/api dev          # :4100
pnpm --filter @nightpay/admin dev        # :4103
pnpm --filter @nightpay/operator dev     # :4101
pnpm --filter @nightpay/web-client dev   # :4102
```

Abre `http://localhost:4103` con el owner.

### Tests

```bash
pnpm --filter @nightpay/api test       # 143 unit + integration, ~8s
pnpm --filter @nightpay/e2e test       # Playwright (necesita apps corriendo)
```

---

## 14. Decisiones de diseño

### Multi-tenant con RLS hard-enforced
Doble defensa: middleware Prisma + RLS Postgres. Si alguien se cuela en la
DB con el role de la app, no puede leer cross-tenant.

### Adapter pattern para pasarelas
Cada pasarela implementa `GatewayAdapter`. Añadir Stripe o Mollie = escribir
un nuevo adapter, sin tocar el resto del código.

### FSM para pagos con XState 5
Los pagos tienen muchos estados. XState formaliza las transiciones legales.
`applyEvent()` valida o tira `InvalidTransitionError`.

### Earnings con snapshot de bps
Cuando una chica cobra y va AUTHORIZED, su comisión se persiste con un
**snapshot del bps actual**. Si OWNER cambia el % después, los earnings
históricos no se reescriben.

### Idempotency keys obligatorios
Tanto en `POST /payments` como en `POST /wallets/:id/consume`. El camarero
puede pulsar 2 veces "Cobrar" sin generar 2 cobros.

### Closed-loop prepaid = sin licencia EMI
Phase 1B opera bajo EMD2 art. 1.5(k). Saldo solo se gasta dentro del venue,
sin conversión a cash, refund solo a la tarjeta original. Mismo modelo legal
que casinos con chips.

### Phase 1C SoftPOS descartada
Se evaluó tap-to-phone con Viva.com / SumUp. Se descartó por complejidad
operativa (KYB con otro PSP, hardware Android NFC, certificación). QR
clásico + wallet prepago cubren el caso.

---

## 15. Riesgos abiertos

### AML banco español
Pattern "PSP settlement → SEPA outgoing a Binance" puede generar review.
**Mitigación**: ratio sano (no 100% a cripto), contabilidad clara, chicas
dadas de alta como autónomas / con factura.

### Fiscalidad chicas
Si residen >183 días en España, ingresos USDT son rendimiento gravable.
Modelo 100 + Modelo 721 si saldo cripto >50k€ a 31/dic. Responsabilidad
de cada chica, NO de NightPay, pero éticamente conviene avisarles.

### MCC vs operativa real
El registro hostelero (5813/5812/7011) debe coincidir con la operativa.
Si se registra como hostelería pero la operativa real difiere, el PSP
eventualmente detecta (review periódico, denuncia, redes) → cierre cuenta.
**Mitigación**: fachada y operativa coherentes.

### Travel Rule cripto
Binance pide info del receptor para envíos >1.000€ a self-custody. Entre
cuentas Binance es trivial. Para self-custody (Trust Wallet) preparar
los datos.

### Chargebacks
Por ahora ningún cliente nos ha hecho chargeback porque no hay tráfico
real. Cuando lleguen, el PSP retiene del settlement. **Mitigación**:
tracking de disputas + fondo de reserva.

---

## Apéndice — métricas del proyecto

- **Branch activo**: `feature-operators` (31 commits ahead de `main`)
- **Líneas de código**: ~25.000 (API + 3 frontends + contratos compartidos)
- **Migraciones Prisma**: 9
- **Tablas**: 16
- **Métodos de payout**: 19
- **Tests**: 143/143 verde
- **Estado**: feature-complete para Phase 1, listo para validar con
  tráfico real una vez resueltos los bloqueantes operativos.

---

**Documento generado para reunión de mayo 2026 · v2 con ejemplos**
