# Pitch deck — NightPay RevShare (10-12 slides)

> Deck en markdown, foco financiero. Estructurado para conversion a Keynote /
> Slides en <30 min con un template editorial. Cada slide tiene **(visual)**,
> **(texto)**, y **(speaker notes)**.

---

## Slide 1 — Portada

**(visual)**
Foto de discoteca al maximo aforo, gente cobrando con movil en la barra. Logo
NightPay arriba izquierda. Tagline central:

**"Software de caja para discotecas. Pagas solo si cobras."**

Subtitulo pequeño abajo: *Modelo Revenue Share — 0,8-1,5 % por transaccion. Cero coste fijo.*

**(speaker)**
"Voy a explicar en 8 minutos por que tiene sentido cobrar QR en tu sala con
nuestro sistema sin pagar ni un euro hasta que tu primer cliente lo use."

---

## Slide 2 — El problema en una frase

**(visual)** Una sola linea de texto grande, centrada:

> **"Tu PAX cobra. Tu caja vieja no te dice nada. Tu cliente espera en la cola
> para pagar. Y nadie te ofrece software sin pedirte 200 € al mes por adelantado."**

**(speaker)**
"Este es el problema real que escuchamos en 30+ locales. Tienes Paytef funcionando.
Tu caja vieja no te da metricas. Tus clientes esperan. Y cualquier solucion
software te exige pagar fijo desde el dia 1 sin saber si te va a aportar."

---

## Slide 3 — La oferta

**(visual)** Tres columnas grandes:

| Setup | Mensualidad | Por transaccion QR |
|-------|-------------|--------------------|
| **0 €** | **0 €** | **1,0 % + 0,10 €** |

Abajo: *Cancelas con 30 dias. Sin permanencia mas alla de 3 meses iniciales.*

**(speaker)**
"Cero coste de entrada. Cero coste mensual. Solo me pagas el 1 % de cada cobro
QR que el sistema procese. Si una semana no operas, no pagas nada esa semana. Es
literalmente el modelo Stripe aplicado a software de caja para ocio nocturno."

---

## Slide 4 — Por que es seguro para ti

**(visual)** Diagrama de flujo:

```
[Cliente] → paga QR → [Paytef] → liquida T+1 → [TU cuenta]
                                                    |
                            (fin de mes)            |
                                                    v
                  [Factura RevShare 1 %] ← [Auditas vs Paytef]
```

Texto debajo: *El dinero NUNCA pasa por nuestras manos. Cobra Paytef, te liquida
a ti. Solo te facturamos comision al final de mes con cada transaccion cruzada
contra tu propio Paytef.*

**(speaker)**
"El punto clave: nosotros no manipulamos tu dinero. Tu cliente paga, Paytef te
liquida a ti, y nosotros te emitimos factura al final de mes sobre el log de
transacciones. Cada linea de nuestra factura lleva el codigo de autorizacion de
Paytef. Puedes auditar nuestro cobro contra tu propio backoffice. Si hay
diferencia, no se factura."

---

## Slide 5 — Tu break-even financiero

**(visual)** Grafica de barras o tabla:

| Volumen QR/mes | Coste NightPay RevShare | Coste SaaS competencia | Diferencia |
|----------------|--------------------------|------------------------|------------|
| 10.000 €       | ~210 €                   | ~265 €                 | **+55 € ahorras** |
| 30.000 €       | ~540 €                   | ~265 €                 | -275 € |
| 60.000 €       | ~960 €                   | ~265 €                 | -695 € |

Texto debajo: *Si haces menos de ~12.000 €/mes en QR, NightPay RevShare es **mas
barato** que SaaS fijo. Si haces mas, sigues sin pagar capex y mantienes flexibilidad
absoluta para cortar.*

**(speaker)**
"Mira los numeros frios. Si tu sala procesa menos de 12.000 €/mes en QR, RevShare
te sale mas barato que un SaaS. Si procesas mas, sigues teniendo cero riesgo
financiero, cero permanencia larga, y cero capex de entrada. Tu eliges en que
punto cambiar a SaaS si te conviene."

---

## Slide 6 — Que te llevas

**(visual)** Mockup de 3 pantallas: TPV camarero, web cliente con QR, admin tiempo real.

Lista bajo:

- TPV camarero (Next.js, tablet o telefono) — cobro en 1 click
- Web cliente QR — tu cliente paga desde su movil en <15 s
- Admin tiempo real — ventas de la noche, refunds, top productos, propinas
- Webhooks Paytef ya cableados a tu cuenta
- Ticket Verifactu-ready (cumple RD 1007/2023)
- Backup multitenant, RLS por venue, datos solo tuyos

**(speaker)**
"Todo esto en 72 horas desde firma. No hay desarrollo custom. El sistema lleva
50+ PAX activos. Tu eres el siguiente."

---

## Slide 7 — Como te facturamos cada mes

**(visual)** Ejemplo factura PDF mockup con linea-a-linea:

