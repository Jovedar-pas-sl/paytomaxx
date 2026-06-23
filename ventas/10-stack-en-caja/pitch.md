# pitch — Deck 12 slides Stack-en-Caja (foco partner agencias)

> Formato: 12 slides, ~25 min con Q&A. Llevar siempre demo en vivo de Maxxag anonimizada como respaldo.

---

## Slide 1 — Cover

**Stack-en-Caja**
Vende WhatsApp IA bajo tu marca. Sin construir backend.

[Tu logo] · [Web] · [Email]

*Notas oratoria:* Empieza con 1 frase: "En los próximos 25 minutos, vas a ver cómo añadir un producto recurrente de WhatsApp IA a tu cartera sin contratar a un solo desarrollador."

---

## Slide 2 — El problema de la agencia

**Tus clientes PYMEs te piden constantemente:**
- "Quiero responder más rápido en WhatsApp"
- "Mi recepcionista atiende mal, ¿hay forma de medirlo?"
- "Necesito un bot que entienda como mi marca"

**Tu realidad:**
- Construir esto in-house = 4-6 meses + un dev senior
- Revender HighLevel/Manychat = pierdes control de datos, marca, márgenes
- Decir "no" = pierdes upsell de mantenimiento mensual

*Notas:* Pausa después de "decir no". Mira al founder. "¿Cuántas veces este mes ya has dicho no a un cliente que te pedía esto?"

---

## Slide 3 — Lo que la mayoría hace (y por qué falla)

| Opción | Realidad |
|--------|----------|
| Recomendar HighLevel | 497 USD/mes white-label, cliente ve infra de HighLevel, datos en USA |
| Recomendar Manychat | Se queda corto en multi-línea y KPIs, no aguanta verticales sensibles |
| Construir propio | 4-6 meses, 30-50 k€ inversión, mantenimiento eterno |
| Reseller básico | Comisión de miseria, sin diferenciación |

**Resultado:** la agencia queda en tierra de nadie. O paga premium externo o construye y se desangra.

---

## Slide 4 — La propuesta

**Stack-en-Caja: el motor productivo, en tu VPS, bajo tu marca.**

- Docker-Compose chárter completo (Postgres + Redis + WAHA + FastAPI + dashboard + widget)
- Mismo motor que mueve Maxxag (caso real, 3+ líneas WA, 5k msgs/día)
- 6 análisis IA paralelos por conversación (mood, conversión, red flags, coaching, tiempos, trato)
- Multi-tenant: 1 instalación = N clientes finales de la agencia
- White-label desde Starter, total en Agency

**Tú vendes. Tú facturas. Tú controlas.**

---

## Slide 5 — Cómo funciona (1 diagrama)

```
NOSOTROS (vendor)         AGENCIA (partner)            CLIENTE FINAL (PYME)
─────────────────         ──────────────────           ────────────────────
Mantenemos motor    ──►   Despliega en su VPS    ──►   Restaurante / clínica
Soporte 2º nivel          Branding propio              Paga a la agencia
Roadmap                   Soporte 1er nivel            Ve marca agencia
                          Factura                      
```

3 capas. Cada una con su rol claro. Sin solapamientos.

---

## Slide 6 — El stack en detalle

| Componente | Rol |
|------------|-----|
| Caddy 2 | HTTPS auto, multi-subdominio por cliente |
| Postgres 16 | Datos multi-tenant aislados |
| Redis 7 | Cola IA + cache |
| WAHA Plus (NOWEB engine) | Bridge WhatsApp ilimitadas sesiones |
| FastAPI + asyncpg | API + dashboard HTMX |
| arq worker | Pipeline 6 skills Claude Haiku 4.5 |
| Widget JS | Chat IA en la web del cliente final |

→ Todo Docker. Despliegue 20-30 min con instalador.

*Notas:* Si el founder es técnico, abrir aquí el `docker-compose.yml` real y enseñarlo. 30 segundos. No más.

---

## Slide 7 — Demo de los 6 skills IA

