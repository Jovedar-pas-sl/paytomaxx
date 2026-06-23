# DECISIONS — Decisiones operativas, técnicas y de negocio

> Documento vivo. Aquí queda registrado el "por qué" de cada decisión clave del servicio. Revisar cada 60 días.

---

## D-001 · Acceso a WhatsApp del cliente

### Decisión

Usar **Evolution API** como canal preferente. Soportar como alternativas la API Cloud oficial de Meta y WAHA.

### Por qué

| Opción | Pros | Contras | Adopción |
|--------|------|---------|----------|
| **Evolution API** | Open-source, dockerizable, controlamos infra, multi-instancia, ya validado en `whatsapp_analyzer/` | Usa WhatsApp Web bajo el capó, riesgo teórico de baneo si Meta endurece políticas | **DEFAULT** |
| API Cloud de Meta | Oficial, sin riesgo de baneo, alto volumen | Requiere número Business verificado, alta de Meta Business, tarifa por mensaje, complejidad de onboarding | Opt-in si el cliente ya la tiene |
| WAHA | Open-source, comunidad activa, multi-sesión | Menos batalla-probado que Evolution en producción | Plan B si Evolution falla |
| Export oficial de Meta (chat export) | Cero infra | Estático, sin tiempo real, perdemos timestamps precisos | NO — descartado para auditoría seria |

### Operativa

1. Cliente firma contrato + DPA
2. Le proponemos Evolution en nuestro VPS (recomendado) o en el suyo (avanzado)
3. Hacemos QR-pairing del dispositivo Business → Evolution captura mensajes
4. El dispositivo del cliente sigue funcionando normalmente

### Riesgo y mitigación

- Si Meta detecta uso no oficial: usar IP rotation, no enviar mensajes desde nuestra instancia (solo leer), pairing en horario neutro
- Tener WAHA como backup operativo (1 cliente piloto en paralelo)

### Memoria relacionada

Ver `feedback_wa_lid_messages` y `feedback_wa_dedup` en memoria global — patrón de dedup ya resuelto.

---

## D-002 · DPA (Encargado de Tratamiento)

### Decisión

Firmar siempre un acuerdo de Encargado de Tratamiento basado en el modelo de la AEPD (art. 28 RGPD) antes de tocar un solo mensaje del cliente.

### Contenido mínimo del DPA

- Identificación de las partes (responsable = cliente, encargado = nosotros)
- Finalidad limitada del tratamiento (análisis conversacional para producir reporte)
- Categorías de datos tratados (mensajes WhatsApp, números, nombres, metadata)
- Duración del tratamiento (30 días + 14 días post-entrega)
- Obligaciones del encargado (confidencialidad, seguridad, asistencia ARSULIPO)
- Subencargados autorizados (Anthropic, proveedor hosting, backup)
- Notificación de brechas en menos de 48h
- Cláusula de devolución/destrucción de datos al final
- Posibilidad de auditoría por parte del responsable

### Subencargados declarados

| Subencargado | Finalidad | Ubicación |
|--------------|-----------|-----------|
| Anthropic (Claude API) | Análisis lingüístico de mensajes | EU/US según endpoint (preferir EU si disponible) |
| Hetzner Cloud (o similar) | Hosting Evolution + pipeline | Falkenstein, Alemania |
| Backblaze B2 | Backup cifrado | UE (Amsterdam) |

### Acción pendiente

- [ ] Hacer revisar el modelo de DPA por un abogado RGPD antes del primer cliente

---

## D-003 · Anonimización de datos

### Decisión

Anonimización **opcional** ofrecida al cliente, **por defecto activada** en reportes destinados a terceros (caso de estudio, ejemplos comerciales).

### Niveles

| Nivel | Qué se anonimiza | Quién decide |
|-------|------------------|--------------|
| **L0 — sin anonimizar** | Nada. Nombres y números reales | Cliente, en reportes para uso interno |
| **L1 — números** | Solo los últimos 4 dígitos de teléfono visibles | Cliente, default recomendado |
| **L2 — nombres + números** | Nombres reemplazados por "Cliente A, B, C…" y números completamente ocultos | Cliente, para reportes compartidos con su equipo |
| **L3 — total** | Todo anonimizado, sectores genéricos | Nosotros, por defecto, en casos de estudio públicos o ejemplos comerciales |

### Acción pendiente

- [ ] Implementar el pipeline de anonimización en `whatsapp_analyzer` con un flag `--anonymize=L1|L2|L3`

---

## D-004 · Plazo de entrega

### Decisión

**10 días laborables** desde la firma del contrato.

### Justificación

- Es lo suficientemente rápido para parecer ágil y diferenciador
- Es lo suficientemente largo para absorber imprevistos (mala calidad de captura, cliente lento en dar acceso, picos de carga)
- Más corto (5 días) → tentación de bajar calidad o subir precio +30%
- Más largo (15+ días) → el cliente pierde momentum, sensación de "es un proyecto pesado"

### Excepciones

- **Express (5 días laborables): +30% sobre el precio base.** Solo aceptamos express si tenemos hueco operativo. No es por defecto.
- Cliente Plus con multi-sede → podemos extender a 15 días sin penalty si la complejidad lo justifica.

