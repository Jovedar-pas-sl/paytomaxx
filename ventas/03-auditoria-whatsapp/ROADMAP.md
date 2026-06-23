# ROADMAP — Lanzar en 7 días

> Objetivo: cerrar el primer cliente de pago en menos de 14 días desde hoy. Llegar a 3 clientes pagados en 30 días.

---

## Día 1 — Plantilla del reporte y pricing operacional

- [ ] Pulir la plantilla del reporte (`templates/reporte-ejemplo.md`) con 1 caso anonimizado real extraído de `whatsapp_analyzer/reports/`
- [ ] Validar que los KPIs prometidos en `SALES.md` los produce hoy el sistema. Si alguno no sale, marcar TODO en `DECISIONS.md`
- [ ] Definir hard floor de precio (no vender por debajo de 590 €, salvo piloto con caso de estudio)
- [ ] Definir costes internos por auditoría:
  - Hosting Evolution (~5 €/mes prorrateado)
  - Tokens Claude (Opus para análisis, ~10-25 € por auditoría según volumen)
  - Tu tiempo: 4-6h por auditoría las primeras, 2-3h cuando esté automatizado
  - Total objetivo de margen: 80%+ a partir del cliente 5

---

## Día 2 — Landing y deck

- [ ] Subir `landing/index.html` a un dominio simple (sugerido: `auditoria-whatsapp.es`, `radar-wa.com`, o subdirectorio de tu dominio actual)
- [ ] Configurar Calendly o Cal.com en el CTA (slot de 20 min, disponibilidad acotada a 3 días/semana)
- [ ] Configurar tracking básico: Plausible o Umami (no GA, problemas RGPD)
- [ ] Pulir `pitch.md` y convertirlo a Google Slides / Pitch / Canva para enseñar en llamadas
- [ ] Preparar el ejemplo anonimizado del reporte como PDF descargable bonito

---

## Día 3 — Contratos y RGPD

- [ ] Plantilla de **contrato de prestación de servicios** (validada por un abogado, no copiar de internet)
- [ ] Plantilla de **DPA / Acuerdo de Encargado de Tratamiento** según artículo 28 RGPD
- [ ] Política de privacidad propia (publicar en la landing)
- [ ] Aviso legal y cookies en la landing (consentimiento simple, sin dark patterns)
- [ ] Definir y documentar:
  - Dónde viven los datos (proveedor + región UE)
  - Cuánto tiempo se conservan (14 días post-entrega)
  - Quién puede acceder (lista nominal interna)
  - Procedimiento ante incidente de seguridad
  - Procedimiento ante solicitud ARSULIPO del titular

> **Recomendación seria:** invierte 200-400 € en un abogado especializado RGPD para revisar estos documentos. Te ahorras un problema futuro de 5 cifras.

---

## Día 4 — Infraestructura operativa

- [ ] Servidor para Evolution API (VPS Hetzner o similar, 5-10 €/mes)
- [ ] Cifrado en reposo de la BD de conversaciones (LUKS / encrypted volume)
- [ ] Cifrado en tránsito de extremo a extremo entre Evolution y tu pipeline de análisis
- [ ] Backup automático cifrado a Backblaze B2 (ya pendiente, ver memory `project_wa_ops_pending`)
- [ ] Política de borrado automático a los 14 días con logs auditables
- [ ] Acceso restringido por IP / VPN al servidor
- [ ] Cuenta de correo profesional con dominio (`hola@tu-dominio.es`)
- [ ] Cuenta de Stripe o GoCardless para cobrar (no aceptar Bizum salvo pruebas pequeñas)

---

## Día 5 — Proceso de onboarding documentado

Documentar paso a paso:

1. Email de bienvenida con enlace a firma del contrato + DPA (DocuSign, HelloSign o similar)
2. Cobro del 50% por adelantado al firmar (mínimo 350 €)
3. Email de instrucciones técnicas para que el cliente nos dé acceso a su WhatsApp:
   - Opción A: instalación de Evolution en su VPS (recomendado, le compartimos guía)
   - Opción B: provisionar Evolution en nuestro VPS y emparejar dispositivo
   - Opción C: usar API Cloud de Meta si ya la tiene
