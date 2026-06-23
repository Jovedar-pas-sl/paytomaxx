# NightPay Lite — TPV-as-a-Service para discotecas

> Alquiler mensual del stack NightPay (QR + NFC + Admin + TPV camarero) para salas
> de ocio nocturno que **ya tienen Paytef instalado** pero operan con software de caja
> obsoleto o inexistente.

---

## Qué es esto

**NightPay Lite** es un paquete comercial cerrado sobre el monorepo
`nightpay/` ya en produccion local. La propuesta de valor es brutalmente concreta:

- El cliente ya tiene un **PAX A920 / IM30** conectado a Paytef.
- Nosotros le damos en 72 h:
  - Una **web cliente** (QR escaneable desde la barra → cobro <15 s).
  - Un **TPV de camarero** (Next.js) que dispara el cobro en el PAX existente.
  - Un **panel admin** con metricas de noche en tiempo real (ventas, tickets, refunds).
  - **Webhooks** ya cableados a la cuenta Paytef company `76861`.
- Cobramos **setup one-shot** + **suscripcion mensual** + **comision opcional sobre volumen**.

No es "venderle software" — es venderle una **operacion completa de cobro de noche**
sobre infraestructura que ya pago.

---

## Por que NightPay Lite y no NightPay completo

| | NightPay (full) | **NightPay Lite** |
|--|----------------|--------------------|
| Pasarela | Wipay + Peanpe + failover | **Paytef ya activo** (sin failover dia 1) |
| Tiempo a primer cobro | 4-6 semanas | **72 h** desde firma |
| Onboarding | Custom por venue | **Self-onboarding** (`pnpm cli` wizard) |
| Comercial | Venta consultiva 30k+ | **SaaS mensual 199-349 €/mes** |
| Cliente objetivo | Cadenas 5+ salas | **Salas individuales 200-1.500 pax** |

NightPay Lite es la primera puerta de entrada. NightPay full es el upsell a 12 meses.

---

## Estado real (hoy, 2026-05-26)

- **Backend:** feature-complete a nivel local (99 tests verdes). Ver
  `../../nightpay/STATUS.md`.
- **Integracion Paytef:** real, company `76861`, 50+ maquinas activas en
  `../../shared_db.json` listadas como `Conectado` / `Desconectado`.
- **Integracion Cecabank/Wipay:** commit `b52153f` ya merged.
- **Bloqueante comercial dia 1:** ninguno. Cliente con PAX activo → factura emitible
  en la misma semana de la firma.
- **Bloqueante tecnico dia 1:** desplegar a VPS Hetzner con dominio. ETA 5 dias.

---

## Pitch en 30 segundos

> "Ya tienes Paytef y un PAX en barra. Te falta el software de caja para que tus
> camareros cobren rapido, ver en tiempo real cuanto llevas vendido esta noche, y
> que el cliente pueda pagar con QR sin pasar por la cola. Te lo monto en 72 h
> sobre lo que ya tienes. 199 € al mes. Si no te aporta, lo quitas."

---

## Demo del flujo de venta (5 pasos)

1. **Prospect** — sala de la lista `shared_db.json` con `paytefDeviceStatus = "Conectado"`.
2. **Llamada qualifier** (10 min, ver `PRIMER_CLIENTE.md`) — confirmar volumen
   noches/semana, ticket medio, dolor de software de caja.
3. **Demo en vivo** (30 min, video o presencial) — login admin, crear pago, QR,
   confirmar en movil, ver ticket en admin en tiempo real.
4. **Propuesta 1-pager** (ver `SALES.md`) — Starter / Pro / Enterprise.
5. **Firma + setup**: `pnpm cli create-venue` + `set-credential PAYTEF` + alta
   camareros + onboarding 2 h presencial primer viernes.

---

## Estructura de esta carpeta

```
01-nightpay-lite/
├── README.md            ← estas aqui
├── SALES.md             ← pricing 3 tiers + propuesta 1-pager + 10 objeciones
├── ROADMAP.md           ← checklist 30 dias para cerrar primer cliente
├── PRIMER_CLIENTE.md    ← perfil ICP + guion llamada + email + objecion clave
├── pitch.md             ← deck 12 slides en markdown
├── DECISIONS.md         ← 7 decisiones clave con razon
└── landing/
    └── index.html       ← landing 1-pagina estatica con form contacto
```

---

## Lo que NO somos

- No somos una pasarela. Paytef cobra. Nosotros somos la capa de software encima.
- No competimos con Glop / Revo / Cuiner (cajas restaurante). Vamos a **ocio nocturno** especifico.
- No vendemos hardware. El PAX ya esta. Nosotros vendemos la operacion alrededor.

---

## Contacto interno

- **Dueno comercial:** ainhoanochesdeverano@gmail.com
- **Repo tecnico:** `../../nightpay/`
- **Stack de paytef ya en uso:** company `76861` (config en `../../paytef_config.json`)
