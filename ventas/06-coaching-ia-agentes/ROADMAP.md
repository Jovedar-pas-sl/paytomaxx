# ROADMAP — Coaching IA Standalone

**Objetivo:** sacar el skill `coaching` (hoy embebido en wa-ops monolito) como producto vendible directo a managers no-técnicos en **5 semanas**, con 3 clientes pagadores beta al final del trimestre.

---

## Semana 1 (S-1) — Extracción técnica

**Objetivo:** un servicio standalone que tome conversaciones y devuelva scorecards.

- [ ] Crear repo nuevo `coaching-ia` (no contaminar wa-ops).
- [ ] Copiar y desacoplar:
  - [ ] `prompts.COACHING_PROMPT` → `coaching_ia/prompts/coaching.py`
  - [ ] `analyzer.skills.analyze_coaching()` → `coaching_ia/analyzer.py`
  - [ ] Schemas Pydantic relevantes (sin tocar conversation_skills DB)
- [ ] Definir contrato de entrada agnóstico (no dependiente de Evolution):
  ```python
  @dataclass(frozen=True)
  class ConversationInput:
      conv_id: str
      agent_id: str
      messages: list[Message]  # {from, to, ts, text, direction}
  ```
- [ ] FastAPI mínimo:
  - [ ] `POST /v1/analyze/coaching` — síncrono, devuelve CoachingResult.
  - [ ] `POST /v1/batch/coaching` — async, devuelve job_id.
  - [ ] `GET /v1/scorecard/agent/{agent_id}?week=YYYY-Www` — agregado semanal.
- [ ] Tests:
  - [ ] Unit del analyzer con 5 conversaciones fixture (academia, clínica, inmobiliaria, adult, soporte).
  - [ ] Integration con Anthropic mock.
  - [ ] Coverage ≥80%.

**Riesgo:** acoplamiento oculto con `Message` model de wa-ops. **Mitigación:** definir DTO propio desde día 1.

---

## Semana 2 (S-2) — Login + Billing + Modelo de datos

**Objetivo:** una empresa puede registrarse, añadir agentes, pagar por agente activo.

- [ ] Auth:
  - [ ] Clerk (skill `clerk-auth`) o Supabase Auth — magic link + Google.
  - [ ] Roles: `owner`, `manager`, `viewer`.
- [ ] Modelo de datos (Postgres + Drizzle o SQLAlchemy):
  - [ ] `tenants` (empresas)
  - [ ] `agents` (por tenant — nombre, JID/identificador WA, activo)
  - [ ] `conversations` (referencia, no contenido — solo metadatos)
  - [ ] `analyses` (resultado del skill coaching por conv)
  - [ ] `scorecards_weekly` (agregado por agente × semana)
  - [ ] `subscriptions` (plan, agentes contratados, status Stripe)
- [ ] Billing — Stripe:
  - [ ] Producto "Coaching IA" con 3 precios: Solo 29 €, Team 39 €, Manager 49 €.
  - [ ] Cobro por agente activo (cantidad variable mensual).
  - [ ] Trial 30 días.
  - [ ] Webhook → desactiva tenant si paga falla en 7 días.
- [ ] Onboarding flow:
  - [ ] 1. Crea cuenta.
  - [ ] 2. Conecta Evolution (URL + API key) o WAHA.
  - [ ] 3. Selecciona qué números/grupos analizar.
  - [ ] 4. Mapea JID → nombre del agente real.
  - [ ] 5. Genera primer scorecard de prueba (últimas 100 conv).
  - [ ] 6. Confirma plan + tarjeta.

**Riesgo:** Stripe usage-based billing es complejo. **Mitigación:** facturación post-pago mensual con quantity ajustada por cron al día 1 de mes.

---

## Semana 3 (S-3) — Scorecards email semanal automático

**Objetivo:** todos los lunes a las 9:00, cada manager recibe el informe en su inbox.

- [ ] Worker batch semanal (APScheduler + cron):
  - [ ] Domingo 22:00 → pull de todas las conv de la semana de cada tenant.
  - [ ] Análisis paralelo (asyncio.gather con cap de concurrencia por tenant).
  - [ ] Generación de scorecards individuales + ranking equipo.
  - [ ] Envío email lunes 9:00 hora local del tenant.
- [ ] Plantilla email (Resend o Postmark):
  - [ ] HTML responsive con scorecard inline.
  - [ ] Botón "Ver dashboard" → link a web app.
  - [ ] PDF adjunto del informe completo para imprimir.
- [ ] Sistema de alertas premium (Manager plan):
  - [ ] Detección banderas rojas críticas en streaming → push/email inmediato.
