# ROADMAP — 2 semanas para abrir el modelo RevShare

Checklist accionable. Cada item con dueño, esfuerzo, criterio de hecho.

---

## Semana 1 — Motor de liquidacion + contrato

### Lunes-martes: Motor de liquidacion

- [ ] **Esquema DB nuevo** (`packages/db/prisma/schema.prisma`)
  - Tabla `RevShareConfig` (venueId, ratePct, perTxFee, tier, contractStart, minMonths)
  - Tabla `Settlement` (venueId, period, txCount, grossAmount, fees, total, status, invoiceUrl)
  - **Done when:** migracion alembic-style aplicada, RLS por tenantId activo
  - Esfuerzo: 4 h

- [ ] **Job de calculo mensual** (`apps/admin/src/lib/revshare-calculator.ts`)
  - Cron 1 de cada mes, 02:00 Europe/Madrid
  - Query: `SUM(amount), COUNT(*)` de `Transaction WHERE status='settled' AND period`
  - Cruza con `paytefAuthCode IS NOT NULL` (excluye refunds y disputas)
  - Genera `Settlement` row + factura PDF
  - **Done when:** test E2E pasa con 100 transacciones falsas y devuelve total esperado
  - Esfuerzo: 6 h

- [ ] **Factura electronica Facturae 3.2.2**
  - Usa libreria `facturae-js` (validar que existe; si no, FacturaScripts API)
  - Plantilla: linea por transaccion + linea agregada de fee fijo
  - Firma con certificado FNMT (ver `nightpay/docs/` — comprobar si existe ya)
  - **Done when:** factura validada por validador AEAT online
  - Esfuerzo: 6 h

### Miercoles: Dashboard de comisiones para el operador

- [ ] **Pagina `/admin/billing`** (Next.js, ya existe `apps/admin`)
  - Tabla: mes, txCount, gross, comision, fee fijo, total, estado factura, descargar PDF/CSV
  - Filtros: rango fechas, descargar detalle linea-a-linea CSV
  - Boton "auditar contra Paytef" → export con columna `paytefAuthCode` para cruzar
  - **Done when:** un operador ve sus ultimos 3 meses con detalle completo
  - Esfuerzo: 5 h

- [ ] **Email mensual automatico**
  - Plantilla: "Tu factura de [mes] esta lista: [link]. Total: [importe]. Vencimiento: [fecha]."
  - Cron 1 de cada mes, 09:00
  - **Done when:** test envia a mailtrap.io
  - Esfuerzo: 2 h

### Jueves-viernes: Contrato modelo

- [ ] **Redactar `contrato.md` (markdown legible)** con clausulas:
  1. Objeto y alcance del servicio (que se incluye y que no)
  2. Modelo de precios (tier elegido + % + fee fijo)
  3. Periodo y permanencia minima (3 meses)
  4. Liquidacion mensual (dia 1, 15 dias para pagar)
  5. SLA y abonos por caida (>2 h horario operacion → credito)
  6. **Exit:** preaviso 30 dias post-permanencia, cero penalizacion
  7. **Auditoria y transparencia:** cliente puede pedir cruce con Paytef en cualquier momento
  8. **Proteccion de datos:** RLS multitenant, GDPR, DPA si lo piden
  9. **Codigo en escrow** (clausula opcional, +0,1 % comision)
  10. Resolucion de disputas: mediacion Camara Comercio Madrid antes de juzgados
  - Esfuerzo: 4 h (con plantilla de abogado-revisor para Idea 01 ya existente)

- [ ] **Mandato SEPA B2B Direct Debit**
  - Plantilla estandar bancaria (template publico CECA)
  - Firma electronica via DocuSign o equivalente espaņol (Signaturit / Lleida.net)
  - **Done when:** ciclo end-to-end firmado en sandbox
  - Esfuerzo: 3 h

- [ ] **Revision por abogado mercantilista** (ext)
  - Coste estimado 350-500 €
  - Foco: clausula exit, clausula SLA, clausula auditoria, clausula codigo escrow
  - **Done when:** abogado da OK por email
  - Esfuerzo: paralelo, 48 h espera

---

## Semana 2 — Seguro, primer cliente, lanzamiento

### Lunes: Seguro y aval

- [ ] **Explorar seguro RC profesional**
  - Hiscox / Markel / AIG — cobertura 100k-300k € por error de software o fallo SLA
  - Cuota estimada 60-150 €/mes
  - **Decision esperada:** comprar si el primer cliente supera 50k €/mes procesado
  - Esfuerzo: 3 h (cotizar 3 proveedores)

