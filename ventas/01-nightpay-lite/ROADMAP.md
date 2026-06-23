# Roadmap NightPay Lite — 30 dias hasta primer cliente

> Fecha objetivo cierre primer cliente: **2026-06-25** (30 dias desde hoy, 2026-05-26).
> Tier objetivo: **Pro** (1.200 € setup + 279 €/mes + 0,4% volumen).
> Cliente objetivo: una sala de `shared_db.json` con `paytefDeviceStatus = "Conectado"`
> y volumen estimado >15 k€/noche.

---

## Resumen ejecutivo

3 frentes en paralelo:
- **Tecnico**: pasar de "feature-complete local" a "deploy publico funcionando".
- **Comercial**: 20 calls qualifier → 5 demos → 1-2 firmas.
- **Operativo**: setup contractual, factura, soporte WhatsApp, runbook noche 1.

Owner unico (tu). 30 dias / 4 semanas.

---

## Semana 1 (2026-05-26 → 2026-06-01) — Cimientos publicos

### Tecnico (bloqueante critico)

- [ ] **VPS Hetzner**: provisionar CX22 (~4 €/mes). 2 h.
- [ ] **Coolify** instalado en VPS. 1 h.
- [ ] **Dominio** `.app` o `.es` comprado (`nightpay.app` o similar). 30 min.
- [ ] **Cloudflare** apuntando dominio + tunnel a Coolify. 1 h.
- [ ] **Deploy NightPay full** (api + 3 frontends + postgres + redis) a Coolify. 4 h.
- [ ] **Rotar secretos** `.env.production` (JWT_SECRET, ENCRYPTION_KEK). 30 min.
- [ ] **HTTPS verificado** en `https://api.nightpay.app/v1/health`. 30 min.
- [ ] **Uptime Robot** apuntando a /health, alertas a Telegram. 30 min.

### Comercial

- [ ] **Lista 20 prospects** de `shared_db.json` filtrados por:
  - `paytefDeviceStatus = "Conectado"` o `last_connection` reciente
  - Maquinas activas >= 1
  - Nombre que sugiere ocio nocturno (Club, Sala, Discoteca, etc.)
- [ ] **Enriquecer** lista con contactos (Instagram DM, telefono web, mail web)
  vía búsqueda manual + LinkedIn de los managers.
- [ ] **Pulir email frio** (ya en `PRIMER_CLIENTE.md`). 1 h.
- [ ] **Plantilla WhatsApp** para seguimiento. 30 min.

### Operativo

- [ ] **Contrato marco** (4-5 paginas): SLA, propiedad datos, comision, baja.
  Usar plantilla legal estandar SaaS B2B + revisar con abogado contractual. 4 h.
- [ ] **Factura modelo** Holded / Sage / facturador autonomo. 30 min.
- [ ] **Numero WhatsApp Business** dedicado a soporte cliente. 30 min.

**Salida semana 1:** Stack publico accesible, 20 prospects listos, contrato listo.

---

## Semana 2 (2026-06-02 → 2026-06-08) — Outreach + onboarding self-service

### Tecnico

- [ ] **CLI onboarding wizard** (`pnpm cli setup-venue` interactivo): pide nombre,
  email owner, terminales, credenciales Paytef → todo en 1 comando. 6 h.
- [ ] **Set-credential Paytef** confirmar que funciona con company 76861 real
  (ya integrado en commit `b52153f` Cecabank — verificar Paytef tambien). 2 h.
- [ ] **Pagina demo publica** `demo.nightpay.app` con cuenta demo seed
  (owner@demo / nightpay-demo-2026), datos anonimos pero realistas. 4 h.
- [ ] **Bot Telegram alertas** P0 (pago atascado, breaker open). 2 h.
- [ ] **Backup remoto** Backblaze B2 + restic cron diario. 3 h.
  > Nota memoria: pendiente desde la semana del 2026-05-12.

### Comercial

- [ ] **Enviar email frio** a los 20 prospects (lunes 10:00). Tasa esperada
  apertura 30-40%, respuesta 5-10% → 1-2 calls.
- [ ] **Follow-up WhatsApp** dia +3 a quienes abrieron pero no respondieron.
- [ ] **2 calls qualifier** minimo (15 min cada una, ver guion `PRIMER_CLIENTE.md`).
- [ ] **Grabar video demo** 5 min con Loom / OBS para enviar tras call qualifier.

### Operativo

- [ ] **Landing publica** `nightpay.app` con `landing/index.html` deployado. 1 h.
- [ ] **Formulario contacto** que escriba en sheet o envie email a inbox comercial.
- [ ] **Dossier comercial PDF** (versionar el `pitch.md` a PDF con marca). 2 h.

**Salida semana 2:** 20 emails enviados, 2-4 calls realizadas, demo grabada, backup ok.

---

## Semana 3 (2026-06-09 → 2026-06-15) — Demo + propuesta

### Tecnico

