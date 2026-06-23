# Pitch deck — WA-Ops Inbox + IA (12 slides)

> Versión texto. Cuando se monte en Keynote/Slides: fondo oscuro, tipografía Geist, screenshots reales del dashboard Maxxag anonimizados.

---

## Slide 1 — Portada

**WA-Ops**
*Saca tu inbox de WhatsApp del móvil. Mide. Coachea.*

Dashboard multi-línea con 6 análisis IA en paralelo para casas con 3+ números WhatsApp.

`[Logo] · waops.es · sales@nouesmalt.com`

---

## Slide 2 — El problema

**Hoy, una casa con 4 líneas WhatsApp opera así:**

- 4 móviles personales repartidos entre recepcionistas
- 0 visibilidad para el dueño
- 0 métricas de tiempo de respuesta
- 0 forma de detectar timewasters o leads calientes
- 0 alertas si entra un menor
- 0 coaching estructurado a recepcionistas

**Resultado:** entre el 15 y el 30 % de leads se enfrían por respuesta tarde. Nadie lo sabe.

---

## Slide 3 — El cambio que proponemos

**De móvil a dashboard.**

- Todas las líneas en una pantalla (tipo WhatsApp Web)
- Análisis IA automático conversación por conversación
- Alertas en tiempo real
- Coaching accionable semanal al dueño

> *"Sé exactamente qué pasa en mis 4 líneas, sin tocar un móvil."*
> — Mehdi, dueño Maxxag (Madrid, Marbella, Valencia, Ibiza)

---

## Slide 4 — Los 6 skills (USP)

Cada conversación se analiza por **6 IAs en paralelo** en 2-3 segundos:

1. **MOOD** — ¿curioso, decidido, calentón, timewaster?
2. **RESPONSE TIME** — p50/p90 de primera respuesta
3. **TREATMENT** — trato de la chica (cariñoso / profesional / vendedor / seco)
4. **CONVERSION** — % probabilidad de cierre + blockers
5. **RED FLAGS** — menores, fraude, acoso, ilegales
6. **COACHING** — qué fue bien, oportunidad perdida, ejemplo de respuesta

**Nadie más en el mercado tiene esto entrenado para tu sector.**

---

## Slide 5 — Demo screenshot

`[Screenshot: panel principal con inbox a la izquierda, conversación abierta en centro, panel de los 6 skills a la derecha con confidence scores y citas textuales]`

`[Screenshot: panel alertas — "Posible menor detectado en chat #1284 hace 3 min"]`

---

## Slide 6 — Diferencial vs alternativas

| | WhatsApp Business App | Chatwoot/Wati | **WA-Ops** |
|---|---|---|---|
| Multi-línea | ❌ | ✅ caro | ✅ |
| Análisis IA por conv | ❌ | ❌ | ✅ **6 skills** |
| Coaching con citas | ❌ | ❌ | ✅ |
| Red flags automáticas | ❌ | ❌ | ✅ |
| Auto-fusión @lid | ❌ | ❌ | ✅ |
| Adult-services friendly | ❌ banea | ❌ banea | ✅ |
| Auto-hospedado | ❌ | parcial | ✅ |

---

## Slide 7 — Cómo funciona (arquitectura)

```
Tus números WhatsApp ──[QR pair]──► WAHA Plus
                                       │
                                       ▼
                                  FastAPI + asyncpg
                                       │
                       ┌───────────────┼───────────────┐
                       ▼               ▼               ▼
                  Postgres 16    Claude Haiku 4.5     Redis
                  (tus datos)   (6 skills paralelos)  (queue)
                       │               │
                       └───────► Dashboard HTMX
                                       │
                                       ▼
                                  Tu navegador
                                  (móvil o desktop)
```

**Todo en tu VPS dedicado.** Sin compartir infra con nadie.

---

## Slide 8 — Riesgos y mitigaciones (honestidad)

| Riesgo | Mitigación |
|--------|-----------|
| Meta banea un número | Warmup + Tier Scale con reserva caliente + rotación documentada |
| WAHA Plus es no oficial | Imagen tagged estable; backup plan: forkear si maintainer desaparece |
| Anthropic se cae | `asyncio.gather(return_exceptions=True)` — inbox sigue funcionando |
| RGPD adult-services | VPS dedicado tuyo, retención configurable, derecho al olvido <5s, DPA Anthropic firmado |

**No vendemos magia. Vendemos un sistema gestionado y honesto sobre sus límites.**

---

## Slide 9 — Pricing

### 3 tiers, modelo SaaS por línea

| Tier | Setup | Mensual/línea | Líneas |
|------|-------|---------------|--------|
| **Starter** | 500 € | **149 €** | 3-5 |
| **Pro** | 900 € | **119 €** | 6-10 |
| **Scale** | 1.500 € | **89 €** | 11+ |

**Ejemplo Maxxag (4 líneas):** Starter = 500 € + 596 €/mes.

ROI: si 1 servicio extra/noche cierra mejor por coaching → recuperas el mes en **4 noches**.

---

## Slide 10 — Programa beta (los 3 primeros)

- **50 % descuento durante 30 días**
- Sin tarjeta hasta el día 1
- Sin permanencia
- Setup en 48 h
- Sesión de coaching con dueño día 7
- Informe de pre-cierre día 25

**A cambio:** referencia llamable + testimonio escrito.

**Solo 3 plazas por trimestre.** No es escasez fingida — el soporte directo no escala más.

---

## Slide 11 — Quiénes somos / tracción

- Proyecto operativo desde **2026-Q1** en casa Maxxag (4 líneas, Madrid + Marbella + Valencia + Ibiza)
- Pipeline 6 skills calibrado contra **>5.000 conversaciones reales**
- Auto-fusión @lid resuelta (problema que toda casa tiene y nadie resuelve)
- Stack productivo: Docker Compose, Postgres 16, Caddy 2 auto-HTTPS, hardening fail2ban
- Detrás: equipo que ya construyó el ecosistema WordPress chatbot Maxxag (4 ciudades) — no somos primer rodeo

---

## Slide 12 — Llamada a la acción

**Hablemos 15 minutos.**

Si gestionas 3 o más números WhatsApp y nunca has medido nada, esta llamada vale la pena aunque no compres.

`demo@nouesmalt.com`
`+34 [número WhatsApp directo]`
`waops.es/demo` ← reservar slot

> *No vendemos software. Vendemos visibilidad y coaching.*
