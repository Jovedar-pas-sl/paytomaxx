# DECISIONES — Coaching IA Standalone

Registro de decisiones de producto, legales y de modelo. Cada decisión va con contexto + alternativas consideradas + criterio.

---

## D1. Legal: ¿Cómo justificamos monitorización RGPD?

**Decisión:** Doble base legal:
1. **Interés legítimo del empleador** (RGPD art. 6.1.f) para evaluar calidad del servicio.
2. **Cumplimiento de obligación contractual** del empleado (formación profesional, art. 6.1.b).

**Requisitos obligatorios para clientes:**

- **Cláusula contractual escrita** comunicada al empleado ANTES de empezar la monitorización. Plantilla incluida en onboarding.
- **Anuncio explícito en manual interno** o tablón de la empresa.
- **Información en señalética del puesto** ("este canal de WhatsApp se monitoriza para fines de formación").

**Fundamento jurisprudencial:**
- TEDH López Ribalda II (2019) — la vigilancia laboral requiere transparencia previa.
- Estatuto Trabajadores art. 20.3 — empresario puede adoptar medidas de vigilancia.
- AEPD Guía sobre uso de dispositivos digitales (2023).

**Alternativas descartadas:**
- ❌ Consentimiento expreso del empleado: no es base válida en relación laboral (desequilibrio de poder).
- ❌ "Just hacerlo y ver qué pasa": riesgo de sanción AEPD (multas 40k-300k €).

**Auditoría planificada:** revisar cláusula con abogado laboralista antes del primer cliente pagador (S-5).

---

## D2. Datos del cliente final (no del agente): rol como encargado

**Decisión:** Somos **encargado del tratamiento** (art. 28 RGPD). El cliente final (empresa de WhatsApp) es **responsable**.

**Implicaciones operativas:**
- Firmamos DPA (Data Processing Agreement) con cada cliente. Plantilla en `legal/dpa-template.md` (a redactar).
- Servidor en EU obligatorio. Decidido: **Hetzner Helsinki** (FI) o **Scaleway Paris** (FR).
- Sub-encargados: Anthropic (proceso IA). Listado público en DPA.
- Borrado: 90 días por defecto, configurable hasta 30 días mínimo, 3 años máximo.
- Sin transferencias internacionales sin SCC (Anthropic API tiene EU residency disponible — verificar).

---

## D3. Qué métricas SÍ reportamos vs. qué NO

### ✅ SÍ reportamos al manager:
- Velocidad media/mediana de respuesta del agente.
- Calidez del tono (escala 0-100).
- Uso de buenas prácticas (nombres, despedidas, plantillas).
- Conversión (mensaje → cita / venta confirmada).
- Banderas rojas (insultos, descuentos no autorizados, lenguaje agresivo).
- **Citas textuales cortas** (≤40 caracteres) de momentos clave.

### ❌ NO reportamos al manager:
- Contenido íntimo del cliente final (datos médicos, sexualidad, problemas familiares).
- Conversaciones privadas que el agente tiene con el cliente fuera del horario laboral (si se detectan).
- "Análisis emocional del empleado" — solo se analiza calidad de respuesta, no estado mental.
- Frases completas largas (>40 caracteres) del cliente — sólo el agente tiene contexto narrativo completo en el dashboard, no el manager.
- **Cualquier dato sensible categoría especial** (RGPD art. 9: salud, religión, orientación, sindical, biométrico).

### Filtro automático
Implementamos pre-filtro en el scorecard que ofusca/elimina menciones a:
- DNI / documentos identificativos
- Direcciones físicas
- Datos médicos específicos (diagnósticos)
- Datos bancarios
- Información sobre menores
- Detalles íntimos del cliente final

**Implementación técnica:** post-procesado del JSON de salida del skill `coaching` antes de mostrarlo al manager. Filtro de regex + LLM-guard.

---

## D4. Benchmark sectorial: cómo se calcula sin violar privacidad

**Decisión:** Benchmark **anonimizado, agregado, con mínimo n=5 tenants** por sector.

**Cómo:**
- Tenant elige sector en onboarding (taxonomía cerrada: `estetica`, `dental`, `academia`, `inmobiliaria`, `adult-services`, `soporte-tecnico`, `legal`, `otros`).
- Cron diario calcula percentiles (p25/p50/p75/p90) por dimensión por sector.
- Si un sector tiene <5 tenants, NO se muestra benchmark (mensaje: "necesitamos al menos 5 clínicas para benchmark").
- **Nunca** mostramos datos individuales de otros tenants.
- **Nunca** se infiere qué tenant es cuál (incluso si el sector tiene solo 5, el percentil del propio tenant no permite reidentificación).

**Diferenciación competitiva:**
- Es el USP frente a "solo es IA contra mi equipo": permite comparar contra mercado.
- Solo en plan **Manager (49 €/agente)**.

**Riesgo:** un competidor podría firmar como tenant para ver benchmark de sus rivales. **Mitigación:** términos de servicio prohíben uso para inteligencia competitiva. En la práctica difícil de probar, pero suficiente como deterrente.

---

## D5. Pricing por agente activo vs. por conversación vs. flat

**Opciones consideradas:**
1. **Por agente activo (elegida).** 29/39/49 €.
2. Por conversación analizada (ej. 0.10 €/conv).
3. Flat por tenant (ej. 199 €/mes).

**Por qué "por agente":**
- Lenguaje del manager: piensa en "agentes" no en "conversaciones".
- Predecible para el cliente: presupuesto estable.
- Refleja valor: más agentes = más cosas que coachear.
- Defendible vs. competencia: Calabrio también factura por seat.

**Lo que dejamos para v2:**
- **Tier por uso real** (modo "elastic"): si tu equipo tiene mes flojo, paga menos. Demasiado complejo para v1.

