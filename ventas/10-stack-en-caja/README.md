# Stack-en-Caja — White-Label para Agencias

> **Vende WhatsApp IA bajo tu marca. Sin construir backend. Sin contratar devs.**
> Paquete Docker-Compose chárter listo para agencias digitales que quieren ofrecer "WhatsApp IA" a sus clientes PYMEs sin tener que construir nada.

---

## Qué es

Un **stack productivo completo** — el mismo que corre Maxxag en producción real — empaquetado como producto white-label revendible por agencias.

La agencia compra una licencia anual, despliega el stack en su propio VPS (o el nuestro gestionado), y revende "WhatsApp IA con IA conversacional + dashboard de operaciones" a sus clientes finales PYMEs (hostelería, ocio, clínicas, inmobiliarias, talleres) bajo su propia marca.

No es un SaaS multi-tenant que el cliente final accede. Es un **producto entregable** que la agencia opera, factura y soporta — con nosotros como proveedor del motor.

---

## Pitch en 30 segundos

> "HighLevel y Manychat te venden un SaaS al que tu cliente accede directamente — tú quedas como mero revendedor sin control sobre datos, marca ni modelo de negocio. Stack-en-Caja te da el motor completo en Docker para que **TÚ seas la plataforma**. Mismo backend que mueve Maxxag (un caso real con 3+ líneas WhatsApp, 6 skills IA paralelos, dedupe @lid/@c.us). Branding tuyo, datos en tu VPS, márgenes tuyos."

---

## Qué incluye el stack (Docker-Compose chárter)

| Componente | Función | Imagen / Tech |
|------------|---------|---------------|
| **Caddy 2** | Reverse proxy + HTTPS automático | `caddy:2-alpine` |
| **Postgres 16** | DB principal (multi-tenant) | `postgres:16-alpine` |
| **Redis 7** | Cola arq + cache WAHA | `redis:7-alpine` |
| **WAHA Plus** | Bridge WhatsApp HTTP API (sesiones ilimitadas) | `devlikeapro/waha-plus:latest` |
| **FastAPI app** | Backend (asyncpg, Jinja2, HTMX) | custom build |
| **arq worker** | Pipeline IA 6-skills paralelos | custom build |
| **Widget JS** | Snippet IA conversacional embebible | wordpress-plugin / standalone JS |
| **wa-ops Dashboard** | Inbox multi-línea + KPIs + alertas | HTMX + Tailwind |

### Extras incluidos en la licencia

- `docker-compose.yml` chárter + `compose.override.yml` por agencia
- Scripts `deploy.sh`, `backup.sh`, `restore.sh` (restic + B2 opcional)
- `Caddyfile` plantilla con dominios variabilizados
- Migraciones Alembic versionadas
- 6 prompts Claude Haiku 4.5 calibrados (mood / response_time / treatment / conversion / red_flags / coaching)
- Manuales operativos para la agencia (`MANUAL.md`, `RUNBOOK.md`, `API.md`)
- Knowledge base inicial reutilizable (vía `manual_browser`)

---

## Modelo white-label en 3 capas

```
  ┌──────────────────────────────────────────────────────────┐
  │ NOSOTROS (vendor)                                        │
  │  Mantenemos: motor IA, WAHA upgrades, parches seguridad  │
  │  Damos: licencia + soporte 2º nivel + roadmap            │
  └──────────────────────────────────────────────────────────┘
                            ▼
  ┌──────────────────────────────────────────────────────────┐
  │ AGENCIA (partner)                                        │
  │  Despliega stack en su VPS · pone su branding            │
  │  Vende a sus PYMEs · factura · da soporte 1er nivel      │
  └──────────────────────────────────────────────────────────┘
                            ▼
  ┌──────────────────────────────────────────────────────────┐
  │ CLIENTE FINAL (PYME)                                     │
  │  Restaurante / clínica / club / inmobiliaria             │
  │  Ve marca de la agencia · paga a la agencia              │
  └──────────────────────────────────────────────────────────┘
```

---

## Ejemplo: cliente final típico de una agencia

**"Restaurante La Mar de Bueno" — agencia La Cosecha Digital (Valencia)**

- 2 líneas WhatsApp: reservas + eventos privados
- 80-120 mensajes/día reparto cliente vs. recepción
- Widget IA en su web responde dudas de carta y horarios → recoge intención de reserva
- WA-ops dashboard: la agencia ve KPIs y le manda al restaurante un PDF mensual con conversión / tiempos respuesta / leads no contestados
- Restaurante paga **89 €/mes** a la agencia
- Agencia paga **39 €/mes** a nosotros (margen ~56 %)
- Coste real del despliegue (VPS Hetzner + WAHA Plus prorrateado): ~12 €/mes

---

## Diferencial vs HighLevel / Manychat

| Capacidad | HighLevel | Manychat | **Stack-en-Caja** |
|-----------|-----------|----------|-------------------|
| Branding profundo (white-label) | $497/mes (SaaS Mode) | Limitado | **Incluido en todos los planes** |
| Datos en VPS propio de la agencia | No | No | **Sí, soberanía total** |
| Multi-línea WhatsApp por cliente | Limitado | 1 número | **Ilimitado por cliente final** |
| IA conversacional con structured outputs | Add-on | Add-on caro | **Claude Haiku 4.5 incluido** |
| Soporte en castellano | EN/limitado | EN/limitado | **Sí, hora europea** |
| Adult-friendly / MCC nicho | Banean | Banean | **Sí, segmento validado** |
| Coste por cliente final | $97-297/mes | $25-65/mes + add-ons | **39 €/mes** |
| Sin "vendor lock-in" | Imposible salir | Imposible salir | **Docker exportable** |

---

## Estado actual

- Stack en producción real con Maxxag (3 líneas WA, ~5k msgs/día)
- Pipeline 6 skills calibrado y estable
- Pendiente para producto white-label: multi-tenant duro, branding configurable, panel agencia, instalador 1-click, programa partner certified (ver `ROADMAP.md`)

---

## Documentos

- **SALES.md** — 3 planes Partner, objeciones, 1-pager
- **PRIMER_CLIENTE.md** — perfil ideal, 15 agencias target, email frío
- **ROADMAP.md** — checklist 10-14 semanas
- **DECISIONS.md** — registro decisiones comerciales/técnicas
- **pitch.md** — deck 12 slides
- **tech-stack.md** — qué se entrega exactamente
- **landing/index.html** — landing B2B agencias
