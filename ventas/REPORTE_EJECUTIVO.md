# Reporte Ejecutivo — 10 Proyectos Comerciales

> Generado 2026-05-26 por 10 agentes autónomos en paralelo. Cada carpeta contiene `README.md`, `SALES.md`, `ROADMAP.md`, `PRIMER_CLIENTE.md`, `pitch.md`, `DECISIONS.md` y `landing/index.html` listos para enseñar a un cliente.

---

## Vista de pájaro

| # | Proyecto | Pricing principal | Primer cliente | Esfuerzo a venta | Tier |
|---|----------|-------------------|----------------|------------------|------|
| 01 | [NightPay Lite](01-nightpay-lite/) | **279 €/mes + 1.200 € setup** (Pro) | Sala del grupo que ya usa Paytef | 30 días | A |
| 02 | [Widget Adult-Services "Nocturna AI"](02-widget-adult-services/) | **199 €/mes + 750 € setup** (Pro) | Referidos cruzados de Maxxag VLC/MAD/Marbella | 7 días | A |
| 03 | [Auditoría WhatsApp](03-auditoria-whatsapp/) | **990 € one-shot** (Pro) | 5 cartera adult + 3 inmob VLC/Marbella + 2 clínicas | 7 días | A |
| 04 | [WA-Ops Inbox+IA](04-wa-ops-inbox/) | **119 €/mes/línea** (Pro) | Maxxag como "Socio-Fundador" a 75 €/línea | 4 semanas | A |
| 05 | [Soporte ATM-as-a-Service](05-soporte-atm/) | **55 €/mes/máquina** (Estándar) · tarifa fundador 42 € | Operador ancla (50+ máquinas Fujitsu F53) | 30 días | A |
| 06 | [Coaching IA Agentes WA](06-coaching-ia-agentes/) | **39 €/mes/agente** (Team) | Manager 5-10 agentes en Valencia/Levante | 5 semanas | B |
| 07 | [Cobro QR Revenue Share](07-cobro-qr-revshare/) | **1,0 % + 0,10 €/tx** (Estándar) | Locales que rechazaron Idea 01 por SaaS fijo | 2 semanas | B |
| 08 | [Pasarela Adult-Friendly](08-pasarela-adult-friendly/) | **199 €/mes + 1,5-2,9 %** (Standard) | Maxxag/Mansion Babylon (piloto 90 días) | 10 semanas | B |
| 09 | [Plataforma Eventos+Pago](09-eventos-pago/) | **5.000 € + 1,2 %/evento** (Mediano) | Promotor ya operando NightPay semanal | 12 semanas | B |
| 10 | [Stack-en-Caja White-Label](10-stack-en-caja/) | **5.000 €/año** (Growth) | Agencia digital VLC/Marbella hostelería/ocio | 10-14 semanas | B |

---

## Tier A — Cierre en ≤30 días (5 proyectos)

### 1 · NightPay Lite
**Pivote comercial inteligente:** en vez de vender NightPay full (4-6 sem, enterprise 30k €), licenciar el monorepo ya vivo a salas con Paytef instalado. Pricing 199/279/349 €/mes + setup. Permanencia 6m. Comisión 0,3-0,5 % sobre volumen.

**KPI mes 1:** 1 firma, ~1.479 € cash neto. Outreach 1-a-1 sobre `shared_db.json` filtrado por `paytefDeviceStatus="Conectado"`.

### 2 · Widget Adult-Services — marca "Nocturna AI"
**Estética premium adult (no SaaS genérico):** negro + oro + burdeos, Cormorant Garamond, demo chat funcional en hero. Cobro **SEPA recibo domiciliado** (no Stripe/PayPal — banco emisor empresa). Garantía 30 días sobre cuota, no IA consumida. Programa referidos 200 € (100+100) a los 3 clientes actuales como primer canal.

**Posición anti-feature-creep:** multi-tenant por carpeta JSON hasta 30+ clientes (no Postgres prematuro).

### 3 · Auditoría WhatsApp
**Lead-magnet perfecto + upsell a Idea 04.** 3 paquetes 690/990/1.290 €. Hallazgo crítico del propio `whatsapp_analyzer/reports/`: detección de OTPs bancarios compartidos por chat → convertido en argumento de venta "Audit de seguridad" en tier Plus.

**Demo material:** `templates/sample-entregable.md` con datos reales anonimizados (88 conversaciones, fugas con € estimado, 3 quick-wins). Cobro 50% upfront + 50% entrega.

### 4 · WA-Ops Inbox+IA
**Pricing por línea (no por casa)** = alinea precio con uso real. 149/119/89 €/línea según volumen. NouEsMalt SL factura "software" → Stripe limpio. **VPS dedicado por cliente** = aísla legal/ban/fallo. Maxxag a "Socio-Fundador" indefinido (50% descuento) a cambio de testimonio + caso de estudio.

**Honestidad explícita:** riesgo WAHA Plus documentado + plan rotación números + warmup.

### 5 · Soporte ATM-as-a-Service
**Tres tiers 39/55/69 €/mes/máquina** con SLAs 24h/8h/2h. **Indemnización inversa y portabilidad de datos defienden al cliente** = coherente con confianza B2B. Tarifa fundador 42 € para operador ancla con 50+ máquinas Fujitsu F53. Ampliación marcas Wincor/NCR/Hyosung en roadmap.

