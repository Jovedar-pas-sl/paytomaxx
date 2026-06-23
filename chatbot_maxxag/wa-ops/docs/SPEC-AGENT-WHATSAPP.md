# SPEC — Agente de WhatsApp para las casas (auto-respuesta humana)

> Estado: **borrador para revisión**. Programa nuevo construido **dentro de wa-ops**.
> Autor: sesión Claude Code 2026-06-15. Lee primero [CLAUDE.md](../CLAUDE.md).

## 1. Objetivo

Un agente que **atiende las líneas de WhatsApp de cada casa** (Maxxage Madrid, Maxxage
Valencia, Mansión Babylon Marbella, Ibiza, …; 8+ números por casa) respondiendo con el
**mismo cerebro y tono del widget web** (`wordpress-plugin/maxxag-chat`): recepcionista
joven, cálida, con chispa, **sonando 100% humano** — el cliente no nota que es un bot.

El agente **cierra** (precio, dirección, reserva) y para las **salidas (outcall)** calcula
el coste de desplazamiento. Cede a una persona **solo por seguridad** (señal de riesgo),
no para el cierre comercial.

## 2. Decisiones tomadas (con el cliente)

| # | Decisión | Elección |
|---|----------|----------|
| 1 | Modo de operación | **Híbrido**: autónomo y cierra; handoff a humano **solo por seguridad** (menor, fraude, queja, acoso, fuera de guion) |
| 2 | Dónde se construye | **Dentro de wa-ops** — reutiliza WAHA, webhook, envío, Claude y datos por casa |
| 3 | Cobertura de números | **Toggle por número, `off` por defecto.** Arranque por líneas de recepción |
| 4 | Alcance | **Cierra todo** (precio + reserva). Para salida: calcula `servicio + taxi×1.20` |
| 5 | Routing salida | **Valhalla** (self-host, open source, costing dinámico). OSRM como alternativa |

## 3. Reglas heredadas que NO se rompen (de CLAUDE.md)

- **El webhook nunca muta ni actúa.** La auto-respuesta se genera en un **job de arq**
  (igual que el análisis), nunca síncrona en `routes/webhooks.py`.
- Modelo Claude = **`claude-haiku-4-5`** (string exacto, sin sufijo `-20251001`).
- SQL siempre parametrizado en `queries.py` (no f-strings).
- Migración nueva por cada cambio; no editar una ya aplicada en prod.
- Skills de Claude pasan por `_fix_schema` + `_call_json`.

## 4. Arquitectura

```
WhatsApp ─→ WAHA ─[webhook]→ /webhook/waha  (solo upsert msg, como hoy)
                                   │
                                   ├─ arq.enqueue(analyze_conversation_job)   [ya existe]
                                   └─ arq.enqueue(auto_reply_job)             [NUEVO, si procede]

kpi-worker (arq):
  auto_reply_job(conversation_id):
    1. Gate: ¿número con agente activo? ¿conv en estado 'active'? ¿no es fromMe?
    2. Guardarraíles previos: reusa evaluate_escalation / detect_red_flags
         → si riesgo: marca conv 'paused_risk' + alert, NO responde
    3. reply_engine.generate(conv, casa_profile, girls)  → borrador
    4. Si intención de salida + dirección → outcall.quote(...) inyecta precio
    5. Modo:
         - auto     → WahaClient.send_text con delay humano + "escribiendo…"
         - copilot  → guarda borrador como sugerencia (no envía)
    6. Registra turno en historial del agente
```

El **gate de pausa por humano**: si la recepcionista escribe en el chat (mensaje `out`
no generado por el agente), la conversación pasa a `paused_human` y el bot calla hasta
que se reactive manualmente.

## 5. Modelo de datos

### F0 — Cerebro unificado (migración `0013`) ← **este entregable**

Hoy el conocimiento (chicas, tarifas, horario, dirección, persona) vive en los JSON del
plugin WordPress por ciudad. Lo traemos a wa-ops como **fuente única** para web y WhatsApp.

**`casa_profile`** (1:1 con `casa`):
- `casa_id` PK/FK→casa, `bot_name`, `default_lang`
- `whatsapp_recepcion`, `telegram_recepcion`
- `greetings` JSONB `{es,en,fr,it}`
- `rates` JSONB (items + title/note, espejo de `config.json.rates`)
- `schedule` JSONB (`hours_*`, `how_*` por idioma)
- `address`, `address_lat`, `address_lng`, `maps_url`  ← origen para routing de salida
- `faqs` JSONB
- `outcall` JSONB → `{ base_price_eur, taxi_surcharge_pct(=20), tariff:{base_fare,per_km,per_min,min_fare,night_mult} }`
- `created_at`, `updated_at`

