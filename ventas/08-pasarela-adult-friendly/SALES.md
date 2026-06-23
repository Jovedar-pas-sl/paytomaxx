# Ventas

## Pricing — 3 tiers

### Lite — 99 €/mes · 1,9 % + 0,25 €/tx · setup 1.500 €
Para negocios con < 10.000 €/mes en volumen.
- Hasta 500 transacciones/mes incluidas.
- Panel sub-merchant, refunds, exportación CSV / Holded / FacturaScripts.
- Onboarding KYB asistido (1 sesión, 2 h).
- Soporte por email, SLA 24 h hábiles.
- 3-D Secure incluido.

### Standard — 199 €/mes · 1,5 % + 0,25 €/tx · setup 1.500 €
Para 10.000 – 50.000 €/mes.
- Hasta 3.000 transacciones/mes incluidas.
- Reglas antifraude custom (BIN blacklist, geo, velocity).
- Webhooks salientes hacia ERP/CRM del cliente.
- Soporte prioritario, SLA 4 h hábiles, canal directo.
- Reporting fiscal trimestral.

### Volume — 399 €/mes · 1,2 % + 0,25 €/tx · setup negociable
Para > 50.000 €/mes.
- Transacciones ilimitadas.
- IBAN dedicado por sub-merchant.
- Panel disputas con flujo de evidencias.
- SLA 1 h hábil, account manager nominal.
- Revisión contractual y de límites cada trimestre.

> **Importante:** las tarifas % son **nuestras al cliente final**. Aún no tenemos confirmado el coste interno Cecabank para MCCs sensibles, lo que implica que estos números son una **propuesta de salida**; el margen real depende de la negociación con Cecabank (ver `riesgos-legales.md`).

---

## Add-ons

| Add-on | Precio |
|---|---|
| Account updater (renovación tokens) | 19 €/mes |
| Reporting fiscal mensual con asiento contable | 49 €/mes |
| Integración a medida (API custom, Shopify, WooCommerce) | 800 – 2.500 € one-shot |
| Onboarding express (KYB en 48 h vs 5-10 días) | 500 € one-shot |
| Sub-cuenta adicional dentro del mismo grupo | 49 €/mes |

---

## Reservas

- **Reserva de garantía:** 5 % – 10 % del volumen mensual durante 90 días (estándar high-risk). Liberable según historial de chargebacks.
- **Chargebacks:** 25 € por chargeback recibido. Si la tasa supera 0,9 % en un trimestre se revisa contrato.

---

## 1-pager — para enviar por email

> **Acepta pagos donde otros no pueden.**
>
> Pasarela de pago para negocios legalmente constituidos en España a los que Stripe o PayPal no aceptan por sector.
>
> - Adquirente español (Cecabank). Liquidación en EUR.
> - Tarifas desde 1,5 % + 0,25 €/tx — 3× más baratos que CCBill o Verotel.
> - Onboarding KYB en 5-10 días con soporte humano.
> - Panel sub-merchant, refunds, disputas y reporting fiscal incluidos.
> - Stack ya en producción.
>
> Pedimos KYB serio. No trabajamos con cualquiera. Eso es exactamente por qué te aceptan donde otros te rechazan.
>
> ¿Hablamos? — 30 min de llamada, evaluación gratuita de tu MCC y volumen.

---

## 10 objeciones esperadas

### 1. "¿Esto es legal?"
Sí, siempre que tu negocio lo sea. Cecabank es un banco supervisado por el Banco de España. Tú facturas como facturarías con cualquier TPV: lo único distinto es que pasamos un filtro de elegibilidad más realista para tu sector. Lo que no es legal —pornografía con menores, prostitución con coacción, blanqueo— sigue sin serlo y no trabajamos con ello. Tenemos `riesgos-legales.md` público para ese conversación.

### 2. "¿Por qué Stripe me rechazó y vosotros no?"
Stripe optimiza para escala global. Su filtro automático corta MCCs sensibles incluso cuando son legales en España. Nosotros hacemos KYB manual y trabajamos con un adquirente español que decide caso a caso, no por matriz global.

