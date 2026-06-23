# Auditoría WhatsApp + Reporte Comercial — Servicio One-Shot

> **¿Qué es esto?** Un servicio cerrado de auditoría sobre el WhatsApp Business de un cliente. Conectamos durante 30 días, analizamos cada conversación con IA, y devolvemos un reporte ejecutivo con KPIs, fugas de conversión, problemas operativos y coaching por agente. Sin recurrencia obligatoria. Sin instalar nada en su CRM. Sin tocar su número.

---

## Qué entregamos

Un **reporte ejecutivo único** (PDF + HTML interactivo + Markdown editable) sobre los últimos 30 días de actividad WhatsApp del cliente, con:

### 1. KPIs operativos
- Volumen total de conversaciones, mensajes entrantes/salientes
- Tiempo medio de primera respuesta (TMPR)
- Tiempo medio de resolución
- Tasa de conversaciones sin respuesta del agente
- Tasa de cierre (cuántos leads acaban contratando / comprando / cerrando cita)
- Distribución horaria de la demanda (huecos de cobertura)

### 2. Fugas de conversión detectadas
- Lista nominal de leads perdidos por falta de respuesta
- Conversaciones abandonadas a mitad del embudo
- Objeciones no resueltas (precio, tiempos, disponibilidad)
- Clientes que pidieron información dos veces y no recibieron seguimiento
- Importe estimado del lucro cesante (basado en ticket medio declarado por el cliente)

### 3. Incidencias y riesgos
- Problemas técnicos repetidos
- Quejas no atendidas
- Impagos o discrepancias económicas mencionadas
- Alertas de seguridad (datos sensibles compartidos por chat, OTPs, IBANs, etc.)
- Conversaciones que requieren escalado urgente

### 4. Coaching por agente (si hay varios)
- Ranking interno por TMPR, tasa de cierre, tono
- Buenas prácticas detectadas
- Errores típicos por persona
- Mensajes ejemplares para usar como plantilla

### 5. Recomendaciones accionables
- Plantillas de respuesta para los 5 escenarios más frecuentes
- Reglas de derivación que faltan
- Horarios donde conviene reforzar cobertura
- 3 quick-wins que el cliente puede aplicar la semana siguiente

---

## Cómo funciona (proceso interno)

1. **Onboarding (día 1)** — Firma de contrato + DPA. El cliente nos da acceso a su WhatsApp Business mediante uno de tres canales soportados:
   - Evolution API instalada en su servidor o en el nuestro (recomendado)
   - Export oficial de Meta (WhatsApp Business API si ya lo tienen)
   - WAHA self-hosted (alternativa open-source)
2. **Captura (días 2-3)** — Descargamos los últimos 30 días de conversaciones a nuestra infra cifrada.
3. **Análisis (días 4-7)** — Cada conversación pasa por Claude (Anthropic) con un prompt-set propietario que extrae KPIs, intenciones, sentiment, fugas y riesgos.
4. **Síntesis (días 8-9)** — Construimos el reporte ejecutivo y la presentación.
5. **Entrega y llamada (día 10)** — Llamada de 60 min explicando el reporte. El cliente recibe los archivos. Borramos los datos brutos a los 14 días salvo que contrate el dashboard recurrente.

**Plazo total:** 10 días laborables desde la firma.

---

## Formato del entregable

| Archivo | Para qué |
|---------|----------|
| `informe_ejecutivo.pdf` | Versión imprimible para el dueño / comité |
| `informe_interactivo.html` | Versión navegable con filtros por agente / sector / fecha |
| `resumen.md` | Bullet points editables para reuniones internas |
| `data_export.xlsx` | Datos brutos anonimizados, por si quieren cruzarlos con su CRM |
| `plantillas_respuesta.md` | 10 plantillas listas para copiar a su WhatsApp |
| `grabacion_llamada.mp4` | Grabación de la sesión de devolución |

---

## Quién lo necesita

- Inmobiliarias pequeñas y medianas que captan por WhatsApp y no miden nada
- Clínicas estéticas y dentales con alta competencia local
- Academias de formación y centros de idiomas
- Ocio nocturno (discotecas, salas, eventos)
- Adult services (operadoras, agencias, salones)
- Pymes B2B con ciclo corto que cotizan por WhatsApp
- Cualquier negocio que ya mueve >300 mensajes/mes y no tiene métricas

---

## Quién NO debería contratarlo

- Quien factura <100 leads/mes por WhatsApp (poca señal estadística)
- Quien ya tiene CRM con analítica WhatsApp integrada
- Quien usa WhatsApp solo para soporte post-venta (este reporte está orientado a comercial + operativo)

---

## RGPD y privacidad

- Firmamos contrato de prestación de servicios + Anexo de DPA (Encargado de Tratamiento)
- Los datos viven en infra cifrada en la UE
- Anonimizamos identificadores en el reporte si el cliente lo solicita
- Los datos brutos se borran a los 14 días tras la entrega
- El cliente puede ejercer derechos ARSULIPO en cualquier momento
- No revendemos datos, no entrenamos modelos con su información, no cruzamos con terceros

Más detalle en `DECISIONS.md`.

---

## Siguiente paso

- **Cliente potencial:** lee `SALES.md` y reserva 20 min en `landing/index.html`
- **Tú (operador):** lee `ROADMAP.md` para lanzar en 7 días
- **Caso de ejemplo:** ver `templates/reporte-ejemplo.md`