[Captura dashboard wa-ops con 1 conversación analizada]

- **mood**: indeciso (0.82)
- **response_time**: p50=47s, p90=412s, max=2840s
- **treatment**: cariñoso=0.71, profesional=0.65, seco=0.15
- **conversion**: 0.78 — "Pidió ubicación, confirma tarifa"
- **red_flags**: ninguno crítico
- **coaching**: "Próxima vez ofrece extras antes del precio total"

**~2-3 s de latencia total** (fan-out paralelo, no suma).
**~3-5 €/mes** coste Claude por tenant activo (incluido en €/mes/cliente).

---

## Slide 8 — Diferencial vs HighLevel / Manychat

| | HighLevel | Manychat | **Stack-en-Caja** |
|---|---|---|---|
| Branding profundo | 497 USD/mes | Limitado | **Incluido** |
| Datos en VPS agencia | No | No | **Sí** |
| Multi-línea WA | Limitado | No | **Ilimitado** |
| IA structured outputs | Add-on caro | Add-on caro | **Incluido** |
| Soporte castellano | EN | EN | **Sí, hora europea** |
| Adult / MCC sensible | Banean | Banean | **Segmento validado** |
| €/mes/cliente | 97-297 USD | 25-65 USD + add-ons | **39 €** (29 € en Agency) |

---

## Slide 9 — Pricing (3 planes)

| Plan | Licencia/año | Clientes finales | €/mes/cliente | Branding |
|------|--------------|------------------|---------------|----------|
| **Starter** | 3.000 € | 10 | 39 € | Logo + nombre |
| **Growth** | 5.000 € | 50 | 35 € | Colores + subdominio |
| **Agency** | 9.000 € | ∞ | 29 € | White-label total |

**Add-ons:**
- Soporte 24/7: 800 €/mes
- Despliegue gestionado: 150 €/mes/cliente

**Piloto:** 500 € · 60 días · 1 cliente prueba. Si sigues, descontamos del Starter.

---

## Slide 10 — Cálculo ROI agencia

**Caso Growth (más común):**

| Concepto | Importe |
|----------|---------|
| Inversión licencia anual | -5.000 € |
| Coste mensual nuestro (8 clientes × 35 €) | -280 €/mes = -3.360 €/año |
| **Coste total año 1** | **-8.360 €** |
| Ingreso agencia (8 clientes × 89 €/mes) | +712 €/mes = +8.544 €/año |
| **Margen año 1** | **+184 €** (break-even) |
| **Margen año 2 (sin amortización setup)** | **+5.184 €** |

→ Break-even mes 12. Margen real cuando llega a 12-15 clientes (~30k€ MRR neto agencia).

---

## Slide 11 — Por qué empezar ahora

**Programa piloto Q1:**
- 50 % off licencia primer año
- Onboarding técnico gratis (4h)
- Co-marketing: caso de éxito conjunto publicado
- Cláusula no-competencia recíproca (no vendemos en tu vertical/región 12 meses)
- Acceso roadmap input

**Cupo limitado:** 5 agencias piloto este trimestre. Después solo precio listado.

*Notas:* Esto es scarcity real, no fake — ancho de banda soporte limitado en arranque.

---

## Slide 12 — Próximo paso

**Si encaja:**
1. Mando hoy mismo factura proforma piloto 500 €
2. Lunes próximo arrancamos despliegue (4h sesión técnica conjunta)
3. Semana 2: 1 cliente real PYME tuyo en producción
4. Día 60: decisión licencia anual o salida limpia

**Si no encaja:**
- Te dejo el 1-pager y la comparativa de precios
- Estoy en [WhatsApp directo] cuando quieras retomar
- No hago follow-up agresivo. Esto se vende solo cuando duele.

**[Tu nombre] · [WhatsApp / Email] · [Calendly]**

*Notas finales:* No cierres tú la slide. Espera 5-10 segundos en silencio. Que hable la agencia. Si dice "déjame pensarlo", responde: "Perfecto, ¿qué dato concreto te falta para decidir?"
