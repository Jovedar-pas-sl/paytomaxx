# Soporte ATM-as-a-Service

> Retainer mensual de soporte técnico para operadores de cajeros automáticos independientes.
> IA sobre manuales técnicos digitalizados + análisis de logs + ticketing por WhatsApp + intervención presencial bajo SLA.

---

## 1. Qué es

Servicio gestionado de soporte para operadores con **flota propia de cajeros** (cash-in-shop, redes ATM privados, gasolineras, ocio nocturno, hostelería) que no tienen contrato con el fabricante o quieren reducir el coste y el tiempo de respuesta del soporte actual.

Cubrimos las marcas y modelos para los que tenemos manuales y know-how digitalizado. Hoy: **Fujitsu F53 con biblioteca técnica completa indexada por IA**. Roadmap de ampliación a Wincor Nixdorf, NCR, Diebold y GRG (ver `marcas-soportadas.md`).

---

## 2. Qué entrega el servicio

### 2.1 Soporte L1/L2 remoto 24/7

- **Búsqueda IA en manuales técnicos** (Flask + Anthropic) sobre biblioteca digitalizada del fabricante. Tiempo medio de respuesta a una consulta: < 60 segundos.
- **Análisis de logs** del cajero (errores de dispensador, atascos, lectores QR, módulos pinpad, comunicación TPV) con interpretación humana asistida.
- **Canal WhatsApp Business** integrado a Evolution API + Chatwoot. El encargado del local manda foto/audio/vídeo del fallo y el sistema abre ticket automáticamente.
- **Resolución asistida** por chat / videollamada: el técnico remoto guía al encargado para reset, recarga, reposicionado, limpieza de cabezales, sustitución de billetes atascados, etc.

### 2.2 Intervención presencial

- Red de **técnicos subcontratados** con cobertura nacional (España peninsular y Baleares en fase 1).
- Despacho bajo SLA del tier contratado.
- Reposición de consumibles (papel, tinta) y componentes de bajo coste incluida en horas de visita; piezas mayores facturadas aparte con presupuesto previo.

### 2.3 Gestión y reporting

- **Dashboard cliente** con estado por máquina, histórico de incidencias, próximas mantenciones preventivas (heredado del módulo `manual_browser`).
- **Inventario digital** de máquinas, componentes, números de serie, IPs locales, tcods Paytef/TPV.
- **Informe mensual** de incidencias resueltas, tiempo medio de respuesta y disponibilidad.
- **Mantenimiento preventivo** programado (no incluido en tier Básico).

---

## 3. Tiers y SLAs

| Tier        | Precio / máq / mes | SLA respuesta L1 (remoto) | SLA presencial         | Horario      | Mantenimiento preventivo | Reporting           |
|-------------|--------------------|---------------------------|------------------------|--------------|--------------------------|---------------------|
| **Básico**  | 39 €               | 4h laborables             | 48h laborables         | L-V 09-18h   | No                       | Mensual básico      |
| **Estándar**| 55 €               | 1h en horario / 4h fuera  | 24h                    | L-D 08-22h   | Anual                    | Mensual + KPIs      |
| **Premium** | 69 €               | 15 min 24/7               | 8h en zona principal\* | 24/7         | Semestral                | Semanal + dashboard |

\* Zona principal: provincias con técnico subcontratado en menos de 2h de desplazamiento. Resto de provincias: 24h.

**Intervención presencial fuera de SLA:** 120 €/intervención (incluye 1h de trabajo + desplazamiento estándar). Hora adicional: 45 €. Kilometraje fuera de zona principal: 0,40 €/km.

**Mínimos:** paquetes desde 10 máquinas en contrato Básico, desde 5 en Estándar/Premium.

Detalle comercial completo en `SALES.md`.

---

## 4. Casos cubiertos por IA vs presencial

### 4.1 Resoluble en remoto (IA + chat / videollamada con encargado del local)

- Reset de software, reinicio servicios, reconexión TPV.
- Diagnóstico de errores reportados por pantalla (códigos Fujitsu F53 documentados en manual).
- Atascos de billetes accesibles (con guía paso a paso al encargado).
- Reposición/cambio de rollo de papel del impresor.
- Configuración de red, IP, pinpad, Paytef.
- Falta de "banderas" / flags, problemas de comunicación con backoffice.
- Discrepancias de saldo, conciliación con logs y registros de dispensación.
- Conciliación con Loomis / proveedor de cash handling.

### 4.2 Requiere intervención presencial

- Fallos físicos del dispensador (rodillos, sensores, módulo de stacker).
- Sustitución de pinpad, lector NFC, lector QR, impresora.
- Atascos en zonas no accesibles para el encargado.
- Limpieza profunda de cabezales y módulos de aceptación.
- Instalación, traslado o desinstalación de máquina.
- Vandalismo, daños físicos por golpes o líquidos (presupuesto aparte, **no incluido** en retainer).
- Auditoría física tras discrepancia financiera grande.

---

## 5. Lo que NO cubre el retainer

Decisiones detalladas en `DECISIONS.md`. Resumen:

- **Vandalismo, robo, daños por accidente o terceros.** Presupuesto aparte.
- **Reposición de efectivo / cash handling.** Coordinamos con Loomis pero no lo ejecutamos.
- **Disputas con clientes finales del operador** (consumidor que reclama). Asistimos con logs; el operador asume la decisión comercial.
- **Soporte de marcas no contempladas** (ver `marcas-soportadas.md`).
- **Conectividad del local** (router, fibra, switch). Diagnóstico sí; reparación de la red, no.
- **Piezas mayores** (módulo dispensador completo, módulo aceptador, mainboard). Presupuesto previo; no incluido.

---

## 6. Stack técnico operativo

- **Manual browser** (`manual_browser/app.py`, puerto 8889): Flask + Anthropic Claude, búsqueda IA en manuales PDF indexados, gestión de inventario, registro de incidencias, generación de informes.
- **Evolution API** (puerto 8080): canal WhatsApp Business.
- **Chatwoot** (puerto 3000): ticketing multicanal.
- **WhatsApp analyzer** (`whatsapp_analyzer/`): pipeline de análisis de conversaciones con contexto técnico Fujitsu F53 pre-cargado.
- **Inventario** (`shared_db.json`): 50+ máquinas reales en producción.

---

## 7. Próximos pasos

- Comercial: ver `SALES.md`, `pitch.md`, `landing/index.html`.
- Migración del operador actual a contrato formal: ver `PRIMER_CLIENTE.md`.
- Plan 30 días: ver `ROADMAP.md`.
- Marcas y modelos soportados: ver `marcas-soportadas.md`.
- Decisiones de producto y operativas: ver `DECISIONS.md`.