### 3. "Vuestra tarifa es más cara que Stripe."
Sí, cuando Stripe te acepta. Si Stripe te ha cerrado la cuenta tres veces tienes dos opciones: nosotros al 1,5 – 2,9 % o CCBill / Verotel al 9 – 14 %. La comparativa relevante es esa.

### 4. "¿Y si Cecabank me cierra en 6 meses?"
Es un riesgo real en cualquier high-risk. Por eso (a) hacemos KYB exigente al inicio, (b) monitorizamos tu tasa de chargebacks en tiempo real, (c) si hay señales tempranas hablamos contigo antes de que el adquirente actúe, (d) podemos pivotar a otro adquirente español si tu perfil sigue limpio. No prometemos cero churn — prometemos transparencia.

### 5. "¿Y los chargebacks y devoluciones?"
Tienes panel de disputas con flujo de evidencias. Por contrato cobramos 25 € por chargeback recibido (es coste del adquirente). Si tu tasa supera 0,9 % en un trimestre revisamos contrato. Las devoluciones normales (cliente pide reembolso) las haces tú desde el panel en un clic.

### 6. "¿KYC del cliente final de mis clientes? ¿Soy yo el que tiene que verificar?"
Tú firmas un sub-merchant agreement con Cecabank a través de nosotros. Tú eres responsable de tu KYC al cliente final según tu sector (AML si aplica, mayoría de edad para servicios para adultos, etc.). Te damos checklist y herramientas (verificación de edad y de identidad vía proveedor integrado), pero la responsabilidad última es tuya. Esto sería igual con Stripe o cualquier otro.

### 7. "¿Qué pasa con mis datos? ¿PCI-DSS?"
Tú no tocas datos de tarjeta. El checkout es hosted en Cecabank: el cliente introduce la tarjeta en su dominio, no en el tuyo. Tú quedas en SAQ A (el escenario más simple de PCI). Si quisieras tokenizar tarjetas en tu plataforma subes a SAQ A-EP, lo cual sí es trabajo serio — desaconsejamos esa ruta salvo necesidad.

### 8. "Vuestro proyecto es muy pequeño. ¿Y si desaparecéis?"
Es una preocupación válida. Tres respuestas: (a) el adquirente real es Cecabank, no nosotros; tu sub-merchant agreement sigue siendo válido si nosotros desaparecemos, (b) podemos darte cláusula de escrow del software del panel, (c) durante el piloto a 90 días puedes salir sin penalización con datos exportables.

### 9. "¿Cuánto tardáis en activarme?"
KYB + contrato sub-merchant Cecabank: 5-10 días hábiles si el dossier está completo. Integración técnica: 2-3 días si usas Shopify / WooCommerce, 1-2 semanas si requiere integración API custom. Onboarding express en 48 h por 500 € de coste único.

### 10. "¿Por qué confiar en vosotros y no llamar directamente a Cecabank?"
Puedes intentarlo. Cecabank acepta clientes directos pero (a) no tienen comerciales especializados en MCCs sensibles, (b) tendrás que construirte el panel sub-merchant, el panel de disputas, el reporting fiscal, el flujo refunds, (c) no tendrás la negociación de tarifa que conseguimos por agregación. Nosotros somos eso: el equipo comercial y de producto que Cecabank no tiene para tu vertical.

---

## Scripts breves

**Apertura email frío:**
> Asunto: Cobro online para [vertical] en España
>
> Hola [nombre], si Stripe o PayPal te han cerrado la cuenta o te han rechazado, tenemos una alternativa con adquirente español (Cecabank) desde el 1,5 % + 0,25 €/tx. Onboarding en 5-10 días con KYB serio. ¿30 min de llamada esta semana?

**Cierre llamada:**
> Te paso el piloto: 90 días, sin penalización para salir, condiciones Standard. Si en 90 días tu volumen va por la línea que hemos hablado, entras en Standard normal. Si no, lo cancelamos sin coste. ¿Avanzamos?
