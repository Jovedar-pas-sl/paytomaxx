# ROADMAP — 30 días para tener servicio facturable

Checklist accionable. Cada tarea con dueño, criterio de "hecho" y bloqueante (si lo hay).

---

## Semana 1 (días 1-7): Fundacional legal y comercial

### T1. Contrato SLA modelo
- [ ] Redactar contrato base con cláusulas: objeto, SLAs por tier, exclusiones, compensación por incumplimiento, indemnización por rescisión unilateral, NDA, tratamiento de datos (RGPD), permanencia, salida y portabilidad de datos, ley aplicable (España), jurisdicción.
- [ ] Anexo I: lista de máquinas cubiertas (numeración, marca, modelo, ubicación, fecha alta).
- [ ] Anexo II: tarifa vigente.
- [ ] Anexo III: definición técnica de SLA (qué cuenta como tiempo de respuesta, qué excluye, ventanas de mantenimiento).
- [ ] **Revisión por abogado** (presupuesto: 400-700€). Buscar abogado especializado en contratos B2B SaaS o servicios técnicos.
- **Criterio hecho:** contrato firmable en PDF, listo para anexar a un primer cliente.
- **Bloqueante:** elección de abogado.

### T2. Estructura de precios y simulador
- [ ] Hoja de cálculo (Google Sheets) que estime coste mensual al cliente según: tier, número de máquinas, zona geográfica, intervenciones presenciales históricas estimadas.
- [ ] Versión simplificada embebible en landing.
- **Criterio hecho:** simulador funcionando, accesible para el equipo comercial.

### T3. Identidad mínima
- [ ] Nombre comercial confirmado.
- [ ] Logo simple (Canva o similar).
- [ ] Dominio + email profesional contacto@.
- [ ] Plantilla de propuesta comercial (Google Docs o PDF generable).
- **Criterio hecho:** se puede mandar un email con membrete.

---

## Semana 2 (días 8-14): Producto y datos

### T4. Dashboard cliente — versión 1
- [ ] Extender `manual_browser/app.py` con vista cliente (separada de la vista admin interna).
- [ ] Login por cliente, mostrar solo sus máquinas.
- [ ] KPIs por cliente: máquinas activas, tickets últimos 30 días, MTTR, próximas mantenciones.
- [ ] Generación de informe mensual PDF automático.
- **Criterio hecho:** un cliente puede entrar y ver el estado real de su flota.
- **Bloqueante:** decisión de auth (¿re-usar Chatwoot? ¿auth propio? ¿magic link?).

### T5. Ampliar biblioteca de manuales
Prioridad de marcas a incorporar (por penetración en España):

| Marca         | Modelos prioritarios                 | Estado  | Fuente manual           |
|---------------|--------------------------------------|---------|-------------------------|
| Fujitsu       | F53 (ya), F56                        | F53 ✅  | Tenemos F53; F56 falta  |
| Wincor Nixdorf| ProCash 280, ProCash 285             | ❌      | Comprar / Wincor partner|
| NCR           | SelfServ 22, SelfServ 32             | ❌      | NCR partner / segunda mano docs |
| Diebold       | Opteva 520, Opteva 720               | ❌      | Diebold partner / forums|
| GRG Banking   | H22N                                 | ❌      | GRG partner             |
| Hyosung       | MoniMax 5300, MoniMax 7600           | ❌      | Hyosung partner         |

- [ ] Conseguir manuales PDF de **al menos 2 marcas más** (Wincor y NCR como objetivo Q3).
- [ ] Indexar y validar con 20 consultas reales por marca antes de declararla "soportada".
- **Criterio hecho:** una marca extra publicable como soportada en landing.
- **Bloqueante:** acceso legal a manuales (¿comprados? ¿facilitados por cliente? ¿open repositories?). Documentar la fuente para evitar problemas IP.

### T6. Reportes automáticos
- [ ] Cron que genera informe mensual por cliente desde `whatsapp_analyzer` + `manual_browser` y lo manda por email al cliente.
- [ ] Template del informe: portada, resumen ejecutivo (3 puntos), tabla de incidencias, gráficas de tendencia, recomendaciones para el mes siguiente.
- **Criterio hecho:** un cliente recibe su PDF del mes 1 sin intervención manual.

---

## Semana 3 (días 15-21): Red de técnicos y operación

### T7. Reclutamiento de técnicos subcontratados
**Modelo:** freelance / autónomo por intervención, no plantilla (ver `DECISIONS.md`).

