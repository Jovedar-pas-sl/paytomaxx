# NightPay Lite — Pitch Deck

> 12 slides. Cada slide = una seccion. Disenadas para venta consultiva 1-a-1 en 30 min.
> Tono: directo, sin marketing-speak. El cliente es un manager con prisa.

---

## Slide 1 — Portada

# NightPay Lite

**TPV-as-a-Service para discotecas que ya tienen Paytef.**

Tu PAX cobra. Nosotros te damos todo lo demas.

[NOMBRE_PROSPECT] · [FECHA]

---

## Slide 2 — El problema

# Tienes Paytef y un PAX en barra. Y ahora ¿que?

Lo que te falta:

- Saber **en tiempo real** cuanto llevas vendido esta noche.
- Que tus camareros cobren en **5 segundos**, no en 25.
- Que el cliente pueda pagar **sin pasar por la cola**.
- Cerrar caja en **10 minutos**, no en una hora.
- **Refunds con doble factor** sin discusiones de barra.
- Reporting sin tener que llamar al banco al lunes.

Hoy lo haces con Excel, papel, o un sistema viejo que no se actualiza.

---

## Slide 3 — La solucion

# NightPay Lite

Una capa de software encima de tu Paytef actual. **No cambia nada de lo que ya funciona.**

3 productos en 1 suscripcion:

- **Web cliente** — QR en barra, paga en 15 s sin descargar app.
- **TPV camarero** — cobro contactless desde movil/tablet, mas rapido que tu sistema actual.
- **Panel admin** — metricas noche en tiempo real, refunds con TOTP, cuadre automatico.

Setup en **72 horas**. Permanencia 6 meses. Despues, 30 dias de aviso.

---

## Slide 4 — Por que ahora, por que nosotros

# No somos developers nuevos. Llevamos 8 sprints encima.

- **99 tests verdes** en backend (NestJS + Postgres + Redis + BullMQ).
- **Integracion Paytef real**: company `76861`, 50+ maquinas PAX activas.
- **Integracion Cecabank/Wipay** ya commit-merged (failover).
- **Multi-tenant con RLS** a nivel base de datos — tus datos solo los ves tu.
- **Backups cifrados** en Backblaze (UE). RGPD compliant.
- **Refresh tokens con rotacion + kill-switch** si pierdes un movil.

No te vendemos un MVP. Te vendemos un sistema que ya esta corriendo.

---

## Slide 5 — Como funciona una noche tipo

# Sabado, 23:30, sala llena

1. **Cliente entra**, llega a barra, ve cola.
2. **Escanea QR** en la barra con su movil — abre web cliente.
3. **Elige consumicion**, mete tarjeta NFC en el movil → autorizado en 6 s.
4. **Camarero recibe push** en su tablet: "Mesa 5 / Combinado / 12 €".
5. **Sirve sin preguntar precio**. Cliente ya pago.
6. **Manager ve en su movil**: 18.450 € vendidos hoy, 142 tickets, ticket medio 11,80 €.
7. **Lunes 12:00**: cierre cuadre automatico contra Paytef. Sin Excel.

Resultado: 30% mas velocidad de servicio. Cero discusiones de "yo no pague".

---

## Slide 6 — Arquitectura tecnica (1 minuto, para el CTO si lo hay)

# Que hay debajo

- **Backend**: NestJS 10 + Fastify + Prisma + Postgres 16 + Redis 7 + BullMQ.
- **Frontends**: Next.js 14 (cliente movil + TPV + admin).
- **Realtime**: Socket.io con Redis adapter (multi-nodo desde dia 1).
- **Pagos**: adapter pattern → Paytef + Cecabank/Wipay (failover Enterprise).
- **Estado de pago**: FSM XState (`CREATED → AUTHORIZING → AUTHORIZED / FAILED`).
- **Webhooks**: HMAC SHA-256 timing-safe + ventana anti-replay 5 min + idempotencia.
- **Observabilidad**: Prometheus metrics + Pino logs + Sentry frontends + Uptime Robot.
- **Hosting**: Hetzner CX22 (UE) + Cloudflare + Coolify.

No magia. **Stack aburrido y solido.**

---

## Slide 7 — Pricing

# 3 tiers, sin sorpresas

| | **Starter** | **Pro** | **Enterprise** |
|--|--|--|--|
| **Setup** | 800 € | **1.200 €** | 1.500 € + 500 €/sala |
| **Mensual** | 199 € | **279 €** | 349 € + 199 €/sala extra |
| **% volumen** | 0,5% | **0,4%** | 0,3% (o 0% comp. 12m) |
| **Terminales** | 2 | 5 | 10 |
| **SLA** | 24 h | 4 h | 2 h 24/7 fines |
| **Failover Cecabank** | — | — | ✓ |

