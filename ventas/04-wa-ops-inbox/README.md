# WA-Ops Inbox + IA

> **Saca tu inbox del móvil. Mide. Coachea.**
> Dashboard multi-WhatsApp con 6 análisis IA en paralelo para casas con 3+ líneas.

---

## Qué es

WA-Ops es un panel web auto-hospedado que centraliza todas las líneas WhatsApp de una casa (recepción, reservas, VIP, marketing) en un único inbox tipo WhatsApp Web, y aplica **6 skills de IA en paralelo** a cada conversación: humor del cliente, tiempos de respuesta, trato de la mamai, probabilidad de conversión, red flags y coaching accionable.

A diferencia de un CRM genérico o WhatsApp Business App, WA-Ops está construido específicamente para operaciones multi-línea donde el dueño nunca ha tenido métricas reales del trabajo de sus recepcionistas.

**Cliente objetivo:** casas/clubes adult-services en España con 3 o más números WhatsApp activos, gestionados hoy desde móviles personales sin trazabilidad ni KPIs.

---

## Los 6 skills (USP)

Cada conversación nueva o actualizada se reanaliza con un *fan-out* de 6 llamadas paralelas a Claude Haiku 4.5 (`asyncio.gather`). Latencia total ≈ 2-3 s (la del skill más lento), no la suma.

### 1. `mood` — Humor del cliente

Clasifica el estado emocional del cliente: `curioso`, `decidido`, `indeciso`, `enfadado`, `calentón`, `timewaster`.

```json
{
  "mood": "indeciso",
  "confidence": 0.82,
  "evidence": [
    "Pregunta precios pero pivota a otra chica tres veces",
    "Dice 'lo pienso y te digo' después de cada propuesta"
  ]
}
```

### 2. `response_time` — Tiempos de respuesta

Determinístico (sin LLM). Calcula `p50`, `p90`, `max` de la primera respuesta de la casa a cada turno del cliente. Detecta huecos de >30 min.

```json
{
  "first_response_p50_s": 47,
  "first_response_p90_s": 412,
  "first_response_max_s": 2840,
  "gaps_over_30min": 2
}
```

### 3. `treatment` — Trato de la mamai

Mide 4 ejes 0.0–1.0: `cariñoso`, `profesional`, `vendedor`, `seco`. Útil para detectar recepcionistas frías o demasiado agresivas comercialmente.

```json
{
  "cariñoso": 0.71,
  "profesional": 0.65,
  "vendedor": 0.40,
  "seco": 0.15,
  "ejemplo_positivo": "Hola guapo, qué tal estás hoy?",
  "ejemplo_negativo": "Tarifa 150. Disponible."
}
```

### 4. `conversion` — Probabilidad de cierre

0.0–1.0 con justificación. Permite priorizar leads calientes y entrenar al equipo en señales reales.

```json
{
  "conversion_score": 0.78,
  "stage": "negociando_horario",
  "blocker": "ninguno",
  "evidence": ["Pidió ubicación", "Confirmó tarifa", "Pregunta por disponibilidad esta noche"]
}
```

### 5. `red_flags` — Detección de riesgo

Detecta menores, insultos, fraude, acoso, timewasters, intentos de no-pago. Genera **alertas automáticas** que aparecen en el dashboard y opcionalmente disparan email.

```json
{
  "flags": [
    {"type": "menor_sospechoso", "severity": "critical", "evidence": "Dice tener 16 años"},
    {"type": "timewaster", "severity": "low", "evidence": "Pregunta 4 veces lo mismo"}
  ]
}
```

### 6. `coaching` — Recomendaciones accionables

Coaching práctico para la recepcionista con **citas textuales** de la conversación: qué fue bien, qué oportunidad se perdió, ejemplo concreto de respuesta alternativa.

