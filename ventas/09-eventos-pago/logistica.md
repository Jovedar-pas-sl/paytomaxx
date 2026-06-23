# Logística — NightPay Events

> Documento operativo. Esta es la parte que la mitad de la competencia no ejecuta bien y donde está nuestro diferenciador real.

---

## Kit logístico por tamaño de evento

### Kit Pequeño (boda / evento privado <300 personas)

**Hardware:**
- 4 × Paytef PAX A920 (cargados al 100%)
- 4 × cargador USB-C de pared (1 backup adicional)
- 1 × router 4G Teltonika RUT241 con SIM Movistar + Vodafone
- 4 × funda anti-cerveza para PAX
- 1 × multi-puerto USB-C (powerbank 20.000 mAh)
- Cable de red Cat6 (5m, por si necesitamos WiFi de la sala)
- Etiquetas adhesivas con número de terminal (T01-T04)

**Documentación:**
- Hoja de configuración del evento (productos, precios)
- Briefing impreso para staff del cliente (2 páginas)
- Contacto técnico 24/7 (WhatsApp + teléfono)
- Lista de verificación firmada al entregar

**Personas:**
- 1 técnico durante el evento (turno máximo 10h)
- Vehículo: coche personal del técnico
- Dietas: 25 € comida + cena, sin alojamiento

**Caja física:** 1 maleta tipo Pelican 1510 (50 × 35 × 20 cm)

---

### Kit Mediano (festival sala / evento corporativo 300-3.000)

**Hardware:**
- 12-15 × Paytef PAX A920 (cargados al 100%)
- 15 × cargador USB-C de pared (3 backup)
- 2 × router 4G Teltonika RUT241 (uno principal + uno backup)
- 1 × repetidor WiFi mesh (TP-Link Deco X50 set de 3)
- 15 × funda anti-cerveza
- 3 × multi-puerto USB-C (powerbank 20.000 mAh)
- 2 × cable de red Cat6 (10m)
- Cinta americana, bridas, etiquetas
- 1 × monitor portátil 15" (para sala de control)

**Documentación:**
- Plano del evento con ubicación de cada terminal
- Configuración del evento + catálogo de productos
- Briefing al staff del cliente
- Manual de operador in situ (qué hacer si...)
- Listado de tickets vendidos (para check-in)

**Personas:**
- 2 técnicos durante el evento (turnos solapados, 12h cada uno)
- 1 vehículo (furgoneta pequeña o coche grande)
- Dietas + alojamiento si fuera de ciudad sede

**Caja física:** 2 maletas Pelican 1610 + 1 caja blanda con accesorios

---

### Kit Grande (festival 3k-10k)

**Hardware:**
- 25-40 × Paytef PAX A920 + 10% stock backup
- 40 × cargador + 10 backup
- 3-4 × router 4G + 2 backup
- 1 × repetidor WiFi mesh extensivo (6-9 puntos Deco)
- 1 × switch gigabit 16 puertos (para sala de control)
- 2 × monitor 24" (sala de control)
- 1 × portátil de operaciones in situ
- 5 × powerbank 30.000 mAh
- 2 × kit de herramientas técnico (alicates, destornilladores, multímetro)
- Fundas, cables, etiquetas, bridas, cinta americana en volumen

**Documentación:**
- Plano completo del evento + asignación por barra
- Pre-configuración por barra (no todas venden lo mismo)
- Manual de project manager
- Protocolo de escalado (qué hacer si falla algo: nivel 1 técnico, nivel 2 PM, nivel 3 CTO on-call)
- Checklist firmada en cada barra al desplegar y al recoger

**Personas:**
- 3-4 técnicos con turnos (24h efectivos cubiertos en evento de 1 día)
- 1 project manager dedicado (interlocutor único con cliente)
- 1 CTO/dueño on-call (no presencial pero localizable)
- 1 furgoneta de carga
- Alojamiento de hotel + dietas completas

