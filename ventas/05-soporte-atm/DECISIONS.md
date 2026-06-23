# DECISIONS — Decisiones de producto y operación

Decisiones documentadas con razonamiento explícito. Si el contexto cambia, se revisan; no se reescribe la historia.

---

## D1. Modelo de técnicos físicos: subcontrata, no plantilla

**Decisión:** los técnicos presenciales son **autónomos contratados por intervención**, no empleados en nómina.

**Razonamiento:**
- Volumen al inicio insuficiente para cubrir salario fijo. Una zona puede tener 2-5 incidencias presenciales / mes en fase de arranque; eso no sostiene un sueldo de 1.800€ netos + costes.
- Flexibilidad de cobertura geográfica: técnico en cada provincia sin asumir coste fijo.
- Sector vending / recreativas / ATM en España tiene ya tradición de freelance. La oferta existe.

**Riesgo asumido:**
- Disponibilidad del técnico no garantizada al 100%. → Mitigación: dos técnicos por zona principal, con compensación al "de guardia" (small retainer 50-100€/mes por compromiso de respuesta).
- Calidad heterogénea. → Mitigación: protocolo escrito, foto/vídeo antes-después obligatorio, scoring por intervención, revisión trimestral.

**Revisión:** cuando una zona supera 15 intervenciones/mes sostenidas durante 3 meses, evaluamos pasar a técnico en exclusiva con retainer alto o contrato laboral fijo discontinuo.

---

## D2. SLAs prometidos: realistas, no marketing

**Decisión:** los SLAs publicados (4h Básico, 1h Estándar, 15 min Premium) son **conservadores y cumplibles**, no aspiracionales.

**Razonamiento:**
- Romper SLA cuesta dinero (cláusula de penalización en contrato).
- Sobre-prometer es la forma más rápida de perder credibilidad en B2B técnico.
- Premium con 15 min 24/7 solo se vende cuando hay **guardia humana real** con turno rotatorio. Antes de tener guardia, no se ofrece Premium.

**Métrica interna de control:**
- SLA cumplido en > 95% de tickets en cada tier. Si baja a 90%, alarma operativa.
- Los SLA cuentan desde **primer mensaje del encargado del local** hasta **primer mensaje útil del soporte** (no acuse de recibo automático).

**Lo que NO contamos como tiempo de respuesta:**
- Tiempo en que el encargado del local no responde a nuestra pregunta de aclaración (pausa el reloj).
- Ventanas de mantenimiento previamente anunciadas.

---

## D3. Cómo medimos uptime

**Decisión:** uptime se mide **a nivel de máquina, no de servicio nuestro**, y de forma **observada, no inferida**.

**Razonamiento:**
- Lo que le importa al cliente es: "¿estaba mi cajero operativo o no?"
- Métrica honesta = horas operativas / horas totales del mes, descontando ventanas de mantenimiento preventivo planificado.

**Cómo recogemos el dato:**
- Idealmente: monitorización activa (ping al cajero + estado del software). Roadmap Q4 (integración con plataforma del fabricante o agente propio).
- Mientras tanto: **uptime declarado por la flota** = incidencias registradas en el sistema con timestamp de apertura y cierre, asumiendo que entre cierre e siguiente apertura la máquina estuvo operativa salvo aviso contrario del local.
- Este método es **transparente con el cliente** desde el primer día. No vendemos "99,9% uptime" que no sabemos medir.

**Lo que reportamos:**
- Disponibilidad observada (basada en incidencias resueltas).
- Lista de incidencias del mes con duración.
- Máquinas con más de N incidencias en el mes → flagged para revisión preventiva.

---

## D4. Qué excluimos del retainer (explícito en contrato)

**Decisión:** las siguientes situaciones **NO están cubiertas** y se facturan aparte con presupuesto previo:

| Categoría                                          | Tratamiento                                |
|----------------------------------------------------|--------------------------------------------|
| Vandalismo, golpes, líquidos derramados, sabotaje  | Presupuesto aparte. Coordinamos con seguro del cliente. |
| Daños por sobretensión, rayos, fallo eléctrico     | Presupuesto aparte.                        |
| Robo del cajero o de su contenido                  | No es nuestro alcance. Coordinamos con CRA/seguro. |
| Reposición de efectivo / cash handling             | No lo hacemos. Coordinamos con Loomis/Prosegur. |
| Conectividad del local (router, fibra, switch)     | Diagnosticamos; reparación no incluida.    |
| Disputa con consumidor final del operador          | Aportamos logs y evidencias; decisión comercial del operador. |
| Soporte de marcas / modelos no en `marcas-soportadas.md` | No cubierto.                          |
| Piezas mayores (módulo dispensador, aceptador, mainboard) | Presupuesto previo. Markup 10% sobre coste. |
| Cambio físico del cajero a otra ubicación          | Presupuesto aparte.                        |
| Adaptaciones para nueva normativa (PCI, KYC, etc.) | Consultoría aparte; no es soporte técnico. |

**Razonamiento:**
- Definir exclusiones evita conflictos en mes 3 cuando llega la primera situación gris.
- Las exclusiones **se mencionan explícitamente en discovery**, no en letra pequeña.

