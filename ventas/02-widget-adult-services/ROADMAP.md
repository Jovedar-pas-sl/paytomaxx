# ROADMAP — 30 dias para producto vendible empaquetado

> Objetivo: pasar del "tengo 3 clientes a medida" a "tengo un producto SaaS multi-tenant que puedo vender en 1 llamada y cobrar por SEPA".

---

## Semana 1 (dias 1-7) — Snippet 1-linea y multi-tenancy

### Dia 1-2: arquitectura multi-tenant

- [ ] Refactor `backend/app.py` para aceptar `client_id` en cada endpoint
- [ ] Separar `data/` por cliente: `data/clients/maxxag-vlc/`, `data/clients/maxxag-mad/`, etc.
- [ ] Migrar config actual (girls.json, config.json) a la nueva estructura
- [ ] Validar que los 3 clientes actuales siguen funcionando despues del refactor

### Dia 3-4: loader 1-linea

- [ ] Crear `widget/loader.js` que sea el unico script que el cliente pega en su web
- [ ] Loader lee `data-client="casa-XXX"` y carga el CSS+JS correctos del CDN
- [ ] Versionado: `/v1/loader.js` para no romper clientes cuando saquemos v2
- [ ] Cache: 1h en CDN, fingerprint para invalidacion

### Dia 5: plugin WordPress definitivo

- [ ] Empaquetar plugin con pantalla de configuracion limpia (1 campo: client_id)
- [ ] Subir a `wordpress-plugin/` con README de instalacion
- [ ] Probar en WordPress vainilla, Astra, GeneratePress, Divi
- [ ] Manual de instalacion en PDF de 1 pagina

### Dia 6-7: panel onboarding self-service

- [ ] Pantalla "Crear cliente nuevo" en panel admin: nombre casa, ciudad, WhatsApp, idiomas
- [ ] Auto-genera `client_id` y crea estructura `data/clients/<id>/` con plantilla
- [ ] Genera la linea de codigo a pegar (copiar al portapapeles)
- [ ] Pantalla "Tarifas" con editor tabla (no editar JSON a mano)

**Hito semana 1:** dar de alta un cliente nuevo desde el panel en 10 minutos sin tocar codigo.

---

## Semana 2 (dias 8-14) — Billing SEPA

### Dia 8: investigacion banco

- [ ] Confirmar con banco que aceptan emisor SEPA B2B (cuenta empresa)
- [ ] Solicitar identificador de acreedor SEPA si no se tiene
- [ ] Definir formato de fichero SEPA (XML pain.008.001.02 estandar UE)

### Dia 9-10: alta clientes SEPA

- [ ] Plantilla de mandato SEPA en PDF (datos casa + IBAN + firma)
- [ ] Proceso: cliente firma digital, lo recibimos por email, archivamos
- [ ] Tabla `mandatos_sepa` en BD: cliente, iban, fecha_firma, estado

### Dia 11-12: facturacion automatica

- [ ] Script Python que genere fichero SEPA XML cada dia 1 del mes
- [ ] Cobra mensualidad de cada cliente activo
- [ ] Sumar overage de conversaciones IA si excede cuota
- [ ] Generar factura PDF con Factura Directa o similar y enviar por email

### Dia 13: dashboard billing

- [ ] Panel `/admin/billing`: clientes activos, pendientes de cobro, devueltos
- [ ] Gestion de devoluciones SEPA (R-transactions: R01, R03, etc.)
- [ ] Alerta cuando un cliente excede el 80% de su cuota mensual

### Dia 14: legal

- [ ] Contrato tipo (PDF) con clausulas: precio, permanencia, baja, SLA, GDPR
- [ ] Politica de privacidad y aviso legal en `widget.tu-dominio.com`
- [ ] Contrato de encargado de tratamiento (GDPR art. 28) firmable digital

**Hito semana 2:** primer cobro SEPA real ejecutado contra uno de los 3 clientes actuales (Maxxag VLC seguramente, mas cercano).

---

## Semana 3 (dias 15-21) — Onboarding y producto

### Dia 15-16: video onboarding

- [ ] Grabar video 5 min: "Como instalar el widget en tu WordPress"
- [ ] Grabar video 5 min: "Como editar catalogo y tarifas desde el panel"
- [ ] Subir a Vimeo privado (no YouTube por SEO del dominio)
- [ ] Link de los videos en el email de bienvenida

### Dia 17-18: email automation