**Caja física:** 4-5 maletas Pelican + 2 cajas grandes de transporte

---

### Kit Macro (>10.000 personas)

Caso por caso. Estructura base como Grande pero:
- Sala de control física dedicada in situ (no sala virtual)
- Tirada de fibra propia si es viable
- Conectividad satelital (Starlink) como backup
- Equipo 5-6 técnicos + PM + presencia del dueño
- Pre-evento técnico 48h antes (no solo 24h)
- Briefing completo con dirección del festival, no solo staff barra

---

## Checklist pre-evento (cronología)

### T-7 días (1 semana antes)

- [ ] Reunión final con promotor (1h): confirmar plano, aforo, horarios, productos
- [ ] Carga de catálogo de productos en sistema
- [ ] Carga de tickets vendidos (si aplica): import CSV/API
- [ ] Confirmación de personal técnico (turnos asignados con nombre y apellidos)
- [ ] Reserva de hotel y dietas para técnicos (si fuera de su ciudad)
- [ ] Verificación de stock hardware (todos los terminales cargados al 100%)
- [ ] Test de configuración en laboratorio con catálogo real
- [ ] Envío al promotor: plan de despliegue PDF, contacto técnico, plan de contingencia

### T-3 días

- [ ] Backup completo de configuración del evento
- [ ] Verificación de conectividad 4G en zona del evento (consulta cobertura operadores)
- [ ] Si zona conflictiva: solicitud de SIM adicional o roaming
- [ ] Briefing interno de equipo técnico (videocall 1h)

### T-24 horas

- [ ] Carga final de todos los terminales (al 100%)
- [ ] Preparación física del kit (cajas selladas con número de evento)
- [ ] Confirmación de transporte
- [ ] Llamada al promotor para confirmar todo
- [ ] Test final del sistema en laboratorio
- [ ] Carga de productos en TPV con previsualización

### T-6 horas (día del evento, antes de la apertura)

- [ ] Llegada de equipo técnico al lugar
- [ ] Reconocimiento de zona y puntos de instalación
- [ ] Instalación del router 4G principal en zona central
- [ ] Verificación de cobertura 4G en cada punto de barra
- [ ] Despliegue de terminal por terminal con etiquetado
- [ ] Test de transacción real (1 € pagado por el técnico) en cada terminal
- [ ] Configuración del repetidor WiFi mesh
- [ ] Arranque de sala de control + dashboard

### T-2 horas

- [ ] Briefing al staff del cliente (camareros, jefe de barra)
- [ ] Distribución de hojas de "cheatsheet" del TPV en cada barra
- [ ] Verificación de productos cargados con jefe de barra (corrección última hora si necesario)
- [ ] Confirmación de canal de comunicación WhatsApp con cliente
- [ ] Café/comida del equipo técnico antes de empezar

### T-30 minutos

- [ ] Última pasada de comprobación de cada terminal
- [ ] Verificación de saldo en pasarela bancaria
- [ ] Captura de pantalla del dashboard en "estado cero"
- [ ] Posicionamiento del project manager / técnico jefe en sala de control

---

## Durante el evento

### Cada 30 minutos

- [ ] Revisión del dashboard: ventas, alertas, terminales con problemas
- [ ] Patrulla física por las barras (técnico de turno)
- [ ] Verificación de batería de terminales (cambio si <30%)

### Cada hora

- [ ] Sincronización de cola offline (si la hubiera)
- [ ] Captura de snapshot del dashboard (para informe post-evento)
- [ ] Check de conectividad 4G + WiFi
- [ ] Comunicación con jefe de barra del cliente: "todo OK?"

### En caso de incidente

**Nivel 1 — terminal individual no responde:**
- Técnico in situ reemplaza con terminal backup en <3 minutos
- Reporte al project manager

