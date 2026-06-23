# Pasarela de Pago Adult-Friendly

**Pasarela de pago white-label para verticales high-risk operadas en España.**

White-label sobre Cecabank/Wipay (TPV Virtual). Para negocios legalmente constituidos en España que Stripe / PayPal / Square rechazan por MCC.

> Estado: **piloto en validación**. La integración técnica (NightPay → Cecabank/Wipay) está construida y en producción para un MCC tolerado. La aceptación de sub-aggregation para MCCs sensibles **NO está validada con Cecabank a nivel comercial** (ver `riesgos-legales.md`).

---

## Para quién

Negocios **legales en España** con dificultad para cobrar online porque su MCC dispara filtros en grandes procesadores internacionales.

| Vertical | MCC típico | Estado |
|---|---|---|
| Adult services (clubes, ocio adulto) legalmente constituidos | 7273, 5967 | Caso ancla. Requiere validación con Cecabank. |
| Juego online operado bajo licencia DGOJ | 7995 | Validación caso a caso. Adquirente probablemente exige licencia. |
| CBD / cannabis bajo regulación española | 5912, 5499 | Tolerado en función del catálogo. |
| Tabaco online (estancos, e-commerce con licencia) | 5993 | Restricciones por norma del Comisionado del Mercado de Tabacos. |
| Clubes privados, ocio nocturno premium | 5812, 7299 | OK. |
| Sex-shops online (productos no-servicio) | 5969 | Habitualmente OK. |
| Escorts independientes | 7273 | **NO** se acepta en este punto. Riesgo regulatorio individual. |

**Honesto:** No cubrimos pornografía con servicios al menor, cam-sites sin verificación de edad robusta, ni cualquier servicio prohibido por la legislación española. Tampoco trabajamos con clientes que no superen un KYB básico.

---

## Comparativa

| Característica | Nuestra pasarela | Stripe / PayPal | CCBill | Verotel |
|---|---|---|---|---|
| Adquirente español | Sí (Cecabank) | Variable | No (Wells Fargo USA) | No (EU genérico) |
| MCC adult-friendly | Caso a caso | Casi nunca | Sí, especializado | Sí |
| Tarifa típica | 1,5 – 2,9 % + 0,25 € | 1,4 – 2,9 % + 0,25 € (cuando aceptan) | 10,8 % | 9 – 14 % |
| Liquidación | EUR, T+1/T+2 | USD/EUR | USD | EUR |
| Soporte fiscal ES | Nativo | Limitado | Casi nulo | Nulo |
| Onboarding | Comercial + KYB local | Self-service | Self-service largo | Self-service |
| Marca blanca panel | Sí | No | No | No |

**Posicionamiento:** somos **caros vs Stripe, baratos vs CCBill/Verotel**, con liquidación EUR nativa y soporte fiscal español.

---

## Pricing

3 tiers — detalle completo en [`SALES.md`](./SALES.md).

| Tier | Setup | % por transacción | Mensualidad | Volumen orientativo |
|---|---|---|---|---|
| Lite | 1.500 € | 1,9 % + 0,25 € | 99 € | < 10 k €/mes |
| Standard | 1.500 € | 1,5 % + 0,25 € | 199 € | 10 – 50 k €/mes |
| Volume | Negociable | 1,2 % + 0,25 € | 399 € | > 50 k €/mes |

---

## Stack técnico

- **Adquirente:** Cecabank TPV Virtual (manual 8.25) + Consulta Estado 4.0
- **Pasarela aplicación:** NightPay → adapter `WipayAdapter` ya en producción. Firma SHA-256, webhook on-line, idempotencia por `Num_operacion`, circuit breaker, FSM de pago, refunds.
- **Antifraude:** 3-D Secure obligatorio en MCCs sensibles. Reglas adicionales sobre BIN, geo y velocity en panel.
- **Cumplimiento PCI:** SAQ A si todo el data flow PCI vive en Cecabank (hosted checkout). Si se hace tokenización propia, sube a SAQ A-EP / SAQ D.

---

## Documentación

- [`SALES.md`](./SALES.md) — pricing, 1-pager, objeciones.
- [`ROADMAP.md`](./ROADMAP.md) — checklist 6-10 semanas hasta primer cliente real.
- [`PRIMER_CLIENTE.md`](./PRIMER_CLIENTE.md) — guion piloto.
- [`DECISIONS.md`](./DECISIONS.md) — decisiones clave.
- [`riesgos-legales.md`](./riesgos-legales.md) — análisis honesto. Léelo antes de prometer nada a un cliente.
- [`pitch.md`](./pitch.md) — deck 12 slides.
- [`landing/`](./landing/) — landing fintech.
