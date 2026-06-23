# SALES — WA-Ops Inbox + IA

## Pricing — 3 tiers

> Modelo: **setup único + cuota mensual por línea WhatsApp activa**.
> Mínimo de entrada: 3 líneas. Una sola línea no cubre el valor del análisis.

| Tier | Para quién | Setup | Mensual | Incluye |
|------|------------|-------|---------|---------|
| **Starter** (3-5 líneas) | Casa única, 1 ciudad | **500 €** (one-time) | **149 €/línea/mes** | 6 skills IA, inbox multi-WA, alertas básicas, 5 GB media, soporte email |
| **Pro** (6-10 líneas) | Casa con varias salas o 2 ciudades | **900 €** (one-time) | **119 €/línea/mes** | Starter + meta-análisis casa, exports CSV, coaching semanal automatizado, 20 GB media, soporte WhatsApp |
| **Scale** (11+ líneas) | Grupo multi-casa o cadena | **1.500 €** (one-time) | **89 €/línea/mes** | Pro + multi-casa, branding propio, rotación gestionada de números, SLA 99.5 %, soporte prioritario |

**Ejemplos reales:**
- Casa Maxxag (4 líneas) → Starter → 500 € + **596 €/mes** = 7.652 €/año
- Grupo con 3 casas, 12 líneas → Scale → 1.500 € + **1.068 €/mes** = 14.316 €/año

**Add-ons:**
- Onboarding asistido + traspaso del histórico WA Web → 300 € por línea adicional
- Branding white-label (logo + dominio propio + colores) → 600 € one-time
- Sesión coaching mensual con dueño (1h, vídeo) → 250 €/mes

**Modelo de pago:**
- Stripe (tarjeta) por defecto
- SEPA débito directo para clientes >6 meses
- Factura emitida desde sociedad española
- Sin permanencia. Cancelación con 30 días.

---

## 1-pager (para enviar por email)

> **Saca tu inbox de WhatsApp del móvil.**
> Dashboard web multi-línea con análisis IA por conversación.
>
> Si gestionas 3 o más números WhatsApp (recepción, reservas, VIP), hoy estás
> ciego: no sabes cuánto tarda tu recepcionista en contestar, qué clientes están
> calientes, ni cuáles son timewasters. WA-Ops cambia eso.
>
> **Lo que recibes:**
> - Inbox web tipo WhatsApp Web con todas tus líneas en una pantalla
> - Cada conversación analizada por 6 IAs en paralelo: humor del cliente,
>   tiempos de respuesta, trato de la chica, % probabilidad de cierre,
>   red flags (menores, fraude, acoso), y coaching accionable
> - Alertas automáticas: cliente esperando >30 min, posible menor, número
>   WhatsApp desconectado
> - Auto-fusión de conversaciones cuando el mismo cliente escribe a dos líneas
>
> **Setup en 48 h.** Te llevamos un VPS, conectamos tus números por QR (sin
> tocar tu móvil), y al día 3 ya tienes coaching real sobre tu equipo.
>
> **Desde 500 € de setup + 149 €/línea/mes.** 3 líneas mínimo.
>
> *Reserva una demo de 20 min: [demo@nouesmalt.com](mailto:demo@nouesmalt.com)*

---

## Las 10 objeciones (con respuesta)

### 1. "¿WAHA es seguro? Es un cliente no oficial."

> Sí, **WAHA Plus es lo que ejecuta TODA la industria** que no quiere o no puede usar la Cloud API oficial. Usamos la versión de pago (~9 €/mes a su creador), instalada en **tu propio VPS**, con tu dominio y tus credenciales. Nadie excepto tú accede al contenedor. El riesgo real no es WAHA: es Meta. Por eso el siguiente punto importa.

### 2. "¿Y si Meta me banea el número?"

> Pasa, y es honesto decirlo. Mitigación que aplicamos:
> 1. **Warmup gradual**: nunca conectamos un número nuevo y empezamos a mandar 500 mensajes. El primer mes va al ritmo de uso normal.
> 2. **Rotación planificada** en Tier Scale: mantenemos 2 números "reserva" calientes; si Meta banea el principal, en 15 min cambiamos cabecera sin perder histórico.
> 3. **Ningún broadcast masivo desde WA-Ops.** El sistema está para gestionar inbox, no spam — es lo que más banea.
> 4. **Identidad coherente**: foto de perfil, descripción y horarios siempre los mismos. Bans suben con perfiles inconsistentes.

### 3. "¿Y RGPD? Estoy guardando conversaciones con datos personales."

