# DECISIONS — registro de decisiones técnicas y comerciales

> Formato ADR ligero. Cada decisión: contexto, opciones evaluadas, decisión, consecuencias.

---

## ADR-001 — Bridge WhatsApp: WAHA Plus vs Cloud API vs Twilio

**Fecha:** 2026-04
**Estado:** Aceptada

### Contexto

Necesitamos una forma de leer y enviar mensajes WhatsApp programáticamente a 3+ líneas por casa, en sector adult-services en España.

### Opciones evaluadas

| Opción | Pros | Contras |
|--------|------|---------|
| **WhatsApp Cloud API (Meta oficial)** | Estable, sin riesgo de ban arbitrario, multi-empleado nativo, audio/vídeo OK | **Suspende cuentas adult-services** sistemáticamente; revisión de plantillas Meta; coste por conversación; verificación de empresa requerida |
| **Twilio (sobre Cloud API)** | UX setup mejor, soporte | Mismo problema raíz (sector prohibido); markup sobre Cloud API; abstracción que limita features (no media inline avanzada) |
| **WAHA Plus (no oficial, Patreon)** | Multi-sesión sin límite; auto-hospedado; agnóstico al sector; coste fijo ~9 €/mes; community activa | No oficial → Meta puede banear el número (no la cuenta WAHA); requiere Patreon login; sin SLA de WAHA |
| **whatsapp-web.js / Baileys directos** | Open source, sin coste licencia | Mantenimiento sobre nosotros, no Patreon; rotura cada update WhatsApp Web; menos features (media, presence) |

### Decisión

**WAHA Plus.** Es la única opción donde el sector cliente no es bloqueado de raíz. El riesgo de ban del número se gestiona con warmup y rotación (ver ADR-002).

### Consecuencias