**Diferenciador:** IA + manuales digitalizados + WhatsApp como canal soporte (vs operadores tradicionales).

---

## Tier B — 3-6 meses (5 proyectos)

### 6 · Coaching IA Agentes WhatsApp
**29/39/49 €/agente.** Skill `coaching` ya implementado en `chatbot_maxxag/wa-ops/kpi-app/app/analyzer/prompts.py:161` → listo para extraer. **Doble base legal RGPD + TEDH López Ribalda II** documentado. Benchmark sectorial mínimo n=5. Output incluye `missed_opportunities` con cita textual + sugerencia → perfecto para scorecard semanal.

### 7 · Cobro QR Revenue Share
**Complementario, no canibal de Idea 01.** Sweet spot 20-80k €/mes con 1,0 % + 0,10 €. Break-even a 3.000 €/mes de volumen (coste op 50 €). Threshold operativo 5.000 €/mes (D1) con 2 meses de gracia. Cliente que crece a >12k €/mes migra automáticamente a Idea 01. Anti-objeción "cómo me fío de la medición": cruce línea-a-línea con `paytefAuthCode` (cláusula 7 + dashboard).

### 8 · Pasarela Adult-Friendly
**3 ADRs no resueltos críticos** explícitamente marcados:
- Figura legal (introductor / agente / EMI / sub-distribuidor)
- Aceptación real Cecabank de MCCs sensibles (validar semana 1)
- Naming pendiente

Sin cerrar estos, **el proyecto NO opera comercialmente**. Plan B con 4 adquirentes alternativos. Piloto 90 días setup 0 € + 49 €/mes + 1,9 % para Maxxag/Mansion Babylon.

### 9 · Plataforma Eventos+Pago "NightPay Events"
**Honestidad operativa:** 50 % software / 50 % logística in situ. Kits por tamaño documentados, checklists T-7d/T-24h/T-6h/T-2h/durante/post. Conectividad redundante triple capa. Póliza RC Mapfre. QR-first con RFID Q3-2026 vía partner (no fabricación). **Modelo referral con promotoras 10 % setup + 0,2 % volumen, nunca reventa.**

### 10 · Stack-en-Caja White-Label
**Modelo 3-capas estricto:** vendor (mantenimiento + 2º nivel) → agencia partner (despliegue + branding + 1er nivel) → cliente final. 3.000/5.000/9.000 €/año. Diferenciador vs HighLevel/Manychat = **soberanía de datos en VPS de la agencia + soporte castellano + MCC adult-friendly**. Piloto 500 €/60d. Add-on soporte 24/7 a 800 €/mes mitiga el riesgo de explosión de soporte 2º nivel.

---

## Orden de arranque recomendado

| Semana | Acción | Idea | Por qué primero |
|--------|--------|------|----------------|
| **Semana 1** | Lanzar landing + outbound 10 prospects | **#3 Auditoría WA** | Cierra en 1-2 llamadas, 690-1.290 € one-shot, alimenta #4 después |
| **Semana 1** | Formalizar contrato con operador ATM ancla | **#5 Soporte ATM** | Cliente ya servido informalmente → solo hay que pasarlo a SLA + factura |
| **Semana 2** | Llamada a Maxxag VLC/MAD/Marbella | **#2 Widget + #4 WA-Ops + #8 Pasarela** | 3 clientes ya operativos → upsell + Maxxag como caso fundacional |
| **Semana 2** | Reactivar leads que rechazaron SaaS | **#7 Revenue Share** | Oferta de fallback "te quito el coste fijo" sobre la base instalada Paytef |
| **Semana 3-4** | Sala objetivo del grupo Paytef existente | **#1 NightPay Lite** | Producto más sólido pero requiere lead caliente y demo en vivo |

Ideas 06, 08, 09, 10 entran en backlog Tier B una vez Tier A genere caja.

---

## Decisiones críticas pendientes (cross-proyecto)

1. **Figura legal NouEsMalt SL** — ¿qué factura cada idea? Software puro (#2, #4, #6, #10), servicio (#3, #5, #9), comisión (#1, #7), o entidad pago (#8). Influye en facturación, IVA, contratos.
2. **Pasarela cobro a clientes finales** — SEPA recibo domiciliado vence en casi todas las ideas adult-services. Validar con tu banco emisor capacidad de B2B SEPA recurrente.
3. **Cecabank sub-aggregation real** para #8 — sin go/no-go, idea 08 no puede prometer.
4. **Equipo de campo** para #5 y #9 — sin red de técnicos / staff in situ, ambas ideas tienen techo bajo.
5. **Maxxag como caso fundacional** — 3 ideas (#2, #4, #8) dependen del consentimiento explícito de Maxxag para ser caso/testimonio público. Una sola conversación cierra esto.

---

## Activos cruzados que cualquier idea puede usar

- `nightpay/` monorepo (NestJS + 3 Next.js apps + Prisma + Paytef + Cecabank)
- `chatbot_maxxag/wa-ops/` (FastAPI + WAHA + 6 skills Claude Haiku calibrados)
- `whatsapp_analyzer/reports/` (entregable real para enseñar)
- `manual_browser/` (Flask + Claude + Evolution + Chatwoot)
- `shared_db.json` (50+ máquinas, establecimientos, incidencias)
- Relación comercial Paytef (company 76861) — acceso a operadores ATM/POS
- 3 webs adult-services en producción (canal de referidos vivos)
