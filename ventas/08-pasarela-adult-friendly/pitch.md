# Pitch deck — 12 slides

> Tono fintech sobrio. No "adult". Foco mercado desatendido y stack técnico real.

---

## Slide 1 — Cover

**Pasarela de pago para negocios que Stripe rechaza.**
Adquirencia española. Pricing sostenible. Stack en producción.

[Logo placeholder]

---

## Slide 2 — El problema

Decenas de miles de negocios **legales en España** no pueden cobrar online.

- Clubes privados con licencia municipal.
- Casinos online con licencia DGOJ.
- E-commerce de CBD bajo regulación europea.
- Estancos online con autorización del Comisionado.
- Servicios para adultos legalmente constituidos.

**Stripe, PayPal y Square aplican filtros automáticos por MCC que ni siquiera revisan caso por caso.** Resultado: estos negocios cobran offline, pierden 30-50 % de conversión, o pagan 10-14 % a procesadores americanos (CCBill, Verotel) liquidando en USD.

---

## Slide 3 — La oportunidad

| Segmento ES | Negocios estimados | Volumen anual estimado |
|---|---|---|
| Ocio adulto legal | ~2.500 | 800 M € |
| Juego online con licencia | ~85 | 1.000 M € GGR |
| CBD / cannabis legal | ~1.200 | 250 M € |
| Tabaco online | ~600 | 400 M € |
| Clubes privados premium | ~400 | 300 M € |

Mercado total direccionable: > 2.500 M € de procesamiento/año. Con tarifa media 2 %: **50 M € de comisión/año** disponible para quien atienda al sector con stack serio.

(Cifras ilustrativas, no auditadas — orientación de tamaño, no compromiso comercial.)

---

## Slide 4 — La solución

**Pasarela white-label sobre adquirente español.**

- Adquirente: **Cecabank** (banco español supervisado por Banco de España).
- Pasarela aplicación: stack propio, ya en producción (NightPay).
- Onboarding KYB asistido en 5-10 días.
- Panel sub-merchant: cobros, refunds, disputas, reporting fiscal.
- Liquidación EUR directa al IBAN del cliente.

---

## Slide 5 — Stack técnico — diferenciación real

**Lo ya construido (no slideware):**

- Adapter Cecabank/Wipay con firma SHA-256, webhook on-line, idempotencia.
- FSM de pago con estados auditables.
- Circuit breaker para resiliencia ante caídas del adquirente.
- Refunds nativos.
- Multi-tenant con aislamiento por sub-merchant.
- 3-D Secure obligatorio.

**Lo construido vs construir:**

| Capacidad | Estado |
|---|---|
| Adapter Cecabank | ✅ Producción |
| Webhook idempotente | ✅ Producción |
| Refunds | ✅ Producción |
| Multi-tenant | ✅ Producción |
| Panel sub-merchant | 🚧 80 % |
| Panel disputas | 🚧 30 % |
| Reporting fiscal | 🚧 50 % |
| Onboarding KYB | 🆕 Diseño |

---

## Slide 6 — Posicionamiento

| | Stripe / PayPal | Nosotros | CCBill / Verotel |
|---|---|---|---|
| Adquirente | Variable | Cecabank ES | Wells Fargo / EU genérico |
| Acepta MCC sensible | Casi nunca | Caso a caso | Sí |
| Tarifa | 1,4 – 2,9 % (cuando aceptan) | 1,5 – 2,9 % | **9 – 14 %** |
| Liquidación EUR | Variable | Sí | No |
| Soporte español | Limitado | Sí | Casi nulo |
| Onboarding | Self-service | KYB asistido | Self-service largo |

**Nuestra propuesta:** caro vs Stripe cuando Stripe acepta. **5× más barato que CCBill cuando Stripe rechaza.** Es el segmento medio que falta hoy.

---

## Slide 7 — Modelo de negocio

| Tier | Setup | % tx | Mensualidad |
|---|---|---|---|
| Lite | 1.500 € | 1,9 % + 0,25 € | 99 €/mes |
| Standard | 1.500 € | 1,5 % + 0,25 € | 199 €/mes |
| Volume | Negociable | 1,2 % + 0,25 € | 399 €/mes |

**Unit economics objetivo (Standard, cliente 25 k €/mes volumen):**
- Ingresos % comisión: 25.000 × 1,5 % = 375 €/mes
- Coste interno % a Cecabank (estimado): 1,0 % = 250 €/mes
- Mensualidad: 199 €/mes
- Margen bruto: ≈ 320 €/mes/cliente

**Con 30 clientes Standard: ≈ 9.600 €/mes margen bruto.** Con 100 clientes: ≈ 32 k €/mes.

(Estimado. Coste interno real con Cecabank pendiente de negociación.)

---

## Slide 8 — Go-to-market

**Fase 1 — Piloto (mes 1-3):**
- 3 clientes existentes de cartera (Maxxag VLC, Maxxag MAD, Mansion Babylon Marbella).
- Setup gratis, mensualidad reducida, exclusividad.

**Fase 2 — Vertical adult ocio nocturno (mes 4-6):**
- Cold outreach a clubes legales en Madrid, Barcelona, Valencia, Marbella.
- Referencia de pilotos.
- Objetivo: 15 clientes activos.

**Fase 3 — Apertura otros verticales (mes 6-12):**
- CBD legal, tabaco online, clubes privados, juego con licencia.
- Partnerships con asesorías legales especializadas.
- Objetivo: 50 clientes.

---

## Slide 9 — Riesgos honestos

Mostramos los riesgos antes de que los pregunte:

1. **Cecabank puede no aceptar sub-aggregation** en MCCs sensibles. Plan B: Banc Sabadell, Caixabank, MONEI.
2. **Figura legal nuestra** requiere validación con abogado fintech antes de operar. Hipótesis: introductor + cliente directo Cecabank.
3. **Visa/Mastercard chargeback ratio** del portfolio agregado puede activar monitoring. KYB serio + monitorización son la mitigación.
4. **Stigma sectorial** puede afectar hiring y partners. Posicionamiento fintech sobrio, no adult.

Documentación completa: `riesgos-legales.md`.

---

## Slide 10 — Tracción

- Stack técnico Cecabank/Wipay **en producción** desde mayo 2026.
- 3 clientes de cartera comprometidos para piloto.
- Pipeline cualificado: ~15 leads en sector ocio adulto / clubes.
- Costes operativos actuales: < 1.500 €/mes (NightPay ya cubre buena parte).

---

## Slide 11 — Roadmap 90 días

| Semana | Hito |
|---|---|
| 1 | Validación comercial Cecabank |
| 2 | Validación legal abogado fintech |
| 3 | Go/No-Go decisión |
| 4-5 | Panel sub-merchant completo |
| 6 | KYC/AML procedimientos |
| 7 | Panel disputas |
| 8 | Auditoría seguridad / SAQ A |
| 9 | Primer cliente piloto en vivo |
| 10 | 3 clientes activos |

Detalle completo: `ROADMAP.md`.

---

## Slide 12 — Cierre

**Mercado desatendido. Stack ya construido. Validación legal en curso.**

Lo que pedimos:
- Si eres cliente potencial: 30 min de discovery.
- Si eres inversor early: conversación abierta sobre figura legal y dilución que financia validación regulatoria.
- Si eres partner adquirente / banco: hablamos.

Contacto: [email]