- Honestidad obligatoria con el cliente sobre riesgo Meta (ver objeción #2 en SALES.md)
- Necesitamos plan de rotación de números (ADR-002)
- Dependencia de un único maintainer (devlikeapro) — mitigación: tenemos imagen pulled + tag estable, no `:latest` en prod
- Sin SLA — cubrimos nosotros desde nuestro lado

---

## ADR-002 — Política de rotación de números

**Fecha:** 2026-04
**Estado:** Aceptada (implementación parcial; doc completa en sprint semana 3)

### Contexto

Aceptado que Meta puede banear números. Necesitamos plan de continuidad.

### Decisión

1. **Warmup obligatorio** las primeras 2 semanas de cada número nuevo: máx 50 mensajes salientes/día, 0 broadcasts, identidad estable (foto, descripción).
2. **Tier Scale incluye 1 número de reserva** mantenido caliente (uso real bajo, no spam).
3. **Heurística pre-ban en dashboard**: ratio respuestas/envíos, frecuencia de mensajes sin respuesta consecutivos, último mensaje recibido > N horas → alerta.
4. **Procedimiento de rotación documentado** (RUNBOOK_ROTATION.md, sprint semana 3): conectar nuevo número en paralelo, migrar conversaciones activas con un click, comunicación al cliente.
5. **No usar WA-Ops para broadcast masivo nunca**. Es lo que más banea. El producto es inbox, no marketing saliente.

### Consecuencias

- Cliente Scale paga por una línea adicional inactiva (justificación de tier).
- UX de "mover conversación a otro WA" debe ser robusta (ya existe parcial).

---

## ADR-003 — Política de moderación y red flags

**Fecha:** 2026-04
**Estado:** Aceptada

### Contexto

Sector adult-services tiene riesgo específico de:
1. Menores intentando contactar
2. Fraude (no-shows, métodos de pago falsos)
3. Acoso explícito a recepcionistas/chicas
4. Solicitudes ilegales

### Decisión

1. **Skill `red_flags` con umbrales calibrados** detecta esos 4 + timewasters.
2. **Severity `critical`** (menor sospechoso, solicitud ilegal explícita) **dispara**:
   - Alert en dashboard
   - Email inmediato al owner
   - Marca de conversación que requiere intervención manual antes de continuar
3. **No bloqueamos automáticamente** — la decisión es siempre del owner. Pero **logueamos la inacción** para trazabilidad legal.
4. **Retención mínima 90 días** de conversaciones marcadas critical, incluso si el cliente normal borraría a 30 días, por si requerimiento de autoridad.
5. **Endpoint de exportación legal** (`/admin/export/legal?conv_id=...`) genera PDF firmado con hash que el cliente pueda entregar a autoridades.

### Consecuencias

- Coste Claude algo mayor (skill red_flags corre siempre, no skipeable).
- Cliente queda más cubierto legalmente; vendible como feature.

---

## ADR-004 — Retención de mensajes (compliance RGPD)

**Fecha:** 2026-04
**Estado:** Aceptada

### Contexto

RGPD obliga a definir plazo de retención proporcional. WhatsApp conversaciones son datos personales (números, contenido).

### Decisión

- **Default: 18 meses** rolling retention.
- **Configurable por casa: 3 a 36 meses.**
- **Excepción retención 90 días mínimo** para conversaciones con red flag critical (ver ADR-003).
- **Borrado real, no soft delete**, cuando vence retención: `DELETE` físico + `VACUUM FULL` mensual sobre `messages`.
- **Derecho al olvido**: endpoint `/admin/erase?phone=...` borra conversación y mensajes en <5 s, cualquier momento.
- **Backups**: se purgan en el mismo ciclo (mensual) — no podemos restaurar tras petición de borrado.

### Consecuencias

- Tarea cron de purga mensual obligatoria (ya programada en arq).
- Coste storage controlado (Postgres no crece indefinidamente).
- Documentación RGPD reduce fricción comercial con casas cumplidoras.

---

## ADR-005 — Pagos: Stripe vs SEPA vs híbrido

**Fecha:** 2026-04
**Estado:** Aceptada

### Contexto

Sector adult-services tiene historia de procesadores cerrando cuentas. Stripe es estricto. SEPA es transparente para Stripe pero más fricción para el cliente.

### Decisión

1. **Stripe** como método principal para nuevos clientes. Razón social factura: **NouEsMalt SL** (sociedad del operador), no la casa cliente. **NouEsMalt vende un SaaS de software**, no servicios sexuales — categoría Stripe `software_services` (legítima).
2. **SEPA directo (mandato)** disponible para clientes con >6 meses de relación que prefieran no usar tarjeta. Activación manual primer ciclo.
3. **Transferencia bancaria mensual** como fallback para clientes que no quieran ni Stripe ni SEPA — factura emitida, cobro a los 5 días, dunning a los 15.
4. **No procesar pagos del cliente final** (cliente que paga a la casa por servicios) — eso queda fuera de scope, jamás.
5. **Plan B Stripe banea cuenta:** abrir cuenta paralela en **MOLLIE** (Países Bajos, también estricto pero menos rotativo) en standby. Backup en standby también **Adyen** para Scale tier.

### Consecuencias

- Comunicación a Stripe limpia: lo facturado es "software analytics dashboard", no se menciona el sector del cliente final.
- Categoría legal de NouEsMalt SL: empresa de software / SaaS.

---

## ADR-006 — Hosting: VPS por cliente vs multi-tenant en infra propia

**Fecha:** 2026-04
**Estado:** Aceptada

### Contexto

Sector regulado + dato sensible + cliente pequeño = ¿hosting compartido o aislado?

### Decisión

**VPS dedicado por cliente** (Hostinger / Hetzner / OVH España).

### Razones

1. **Aislamiento legal**: cada cliente es responsable RGPD de su VPS. Nosotros somos encargado limitado.
2. **Aislamiento de ban Meta**: si Meta banea, banea **un número en un VPS**, no todo el pool.
3. **Aislamiento de fallo**: nadie tira a nadie con un pico de carga.
4. **Customización**: cada casa puede tener su retención, su pricing, su branding.

### Trade-offs aceptados

- Más coste operativo (1 VPS = ~10 €/mes coste real); ya incorporado en pricing.
- Más fricción de release (actualizaciones N veces); mitigamos con Ansible/script de auto-update (sprint semana 3).

### Plan B (no antes de tener 30+ clientes)

Tier "Lite" futuro con multi-tenant compartido para casas pequeñas (1-2 líneas) a precio bajo. Hoy no.

---

## ADR-007 — Modelo IA: Claude Haiku 4.5 vs alternativas

**Fecha:** 2026-04
**Estado:** Aceptada

### Opciones evaluadas

| Modelo | Coste/Mtok in/out | Latencia | Structured outputs | Sector |
|--------|------------------|----------|--------------------|--------|
| **Claude Haiku 4.5** | $1 / $5 | ~1-2s | Sí, robusto | Sin bloqueo de uso |
| Claude Sonnet 4.6 | $3 / $15 | ~2-3s | Sí | Sin bloqueo |
| GPT-4o mini | $0.15 / $0.6 | ~1s | Sí | Bloqueo posible adult |
| Llama 3.1 70B (Groq) | $0.59 / $0.79 | <1s | Parcial | OK pero structured menos fiable |

### Decisión

**Claude Haiku 4.5** para los 6 skills.

- Latencia aceptable en `gather` paralelo.
- Coste real medido: ~0.02 USD por conversación de 50 mensajes × 6 skills = ~1.2 USD por 100 conversaciones. Con 1000 conv/mes/casa ≈ 12 USD/mes → encaja en margen.
- Structured outputs vía `output_config.format` muy fiable (con `_fix_schema` ya implementado).
- Anthropic firma DPA RGPD.

### Plan B

Mantenemos abstracción `_call_json` aislada en `skills.py`. Si en 6 meses queremos bajar coste, podemos rutear skills "fáciles" (response_time es determinístico ya; mood, treatment) a Groq Llama, dejando solo coaching y red_flags en Claude.

---

## ADR-008 — Auto-fusión @lid ↔ @c.us

**Fecha:** 2026-03
**Estado:** Implementada

### Contexto

WhatsApp introdujo `@lid` (privacy mode) en 2024-2025. El mismo cliente puede aparecer con `@c.us` (teléfono) y con `@lid` (identificador opaco) según cómo nos contactó.

### Decisión

Webhook **nunca fusiona automáticamente** — solo crea `alert` tipo `merge_suggestion`. Fusión real:

1. Vía IA: `/conversation/<id>/auto-merge` con confianza ≥ 0.7 y confirmación del admin.
2. Vía dropdown manual cuando admin lo decide.
3. Vía undo si la fusión fue errónea (tabla `merge_undo` con histórico).

### Consecuencias

- Cero falsos positivos no reversibles.
- Trabajo manual mínimo (la IA acierta ~90 % según observación interna).
- Buena historia comercial: "no perdemos clientes por la rotura @lid de WhatsApp".

---

## Decisiones pendientes (sin ADR todavía)

- Análisis de **audio** (Whisper) — habilitar a partir del Tier Pro o como add-on +30 €/línea/mes
- **Branding white-label** — alcance: solo logo+colores+dominio, no rebrand profundo. Tarifa fija 600 € one-time.
- **App móvil** — Android antes que iOS si se hace; probable PWA antes que nativo.
