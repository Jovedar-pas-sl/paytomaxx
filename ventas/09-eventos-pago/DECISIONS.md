# Decisiones — NightPay Events

> Registro de decisiones clave (ADR-style). Cada decisión incluye contexto, alternativas, decisión tomada y razonamiento.

---

## DEC-001 · Pulsera RFID propia vs QR vs ambas

**Contexto:**
Los competidores (Glownet, Weezevent) basan su sistema en pulsera RFID propia. Es la norma en festivales internacionales grandes. NightPay nace QR/NFC móvil.

**Alternativas evaluadas:**
1. **Solo QR/NFC móvil** — más barato, sin inventario, depende del móvil del cliente
2. **RFID propio** — control total, pero inversión inicial (50-100k € de stock), logística devolución, fabricación
3. **QR principal + RFID opcional integrado con proveedor existente** — flexibilidad, no asumimos coste de fabricación

**Decisión:** Empezamos con **QR/NFC móvil como producto principal**. Añadimos compatibilidad con pulseras RFID en Q3-2026 vía integración con proveedor existente (ej. Intellitix, Connecthings), no fabricación propia.

**Razonamiento:**
- 95% de asistentes a eventos ES tienen smartphone con NFC
- Pulsera RFID es estándar pero NO es requisito en bodas, eventos privados, festivales <5k
- Inversión inicial en stock RFID destruiría margen del primer año
- Compatibilidad vía proveedor nos da opcionalidad sin riesgo de inventario
- Si un cliente grande lo exige, podemos alquilarlas como passthrough

**Revisión:** Q3-2026, tras 5 eventos ejecutados.

---

## DEC-002 · Conectividad redundante (4G + WiFi + offline)

**Contexto:**
La fiabilidad de cobro durante el evento es el punto crítico. Una caída de 5 minutos en hora punta = pérdida de 5-10k € y daño reputacional.

**Alternativas evaluadas:**
1. **Solo WiFi de la sala** — barato pero punto único de fallo
2. **4G dedicado** — bueno pero zonas indoor con mala cobertura
3. **Triple capa: 4G dual-SIM + WiFi mesh propio + cola offline en TPV** — robusto pero más coste

**Decisión:** **Triple capa siempre**, sin excepciones.
- Router 4G Teltonika RUT241 con SIM Movistar + SIM Vodafone (failover automático)
- Repetidor WiFi mesh propio en eventos grandes (no dependemos de WiFi de la sala)
- Cola offline cifrada en cada TPV (SQLite WASM), sync diferencial al reconectar

**Razonamiento:**
- Coste adicional del kit (~150 €/evento) es nada vs riesgo reputacional de un fallo
- Garantiza SLA 99,9% contractual sin asustarnos
- Diferenciador real vs competencia que depende del WiFi de la sala

**Revisión:** evaluar coste por evento tras 10 ejecutados.

---

## DEC-003 · Soporte presencial — cuántos técnicos por evento

**Contexto:**
Soporte presencial es diferenciador clave vs Glownet/Weezevent. Pero técnicos cuestan dinero y son recurso escaso.

**Decisión:** Estructura por tamaño:

| Tamaño | Aforo | Técnicos | Turnos |
|---|---|---|---|
| Pequeño | <300 | 1 técnico | 8h cubriendo evento + 1h post |
| Mediano | 300-3000 | 2 técnicos | turnos solapados cubriendo 12h + 2h post |
| Grande | 3000-10000 | 3-4 técnicos + project manager | turnos 24h + sala control |
| Macro | 10000+ | 5-6 técnicos + PM + escalado a CTO on-call | 24/7 con sala control física in situ |

**Razonamiento:**
- Mínimo 1 técnico siempre — sin presencia no hay diferenciación
- Solapamiento de turnos en medianos evita ventana sin cobertura en cambio de turno
- En grandes/macro, project manager es figura de interlocución con promotor (técnicos no deben hablar con cliente final)
- Estructura escalable: el segundo y tercer técnico pueden ser freelance pre-validados, no fijos

**Implicación operativa:**
- Necesitamos pool de 6-8 técnicos freelance pre-validados en Madrid + Barcelona
- Salario base técnico fijo: 1.800-2.200 €/mes (interno)
- Tarifa freelance/evento: 250 €/día técnico junior, 400 €/día senior

**Revisión:** ajustar tras experiencia real en 5 eventos.

---

## DEC-004 · Partnerships con promotoras locales

**Contexto:**
Adquisición de clientes 1-a-1 es lenta y cara. Una promotora con red de eventos puede traer 5-15 eventos/año.

**Alternativas:**
1. **Solo venta directa** — control total, margen completo, crecimiento lento
2. **Reventa con margen para promotor** — escalado rápido, perdemos margen y control
3. **Referral con comisión** — promotor refiere a cambio de comisión, mantenemos relación con cliente final