---

## D-005 · Cobro y facturación

### Decisión

- **50% al firmar contrato.** Sin esto, no arrancamos.
- **50% al entregar reporte y completar llamada de devolución.**
- Plazo de pago: 7 días naturales tras factura.
- Recargo por mora: 8% anual sobre el saldo pendiente.

### Métodos

- Transferencia SEPA (default)
- Stripe Checkout (para clientes que prefieren tarjeta)
- Bizum solo para piloto o ticket reducido (<350 €)

### Facturación

- IVA al 21% siempre
- Retención IRPF según contrato del cliente si aplica
- Factura en PDF emitida automáticamente al cobrar el primer 50%

---

## D-006 · Upsell flow al dashboard recurrente

### Decisión

Vender el one-shot como producto independiente con valor completo. Ofrecer dashboard recurrente como **add-on natural** durante la llamada de devolución, **no antes**.

### Mecánica de upsell

1. En la llamada de devolución (día 10), enseñar 2 KPIs evolutivos que se perderán si no hay tracking continuo
2. Proponer dashboard recurrente a 290 €/mes con 3 meses de compromiso mínimo
3. Si firma en los 7 días siguientes a la llamada → descuento del 15% en el primer mes
4. Si no firma → seguimiento a los 45 días con el follow-up (incluido en Pro y Plus)

### Tasa esperada

20-30% de los clientes one-shot deberían convertir a recurrente en los primeros 45 días.

### Producto recurrente

Ver idea 04 (dashboard recurrente — proyecto separado).

---

## D-007 · Pricing floor

### Decisión

**No vender por debajo de 590 €.**

### Excepciones autorizadas

| Caso | Precio mínimo | Contrapartida obligatoria |
|------|---------------|---------------------------|
| Cliente piloto público | 390 € | Caso de estudio publicable con nombre |
| Cliente piloto anónimo | 490 € | Testimonial escrito + permiso para usar logo en landing |
| Referido por cliente existente | 590 € | Ninguna (es el descuento normal de referido) |
| ONG o causa social verificada | 290 € | Visibilidad pública + permiso de uso |

### Lo que NUNCA aceptamos

- "Pago si funciona" — el reporte es valor entregado, no resultado
- Descuento sin contrapartida
- Pago al 100% a la entrega
- Pago en especie / barter

---

## D-008 · Stack técnico

### Decisión

Reutilizar el código existente en `whatsapp_analyzer/` y construir encima.

### Stack actual

- **Captura:** Python + Evolution API
- **Análisis:** Anthropic Claude (Opus para análisis profundo, Haiku para tareas simples)
- **Storage:** PostgreSQL local + filesystem para PDFs
- **Reporte:** HTML + Markdown templating, conversión a PDF con WeasyPrint o Playwright

### Roadmap técnico

- [ ] Pipeline de anonimización (D-003)
- [ ] Plantilla HTML pulida para el reporte (look ejecutivo, no técnico)
- [ ] Generación automática del PDF desde el HTML
- [ ] Dashboard de operaciones interno (ver clientes activos, plazos, alertas)
- [ ] Notificación automática a los 14 días para borrado de datos del cliente entregado

### Memoria relacionada

Ver `feedback_alembic_concurrently`, `feedback_wa_lid_messages` y `project_wa_ops_pending` (backup remoto a Backblaze B2 pendiente).

---

## D-009 · Política de retención de datos

### Decisión

- **Datos brutos del cliente:** se borran automáticamente a los **14 días** desde la entrega del reporte.
- **Reporte final:** queda en mano del cliente; nosotros conservamos solo un hash del reporte y los metadatos no identificativos durante 12 meses (por si reclama soporte).
- **Backup cifrado:** rotación mensual con borrado seguro tras la fecha de retención.

### Excepción

Si el cliente contrata dashboard recurrente, los datos brutos se conservan mientras dure la suscripción.

---

## D-010 · Verticales y descalificación

### Decisión

Aceptar clientes de los siguientes verticales:

- Inmobiliaria pequeña/mediana
- Clínicas estéticas, dentales, fisioterapia
- Academias, centros de formación
- Ocio nocturno
- Adult services (con DPA reforzado)
- Pymes B2B con ciclo corto
- E-commerce con atención por WhatsApp

### NO aceptamos

- Bufetes con casos penales abiertos (secreto profesional reforzado)
- Servicios médicos con datos de salud individualizados (categoría especial RGPD, alto riesgo)
- Empresas que usen WhatsApp para captación política o religiosa
- Empresas con denuncias activas relevantes
- Cualquiera que se niegue a firmar DPA

---

## Decisiones pendientes

- [ ] Nombre comercial final del producto (RadarWA, Auditoría Conversacional, otros)
- [ ] Dominio definitivo
- [ ] Política de retención post-suscripción cuando un cliente recurrente cancela
- [ ] Definir si ofrecemos versión enterprise (>5.000 €) para grupos hoteleros, cadenas franquiciadas
- [ ] Verificar disponibilidad de endpoint EU de Claude para reducir el riesgo de transferencia internacional de datos