- [ ] **Auto-failover Paytef ↔ Cecabank** activado para Enterprise. 4 h.
- [ ] **Modulo "Sesiones activas"** en frontend admin (kill-switch UI). 3 h.
- [ ] **Audit log UI** en frontend admin (ver eventos recientes). 3 h.
- [ ] **Indicador "modo degradado"** en TPV cuando WS cae (fallback polling). 2 h.
- [ ] **Sentry** integrado en los 3 frontends. 1 h.
- [ ] **Test smoke nocturno** automatico (crea pago demo cada 4 h, alerta si falla). 2 h.

### Comercial

- [ ] **3-5 demos** (30 min cada una) con interesados de semana 2.
- [ ] **Enviar propuesta 1-pager** a los 3-5 demos (template en `SALES.md`).
- [ ] **Follow-up dia +3** tras propuesta enviada.
- [ ] **Identificar al menos 1 "campeon interno"** (manager joven que quiere modernizar)
  en cada cuenta caliente.

### Operativo

- [ ] **Playbook "primera noche"**: checklist tecnico + presencial al cliente que firme.
- [ ] **Material onboarding** (PDF camarero + PDF manager + video 2 min) listo.
- [ ] **Cuenta Holded** para facturacion recurrente. 1 h.

**Salida semana 3:** 3-5 propuestas enviadas, 1 en negociacion avanzada.

---

## Semana 4 (2026-06-16 → 2026-06-25) — Cierre primer cliente

### Tecnico

- [ ] **Hardening final** (rotar passwords seed, secretos prod, RLS verificado).
- [ ] **Drill restore** ejecutado al menos 1 vez (probar que el backup funciona).
- [ ] **Game day chaos**: kill Redis 30 s, kill mock pasarela, ver que se recupera.
- [ ] **Provisionar venue real cliente firmado** vía `cli create-venue`.
- [ ] **Onboarding presencial 2 h** primera noche cliente.

### Comercial

- [ ] **Cierre firma electronica** primer cliente.
- [ ] **Cobrar setup** (1.200 € Pro) por transferencia adelantada.
- [ ] **Activar mensualidad** primera factura (279 €).
- [ ] **Caso de exito** post-primera-noche: numeros reales, testimonio. Material
  para semana 5+.

### Operativo

- [ ] **Soporte WhatsApp activo** la noche del estreno (sabado).
- [ ] **Postmortem primera noche** con cliente al lunes siguiente (30 min).
- [ ] **Ajustes prioritarios** detectados → roadmap mes 2.

**Salida semana 4:** **1 cliente Pro firmado, facturado y operando.**

---

## Indicadores de exito (KPI)

| Metrica | Objetivo semana 1 | Objetivo semana 4 |
|---------|-------------------|-------------------|
| Prospects identificados | 20 | 50 |
| Emails enviados | 0 | 20 |
| Calls qualifier | 0 | 4-6 |
| Demos realizadas | 0 | 3-5 |
| Propuestas enviadas | 0 | 3-5 |
| Firmas | 0 | **1** |
| MRR (mensual recurrente) | 0 € | **279 €** |
| Cash neto primer mes | 0 € | **1.479 €** (setup + mes 1) |

---

## Bloqueantes potenciales y mitigacion

| Bloqueante | Probabilidad | Mitigacion |
|------------|-------------:|-----------|
| Paytef no aprueba integracion adicional sobre la company 76861 | Baja | Ya integrado, commit `b52153f` |
| Cliente exige migracion datos historicos | Media | Add-on 300 € one-shot ya pricing |
| Cliente quiere whitelabel completo dia 1 | Media | Add-on 149 €/mes, mes 2 |
| VPS / Coolify se cae justo en demo | Baja | Plan B: demo en local con tunnel ngrok |
| Cliente exige integracion con su TPM Hosteltactil | Media | Roadmap mes 2, no para primer cierre |
| Compliance / RGPD prospect | Media | Dossier compliance preparado, hosting UE |
| Negociacion comision por debajo del 0,3% | Alta | Limite duro: -15% sobre tarifa sin aprobacion CEO |

---

## Despues del primer cierre (mes 2-3)

Inmediatamente al cerrar primer cliente:

1. **Caso de exito** publico con sus numeros (anonimizado si necesario).
2. **Referidos**: pedir 2 nombres al primer cliente (mismo sector, mismo ICP).
3. **Levantar lista prospects** del primer cliente (cadena? eventos? amigos?).
4. **Subir el ritmo**: objetivo 1 nuevo cliente cada 2-3 semanas hasta 5 en 90 dias.
5. **NightPay Full upsell** al primer cliente: cuando vea estabilidad, presentar
   failover + wallet + entradas (suma 297 €/mes en add-ons).

---

## Checklist semanal de ritmo (review viernes 18:00)

- [ ] ¿Cuantos prospects nuevos esta semana?
- [ ] ¿Cuantos emails / calls / demos hechos?
- [ ] ¿Que propuestas estan vivas y en que estado?
- [ ] ¿Que falta tecnicamente para la siguiente firma?
- [ ] ¿Que costo de oportunidad estoy aceptando esta semana?
- [ ] ¿Que aprendi de las objeciones reales (no las teoricas en `SALES.md`)?