- [ ] Tests:
  - [ ] E2E: crear tenant fake, simular 50 conv, ejecutar batch semanal, verificar email enviado.
  - [ ] Carga: 100 tenants × 30 agentes × 200 conv/semana.

**Riesgo:** coste de tokens IA explota a escala. **Mitigación:** cache de análisis por hash(conv_id, last_msg_ts) + tier pricing repercute coste real.

---

## Semana 4 (S-4) — Dashboard web + comparativas internas

**Objetivo:** manager puede entrar al dashboard, ver evolución temporal y comparar agentes.

- [ ] Frontend (Next.js + Tailwind + shadcn):
  - [ ] Login + onboarding visual.
  - [ ] Dashboard equipo: ranking semanal, gráfico evolución.
  - [ ] Página agente: scorecard semanal + histórico + ejemplos textuales.
  - [ ] Comparativa: 2 agentes lado a lado.
  - [ ] Configuración: agentes, plan, facturación.
- [ ] Diseño visual:
  - [ ] **No template-looking.** Editorial style (rule design-quality).
  - [ ] Paleta semántica (verde = mejora, rojo = atención, gris = neutro).
  - [ ] Dark/light intencionales (no auto).
- [ ] Exportar:
  - [ ] PDF del scorecard semanal por agente.
  - [ ] CSV del histórico para Excel.
- [ ] Accesibilidad: keyboard nav + axe-core sin errores críticos.

**Riesgo:** scope creep en frontend. **Mitigación:** v1 solo lectura, sin editar análisis. Edición v2.

---

## Semana 5 (S-5) — Benchmark sectorial + lanzamiento beta

**Objetivo:** los primeros 10 beta-testers están activos. Benchmark sectorial v1 funciona.

- [ ] Benchmark sectorial:
  - [ ] Definir taxonomía de sectores: `estetica`, `dental`, `academia`, `inmobiliaria`, `adult-services`, `soporte-tecnico`, `legal`, `otros`.
  - [ ] Tenant elige sector en onboarding.
  - [ ] Cron diario: calcula percentiles agregados por sector (anónimo, min n=5 tenants).
  - [ ] Mostrar en scorecard del Manager plan: "Estás en percentil 38 vs. 24 clínicas estéticas".
  - [ ] Detalle ético: anonimización agregada, NUNCA mostrar tenants individuales.
- [ ] Landing pública (`landing/index.html` ya en repo):
  - [ ] Deploy en Vercel/Cloudflare Pages.
  - [ ] Conectada a Stripe Checkout.
  - [ ] Form "Solicita demo" → CRM (Pipedrive o HubSpot free).
- [ ] Reclutar 10 beta-testers:
  - [ ] Ejecutar plan de [`PRIMER_CLIENTE.md`](PRIMER_CLIENTE.md).
  - [ ] 5 emails fríos/día durante semana 5.
  - [ ] 3 demos agendadas mínimo.
- [ ] Documentación pública:
  - [ ] Pública (README, FAQ, precios, RGPD).
  - [ ] Privada (manual técnico, runbook).

**Riesgo:** ningún beta-tester convierte a pagador. **Mitigación:** entrevistas de 30 min con cada beta al día 25, ajustar producto, no insistir si producto no encaja.

---

## Post-lanzamiento (semanas 6+) — Iteración

### Cosas que NO hacemos en v1 (YAGNI):
- ❌ Móvil nativa
- ❌ Integración con CRMs (add-on de pago a partir de 10 clientes)
- ❌ Multi-idioma (solo ES Castellano en v1)
- ❌ Coaching en tiempo real (chat-side suggestions) — v2 después de validar
- ❌ Multi-canal (Instagram DM, Telegram) — v2

### Decisiones de producto pendientes
- ¿Cuánto historial conservamos? Plan Solo 90 días, Team 1 año, Manager 3 años.
- ¿Re-análisis bajo demanda? Manager plan sí.
- ¿API pública? Manager plan, 10k requests/mes.

---

## Definition of done por entregable

Un entregable se da por hecho cuando:

- [x] Funciona en staging contra Evolution real (no mock).
- [x] Tiene tests con cobertura ≥80%.
- [x] Está documentado (un párrafo en wiki interno).
- [x] Pasa security-reviewer agent sin CRITICAL.
- [x] Lo ha probado al menos un humano externo al equipo.

---

## Hito de éxito S-5

✅ **5 beta-testers activos** recibiendo email lunes 9:00.
✅ **1 cliente pagador** confirmado para mes 2.
✅ **NPS >40** entre beta-testers.
✅ **Coste IA <30%** del precio por agente (margen sano).

Si no se cumplen 3 de 4 → **pausar y pivotar.** No insistir con producto que no encaja.
