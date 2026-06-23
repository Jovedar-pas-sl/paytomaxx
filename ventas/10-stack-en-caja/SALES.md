# SALES — Stack-en-Caja

## 1-pager (lo que mandas en frío a un dueño de agencia)

> **Vende WhatsApp IA bajo tu marca. Sin construir backend.**
>
> Stack-en-Caja es el motor que mueve Maxxag (caso real adult-services con 3 líneas WA, 5k msgs/día, dedupe @lid resuelto, 6 skills IA paralelos en Claude Haiku 4.5). Lo empaquetamos como Docker-Compose chárter para que **tu agencia revenda "WhatsApp IA + dashboard de operaciones" a tus PYMEs bajo tu marca**.
>
> No es HighLevel: tú controlas datos, branding, márgenes y soporte de 1er nivel. Nosotros mantenemos el motor (WAHA, prompts, parches) y damos soporte de 2º nivel.
>
> **Desde 3.000 €/año** + 39 €/mes/cliente final desplegado. ROI <8 clientes desplegados.
>
> Primer cliente piloto este trimestre: -50 % licencia primer año + co-marketing.

---

## Pricing — 3 planes Partner

### Starter — 3.000 €/año

Para agencias que empiezan a vender WhatsApp IA y aún no tienen una cartera definida.

**Incluye:**
- Hasta **10 clientes finales** desplegados simultáneamente
- Stack Docker-Compose completo + 2 actualizaciones mayores/año
- Manual técnico + scripts deploy
- Soporte por email (SLA 48h hábiles)
- Branding básico (logo + nombre del producto en el dashboard)
- 39 €/mes por cliente final desplegado (sub-billing nuestro)

**Para quién:** agencias 1-3 personas, primer paso, validación.

---

### Growth — 5.000 €/año

Para agencias que ya tienen cartera PYME y quieren un canal recurrente.

**Incluye todo lo de Starter más:**
- Hasta **50 clientes finales** desplegados
- Branding profundo (colores, dominio personalizado por cliente)
- Soporte por Slack/email (SLA 24h hábiles)
- Llamada onboarding técnico (2h) + 1 sesión trimestral de revisión
- Plantillas comerciales: emails, 1-pagers, ofertas por vertical (hostelería, clínicas, ocio)
- 35 €/mes por cliente final desplegado

**Para quién:** agencias 4-10 personas con vendedor comercial dedicado.

---

### Agency — 9.000 €/año

Para agencias que quieren ser la "plataforma de WhatsApp IA" de su mercado.

**Incluye todo lo de Growth más:**
- **Clientes finales ilimitados**
- White-label total (sin mención nuestra en UI, docs ni dominios)
- Revenue share opcional: 20 % comisión sobre clientes finales que nos refieras
- Acceso al canal partner Slack privado + roadmap input mensual
- 2 sesiones onboarding (técnico 4h + comercial 2h)
- Soporte prioritario (SLA 8h hábiles) + número WA directo
- Beta features 60 días antes
- 29 €/mes por cliente final desplegado

**Para quién:** agencias 10+ personas con cartera 30+ PYMEs activas.

---

### Add-ons

| Add-on | Precio | Descripción |
|--------|--------|-------------|
| Soporte premium 24/7 | 800 €/mes | Respuesta <2h cualquier día, incluye fines de semana |
| Despliegue gestionado | 150 €/mes/cliente | Te montamos y mantenemos los VPS de tus clientes |
| Migración datos | 500-2.000 € | Desde Chatwoot, Wati, HighLevel u otro sistema |
| Knowledge base custom | 1.500 € | Ingesta + indexación documentación específica del cliente final |
| Branding total (UI custom) | 3.000 € one-time | Rediseño completo del dashboard con tu CI |

---

## Quién decide en la agencia

- **Decisor económico:** founder / CEO (firma licencia anual)
- **Decisor técnico:** CTO o tech lead (valida el stack)
- **Influenciador:** account manager senior (sabe qué piden los clientes finales)

→ Email frío al **founder** primero, después demo técnica con CTO.

---

## 10 objeciones — guion de respuesta

### 1. "¿Por qué no usamos HighLevel directamente?"

HighLevel SaaS Mode son 497 USD/mes solo por el white-label, y aun así tus clientes ven la infraestructura en cloud de HighLevel — si caen, caes tú. Aquí tu stack corre en TU VPS, controlas backups, controlas datos. Y nuestro precio entrada es 250 €/mes equivalente (3.000 €/año).

