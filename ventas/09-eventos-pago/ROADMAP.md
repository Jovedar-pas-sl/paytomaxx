# Roadmap NightPay Events — 8 a 12 semanas hasta evento piloto

## Visión general

Tenemos NightPay funcionando en operativa semanal (discotecas, bares). Para servir festivales y eventos especiales necesitamos:

1. Modo "evento efímero" (tenant temporal con cierre y liquidación 24h)
2. Ticketing + consumiciones (recarga en barra, saldo en QR/pulsera)
3. Kit logístico desplegable
4. Procedimientos operativos (checklist pre/durante/post evento)
5. Cobertura legal y de seguros

**Objetivo:** ejecutar **1 evento piloto** a coste real con un promotor amigo en semana 12.

---

## Semana 1-2 · Diseño y validación

### Producto
- [ ] Diseño técnico del "modo evento efímero": tenant temporal, fecha de cierre automática, liquidación programada
- [ ] Diseño de modelo de datos para tickets + consumiciones: `event`, `ticket_type`, `wallet`, `wallet_transaction`
- [ ] ADR sobre QR vs RFID vs ambos (decisión inicial: QR-first, RFID en Q3-2026)
- [ ] Decisión: ¿integramos con Eventbrite/Ticketmaster vía API o solo CSV import?

### Comercial
- [ ] Lista de 10 promotores objetivo (ver [PRIMER_CLIENTE.md](PRIMER_CLIENTE.md))
- [ ] 3 conversaciones de descubrimiento con promotores
- [ ] Confirmar 1 evento piloto en agenda real (firmar carta de intenciones)

### Legal
- [ ] Revisar contrato marco con abogado: SLA, penalizaciones, fuerza mayor
- [ ] Cotizar póliza responsabilidad civil profesional (Mapfre, Allianz, Hiscox)

---

## Semana 3-4 · Implementación modo evento efímero

### Producto
- [ ] Migración Prisma: tablas `event`, `event_session`, `event_terminal_assignment`
- [ ] Endpoint `POST /v1/admin/events` con configuración del evento (fecha inicio/fin, aforo, terminales)
- [ ] Cierre automático: cron que detecta fin de evento + lanza conciliación
- [ ] Liquidación 24h: job que genera informe + dispara transferencia bancaria
- [ ] UI admin: pantalla "Crear evento" con asistente paso a paso

### Operaciones
- [ ] Inventario completo del parque hardware Paytef (cuántos PAX activos, baterías, fundas)
- [ ] Compra de hardware adicional si necesario: routers 4G Teltonika RUT241, SIM dual-operador
- [ ] Diseño del kit logístico por tamaño (ver [logistica.md](logistica.md))

---

## Semana 5-6 · Ticketing + consumiciones

### Producto
- [ ] Modelo wallet: saldo prepago vinculado a QR/email/teléfono
- [ ] Endpoint `POST /v1/wallets/topup` (recarga en taquilla o app)
- [ ] Endpoint `POST /v1/payments/wallet` (cobro contra saldo)
- [ ] TPV: nuevo modo "consumición" con descuento automático de wallet
- [ ] Web cliente: vista "mi saldo del evento" con QR fácil de mostrar al camarero
- [ ] Devolución de saldo no consumido post-evento (cashback en cuenta bancaria)

### Validación
- [ ] Tests E2E del flujo completo: compra ticket → recarga → consumir → devolución saldo
- [ ] Test de carga: 500 transacciones/minuto en simulación

---

## Semana 7-8 · TPV offline-first y app operador

### Producto
- [ ] TPV offline-first robusto: cola local cifrada (SQLite WASM) + sync diferencial
- [ ] Detección de duplicados en sync (idempotency keys)
- [ ] App operador en vivo (móvil del jefe de barra): ventas en tiempo real, top productos, ticket medio
- [ ] Alertas push: "Barra 3 sin actividad en 10 min", "Terminal 7 sin batería", "Pico de aforo"
- [ ] Chaos test: simular caída de WiFi durante 15 minutos → verificar 0 pérdidas

### Operaciones
- [ ] Procedimiento de configuración rápida de TPV (script automatizado: pairing + tenant + productos)
- [ ] Tiempo objetivo: configurar 15 terminales en menos de 45 minutos

---

## Semana 9-10 · Logística y procedimientos

### Operaciones
- [ ] Kit pre-montado y etiquetado: caja por tamaño de evento
- [ ] Checklist pre-evento (24h, 6h, 1h, durante, post) — ver [logistica.md](logistica.md)
- [ ] Plantilla de briefing al staff del cliente (PDF + video 10 min)
- [ ] Manual de operador in situ (qué hacer si: cae la red, batería baja, terminal congelado, cliente reclama)
- [ ] Contratación de 2 técnicos freelance para evento piloto (Madrid/Barcelona)
- [ ] Acuerdo con empresa de transporte de carga ligera para envío de kit

### Legal y seguros
- [ ] Firmar póliza RC profesional
- [ ] Cumplimiento RGPD para datos de asistentes (consentimiento, retención, derecho al olvido)
- [ ] Inscripción RETA / régimen fiscal correcto para facturación a promotoras
- [ ] Cláusulas anti-fraude en contrato (verificación bancaria del promotor antes de aceptar)

---

## Semana 11 · Evento piloto

### Pre-evento (7 días antes)
- [ ] Reunión final con promotor: plano, aforo, horarios, productos
- [ ] Subida de catálogo de productos a sistema
- [ ] Pruebas de conectividad in situ (visita técnica)
- [ ] Carga de tickets vendidos vía import CSV

### Día del evento
- [ ] Llegada técnicos 4h antes
- [ ] Despliegue y prueba de cada terminal
- [ ] Briefing staff del cliente 2h antes
- [ ] Operativa en vivo con monitor de dashboard
- [ ] Guardia 24/7 vía WhatsApp del cliente

### Post-evento (siguiente día)
- [ ] Cierre técnico y conciliación
- [ ] Informe completo en 6h
- [ ] Liquidación al promotor en 24h
- [ ] Retrospectiva interna: qué falló, qué hay que arreglar

---

## Semana 12 · Iteración y siguiente cliente

- [ ] Retrospectiva con el promotor del piloto (entrevista 1h)
- [ ] Caso de estudio escrito (con permiso del cliente) — PDF 2 páginas
- [ ] Aplicar mejoras al producto y a procedimientos
- [ ] Cerrar 2 eventos más para Q3
- [ ] Decidir contratación de tercer técnico fijo (o seguir con freelance)

---

## KPI de éxito del piloto

| Métrica | Objetivo |
|---|---|
| Uptime de pagos durante evento | ≥ 99,5% |
| Tiempo medio de transacción | ≤ 15 segundos |
| % devoluciones por error técnico | ≤ 0,5% |
| Liquidación al promotor | ≤ 24h post-cierre |
| Satisfacción promotor (NPS 1-10) | ≥ 8 |
| Satisfacción staff del cliente | ≥ 7 |
| Margen real del evento | ≥ 50% |

---

## Backlog post-piloto (Q3-Q4 2026)

- Integración pulseras RFID (Glownet-compatible para migración)
- Integración Eventbrite/Ticketmaster vía API oficial
- Módulo de control de aforo con conteo automático en entradas
- App de scan QR para personal de control de acceso
- Liquidación dividida en multi-promotor (festival con 3 promotoras)
- Modo "festival multi-día" con corte diario y liquidación parcial
- Cobertura satélite para festivales outdoor sin 4G
- Internacionalización (Portugal, Francia)