- [ ] **Aval bancario opcional para grupos grandes**
  - Si un grupo nos exige aval para firmar, aval BBVA / Santander con coste 0,5-1 % anual
  - **Decision esperada:** ofrecerlo solo a partir de contratos >250k €/mes procesado
  - Esfuerzo: 2 h (investigar)

### Martes-miercoles: Primer cliente piloto

- [ ] **Identificar 3 locales del grupo donde ya hay PAX** (ver `../../shared_db.json`)
  - Criterio: `paytefDeviceStatus=Conectado` AND volumen estimado >20k €/mes
  - Esfuerzo: 1 h

- [ ] **Llamada de reabordaje** (ver `PRIMER_CLIENTE.md`)
  - Guion: "te quito el coste fijo, lo pago yo, te llevo a comision"
  - 3 llamadas reales esta semana
  - Esfuerzo: 4 h (incluye preparacion y followup)

- [ ] **Cerrar primer piloto a coste 0**
  - Plan: HIGH-VOLUME 0,8 % con compromiso 100k €/mes (renegociable si baja)
  - Setup 0 €, primer mes facturado el 1 de junio si firma antes del 22 de mayo
  - **Done when:** contrato firmado y mandato SEPA activo
  - Esfuerzo: variable, target 5 h

### Jueves: Onboarding tecnico cliente 1

- [ ] **Deploy NightPay en VPS Hetzner** (ya prevista 5 dias en Idea 01, reutilizar)
  - Dominio: `revshare.nightpay.cobro` o `[local].nightpay.cobro`
  - **Done when:** TPV camarero responde, admin responde, QR generado
  - Esfuerzo: 4 h

- [ ] **Onboarding presencial 2 h** en el local
  - Formacion camareros, alta usuarios admin, validar flujo cobro real
  - **Done when:** primera transaccion QR real procesada
  - Esfuerzo: 3 h

### Viernes: Lanzamiento landing

- [ ] **Publicar `landing/index.html`** en Cloudflare Pages o Vercel
  - Dominio: `nightpay-revshare.com` (verificar disponibilidad) o subdir
  - Calculadora interactiva activa (JS vanilla, ya incluida)
  - **Done when:** Lighthouse >85, CLS <0.1
  - Esfuerzo: 2 h

- [ ] **Lanzar campaña email a leads frios** (los que dijeron NO a Idea 01)
  - Lista: ver `PRIMER_CLIENTE.md` seccion "leads que rechazaron Idea 01"
  - Plantilla: ver `PRIMER_CLIENTE.md` email "te quito el coste fijo"
  - **Done when:** 30 emails enviados, tracking en SendGrid o equivalente
  - Esfuerzo: 2 h

---

## Criterios de exito al cerrar las 2 semanas

- [x] Motor de liquidacion funciona end-to-end con factura electronica valida
- [x] Dashboard de operador muestra mes en curso + historico
- [x] Contrato firmado por abogado y publicado en `contrato.md`
- [x] Mandato SEPA listo para firmar electronicamente
- [x] **Al menos 1 contrato RevShare firmado**
- [x] Landing online con calculadora funcional
- [x] Campaña email a 30+ leads de Idea 01 enviada

---

## Riesgos y mitigaciones

| Riesgo                                          | Probabilidad | Mitigacion                                |
|-------------------------------------------------|--------------|-------------------------------------------|
| Abogado tarda mas de 1 semana                   | Media        | Empezar review en paralelo dia 1          |
| Cliente no firma SEPA por desconfianza          | Alta         | Alternativa: transferencia 15 dias        |
| Cliente exige aval bancario antes de firmar     | Baja-media   | Aval BBVA presupuestado en semana 1       |
| Motor de calculo falla en produccion mes 1      | Media        | Doble check manual mes 1 contra Paytef    |
| Disputa por importe en mes 1                    | Alta         | Clausula auditoria + dashboard linea-a-linea desde dia 1 |

---

## Lo que NO esta en este roadmap (post-mes 1)

- API publica para que el operador integre con su contabilidad
- Multi-divisa (no relevante en España)
- Aplicacion movil propia (web mobile-first es suficiente)
- White-label para reventa por terceros

Estas funciones se valoraran solo si hay 5+ clientes RevShare activos al final del mes 2.