---

## D5. Stack tecnológico: nada propietario nuevo si existe alternativa madura

**Decisión:** reutilizamos al máximo `manual_browser`, `whatsapp_analyzer`, Evolution API, Chatwoot, Anthropic. Solo construimos lo que no existe.

**Razonamiento:**
- Tiempo a mercado es la única ventaja real frente a competidores grandes.
- Mantener un stack reducido y conocido (Flask + JSON + Anthropic + Chatwoot) facilita que un solo desarrollador lo opere.
- Cuando el ARR justifique reescribir, se reescribe (no antes).

**No vamos a construir todavía:**
- Plataforma multitenant SaaS pública.
- App móvil propia para técnicos (Telegram bot + Google Forms es suficiente en fase 1).
- Sistema de monitorización IoT con sensores físicos (espera hasta tener 200+ máquinas).

**Sí vamos a construir Q3:**
- Dashboard cliente con login.
- Generación automática de informe mensual PDF.
- Integración Stripe/GoCardless para facturación recurrente.

---

## D6. Política de IA: asistida, no autónoma

**Decisión:** la IA **propone respuesta** al técnico, pero **el técnico la valida antes de enviarla al cliente** durante los primeros 6 meses.

**Razonamiento:**
- Una respuesta errónea de IA en un cajero con cash dentro puede causar: pérdida de efectivo, atasco peor, escalado a una intervención cara.
- El sector financiero tiene tolerancia cero a errores. Más vale ser un poco más lento y correcto.
- Pasados 6 meses con dataset propio de tickets, evaluamos auto-respuesta para casos clasificados de baja complejidad (reset, papel, instrucciones operativas básicas).

**Métrica de control:**
- % de respuestas IA modificadas por técnico antes de enviar.
- Si baja sostenidamente por debajo de 15%, ese tipo de pregunta puede pasar a auto-respuesta.

---

## D7. Datos del cliente: minimizar, contractualizar, auditar

**Decisión:**
- Nunca exportamos masivamente datos transaccionales del cliente.
- Acceso a logs **solo al abrir incidencia**, con justificación registrada.
- NDA en todo contrato.
- Acuerdo de tratamiento de datos según RGPD/LOPDGDD (somos encargados del tratamiento; el operador es responsable).

**Razonamiento:**
- El sector tiene paranoia legítima sobre datos financieros y de transacciones.
- Vender "transparencia y control" es diferenciador real frente a soporte tradicional opaco.
- Cumplir RGPD es obligación legal; mejor hacerlo bien desde día 0 que arreglarlo después.

**Auditable:**
- Log de accesos a logs del cliente (sí, meta-logs).
- Borrado en plazo legal contado desde cierre de incidencia.
- Cliente puede pedir export y borrado en cualquier momento.

---

## D8. Geografía de cobertura: España peninsular + Baleares fase 1

**Decisión:** fase 1 cubre **España peninsular y Baleares**. Canarias, Ceuta y Melilla **excluidos** del SLA presencial; remoto sí cubierto al precio estándar.

**Razonamiento:**
- Logística de técnicos en Canarias es otro juego (vuelo, ferry, tiempo).
- Volumen insuficiente para sostener técnico local en archipiélago al inicio.
- Decisión revisada cuando entre primer cliente con flota significativa fuera de península.

**Zona principal** (SLA presencial pleno): provincias con técnico subcontratado en < 2h de desplazamiento.
**Zona secundaria**: resto de la península, SLA presencial relajado (24-48h adicionales) o desplazamiento facturable.

---

## D9. Pricing: psicológico + sostenible, no el más barato

**Decisión:** **39 / 55 / 69** son precios elegidos por:

- Mantenerse claramente por debajo del precio fabricante (Wincor cobra ~120€/mes/máquina con SLA real).
- Posicionarse claramente por encima de freelance puntual (que no cubre SLA).
- Permitir un margen bruto que cubra técnicos subcontratados y stack tecnológico.
- Aritmética clara: 10 máquinas a 39€ son 390€/mes; 50 máquinas a 55€ son 2.750€/mes. Cifras que el operador entiende sin calculadora.

**No bajamos de 39€** en tier Básico. Si el cliente regatea más, se ofrece **discount de fundador** (10-15%) bloqueado 24 meses, no rebaja permanente del precio público.

---

## D10. Cuándo cerramos el negocio (señales de salida)

**Decisión:** lo cerramos honestamente si en 12 meses no se cumple:

- ≥ 20 máquinas bajo contrato con SLA real.
- MRR ≥ 1.000 €/mes sostenido 3 meses consecutivos.
- NPS interno (medido a clientes) ≥ 30.
- Margen bruto positivo (no contamos hora del fundador en este cálculo).

Si esto no ocurre, el modelo no funciona y se reorienta o se cierra sin acumular deuda técnica ni clientes mal servidos.

**Pivot posible si falla:** licencia del software (`manual_browser` + `whatsapp_analyzer`) a redes ATM grandes como herramienta interna, en lugar de retainer.
