# Manual de uso — Maxxag Ops

Guía para el operador del día a día. Qué hace el sistema, cómo usarlo, qué problemas pueden aparecer y cómo solucionarlos, y por qué elegimos WAHA en lugar de WhatsApp Business API oficial.

> Para docs técnicas (arquitectura, schema DB, API, deploy) ver [docs/ARCHITECTURE.md](ARCHITECTURE.md), [docs/SCHEMA.md](SCHEMA.md), [docs/API.md](API.md), [docs/DEPLOY.md](DEPLOY.md).

---

## 1 · Qué es Maxxag Ops

Un panel privado auto-hospedado donde gestionas **todos los WhatsApps** de tus casas desde un solo sitio, con **análisis IA** de cada conversación para que veas:

- Qué cliente está caliente y cuál es timewaster
- Cómo está tratando la mamai a los clientes
- Qué hacer ahora mismo en cada chat (texto sugerido listo para copiar)
- Cuándo tienes que escalar a admin
- Oportunidades perdidas y cómo mejorar la próxima vez

### Lo que no es

- No es Chatwoot ni WhatsApp Business — es tu propio inbox
- No está pensado para equipos grandes — 1 admin, varias casas con múltiples números cada una
- No responde solo — tú sigues enviando los mensajes; la IA solo analiza y sugiere

---

## 2 · Pantallas principales

### Dashboard (`/`)

Métricas del día: conversaciones, mensajes, tiempo medio de respuesta, conversión media, estado de WhatsApps. Se actualiza solo cada 30 s.

### Casas (`/casas`)

Lista de casas. Cada card muestra:
- Nombre + avatar
- Indicador verde/ámbar/rojo (cuántos WhatsApps online / totales)
- Conversaciones hoy · total de WhatsApps

Click en una casa → entras a su **workspace**.

### Workspace de una casa (`/casas/<id>`)

4 pestañas:

| Tab | Qué ves |
|-----|---------|
| **Conversaciones** | Lista de chats con filtro por WhatsApp (Oficial / Secundario / Todos). Click → abre el chat |
| **Métricas** | KPIs propios de esa casa |
| **Problemas** | Alertas activas de la casa (WA caídos, red flags, respuesta lenta…) |
| **Análisis IA** | Historial de meta-análisis (patrones sobre las últimas 50 conversaciones) |

Selector de período arriba: `24h / 7d / 30d / 90d / all`.

### Conversación (`/conversation/<id>`)

- **Centro**: chat estilo WhatsApp con burbujas. Media (fotos, vídeos, audios) se ven inline.
- **Panel derecho**: 9 bloques de análisis IA:
  1. Mood del cliente + motivo
  2. Tiempos de respuesta (p50/p90/max)
  3. Trato de la mamai (cariñoso/profesional/vendedor/seco)
  4. Probabilidad de conversión
  5. Red flags (menor / insulto / fraude / acoso / timewaster)
  6. Coaching (qué fue bien, oportunidades perdidas, ejemplo de respuesta)
  7. **Intención** del cliente (booking / cotización / queja / chit-chat / spam…)
  8. **Próxima acción** + mensaje sugerido listo para copiar-pegar
  9. **Escalar a admin** (solo si la IA detecta algo crítico)
- **Input abajo**: escribe y envías desde aquí, va por WAHA al número correcto.
- **Botones**:
  - 🔄 Re-analizar con IA (~$0.003) — vuelve a procesar con las 9 skills
  - 📥 Exportar transcript (TXT)
  - 📄 Informe PDF (abre → Ctrl+P → guardar PDF)
  - 📝 Informe DOCX (descarga editable en Word/Google Docs)
  - Fusionar con cliente (IA) — si detectas duplicados por privacy split

### WhatsApp (`/sessions`)

Cards por casa con los WhatsApps conectados. Por cada WA ves:
- Etiqueta (Oficial, Secundario…)
- Teléfono real (si está online)
- Estado (WORKING, STOPPED, SCAN_QR_CODE, FAILED)
- Acciones: ▶ Iniciar · 🔄 Reiniciar · ■ Parar · ⚙ Renombrar · 🗑 Borrar

Botones globales: **+ Nueva casa** · **+ Añadir WhatsApp** dentro de cada casa.

### Alertas (`/alerts`)

Dos filtros: **Activas** / **Todas**. Cada alerta tiene severidad (info / warning / critical). Click en "Visto" la silencia.

---

## 3 · Flujos típicos del día

### Arrancar una casa nueva