```
NightPay S.L. — Factura RevShare
Periodo: 1 - 31 mayo 2026
Cliente: Sala Atlantis (v_001)

Detalle de transacciones procesadas:
  N° Tickets: 3.124
  Volumen procesado: 47.560,00 €
  Comision 1,0 %: 475,60 €
  Fee fijo (3.124 x 0,10): 312,40 €
                          ----------
  Total servicios: 788,00 €
  IVA 21 %: 165,48 €
                          ----------
  TOTAL FACTURA: 953,48 €

Adjunto: detalle_transacciones_mayo2026.csv (3.124 lineas con paytefAuthCode)
```

**(speaker)**
"Dia 1 de cada mes recibes esta factura con CSV adjunto. Cada linea es una
transaccion con codigo Paytef. Puedes cruzar y validar antes de pagar. Pagas por
SEPA o transferencia a 15 dias."

---

## Slide 8 — Que pasa si yo desaparezco / tu cierras / tu sistema falla

**(visual)** Tres iconos con respuesta breve:

| Si... | Pasa que... |
|-------|-------------|
| **Yo desaparezco** | Tu PAX sigue cobrando. Tienes export completo de datos. Codigo en escrow opcional. |
| **Tu cierras** | No hay factura. Cero deuda futura. Cero penalizacion. |
| **Sistema cae >2 h** | Abono SLA: 100 % de la comision del mes en credito. |

**(speaker)**
"Las tres preguntas mas comunes en la sala. Las respondemos por contrato, no
por buena fe. Si me caigo, tu sigues operando porque Paytef es independiente. Si
tu cierras, no me debes nada. Si yo te fallo mas de 2 h en horario de operacion,
te abono el equivalente al 100 % del mes."

---

## Slide 9 — Tracking y transparencia

**(visual)** Screenshot del dashboard `/admin/billing` con tabla de meses y
boton "Auditar contra Paytef".

Texto: *Cada euro que te facturo lleva su codigo de autorizacion Paytef. Cero
opacidad. Auditoria abierta 24/7.*

**(speaker)**
"Esto es lo que ves en tu panel. No tienes que pelearte conmigo a fin de mes
para saber cuanto debes. Tu panel te lo dice antes que mi factura. Es la
diferencia con el resto del mercado."

---

## Slide 10 — Las 3 estructuras

**(visual)** Tabla limpia:

| Plan       | Coste / tx       | Ideal para               | Soporte         |
|------------|------------------|--------------------------|-----------------|
| Premium    | 1,5 % + 0,10 €   | <30k €/mes, soporte alto | Telefono + presencial |
| **Estandar**| **1,0 % + 0,10 €** | **20-80k €/mes**       | Email <48 h    |
| High-Volume| 0,8 % + 0,08 €   | >100k €/mes compromiso   | Email + Slack <24 h |

**(speaker)**
"Tres tiers. El estandar es el caballo de batalla. Si haces mucho volumen, te
paso al high-volume con compromiso. Si quieres soporte presencial y respuesta
en horas, premium. Ningun tier tiene cuota mensual."

---

## Slide 11 — Quien lo usa ya

**(visual)** Logos / capturas de 3 salas (anonimizadas o con permiso). Numero
grande:

> **50+ PAX Paytef activos**
> en nuestro stack desde 2025.

Citas (anonimizadas):

- *"En la primera semana cobre el 30 % de la noche por QR. Cero quejas de cola."* — operador, Valencia
- *"Era no pagar fijo o nada. Esto era nada hecho oferta."* — director, Madrid
- *"Lo audite contra Paytef. Cuadra al euro."* — gestor, Barcelona

**(speaker)**
"La infraestructura tecnica ya esta probada. Tenemos 50+ PAX activos. Estas
salas no son ficcion: son del mismo grupo donde ya hay maquinas y a quienes
ofrecemos primero esta oferta."

---

## Slide 12 — Llamada a la accion

**(visual)** Texto grande centrado:

> **¿Probamos en una sola sala 3 meses?**
>
> Setup en 72 horas. Cero euro de adelanto. Te lo pruebo en mi piel.

Abajo en pequeño:
- Email: ainhoanochesdeverano@gmail.com
- Web: nightpay-revshare.com
- Calculadora: nightpay-revshare.com/calculadora

**(speaker)**
"Tres meses, una sala, cero euros de adelanto. Si te aporta, escalamos al resto
del grupo. Si no, te quedas con la pasta que no me has pagado y nos damos las
gracias. ¿Cuando lo arrancamos?"

---

## Notas para producir el deck en visual

- **Paleta sugerida:** negro fondo (`#0A0A0A`), texto blanco roto (`#F4F4F0`),
  acento amarillo electrico tipo neon discoteca (`#F2FF00`) usado solo en
  numeros financieros clave y CTA. Cero gradientes.
- **Tipografia:** display tipo Druk o Inter Display para titulares, mono tipo
  IBM Plex Mono para numeros. Cero serif.
- **Movimiento:** transiciones tipo "cut" estilo magazine. Cero fades suaves.
- **Datos:** todos los numeros de la slide 5 deben matchear `calculadora.md`
  exactamente. Si cambias uno, sincroniza el otro.
