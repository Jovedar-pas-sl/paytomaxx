# Primer cliente — Maxxag VLC / Maxxag MAD / Mansion Babylon Marbella

## Contexto

Tres clientes existentes de la cartera. Negocios legales constituidos en España, sector ocio adulto / clubes privados, con necesidad real de cobrar online (reservas, depósitos, fidelización) y rechazados por Stripe / PayPal.

**Maxxag VLC + Maxxag MAD** comparten estructura societaria, lo que permite ofertar paquete grupo. **Mansion Babylon Marbella** es independiente.

---

## Propuesta piloto 90 días

### Condiciones especiales

- **Setup:** 0 € (vs 1.500 € estándar) — coste asumido como inversión comercial.
- **Mensualidad piloto:** 49 €/mes los 3 primeros meses (vs 199 € Standard).
- **% transacción:** 1,9 % + 0,25 € los 3 primeros meses (luego 1,5 % + 0,25 € si firman Standard, o cancelan).
- **Cláusula salida limpia:** pueden cancelar cualquier día con 7 días de aviso, datos exportables, sin penalización.
- **Compromiso nuestro:** soporte directo por WhatsApp / Telegram las 24 h durante el piloto.

### A cambio pedimos:

- **Caso de éxito documentado** (anónimo OK) con cifras de volumen y conversión.
- **2 referrals** dentro del sector si el piloto funciona.
- **Compromiso de exclusividad** con nuestra pasarela para cobro online durante los 90 días.
- KYB completo y serio. No saltamos pasos.

---

## Guion comercial — reunión inicial

**Apertura (2 min):**
> "Tenemos noticias buenas. Lo que pasó con Stripe / PayPal no es problema vuestro, es un filtro automático por sector. Hemos construido una alternativa con un banco español, Cecabank, que es el mismo que llevan muchos hoteles y clubes legales. La tarifa es 5× más barata que CCBill o Verotel y la liquidación es en EUR directa a vuestra cuenta. Quiero proponeros un piloto de 90 días con coste casi cero y sin compromiso."

**Discovery (10 min):**
1. ¿Qué cobráis ahora online y qué no? ¿Cuánto perdéis por no aceptar tarjeta online?
2. ¿Reservas, entradas, depósitos, fichas? Volumen mensual aproximado.
3. ¿Cuántas devoluciones reales tenéis al mes?
4. ¿Cuántos chargebacks habéis tenido históricamente?
5. ¿Cómo gestionáis la mayoría de edad y la identificación del cliente in situ? (esto importa para argumentar limpieza ante Cecabank).

**Demo (5 min):**
- Mostrar landing y panel sub-merchant.
- Mostrar flujo de cobro (link de pago → 3-D Secure → confirmación → reflejo en panel).
- Mostrar refund de un clic.
- Mostrar exportación CSV / Holded.

**Propuesta (3 min):**
- 90 días, 49 €/mes, 1,9 % + 0,25 €/tx.
- Setup gratis. Cancelación sin penalización.
- Compromiso 24 h soporte directo.
- Pedimos: KYB serio, caso de éxito anónimo, exclusividad piloto, 2 referrals si va bien.

**Objeciones esperadas y respuestas (ver `SALES.md`):**
- "¿Y si me cierran a los 6 meses?" — respuesta objeción 4.
- "¿De verdad es legal?" — respuesta objeción 1, enseñar `riesgos-legales.md`.
- "¿Quién responde si hay devolución?" — explicar flujo refund + reserva de garantía.

**Cierre:**
- "Os mando hoy el contrato piloto. Si firmáis en 48 h, empezamos KYB el lunes. Primera transacción real en 2 semanas."

---

## Orden de ataque

1. **Maxxag VLC** — primer piloto. Volumen probablemente medio. Validación técnica y operativa.
2. **Maxxag MAD** — semana +2. Mismo grupo, contrato gemelo, replicación rápida.
3. **Mansion Babylon Marbella** — semana +4. Cliente independiente, valida que el producto funciona fuera del grupo Maxxag y abre referrals en Marbella (mercado denso).

---

## Email a competencia adult-friendly internacional

> **Para:** partner@ccbill.com, sales@verotel.com, sales@netbilling.com
>
> **Asunto:** Partnership oportunidad — segmento España adquirente local
>
> Hola,
>
> Soy fundador de una pasarela de pago para verticales high-risk en España, con adquirente local (Cecabank) y stack ya operativo. Veo dos modelos de colaboración con vosotros:
>
> 1. **Failover:** clientes vuestros que prefieren liquidar en EUR con un adquirente español pero no quieren perder vuestro stack global. Os los pasamos cuando os pidan opción EUR-local; nosotros somos su sub-merchant Cecabank y vosotros mantenéis el contrato global.
>
> 2. **Referral inverso:** clientes nuestros que necesitan multimoneda / mercados USA donde Cecabank no llega — os los referimos.
>
> Pricing partner: 0,2 % - 0,4 % por transacción referida según volumen y vertical.
>
> ¿Hablamos 30 min esta semana?
>
> — [Firma]

(No esperar mucho de esta vía a corto plazo: CCBill / Verotel ven España como mercado pequeño. Pero abre conversación que puede ser útil en 6-12 meses.)

---

## Métricas del piloto a medir

| Métrica | Objetivo 90 días |
|---|---|
| Volumen procesado | > 5.000 €/mes a partir del mes 2 |
| Tasa de éxito de pago | > 92 % |
| Tasa de chargebacks | < 0,5 % |
| Tasa de devoluciones | < 5 % |
| NPS sub-merchant | > 50 |
| Soporte: tickets/mes | < 10 |
| Soporte: tiempo medio respuesta | < 1 h hábil |

Si se cumplen 5 de 7, el piloto es éxito y se firma Standard.