1. `/sessions` → **+ Nueva casa** → pon el nombre (ej: "Maxxag VLC")
2. Dentro de la card de la casa → **+ Añadir WhatsApp**
3. Label = "Oficial". Session name = slug único (ej: `vlc-oficial`)
4. Pulsa ▶ Iniciar → aparece QR → escanéalo desde el teléfono oficial
5. Cuando el estado pase a **WORKING** ya recibes mensajes
6. Repite para añadir Secundario, Marketing, etc.

### Responder un mensaje nuevo

1. `/casas/<id>?tab=chats` → verás la lista con el más reciente arriba
2. Click en el chat → lees el histórico
3. Mira el panel derecho: **Próxima acción** tiene ya el texto sugerido
4. Copia y pega (o edita antes de enviar)
5. Envía desde el input de abajo

### Saber qué conversaciones son más urgentes

En la lista de chats, busca las que tienen:
- **Badge rojo de escalation** — hay algo grave
- **Mood "calentón" / "decidido"** con conv alta — cliente caliente, no dejar esperar
- **Mood "enfadado"** — atender rápido antes de que se vaya

### Detectar un cliente que escribe a 2 números

A veces el mismo cliente escribe al Oficial y al Secundario con JIDs distintos (privacy split de WhatsApp). En el chat:
1. Botón **Fusionar con cliente (IA)** → la IA identifica candidatos y devuelve % de confianza
2. Si confianza ≥ 0.7 fusiona automáticamente; si menor, te muestra opción manual
3. Tras fusión, el histórico se une bajo el mismo contacto

### Hacer un informe mensual de una casa

1. `/casas/<id>?tab=analisis&period=30d`
2. Botón "Generar meta-análisis" → la IA procesa 50 conversaciones y te da patrones, cliente tipo, fortalezas y mejoras
3. Exporta a Markdown si quieres compartirlo

### Exportar un informe de una conversación concreta

En la conversación → botón **📄 Informe PDF** (pestaña nueva → imprimir como PDF) o **📝 DOCX** (descarga). Contiene todos los análisis IA formateados para enviar a un encargado o archivar.

---

## 4 · Problemas comunes y soluciones

### 🔴 "No recibo mensajes de un número"

**Diagnóstico**:
1. Ve a `/sessions` → mira el estado de esa WA.
2. Si está **WORKING**: el problema puede ser del móvil del cliente o que te bloqueó.
3. Si está **STOPPED / FAILED**: la sesión cayó.

**Solución**: pulsa **▶ Iniciar** o **🔄 Reiniciar**. Si sigue fallando tras varios intentos, el cron del sistema intentará recuperar (stop+start → esperar → recrear tras 15 min). Tras re-crear pide re-escaneo de QR.

### 🔴 "Me pide el QR otra vez"

Causa habitual: conflicto con WhatsApp Web en otro dispositivo, o alguien cerró sesión desde el móvil.

**Solución**: escanéalo de nuevo. Si pasa mucho, quita la vinculación en el móvil (Ajustes → Dispositivos vinculados → borrar) y vuelve a escanear.

### 🔴 "Intenté añadir un 2º WhatsApp y me da error 422"

Significa que estás usando **WAHA Free** (1 sesión única). Para multi-número hace falta **WAHA Plus** (~9 €/mes vía Patreon).

Ya deberíamos estar en Plus; si reaparece, avisa al dev — puede ser que el contenedor cargó la imagen vieja (`docker compose up -d --force-recreate waha`).

### 🔴 "No se ven las fotos/vídeos en el chat"

- Si el mensaje es muy antiguo: la media caduca en WAHA (engine NOWEB). Pide al cliente que la re-envíe.
- Si es reciente: verifica que tu sesión esté **WORKING**. Si sí, reporta al dev.

### 🔴 "La IA no analiza mis conversaciones"

**Diagnóstico**:
- Pulsa **🔄 Re-analizar con IA** en la conversación. Si falla con error, mira `/alerts`.
- Si está en cola y no avanza, puede haber:
  - Créditos Anthropic agotados → ve a console.anthropic.com/settings/billing
  - Worker caído → avisa al dev para `docker compose restart kpi-worker`

### 🔴 "El panel dice online pero los mensajes no llegan"

Puede ser el webhook de WAHA que no está llegando al backend. El cron detecta esto y crea alerta `wa_disconnected`. Solución de emergencia: `docker compose restart waha kpi-app`.

### 🟡 "Tiempo de respuesta lento"

El sistema alerta automáticamente cuando p90 > 30 min. Revisa por qué:
- ¿La mamai está offline en esa franja?
- ¿Notificaciones silenciadas en el móvil?
- ¿Cola de mensajes? mira `/casas/<id>?tab=chats` filtrando unread.

### 🟡 "Mensajes duplicados entre Oficial y Secundario"

