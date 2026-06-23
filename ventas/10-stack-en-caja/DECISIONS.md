# DECISIONS — Stack-en-Caja

Registro de decisiones comerciales y técnicas con rationale. Formato: decisión + alternativas consideradas + por qué.

---

## D1 — Licencia anual recurrente vs perpetua + mantenimiento

**Decisión:** Licencia **anual recurrente** (no perpetua + mantenimiento).

**Alternativas:**
- A. Perpetua 5.000-15.000 € + mantenimiento opcional 20 %/año
- B. Anual recurrente 3.000-9.000 €/año (escogida)
- C. Solo €/mes/cliente final sin licencia

**Por qué B:**
- Predictibilidad MRR (clave para sostener soporte)
- Alinea incentivos: agencias que no usan el producto NO renuevan (señal clara)
- Modelo HighLevel/ActiveCampaign ya validado en mercado
- Perpetua atrae agencias que compran y desaparecen, sin upgrades
- Solo €/cliente sin licencia → agencias pequeñas no se comprometen y rotan rápido

**Revisión:** si una agencia "Agency" pide perpetua + mantenimiento, **considerar oferta custom** desde 40 k€ one-time + 8 k€/año mantenimiento. No publicado.

---

## D2 — Profundidad de branding por tier

**Decisión:**
- Starter: solo logo + nombre producto
- Growth: + colores + subdominio
- Agency: white-label total (sin nuestra marca en absoluto)

**Alternativas:**
- A. Branding total en todos los tiers
- B. Sin branding en Starter, profundo en Growth+, total en Agency (escogida)
- C. Solo white-label total como add-on +3.000 € one-time

**Por qué B:**
- Mantiene visibilidad "Stack-en-Caja" en Starter → marketing orgánico vía agencias pequeñas
- Premium real en Agency justifica salto de precio
- Si todos tienen branding total perdemos canal de descubrimiento
- Si nadie tiene branding total perdemos venta a las agencias serias que LO EXIGEN

**Excepción:** un Starter puede pagar add-on "Branding total" +2.000 €/año si lo necesita. No se publicita activamente.

---

## D3 — Soporte: 1er nivel agencia vs 2º nivel nuestro

**Decisión:** **Modelo 2 niveles estricto** — agencia 1er, nosotros 2º. Add-on opcional 24/7.

**Alternativas:**
- A. Soporte directo a cliente final (lo que pide HighLevel)
- B. Modelo 2 niveles estricto (escogida)
- C. Sin soporte, solo docs

**Por qué B:**
- Escalar soporte directo PYMEs = contratar 3 personas a 30 k€/año → mata la economics
- Agencia conoce mejor a su cliente, da soporte más rápido
- Diferenciador comercial: "controlas la relación con TU cliente"
- 24/7 opcional cubre las urgencias reales (~10 % de agencias)

**Riesgo:** agencias se quejan de hacer "trabajo gratis" de soporte → mitigación: plantillas + KB + entrenamiento incluidos en onboarding.

---

## D4 — Revenue share con agencias

**Decisión:** Revenue share **20 % solo en plan Agency** sobre clientes referidos a OTROS verticales/regiones.

**Alternativas:**
- A. Revenue share universal 30 % en todos los tiers
- B. 20 % solo Agency en referidos cross-vertical (escogida)
- C. Sin revenue share, todo licencia + €/cliente

**Por qué B:**
- Universal 30 % canibaliza pricing y atrae partners que solo refieren 1 cliente y desaparecen
- 20 % cross-vertical incentiva a agencias top a abrir mercado nuevo para nosotros
- Mantiene foco en su vertical primario (no se desvían vendiendo todo)
- Cláusula no-competencia recíproca refuerza confianza

**Cálculo:** sobre LTV neto del cliente referido (no GMV bruto), pagado anualmente.

---

## D5 — Multi-region hosting (ES vs LATAM)

**Decisión:** **Self-host agencia** en su VPS preferido. Recomendamos Hetzner FSN1 (UE) o AWS São Paulo (LATAM). No tenemos región default.

**Alternativas:**
- A. Solo Hetzner EU (default forzado)
- B. Self-host total con guías por región (escogida)
- C. Nosotros operamos infra gestionada por defecto