---

## D6. ¿Modelo de IA? Claude Haiku vs. Sonnet vs. GPT-4

**Decisión:** **Claude Haiku 4.5** para análisis individual (skill coaching), **Sonnet 4.6** para meta-análisis semanal.

**Razones:**
- Haiku: rapidez + coste. 6 skills en paralelo cuestan ~$0.002/conv. A 200 conv/agente/mes = $0.4/agente/mes. Margen sano sobre 39 €.
- Sonnet: el ranking y el meta-análisis semanal necesita razonamiento mejor. 1 llamada/agente/semana = coste despreciable.
- GPT-4 considerado pero descartado:
  - Mejor en algunos benchmarks pero coste mayor.
  - Anthropic mejor compromiso con safety + EU residency.
  - El skill `coaching` ya está optimizado en Claude (existe en wa-ops monolito).

**Alternativa de futuro:** modelo local (Llama 3.3 70B + finetune) para clientes Enterprise on-premise. v3.

---

## D7. Frecuencia: semanal vs. diaria vs. mensual

**Decisión:** **Semanal** por defecto. Alertas tiempo real en Manager plan.

**Por qué semanal:**
- Manager no puede revisar informe diario (overload).
- Una semana da patrón estadístico (≥5 días laborales).
- Coste IA controlable: 4-5 batches/mes vs. 30 batches.
- Match con cadencia de RRHH típica (revisión 1:1 semanal o quincenal).

**Por qué NO diario:**
- Cuando los datos son ruido, el manager se desentiende.
- Coste IA × 7 → revienta margen.

**Excepción — alertas tiempo real:** insulto, descuento no autorizado, conversación >2h sin respuesta. Notificación push/email inmediato en plan Manager. Implementación: webhook → análisis síncrono → si flag crítico → notificar.

---

## D8. ¿Mostramos los scorecards a los agentes?

**Decisión:** **Configurable por tenant** con default = NO en mes 1, SÍ a partir mes 2.

**Lógica:**
- **Mes 1:** solo manager ve. Razón: corregir bugs del sistema, ajustar prompts, evitar conflicto laboral si IA falla.
- **Mes 2+:** cada agente ve SU propio scorecard (no los del resto). Razón:
  - Aprendizaje individual real.
  - Los buenos agentes lo valoran como objetividad ("por fin se ve que trabajo bien").
  - Reduce sensación de "vigilancia opaca".
- **Ranking equipo:** NUNCA visible para agentes (solo manager). Evita comparaciones tóxicas.

**Override:** manager puede activar/desactivar visibilidad por agente.

---

## D9. Multi-tenant: aislamiento de datos

**Decisión:** **Aislamiento lógico a nivel DB con `tenant_id` en todas las tablas** + Row Level Security (RLS) en Postgres.

**Por qué no aislamiento físico (BD por tenant):**
- Coste operativo alto (N bases de datos a mantener, migrar, backupear).
- Complejidad para escalar a +100 tenants.

**Por qué RLS:**
- Postgres + Drizzle/SQLAlchemy soporta RLS.
- Tests automáticos verifican que tenant A no puede ver datos de tenant B.
- Auditoría fácil: cada query lleva `WHERE tenant_id = current_setting('app.tenant_id')`.

**Si un cliente Enterprise pide BD dedicada:** opcional con upcharge significativo (>5k€/año setup + premium).

---

## D10. Sectores que ATENDEMOS y que NO

### ✅ Aceptamos:
- Estética, dental, fisio, peluquería.
- Academias, idiomas, formación profesional.
- Inmobiliarias boutique.
- Adult services legales (consentido, mayoría de edad, contexto del proyecto Maxxag).
- Soporte técnico B2B.
- Despachos legales (con NDA reforzado).

### ❌ NO aceptamos:
- Sectores ilegales (drogas, armas, prostitución forzada/trata).
- Sectores donde la conversación incluya menores.
- Sectores médicos críticos (psiquiatría, oncología) — riesgo demasiado alto si IA se equivoca.
- Sectores que requieren certificación HIPAA/PCI-DSS específica (v2 con compliance certificado).

**Política de aceptación:** revisión manual del primer cliente de cada sector nuevo. Reservamos derecho a no aceptar tenant.

---

## D11. Roadmap de cosas que NO hacemos (YAGNI)

Para evitar scope creep, decisiones explícitas de NO en v1:

- ❌ Apps móviles (web responsive es suficiente).
- ❌ Multi-idioma (solo ES Castellano).
- ❌ Coaching tiempo real (sugerencias en línea para el agente mientras escribe) — atractivo pero complejo, v2.
- ❌ Multi-canal (Instagram DM, Telegram, FB Messenger) — solo WhatsApp.
- ❌ Integración con CRMs estándar (add-on de pago a partir de 10 clientes).
- ❌ White-label (revender como producto propio) — no a corto plazo.
- ❌ On-premise/self-hosted — solo SaaS.
- ❌ Modelos locales / sin Anthropic — v3.

---

## D12. Métricas de salud del negocio

**KPIs internos a vigilar semanalmente:**

| KPI | Objetivo | Alarma |
|---|---|---|
| MRR | crece >10% mensual | crece <3% → revisar pricing |
| Churn | <8% mensual | >12% → emergencia |
| NPS | >40 | <20 → producto no encaja |
| Margen bruto | >75% | <60% → coste IA demasiado alto |
| Coste IA / agente / mes | <8 € | >15 € → optimizar prompts |
| CAC | <90 € | >250 € → canal no funciona |
| LTV | >540 € (14 meses) | <300 € → retención floja |

**Si NPS <20 en mes 3:** parar adquisición, hacer 20 entrevistas, pivotar o cerrar.