- [ ] Email 1 (dia 0): bienvenida, link a videos, contacto soporte
- [ ] Email 2 (dia 3): "esta todo OK? agendamos llamada de 15 min"
- [ ] Email 3 (dia 14): reporte de conversaciones del widget primera quincena
- [ ] Email 4 (dia 30): factura + reporte mensual + checking satisfaccion

### Dia 19-20: telemetria producto

- [ ] Logging por cliente: conversaciones/dia, idioma usado, tasa handoff WhatsApp
- [ ] Dashboard `/admin/metricas/<client_id>` accesible para el cliente
- [ ] Acceso del cliente con magic-link por email (sin password complicado)

### Dia 21: pruebas E2E

- [ ] Dar de alta cliente ficticio "casa-demo" desde cero
- [ ] Instalar widget en WordPress de pruebas
- [ ] Generar 50 conversaciones de prueba
- [ ] Verificar que aparecen en panel, que se calculan metricas, que SEPA se prepararia

**Hito semana 3:** demo end-to-end funcionando, lista para mostrar a prospecto.

---

## Semana 4 (dias 22-30) — Comercial y primer cliente externo

### Dia 22-23: landing y materiales

- [ ] Landing publica en `widget.tu-dominio.com` (la que esta en `landing/index.html`)
- [ ] Subir deck `pitch.md` a PDF profesional
- [ ] Caso de exito 1 pagina por cada cliente actual (Maxxag VLC, Maxxag MAD, Babylon)

### Dia 24-25: outreach

- [ ] Lista de 30 casas/clubes en Espana con web propia (objetivo: Barcelona, Bilbao, Sevilla, Malaga, Zaragoza)
- [ ] Email frio personalizado por cada uno (ver `PRIMER_CLIENTE.md`)
- [ ] Programa de referidos arrancado con los 3 clientes actuales (200 EUR por referido confirmado)

### Dia 26-27: llamadas

- [ ] Agendar minimo 5 llamadas con prospectos
- [ ] Guion de llamada en mano (ver `PRIMER_CLIENTE.md`)
- [ ] Demo en vivo durante la llamada (acceso a panel y widget de prueba)

### Dia 28-29: cerrar primer cliente externo

- [ ] Negociar contrato, firmar
- [ ] Cobrar setup por transferencia (mientras se firma mandato SEPA para el recurrente)
- [ ] Instalar widget en 48h
- [ ] Onboarding live de 30 min con la casa

### Dia 30: retrospectiva

- [ ] Reunion conmigo mismo: que funciono, que no, que precio aguanto el mercado
- [ ] Ajustar pricing si hace falta
- [ ] Planificar mes 2: objetivo 3 clientes externos nuevos

**Hito semana 4:** 1 cliente externo nuevo firmado y facturando, sistema replicable.

---

## KPIs objetivo a fin de mes 1

| KPI | Objetivo |
|-----|----------|
| Clientes facturando | 4 (3 actuales + 1 nuevo) |
| MRR | 600-750 EUR |
| Setup cobrado este mes | 600-900 EUR (cliente nuevo) |
| Tiempo onboarding cliente nuevo | < 5 dias laborables |
| Prospectos contactados | 30 |
| Demos realizadas | 5 |
| Tasa conversion demo a cliente | 20% (1 de 5) |

---

## Mes 2 y 3 — visibilidad rapida

### Mes 2 — escalar

- [ ] Objetivo: 3 clientes externos nuevos (total 7)
- [ ] MRR objetivo: 1.500 EUR
- [ ] Optimizar coste IA (cache de respuestas frecuentes, fine-tuning prompt)
- [ ] Anadir idioma DE (alemanes en Costa del Sol y Canarias)

### Mes 3 — consolidar

- [ ] Objetivo: 4 clientes externos nuevos (total 11)
- [ ] MRR objetivo: 2.500 EUR
- [ ] Contratar (o subcontratar) primer soporte para descargar trabajo
- [ ] Empezar a producir contenido sectorial (no SEO publico, mas bien grupos privados Telegram del sector)

---

## Bloqueadores conocidos

| Riesgo | Mitigacion |
|--------|------------|
| Banco rechaza emision SEPA por sector | Hablar con banco especifico (Caixabank Empresa o Cecabank). Plan B: transferencia mensual manual |
| Anthropic sube precios Claude Haiku | Tener cache local + opcion fallback a modelo Llama self-hosted |
| Cliente quiere Stripe para cobrar a sus clientes finales | No es nuestro problema, derivar a proyecto 08 (pasarela adult-friendly) |
| Casa quiere personalizacion infinita | Tarifa "custom" con minimo 2.000 EUR setup |