**Por qué B:**
- Self-host es nuestro diferenciador clave vs HighLevel/Manychat → no romperlo
- Agencias LATAM exigen datos en LATAM (residencia legal Brasil, México)
- Operar infra gestionada = SaaS = otro modelo de negocio (futuro?)
- Add-on "Despliegue gestionado" 150 €/mes/cliente cubre las que sí lo quieren

**Excepción add-on Despliegue Gestionado:** usamos Hetzner FSN1 para UE, Hetzner ASH para Norteamérica/LATAM costa este (latencia ok). São Paulo solo si lo pide cliente Brasil específico.

---

## D6 — Pricing en € vs USD vs local

**Decisión:** Precios listados **en €** + paridad orientativa USD. Facturación en moneda local del país de la agencia.

**Alternativas:**
- A. Solo €, todos factura en €
- B. € listado + factura moneda local agencia (escogida)
- C. Pricing dinámico por paridad poder adquisitivo (Argentina 30 %, México 60 %...)

**Por qué B:**
- Simplicidad pricing público
- Mantiene margen frente a fluctuaciones FX
- Agencias LATAM agradecen factura en pesos / soles
- PPP variable es operativamente costoso y abre arbitraje (agencia argentina vende a cliente español)

**Stripe Tax + Stripe Billing manejan IVA por país automáticamente.**

---

## D7 — Modelo IA: Claude propio vs cliente trae su key

**Decisión:** **Claude key nuestra incluida** en €/mes/cliente. Cliente NO trae su key.

**Alternativas:**
- A. Cliente trae su Anthropic API key (BYOK)
- B. Nuestra key con coste pass-through transparente (escogida)
- C. Cliente elige: OpenAI, Anthropic, Mistral, local

**Por qué B:**
- BYOK añade fricción onboarding masiva (config, billing dual, rate limits)
- Pass-through nos da control de modelo (Haiku 4.5 calibrado, no permitimos GPT-3.5)
- Margen incorporado en €/mes/cliente cubre coste real + 30 % spread
- Cliente no quiere otra factura más

**Cálculo coste medio:** ~3-5 €/mes por tenant activo en uso típico (200 conversaciones analizadas/día con 6 skills). Incluido en €/mes/cliente sin línea separada.

---

## D8 — WAHA Plus vs WAHA Core (gratis)

**Decisión:** WAHA **Plus** obligatorio. Coste asumido por agencia (subscripción Patreon).

**Alternativas:**
- A. WAHA Core gratis (1 sesión por instancia)
- B. WAHA Plus subscripción agencia (escogida)
- C. Nosotros pagamos WAHA y prorrateamos

**Por qué B:**
- Core no soporta multi-sesión → 1 cliente = 1 VPS = imposible economically
- Plus son ~9 €/mes para agencia → trivial frente a su ingreso
- Pagar nosotros = relación cliente con WAHA pasa por nosotros (riesgo si caen)
- Documentamos login Patreon explícitamente en `INSTALL.md`

---

## D9 — Nombre comercial

**Decisión:** **Stack-en-Caja** como nombre interno + nombre comercial castellano. Naming alternativo open para LATAM ("Stack-en-Caja" funciona).

**Alternativas:**
- A. Nombre inglés (StackBox / BoxStack / WhatsKit)
- B. Stack-en-Caja (escogida)
- C. Nombre completamente fantasía (Aurora, Tropos)

**Por qué B:**
- Marca el carácter "producto entregable, no SaaS" — explícitamente "stack en caja"
- Castellano refuerza positioning ES/LATAM
- Memorable, descriptivo, no requiere explicación
- Dominio `.es` disponible (verificar `.com` y `.lat`)

**Verificar:** registro marca clase 9 (software) + 42 (servicios IT) en EUIPO antes lanzamiento público.

---

## D10 — Open-source parcial vs todo cerrado

**Decisión:** **Todo cerrado** en v1. Considerar open-source el widget JS standalone en v2.

**Alternativas:**
- A. Core open-source + pro features cerradas (modelo Mautic)
- B. Todo cerrado (escogida)
- C. Open-source total + servicios pago (modelo Plausible)

**Por qué B:**
- Open-source en este nicho atrae forks que canibalizan venta
- Modelo cerrado + Docker entregable = mejor de ambos mundos (control + portabilidad cliente)
- v2: widget JS standalone open-source puede ser canal marketing (GitHub stars)

**Re-evaluar en 18 meses** con datos reales tracción.