> Sí, y por eso lo hacemos en **tu VPS, no en el nuestro**. Eres el responsable del tratamiento; nosotros somos encargado limitado al soporte. Te entregamos:
> - **Registro de actividades de tratamiento** ya redactado para WhatsApp inbox
> - **Política de retención configurable** (default: 18 meses; ajustable 3-36)
> - **Endpoint de borrado por cliente** (`/admin/erase?phone=...`) que cumple el derecho al olvido en <5 s
> - **Cifrado en reposo** (Postgres + LUKS opcional) y en tránsito (TLS Caddy)
> - **Sin transferencias internacionales** salvo Claude (Anthropic UE/US — DPA firmable con Anthropic Inc.)

### 4. "Yo ya tengo Chatwoot / Wati / Trengo, ¿qué me das que ellos no?"

> **Los 6 skills de IA por conversación.** Chatwoot, Wati y Trengo te dan un inbox decente, pero ninguno te dice si el cliente está caliente, si la chica respondió fría, o si hay un menor en el chat. Eso lo construyes tú con sus integraciones a OpenAI, pagando por turno, sin coaching estructurado. Nosotros traemos el análisis ya entrenado para tu sector. Y para sector adult, esos CRMs **te suspenden la cuenta cuando se enteran del contenido** — nosotros estamos hechos para esto.

### 5. "Es caro. WhatsApp Business gratis."

> WhatsApp Business: 1 número, 1 móvil, 0 métricas, 0 coaching, 0 multi-empleado real. Maxxag con 4 líneas pagaría **596 €/mes**. Si una recepcionista mejor entrenada cierra **1 servicio extra por noche** (≈150 €), recuperas el coste en 4 noches. El resto del mes es margen.

### 6. "Mi recepcionista no quiere que la 'graben'."

> Lo entendemos. La conversa **ya queda grabada en WhatsApp**, lo único que añadimos es visibilidad para el dueño y coaching automatizado. Aún así, dos mitigaciones:
> 1. El coaching es **constructivo, no punitivo** (señala oportunidades, no errores nominales)
> 2. Se puede configurar para que **solo el dueño vea el detalle**, y la chica reciba solo recomendaciones genéricas anonimizadas

### 7. "¿Cuánto tarda el setup? No quiero parar."

> 48 horas. No tocamos el móvil de nadie:
> - Día 1: te montamos VPS, dominio, certificados, contenedores
> - Día 2: escaneas QRs de tus 3+ números desde la web (1 min cada uno)
> - Día 3 por la mañana ya tienes inbox funcionando y los primeros análisis
> Los números **siguen funcionando en paralelo en el móvil** si quieres durante una semana de transición.

### 8. "¿Y si Anthropic / Claude se cae?"

> Skills usan `asyncio.gather(return_exceptions=True)`: un skill caído **no tumba los otros 5**. Si Anthropic está caído completamente, el inbox sigue funcionando (envío/recepción WA intactos), solo se pausa el análisis IA y se reencola para procesarse en cuanto vuelva. Histórico de SLA Anthropic: >99.5 % últimos 12 meses.

### 9. "Quiero verlo funcionando con mis números antes de pagar."

> **Programa beta**: 30 días al 50 % (setup 250 € + 75 €/línea/mes Starter). Si al final del mes no ves valor, no continuas. Si continuas, los próximos meses van a precio normal. **Sin tarjeta hasta el día 1.** Solo aceptamos 3 betas por trimestre (no es lock-in, es que el soporte directo no escala más).

### 10. "¿Quién está detrás? ¿Qué pasa si os atropella un autobús?"

> Buen punto. **Código en tu VPS**, base de datos en tu VPS, dominio tuyo. Si mañana desapareciéramos, el sistema sigue funcionando como está. Te entregamos:
> - Acceso root al VPS
> - Repositorio Git completo (entregable en contrato)
> - Documentación de operación (RUNBOOK.md ya redactado)
> - Migration path documentado para auto-mantenimiento o contratar otro proveedor
> No hay vendor lock-in real.

---

## Guion comercial — primera llamada (15 min)

1. **Apertura (1 min):** "Hola, soy [X] de WA-Ops. Sé que gestionas N líneas en [casa]. Cuéntame cómo lo lleváis hoy en el día a día."
2. **Discovery (5 min):** ¿Cuántos números? ¿Quién contesta? ¿Móvil personal? ¿Cómo sabes cuánto tarda en contestar Sandra vs Ana? ¿Has perdido clientes por respuesta tarde?
3. **Demo (5 min):** Pantalla compartida → inbox real anonimizado → los 6 skills → alertas → coaching.
4. **Pricing (2 min):** Tier que encaja. Setup. Mensual. Beta si dudan.
5. **Cierre (2 min):** "¿Te paso propuesta por email y agendamos llamada de cierre en 48 h?"