Es lo normal con la privacy moderna (@lid vs @c.us). Usa el botón **Fusionar con cliente (IA)** en la conversación para unirlos.

### 🟡 "Cliente enfadado / red flag crítico"

Alertas críticas (menor de edad, fraude, acoso) disparan una alerta y **NO se auto-responden desde IA** — siempre requieren admin humano. Revisa en `/alerts?show=active`.

### 🟢 "Quiero cambiar password de admin"

1. Para hashear: `python3 scripts/hash-admin-password.py` (en el servidor o local)
2. Copia el hash a la variable `KPI_ADMIN_PASSWORD_HASH` en `.env`
3. `docker compose up -d kpi-app` para recargar

### 🟢 "He perdido la sesión del browser"

Cookie JWT caducada. Vuelve a `/login` con el email+password de admin.

---

## 5 · Riesgos reales de usar WAHA

**WAHA no es oficial de WhatsApp**. Usa una biblioteca (Baileys / NOWEB engine) que se conecta como si fuera un dispositivo vinculado (igual que WhatsApp Web). Esto implica riesgos reales que debes entender.

### Riesgo 1 · WhatsApp te banea el número

**Probabilidad**: baja con uso normal, alta si abusas.

WhatsApp detecta patrones automáticos (envío masivo, muchos mensajes idénticos, responder a todo en <1 segundo) y **puede banear el número permanentemente**. Al banear el número, pierdes:
- Todo el histórico reciente que tuviera la cuenta
- Ese número como canal con esos clientes
- En casos extremos, otros números si están asociados al mismo device

**Cómo mitigar**:
- No envíes mensajes masivos (broadcast lists masivos → ban instantáneo)
- No copies y pegues el mismo texto a 20 clientes seguidos
- Ritmo humano: 1 mensaje cada pocos segundos, no 10 por segundo
- Deja respuestas ligeramente variadas — la IA de WhatsApp detecta patrones robóticos
- Si tu número es nuevo, ve aumentando volumen gradualmente

### Riesgo 2 · La sesión se cae más fácilmente que en WhatsApp Web oficial

NOWEB simula un dispositivo, pero no es 100 % estable. Puede caer por:
- WhatsApp actualiza su protocolo y WAHA tarda días en actualizar
- Múltiples dispositivos vinculados al mismo número se pelean
- Cliente quita "dispositivos vinculados" desde el móvil

El sistema auto-recupera la mayoría de casos, pero algunas veces toca escaneo manual de QR.

### Riesgo 3 · Dependencia de un solo mantenedor

WAHA es un proyecto casi-unipersonal (Patreon "DevLikeAPro"). Si el autor decide dejarlo, lo volvemos a migrar.

Tenemos experiencia de esto: antes usábamos Evolution API, lo dejaron mantenido → migramos. Volverá a pasar probablemente en 1-2 años.

### Riesgo 4 · Sin soporte oficial en caso de problema

Si tienes un ban, o pierdes mensajes, **no puedes reclamar a WhatsApp**. No hay SLA. Estás por tu cuenta.

### Riesgo 5 · Uso contra los ToS de WhatsApp

Técnicamente, usar WhatsApp automatizado sin la API oficial **viola los Términos de Servicio**. No ha habido casos públicos de WhatsApp demandando a negocios pequeños por esto (su represalia es bantear el número), pero jurídicamente estás en zona gris.

Para un negocio pequeño (como tuyo): el riesgo real es **perder el número**, no denuncia judicial.

---

## 6 · Por qué no usamos WhatsApp Business API oficial (Meta)

Es tentador pensar que la API oficial solucionaría todos los riesgos anteriores. En la práctica **no encaja para tu caso de uso** por varios motivos concretos:

### Motivo 1 · Aprobación de Meta — tu negocio no pasaría

Meta exige verificación de empresa y aprueba el uso de su API según criterios. **Sectores como contenido para adultos / acompañantes / masajes eróticos están explícitamente prohibidos** en su política. Aunque presentaras la documentación, Meta rechazaría la verificación o te cerraría la cuenta tras aprobar.

### Motivo 2 · Coste por conversación

La API oficial no es gratuita. Estructura actual (2026):

| Tipo | Coste por conversación |
|------|------------------------|
| Marketing (iniciada por ti) | ~0.05–0.10 € |
| Servicio (iniciada por cliente) | ~0.02–0.04 € |
| Gratis | Primeras 1000 del mes (cambia) |

Con tu volumen de conversaciones (cientos al día entre casas), serían cientos de euros/mes solo en la API, más el coste del **BSP** (Business Solution Provider — Twilio, 360Dialog, etc.) que cobra su margen encima.