- [ ] Definir perfil: técnico electromecánico con experiencia ATM, vending, máquinas recreativas, TPV o ofimática avanzada. Permiso conducir, vehículo propio, herramienta básica.
- [ ] Tarifa propuesta al técnico: 60€/intervención en zona principal (≤30km), 80€ fuera de zona principal, 12€/h adicional, 0,30€/km fuera de zona.
- [ ] Canales de reclutamiento:
  - LinkedIn (búsqueda "técnico ATM", "técnico cajeros automáticos", "técnico vending").
  - Foros sector vending y recreativas españolas (faemcr, AEDET).
  - Antiguos técnicos de Fujitsu/Wincor/NCR despedidos o autónomos (ex-empleados son oro).
  - Boca a boca con técnicos ya conocidos del operador actual.
- [ ] Objetivo semana 3: **3 técnicos firmados** en zonas Madrid, Barcelona, Levante (Valencia/Murcia/Alicante).
- [ ] Contrato de prestación de servicios + NDA + cláusula de no competencia limitada.
- [ ] Onboarding técnico: 1h de formación remota sobre cómo abrir/cerrar ticket en nuestra plataforma, sistema de fotos antes/después, parte de trabajo.
- **Criterio hecho:** 3 técnicos en 3 zonas operativos.
- **Bloqueante:** disposición a firmar exclusividad parcial (no recomendado al inicio; rebajar exigencia).

### T8. Protocolo de despacho
- [ ] Playbook escrito de cómo se decide enviar técnico vs resolver remoto.
- [ ] Flujo: ticket entra → triage L1 (15 min) → intento remoto (30 min) → si no resuelto → escalado a despacho presencial.
- [ ] Quién despacha: una persona de guardia con app móvil para llamar al técnico de zona.
- [ ] App para el técnico (versión 1 = Telegram bot o WhatsApp + Google Forms). Versión 2 (Q3): app propia.
- **Criterio hecho:** flujo end-to-end probado con 1 incidencia real del operador piloto.

---

## Semana 4 (días 22-30): Facturación y arranque comercial

### T9. Facturación recurrente
- [ ] Stripe Billing o GoCardless (para domiciliación SEPA, más barato para B2B España).
- [ ] Comparativa: Stripe (2,5% + 0,25€) vs GoCardless (1% + 0,20€, max 4€). GoCardless gana en B2B con tickets > 100€.
- [ ] Plan de suscripción por máquina, prorrateado.
- [ ] Generación automática de factura mensual con desglose por máquina + extras del mes (intervenciones presenciales facturadas aparte).
- [ ] Numeración legal de facturas (Hacienda) + integración contable (Holded, Quaderno, o exportable a gestoría).
- **Criterio hecho:** primer cliente domiciliado, factura emitida automáticamente.
- **Bloqueante:** alta como autónomo / SL si no existe ya.

### T10. Landing publicada
- [ ] `landing/index.html` desplegada en dominio.
- [ ] Form de demo conectado a CRM mínimo (Notion DB o Airtable) + notificación WhatsApp al equipo.
- [ ] Política de privacidad + aviso legal + cookies (RGPD).
- **Criterio hecho:** un prospecto puede pedir demo desde web.

### T11. Outbound piloto
- [ ] Lista de 30 operadores ATM en España (cajeros independientes, redes privadas, gasolineras, hostelería con cajero).
- [ ] Email frío + 1 follow-up + LinkedIn touch (template en `PRIMER_CLIENTE.md`).
- [ ] Objetivo: **5 reuniones de discovery agendadas en 2 semanas**.
- **Criterio hecho:** 5 reuniones en agenda.

### T12. Formalización del cliente "ancla" (operador actual de 50+ máquinas)
- [ ] Ver `PRIMER_CLIENTE.md`.
- [ ] Cierre objetivo: día 30 con contrato firmado.

---

## Métricas de éxito a día 30

| KPI                                  | Objetivo  |
|--------------------------------------|-----------|
| Contrato modelo firmable             | Sí        |
| Cliente ancla firmado                | Sí (50+ máq)|
| Otros clientes firmados              | ≥ 0       |
| Reuniones discovery agendadas        | ≥ 5       |
| Técnicos subcontratados activos      | ≥ 3       |
| Marcas soportadas                    | ≥ 2 (Fujitsu + 1) |
| Landing publicada                    | Sí        |
| MRR comprometido                     | ≥ 2.000 € |

---

## Riesgos y mitigaciones

| Riesgo                                          | Mitigación                                       |
|-------------------------------------------------|--------------------------------------------------|
| No conseguir técnicos en algunas zonas          | Ampliar SLA presencial en zona no cubierta y comunicarlo al cliente como condición |
| Cliente ancla no quiere formalizar contrato     | Ofrecer descuento fundador 30% primer año + permanencia 6 meses (no 12) |
| Manuales de otras marcas inaccesibles           | Empezar con clientes Fujitsu únicamente y nichar |
| Carga operativa nocturna en Premium aplasta al equipo | No vender Premium hasta tener 2 técnicos en guardia rotatoria |
| Coste de adquisición alto                       | Conversión del cliente ancla = prueba social inmediata |