**`girl`** (N por casa):
- `id` PK, `casa_id` FK→casa CASCADE, `ext_id` (id del plugin, para sync/dedup)
- `name`, `age`, `nationality`, `description`, `photo_url`, `whatsapp`
- `available_today`, `outcall`, `escort_pareja` (bool)
- `services` JSONB[], `languages` JSONB[]
- `active`, `sort_order`, `created_at`, `updated_at`
- índices: `uq (casa_id, ext_id)`, `ix (casa_id, available_today)`

### F2 — Estado del agente (migración futura `0014`)
- **`wa_number_agent`** (1:1 `wa_number`): `mode` (`off`|`copilot`|`auto`, default `off`), `quiet_hours` opc.
- `conversation`: + `agent_status` (`active`|`paused_human`|`paused_risk`|`off`), `agent_paused_at`

## 6. El cerebro (port de `claude.php` → `app/agent/reply_engine.py`)

Portamos 1:1, ajustado a Python/Anthropic SDK:
- Persona por idioma (ES/EN/FR/IT) — mismos prompts, mismas reglas y ejemplos.
- Contexto de chicas disponibles (solo `available_today`) + resumen de tarifas.
- Defensa anti prompt-injection (sanitizado de entrada + validación de salida).
- Historial: últimos 8 turnos. `max_tokens=220`, `temperature=0.85`, modelo `claude-haiku-4-5`.
- **Diferencia clave web→WhatsApp:** la web "tantea y deriva a WhatsApp"; aquí el agente
  YA está en WhatsApp, así que **sí da precio y cierra** (regla de prompt ajustada).

## 7. Guardarraíles, handoff y anti-baneo

- **Handoff por seguridad** (reusa skills existentes): `detect_red_flags` (menor/fraude/
  acoso) y `evaluate_escalation` (severidad ≥ media) → `paused_risk` + `alert`, sin responder.
- **Pausa por humano**: recepcionista escribe → `paused_human`.
- **Anti-baneo WAHA (números no oficiales):** delay humano (lectura + "escribiendo…"
  proporcional a la longitud), límite de ritmo por número, arranque gradual (1 número
  piloto → ampliar), horario; el `copilot` queda disponible para las líneas más sensibles.

## 8. Calculadora de salida (F3)

Servicios nuevos en `docker-compose.yml`: **Valhalla** (tiles OSM de España).

```
origen   = casa_profile.address_lat/lng        (geocodificado una vez al configurar la casa)
destino  = ubicación que envía el cliente:
             (a) PIN de ubicación de WhatsApp  → coords exactas  [vía preferida, 0 infra geocoding]
             (b) dirección en texto            → geocoding (Nominatim/Photon)  [fase posterior]
ruta     = Valhalla /route (costing auto)      → distance_km, duration_min
tarifa   = max(min_fare, base_fare + per_km·km + per_min·min) · (night_mult si nocturno)
precio   = outcall.base_price_eur + tarifa · (1 + taxi_surcharge_pct/100)   # = servicio + taxi×1.20
```

Tarifas de taxi en España son **reguladas y públicas por municipio** → tabla por casa en
`casa_profile.outcall.tariff`. Vía preferida: pedir al cliente el **PIN de ubicación**
(coords exactas, sin necesidad de geocoder en el camino caliente).

## 9. Fases

- **F0 — Cerebro unificado** *(este PR)*: migración `0013` (`casa_profile` + `girl`) + seed desde los JSON del plugin + editor en el panel.
- **F1 — Motor de respuesta**: `agent/reply_engine.py` (port). Modo **copiloto interno** (genera, no envía) para QA contra conversaciones reales.
- **F2 — Auto-send + guardarraíles**: migración `0014`, `auto_reply_job`, toggle por número, pausas, delays humanos. Piloto en 1 número.
- **F3 — Calculadora de salida**: Valhalla en compose + `agent/outcall.py` + captura de PIN.
- **F4 — Cierre completo**: reserva/booking, aviso a recepción, métricas bot vs humano en el KPI.

## 10. Riesgos

| Riesgo | Mitigación |
|--------|------------|
| Baneo de WhatsApp (números no oficiales, automatización) | delays humanos, ritmo limitado, arranque gradual, copilot en líneas sensibles |
| El bot da precio/dirección a un caso de riesgo | handoff por seguridad **antes** de responder (skills existentes) |
| Desync conocimiento web ↔ WhatsApp | fuente única en wa-ops; el plugin web migra a leer de aquí (futuro) |
| Valhalla/tiles España consumen recursos | tiles solo de España; PIN de ubicación evita geocoder en caliente |