4. Onboarding call de 30 min para resolver dudas técnicas
5. Confirmación de que la captura funciona y los mensajes llegan
6. Comunicación de plazo final: D+10 desde la captura activa

Plantillas de email para cada paso → guardar en `templates/emails/` (TODO crear).

---

## Día 6 — Outbound y primeros prospects

- [ ] Leer `PRIMER_CLIENTE.md` y ejecutar la lista de 10 prospects
- [ ] Enviar emails fríos en los 3 verticales sugeridos (adult-services, inmobiliaria, clínica estética)
- [ ] Calentar antes vía LinkedIn / Instagram según el sector
- [ ] Pedir 3 introducciones a contactos de cartera que ya conoces
- [ ] Postear en 2-3 grupos sectoriales WhatsApp/Telegram donde estés con el caso de estudio anónimo

**Métrica del día 6:** 15 outbounds enviados, 3 conversaciones abiertas, 1 llamada agendada.

---

## Día 7 — Llamadas y cierre del primer cliente

- [ ] Hacer las llamadas de descubrimiento agendadas
- [ ] Aplicar guion de 20 min de `SALES.md`
- [ ] Enviar propuesta + contrato + link de pago en menos de 2 horas tras la llamada
- [ ] Si el primer cliente cierra → arrancar onboarding inmediatamente
- [ ] Si no cierra → iterar el pitch y revisar objeciones; agendar 5 outbounds más

---

## Checklist agregado para el lanzamiento

### Comercial
- [ ] Landing publicada y testeada en móvil
- [ ] Deck en presentación cloud accesible por enlace
- [ ] Ejemplo de reporte como PDF descargable
- [ ] Calendly conectado al CTA principal
- [ ] 3 emails fríos por vertical guardados en plantillas

### Legal
- [ ] Contrato modelo firmado por tu lado
- [ ] DPA modelo firmado por tu lado
- [ ] Política de privacidad publicada
- [ ] Aviso legal publicado
- [ ] Texto de "comunicación a clientes" del prospect listo para entregar

### Técnico
- [ ] Evolution dockerizada en VPS productivo
- [ ] Pipeline de análisis funcionando con 1 cliente de prueba (puede ser tu propio número)
- [ ] Plantilla del reporte generada automáticamente desde el output del analyzer
- [ ] Borrado automático a 14 días con cron auditado
- [ ] Backup cifrado verificado

### Financiero
- [ ] Cuenta de cobro (Stripe + transferencia)
- [ ] Plantilla de factura
- [ ] Alta como autónomo o sociedad operativa (ya debe estar)
- [ ] Modelo de tributación verificado (IVA al 21%, retención según contrato)

---

## Hitos post-lanzamiento

| Día | Hito |
|-----|------|
| D+14 | Primer cliente firmado y onboardado |
| D+24 | Primer reporte entregado |
| D+30 | 3 clientes en cartera |
| D+45 | Primer cliente convertido a dashboard recurrente (upsell idea 04) |
| D+60 | 5 clientes acumulados + 1 testimonial público en la landing |
| D+90 | 10 clientes acumulados + decidir si subimos precios o lanzamos versión enterprise |

---

## Trampas a evitar

1. **No regalar el primer reporte.** Si lo regalas, el prospect lo asocia a algo sin valor. Mínimo cobrar 290 € como "piloto" si es absolutamente necesario.
2. **No prometer plazos imposibles.** 10 días laborables es justo; si el cliente quiere en 5 días, sube precio +30%.
3. **No personalizar demasiado los primeros entregables.** Mantén la plantilla estándar para escalar.
4. **No aceptar pago contra entrega completo.** Siempre 50% al firmar.
5. **No vender por debajo de 590 € sin estar muy seguro de qué consigues a cambio** (testimonial, referido, caso de estudio público).