**Nivel 2 — caída de conectividad:**
- TPV pasa a modo offline (automático)
- Técnico verifica router principal, si falla activa router backup
- Si ambos fallan, repetidor WiFi mesh redirige a WiFi de sala
- Reporte al project manager y al cliente

**Nivel 3 — fallo sistémico (DB, pasarela bancaria):**
- Project manager comunica al cliente + dueño on-call
- Activación de plan de contingencia escrita (en este caso, modo "solo efectivo" temporal con registro manual posterior)
- CTO/dueño se conecta remoto en <15 minutos

---

## Post-evento

### T+0 (cierre del evento)

- [ ] Anuncio en dashboard del cierre técnico del evento
- [ ] Cierre automático de cobros (programado a la hora pactada)
- [ ] Recogida física de terminales (mantener encendidos hasta confirmar sync)
- [ ] Verificación visual de cada terminal recogido (todos contabilizados)
- [ ] Foto del estado físico del kit antes de recoger (para reclamaciones de daños)

### T+6 horas

- [ ] Sincronización final de toda la cola offline
- [ ] Conciliación bancaria automática
- [ ] Verificación manual de discrepancias (si las hay)
- [ ] Informe preliminar al promotor (resumen 1 página vía WhatsApp/email)

### T+24 horas

- [ ] Informe completo en PDF: ventas por barra/hora/producto, ticket medio, top productos, distribución pago, picos
- [ ] Liquidación al promotor (transferencia bancaria iniciada)
- [ ] Email con informe + datos exportables (CSV, Excel)
- [ ] Devolución de saldo no consumido a asistentes (si aplica)

### T+7 días

- [ ] Entrevista de retrospectiva con el promotor (30-60 min)
- [ ] Encuesta NPS al staff del cliente
- [ ] Retrospectiva interna del equipo técnico: qué falló, qué arreglar
- [ ] Caso de estudio borrador (si autorizado)

### T+30 días

- [ ] Archivo de datos del evento en almacenamiento de largo plazo
- [ ] Mantenimiento físico del hardware (revisión, sustitución de baterías si necesario)
- [ ] Facturación final cerrada
- [ ] Si hubo incidentes: análisis raíz + actualización del manual

---

## Plantilla de informe post-evento (1 página resumen + anexo)

```
EVENTO: [Nombre del evento]
FECHA: [DD/MM/YYYY HH:MM - HH:MM]
PROMOTOR: [Nombre]
AFORO REAL: [X personas] (de [Y] esperadas)

═══════════════════════════════════════════════════════════
RESULTADOS DE COBRO
═══════════════════════════════════════════════════════════
Volumen total facturado:     XX.XXX,XX €
Número de transacciones:     X.XXX
Ticket medio:                XX,XX €
Tiempo medio transacción:    XX segundos
% pago QR / NFC / tarjeta:   XX% / XX% / XX%

═══════════════════════════════════════════════════════════
RENDIMIENTO TÉCNICO
═══════════════════════════════════════════════════════════
Uptime sistema:              XX,XX% (objetivo 99,9%)
Incidentes nivel 1:          X (resueltos en <3 min)
Incidentes nivel 2:          X (resueltos en <15 min)
Incidentes nivel 3:          X
% transacciones offline:     XX%
% transacciones reembolsadas: X,XX%

═══════════════════════════════════════════════════════════
TOP 5 PRODUCTOS POR BARRA
═══════════════════════════════════════════════════════════
[Tabla por barra]

═══════════════════════════════════════════════════════════
LIQUIDACIÓN AL PROMOTOR
═══════════════════════════════════════════════════════════
Bruto cobrado:               XX.XXX,XX €
Fees pasarela bancaria:      -XXX,XX €
Comisión NightPay (1,2%):    -XXX,XX €
Neto a transferir:           XX.XXX,XX €
Fecha valor transferencia:   [DD/MM/YYYY antes de 24h]
═══════════════════════════════════════════════════════════
```