```json
{
  "wins": ["Cerró tarifa rápido sin regatear"],
  "missed": ["Cliente preguntó por extras y no se ofreció upsell"],
  "suggestion": "Cuando pregunten 'qué incluye', responder con 2 extras de mayor margen antes del precio total",
  "example_response": "Incluye media hora más masaje relajante y champán. Queda en 220 € en lugar de 180 €."
}
```

---

## Arquitectura

```
                  ┌──────────────────────────────────────────────────┐
                  │                  VPS (Hostinger)                 │
                  │                                                  │
  Browser ───────►│  Caddy 2  ──►  FastAPI (kpi-app)                 │
  (HTMX/admin)    │  (HTTPS)       │                                 │
                  │                ├──► Postgres 16 (asyncpg pool)   │
                  │                ├──► Redis 7   (arq queue)        │
                  │                ├──► WAHA Plus (httpx client)     │
                  │                └──► Claude Haiku 4.5 (Anthropic) │
                  │                                                  │
  WhatsApp ──────►│  WAHA Plus ──[webhook]──► /webhook/waha          │
  (3+ números)    │                            │                     │
                  │                            ├──► DB upsert msg    │
                  │                            └──► arq.enqueue()    │
                  │                                                  │
                  │  arq worker (kpi-worker):                        │
                  │   ├─ analyze_conversation_job (fan-out 6 skills) │
                  │   ├─ meta_analyze_casa_job (50 convs sample)     │
                  │   └─ waha_health_check (cron, recovery stateful) │
                  └──────────────────────────────────────────────────┘
```

### Modelo de datos (resumen)

| Tabla | Propósito |
|-------|-----------|
| `casas` | Tenant: 1 casa = 1 cliente |
| `whatsapp_accounts` | N líneas WA por casa (oficial / secundario / recepción / VIP) |
| `conversations` | 1 conv = 1 cliente, agrupada por casa+wa |
| `conversation_skills` | JSON de los 6 skills + meta + coste tokens |
| `messages` | Histórico completo, media inline |
| `alerts` | Red flags, desconexiones, sugerencias de fusión @lid↔@c.us |

### Stack confirmado en producción

- **Inbox bridge:** WAHA Plus (`devlikeapro/waha-plus:latest`) — sin límite de sesiones
- **Backend:** FastAPI + asyncpg + arq
- **Frontend:** HTMX + Tailwind CDN + Jinja2 + Geist font
- **IA:** Claude Haiku 4.5 con structured outputs (JSON Schema)
- **Orquestación:** Docker Compose, `restart: unless-stopped`
- **HTTPS:** Caddy 2 + Let's Encrypt auto

---

## Diferencial (por qué no es otro CRM)

| Capacidad | CRMs genéricos (Chatwoot, Wati…) | WhatsApp Business App | **WA-Ops** |
|-----------|----------------------------------|------------------------|------------|
| Multi-línea por tenant | Sí, pero caro y rígido | No (1 número) | **Sí, ilimitado** |
| Análisis IA por conversación | No | No | **6 skills paralelos** |
| Coaching accionable con citas | No | No | **Sí** |
| Red flags automáticas | No | No | **Sí** |
| Auto-fusión @lid ↔ @c.us | No | No | **Sí (resuelto)** |
| Diseñado para adult-services | No (banean) | No (banean) | **Sí** |
| Auto-hospedado | Algunos | No | **Sí (tu VPS)** |

---

## Estado actual

- Prototipo Docker-Compose ready
- Dedupe @lid/@c.us resuelto y en producción interna
- Pipeline 6 skills calibrado contra conversaciones reales
- Pendiente: multi-tenant real, billing, onboarding self-service (ver `ROADMAP.md`)

## Documentos

- **SALES.md** — pricing, pitch 1-pager, objeciones
- **ROADMAP.md** — 4 semanas a venta real
- **PRIMER_CLIENTE.md** — plan para convertir Maxxag y captar 3 casas más
- **DECISIONS.md** — registro de decisiones técnicas y comerciales
- **pitch.md** — deck 12 slides
- **landing/index.html** — landing page