**Con WAHA Plus pagas 9 €/mes fijos, sin topes de conversación.**

### Motivo 3 · Ventana de 24h

La API oficial **solo te deja enviar mensajes libres dentro de las 24 h tras el último mensaje del cliente**. Fuera de ese tiempo, solo puedes enviar "template messages" previamente aprobados por Meta (cada plantilla tarda días en ser revisada y puede ser rechazada).

Esto choca frontalmente con tu flujo: enviar un recordatorio a alguien que te escribió hace 2 días, o un follow-up a las 48h → imposible con API oficial sin templates aprobadas (y las tuyas no pasarían aprobación).

### Motivo 4 · Un solo número por cuenta empresarial

Con la API oficial, cada número de WhatsApp necesita su **cuenta Meta Business** y pasar la verificación. Gestionar múltiples casas, cada una con 2-3 números, se convierte en un infierno administrativo. Con WAHA cada WA es solo una sesión más en el panel.

### Motivo 5 · Tu UX no es compatible

La API oficial empuja a usar:
- **Botones interactivos** (reply buttons, list messages) que no siempre funcionan en todos los teléfonos
- **Mensajes fríos** (templates aprobados) que matan la cercanía del chat humano
- **Reglas estrictas** de qué puedes enviar y cuándo

Tu valor diferencial es que las mamais mantienen una conversación humana, cercana, que fluye. Eso es incompatible con templates aprobados y botones corporativos.

### Motivo 6 · Tu cliente no quiere saber que usas API

La API oficial aparece en WhatsApp del cliente como un "verified business" con etiqueta. Tu cliente asume que está hablando con una persona — no con un negocio verificado por Meta, que activa sospechas y hace la conversación más fría.

### Conclusión

WAHA es **la herramienta correcta** para este caso, asumiendo conscientemente sus riesgos:
- Usa los números con cuidado (sin spam, sin ritmo robotizado)
- Acepta que cada 6-12 meses puede haber una caída de 1-2 días por cambios de WhatsApp
- Tén backup: si un número cae, avisa a los clientes por otro canal
- No pongas todos los huevos en un solo número por casa — ten **Oficial + Secundario** por si acaso

---

## 7 · Checklist de higiene operativa

- [ ] No envías el mismo texto idéntico a >10 clientes seguidos
- [ ] Los WhatsApps tienen 2+ días de "warm-up" antes de volumen alto
- [ ] Revisas `/alerts` al menos 1 vez al día
- [ ] Re-analizas conversaciones clave para obtener coaching
- [ ] Backup diario está configurado (`scripts/backup.sh` por cron)
- [ ] Anthropic API key tiene créditos (revisar mensualmente)
- [ ] Dominio no caduca este año (revisa registro DNS)
- [ ] Password admin está en password manager, no en notas

---

## 8 · Glosario

| Término | Qué significa |
|---------|---------------|
| **Casa** | Una unidad de negocio (local / equipo) con su propio inbox |
| **wa_number** | Un WhatsApp concreto dentro de una casa (Oficial, Secundario…) |
| **WAHA** | El bridge que conecta WhatsApp con tu sistema (no oficial) |
| **Session** | Identificador de un WhatsApp dentro de WAHA (slug único) |
| **WORKING** | Estado de sesión = el WhatsApp está online y funcional |
| **SCAN_QR_CODE** | Estado = hay que escanear QR para vincular |
| **FAILED** | Estado = la sesión rompió, necesita recovery |
| **@c.us** | JID normal de WhatsApp (contiene el teléfono) |
| **@lid** | JID privacy — cliente con privacy moderna, no expone teléfono |
| **Skill** | Un análisis IA concreto (mood, conversión, coaching…) |
| **Meta-análisis** | Análisis sobre 50 conversaciones de una casa (patrones) |
| **Red flag** | Alerta crítica: menor / insulto / fraude / acoso / timewaster |
| **ACK** | Estado de entrega del mensaje (enviado/entregado/leído/escuchado) |
| **Claude Haiku** | Modelo IA rápido y barato que usamos para los skills |

---

## 9 · Contacto

- **Logs en vivo** del VPS: `ssh root@<IP> "docker compose -f /opt/wa-ops/docker-compose.yml logs -f kpi-app"`
- **Panel del VPS**: hpanel.hostinger.com
- **Consola WAHA**: `https://wa.<DOMAIN>` (auth: `WAHA_DASHBOARD_USERNAME/PASSWORD`)
- **Panel Anthropic**: console.anthropic.com

Para cambios de código, sigue el flujo descrito en [DEPLOY.md](DEPLOY.md) o [../CLAUDE.md](../CLAUDE.md) → Convención de despliegue.