**Decisión:** **Modelo referral exclusivamente.**
- 10% del setup + 0,2% del volumen los primeros 12 meses por evento referido
- Contrato directo nuestro con cliente final (factura directa)
- Promotor cobra comisión mensual diferida
- Exclusividad geográfica limitada (6 meses, ciudad)

**Razonamiento:**
- Reventa con margen rompe nuestra posición de precio agresivo
- Referral mantiene relación directa con cliente final (cross-sell futuro)
- Comisión recurrente alinea incentivos del promotor a largo plazo
- Exclusividad geográfica corta nos protege sin frenar crecimiento

**No firmamos partnership con:**
- Promotores que organizan eventos sin permisos legales
- Promotores con historial de impago a proveedores
- Promotores que exigen reventa con margen propio
- Promotores que compitan directamente con un evento que ya nos refirió un partner en la misma ciudad y mes

**Revisión:** tras primeros 3 partnerships firmados, ajustar % comisión si necesario.

---

## DEC-005 · Pasarela bancaria — Wipay/Cecabank vs alternativas

**Contexto:**
Necesitamos pasarela que funcione bien para eventos: alto volumen concentrado en pocas horas, contracargos bajos, liquidación rápida.

**Alternativas:**
1. **Stripe / Adyen** — internacionales, fees 2,5-3% + FX si EUR, soporte EN, liquidación 2-7 días
2. **Wipay (Cecabank)** — española, fees 1,2-1,8%, soporte ES, liquidación T+1
3. **Redsys** — la pasarela bancaria histórica española, fees variables

**Decisión:** **Wipay/Cecabank como pasarela principal** + Redsys como fallback en eventos grandes.

**Razonamiento:**
- Fees significativamente menores que Stripe/Adyen (margen real)
- Liquidación T+1 = podemos cumplir nuestra promesa 24h al promotor
- Soporte español en horario español (Stripe no abre fin de semana)
- Sin FX (somos €→€), Stripe cobraría conversión aunque sea misma divisa
- Cecabank es banco español, no dependemos de regulación irlandesa (Stripe)

**Riesgo asumido:**
- Wipay tiene menos features que Stripe (no Apple Pay nativo en algunos flujos, sin Klarna)
- Para eventos no necesitamos esos features

**Revisión:** anual o si Wipay sube precios/cambia condiciones.

---

## DEC-006 · Modelo de datos del evento — efímero vs permanente

**Contexto:**
NightPay diaria opera con tenants permanentes (sala X, sala Y). Evento es tenant temporal.

**Alternativas:**
1. **Mismo tenant + flag "is_event"** — sencillo pero contamina queries normales
2. **Tenant separado por evento** — aislamiento total pero crea muchos tenants efímeros en DB
3. **Sub-tenant dentro del tenant promotor** — herencia de configuración, aislamiento dentro de promotor

**Decisión:** **Sub-tenant dentro del tenant promotor**, con cierre automático y archivado tras 12 meses.

**Razonamiento:**
- Heredan productos, catálogo y configuración del promotor → setup rápido
- Aislamiento de transacciones (queries del evento no contaminan operativa diaria)
- RLS funciona bien con `event_id` adicional al `tenant_id`
- Archivado a S3 tras 12 meses cumple obligación contable + reduce coste DB

**Implementación:**
- Nueva tabla `event` con FK a `tenant`
- Todas las tablas operativas (payment, refund, audit_log) ganan columna `event_id NULL`
- Jobs de cierre y liquidación parametrizados por `event_id`

---

## DEC-007 · Cobertura legal y seguros

**Contexto:**
Eventos = público, contratos con promotoras, dinero contado. Necesitamos cobertura legal sólida.

**Decisión:**
- **Póliza RC profesional Mapfre** — 600.000 € de cobertura por reclamación, 1,2 M€ agregado anual
- **Contrato marco con cláusula SLA + penalización** — uptime <99% durante evento = penalización proporcional
- **Cláusula fuerza mayor** — alerta sanitaria, prohibición administrativa → reembolso 100%
- **Cumplimiento RGPD** — datos asistentes anonimizados tras 90 días si no hay reclamación
- **Inscripción RETA** + sociedad limitada para facturación a promotoras grandes

**Razonamiento:**
- Sin seguro, un fallo grande nos puede cerrar la empresa
- Cláusula penalización en SLA da confianza al cliente pero limitada a valor del evento
- RGPD: los datos del asistente NO son nuestros, son del promotor, somos encargado de tratamiento

---

## Decisiones pendientes (a tomar antes del piloto)

- **DEC-008** · Política de devoluciones de saldo no consumido (cashback automático a tarjeta vs solicitud manual)
- **DEC-009** · Soporte multi-idioma en TPV (catalán, euskera, valenciano) — ¿lo hacemos en v1 o esperamos?
- **DEC-010** · Estrategia de precio dinámico (% volumen variable según día de la semana / temporada alta)
- **DEC-011** · Integración con plataformas de ticketing externas (Eventbrite, Ticketmaster, Fever) — ¿API oficial o solo CSV?