**Recomendado para [NOMBRE_PROSPECT]: Pro.**
Volumen estimado: [TBD] €/noche × [TBD] noches = [TBD] €/mes.
Tu coste NightPay: 279 + (0,4% × [TBD]) = aprox **[TBD] €/mes total**.

---

## Slide 8 — Onboarding y plazos

# De firma a primera noche en 72 h

| Dia | Hito |
|-----|------|
| **D0** | Firma electronica + transferencia setup |
| **D+1 (martes)** | Provisionamos venue + alta camareros + credenciales Paytef |
| **D+2 (miercoles)** | Pruebas e2e en sandbox + ajustes ticket medio / categorias |
| **D+3 (jueves)** | Formacion presencial 2 h (manager + camareros) |
| **D+4 (viernes 19:00)** | **Primera noche en vivo** — tu equipo en sala, nosotros remoto on-call |
| **D+7 (lunes)** | Post-mortem 30 min + ajustes |
| **D+30** | Review primer mes + factura mensualidad mes 2 |

---

## Slide 9 — Que NO somos

# Honestidad antes que venta

- **No somos una pasarela.** Paytef cobra. Nosotros somos software encima.
- **No reemplazamos a tu gestoria.** Le mandamos los CSV cuadrados, ella factura.
- **No te subimos la comision bancaria.** La comision Paytef es la misma de siempre.
- **No es para restaurantes de mediodia.** Esto es ocio nocturno especifico.
- **No tenemos modulo de stock fisico.** Para eso ya tienes tu camara / albaranes.
- **No vendemos hardware.** Tu PAX ya esta, no te lo cambiamos.

Si lo que necesitas es otra cosa, te lo decimos sin venderte humo.

---

## Slide 10 — Riesgos y mitigaciones

# Lo que puede salir mal y como lo manejamos

| Riesgo que te preocupa | Como lo manejamos |
|------------------------|-------------------|
| **Os caeis un sabado a las 2 AM** | El Paytef sigue cobrando directo. Nuestra capa es admin + UX, no camino critico del cobro. SLA 2 h 24/7 fin de semana en Pro/Enterprise. |
| **Mis datos los ve alguien** | RLS Postgres + multi-tenant. Hosting UE. Backups cifrados. RGPD compliant. |
| **Me quedo atado** | Permanencia 6 m, luego 30 dias aviso. Export CSV completo al irte. |
| **Paytef cambia su API** | Lo arreglamos a nivel plataforma. Tu no tocas nada. |
| **El camarero rompe el movil** | Kill-switch por SMS / panel admin. Sesion revocada en <30 s. |
| **Chargeback gordo** | Audit log inmutable. Tienes la prueba ante el banco. |

---

## Slide 11 — Caso de uso real

# [PLACEHOLDER caso piloto]

> Cuando tengamos el primer cliente vivo (objetivo 2026-06-25), aqui aparece un
> resumen tipo:
>
> - **[NOMBRE_CLIENTE]**, sala de 800 pax en [CIUDAD].
> - **Antes**: 35 min cierre caja, sin reporting real, 3-4 chargebacks/mes
>   indefendibles.
> - **Despues de 30 dias NightPay Lite**:
>   - Cierre caja: 8 min.
>   - Tickets por camarero / hora: +28%.
>   - Chargebacks evitados con audit log: 2/2.
>   - ROI mes 1: positivo (mensualidad < ahorro de hora de manager).
>
> Mientras tanto, lo que **podemos ensenar ya** es la demo en
> `demo.nightpay.app` con datos sinteticos pero realistas.

---

## Slide 12 — Siguiente paso

# Lo que necesitamos de ti hoy

Si te encaja:

1. **Firma electronica** del contrato (te lo mando en 30 min).
2. **Transferencia setup** (1.200 € Pro) al IBAN del contrato.
3. **2 datos**: tu codigo Paytef company + serie PAX en barra principal.
4. **Fecha de primera noche** objetivo (mejor un viernes).

A partir de ahi, **el plazo lo marcamos nosotros**. Tu solo apareces el viernes
a las 19:00 para la formacion presencial.

---

> [TU_NOMBRE]
> NightPay
> [MOVIL] · ainhoanochesdeverano@gmail.com
> nightpay.app

> Gracias.