### 2. "Manychat es mucho más barato."

Manychat funciona si solo necesitas un bot lineal. En cuanto el cliente pide "quiero ver KPIs de mis recepcionistas" o "necesito dedupe de contactos @lid" o "quiero IA que escriba como mi marca", Manychat se queda corto. Stack-en-Caja viene calibrado para casos avanzados — no es bot, es infraestructura.

### 3. "¿Quién hace el soporte cuando se rompe a las 3 AM?"

Tú haces el 1er nivel (reinicios, dudas usuario final, configuración). Nosotros hacemos el 2º (bugs del motor, upgrades WAHA, problemas Claude API). Para emergencias 24/7 está el add-on Soporte Premium 800 €/mes. La mayoría de agencias Starter empieza sin él y lo añade cuando llega al 5º cliente.

### 4. "¿Y el RGPD? ¿Quién es responsable?"

Tu agencia es la responsable del tratamiento frente al cliente final, porque los datos viven en TU VPS. Nosotros somos solo proveedor de software, no de hosting — no tocamos datos personales. Te damos modelo DPA firmable con tus clientes y el listado de subprocessors (Anthropic Claude, WAHA Plus). Sí, eso es venta — pero también es la verdad: nada de "tus datos en nuestra nube".

### 5. "¿Y si Meta banea WhatsApp Business API?"

WAHA Plus usa el motor NOWEB (no la API oficial de Meta) — exactamente para evitar el cierre de cuentas en MCCs sensibles. Si Meta cambia algo, WAHA actualiza y nosotros publicamos el upgrade. Llevamos 18 meses en producción sin un solo ban en cuentas Maxxag.

### 6. "Mi cliente final quiere su propio login, no entrar por mi panel."

Plan Growth y Agency incluyen sub-dominios por cliente (`cliente.tu-agencia.com`) con login propio. El cliente final entra en SU dashboard, no en el tuyo — solo tú ves el super-admin con todos los clientes.

### 7. "¿Y si dejo de pagar la licencia? ¿Me quedo sin nada?"

El código está en TU servidor. Si dejas de pagar, dejas de recibir actualizaciones y soporte, pero el stack sigue corriendo con la versión actual. No hay kill-switch. Es Docker en tu VPS, no SaaS.

### 8. "¿Cuánto tarda en estar operativo un cliente nuevo?"

Con scripts de deploy: 2-3h primera vez (instalación inicial agencia), 30 min por cliente adicional (provisioning multi-tenant). Con add-on despliegue gestionado: nos lo pasas y queda listo en 24h sin que toques nada.

### 9. "¿Vosotros sois competencia mía? ¿Podéis vender directo a mis clientes?"

No. Estamos B2B-only con agencias. No tenemos equipo comercial PYME y no es nuestro foco. De hecho, el plan Agency incluye cláusula de no-competencia recíproca: no vendemos directo en tu vertical/región durante la vigencia del contrato.

### 10. "Quiero probar antes de comprometer 3.000 €."

Plan piloto: 500 € por 60 días, con 1 cliente final de prueba. Si decides seguir, el piloto cuenta como adelanto del Starter (te restamos 500 € de los 3.000 €). Si no, te ayudamos a migrar los datos del cliente piloto a otro sistema.

---

## Comparativa rápida para mandar en email

| Plan | Licencia anual | Clientes max | €/mes/cliente | Soporte | Branding |
|------|----------------|--------------|---------------|---------|----------|
| Starter | 3.000 € | 10 | 39 € | Email 48h | Logo |
| Growth | 5.000 € | 50 | 35 € | Slack 24h | Colores + subdominio |
| Agency | 9.000 € | ∞ | 29 € | 8h + WA | White-label total |

---

## CTA por canal

- **Email frío:** "¿15 min esta semana para enseñarte la demo? Mando link Calendly."
- **LinkedIn DM:** "Vi que tu agencia hace webs hostelería. Tenemos motor WhatsApp IA listo para revender. ¿Te mando 1-pager?"
- **Llamada calificación:** "¿Cuántos clientes PYME tenéis activos hoy y cuántos preguntan por WhatsApp/automatización?"
- **Demo:** 25 min, screen-share, casos Maxxag anonimizados.
- **Cierre:** "Hago factura proforma hoy mismo, despliegue arrancando lunes."
