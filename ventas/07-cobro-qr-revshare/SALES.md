# SALES — NightPay Revenue Share

3 estructuras de pricing, 1-pager comercial, 10 objeciones con respuesta.

---

## Las 3 estructuras de pricing

### Plan **HIGH-VOLUME 0,8 %** — para grupos serios

**Para quien:** locales o grupos que procesan **>100.000 €/mes** por QR/NFC
estimados. Requiere **compromiso minimo 100k €/mes** durante 6 meses (si no se
cumple, escala automaticamente a 1,0 %).

| Concepto                       | Precio                    |
|--------------------------------|---------------------------|
| Coste por transaccion          | **0,8 % + 0,08 €**        |
| Setup                          | 0 €                       |
| Cuota mensual                  | 0 €                       |
| Soporte                        | Email + Slack compartido  |
| SLA respuesta                  | <24 h habiles             |
| Permanencia                    | 6 meses                   |
| Comision over-volumen          | 0,7 % a partir de 250k/mes|

**Ejemplo:** local que procesa 150.000 €/mes en 8.000 transacciones
- Coste mensual: 150.000 × 0,008 + 8.000 × 0,08 = **1.840 €/mes**
- Equivalente SaaS competencia: 349 € + 0,5 % = 349 + 750 = **1.099 €/mes**
- Diferencia: 741 €/mes MAS caro para el local, pero **cero capex, cero riesgo**

### Plan **ESTANDAR 1,0 %** — el caballo de batalla

**Para quien:** locales que procesan **20-80k €/mes**. Sin compromiso de volumen,
solo 3 meses minimos de servicio.

| Concepto                       | Precio                    |
|--------------------------------|---------------------------|
| Coste por transaccion          | **1,0 % + 0,10 €**        |
| Setup                          | 0 €                       |
| Cuota mensual                  | 0 €                       |
| Soporte                        | Email                     |
| SLA respuesta                  | <48 h habiles             |
| Permanencia                    | 3 meses                   |

**Ejemplo:** local que procesa 45.000 €/mes en 3.000 transacciones
- Coste mensual: 45.000 × 0,010 + 3.000 × 0,10 = **750 €/mes**
- Equivalente SaaS competencia: 199 € + setup 800 € amortizado a 12 meses = **265 €/mes**
- Diferencia: 485 €/mes mas caro, **pero el local arranca con 0 € fuera de bolsillo**

### Plan **PREMIUM 1,5 %** — para los exigentes

**Para quien:** locales <30k €/mes que quieren **soporte presencial primer viernes
del mes**, formacion camareros, dashboard ejecutivo personalizado, prioridad maxima
en incidencias.

| Concepto                       | Precio                    |
|--------------------------------|---------------------------|
| Coste por transaccion          | **1,5 % + 0,10 €**        |
| Setup                          | 0 €                       |
| Cuota mensual                  | 0 €                       |
| Soporte                        | Telefono + presencial 1/mes |
| SLA respuesta                  | <4 h habiles, <12 h finde |
| Permanencia                    | 3 meses                   |
| Onboarding presencial          | Incluido (8 h primer viernes) |

**Ejemplo:** local que procesa 18.000 €/mes en 1.200 transacciones
- Coste mensual: 18.000 × 0,015 + 1.200 × 0,10 = **390 €/mes**
- Equivalente Idea 01: 349 €/mes
- Diferencia: 41 €/mes mas caro, **pero todo el riesgo lo asumimos nosotros**

---

## 1-pager comercial (para mandar por email/WhatsApp)

```
================================================================
NIGHTPAY REV-SHARE — software de cobro para tu sala, sin coste fijo
================================================================

QUE TE LLEVAS:
  - Web cliente: tu cliente paga con QR desde el movil en 15 s.
  - TPV camarero: tu equipo dispara cobros desde el PAX en 1 click.
  - Admin tiempo real: ves ventas, refunds, propinas, top productos.
  - Webhooks Paytef: ya cableados, sin tocar tu PAX.

CUANTO PAGAS:
  Setup ............... 0 €
  Mensualidad ......... 0 €
  Por cada cobro ...... 1,0 % + 0,10 €  (sobre lo que pase por NightPay)

PUEDES ABANDONAR:
  Permanencia minima: 3 meses.
  Despues, baja con 30 dias de preaviso. Sin penalizaciones.

COMO TE LO COBRO:
  Dia 1 de cada mes te paso factura electronica con cada transaccion
  detallada y cruzada con el ticket Paytef. SEPA o transferencia a 15 dias.

CUANDO ARRANCO:
  Firma hoy -> instalado en 72 h -> primera transaccion <5 dias.

================================================================
[X] Si me sale a cuenta, lo dejo. Cero riesgo financiero hoy.
================================================================
```

---

## Las 10 objeciones reales (con respuesta lista)

### 1. "Y si dejo de operar el local? Sigo pagando?"
**Respuesta:** No. Si no hay transacciones, no hay factura. Cero coste mensual
fijo. Si cierras tres meses por reformas, no recibes factura tres meses. Es
literalmente el modelo Stripe: **solo pagas si cobras**.

### 2. "Y si tu cierras la empresa o desapareces?"
**Respuesta:** Buen punto, y por eso el dinero **no pasa nunca por nosotros**.
Tu cliente paga a Paytef, Paytef te liquida a TU cuenta a T+1. Si nosotros
desaparecemos, los cobros **siguen funcionando** porque Paytef sigue ahi.
Solo se cae el dashboard y los QR; el PAX sigue cobrando con TPV camarero.
Ademas, el contrato te da derecho a **export completo de datos** y **codigo
del frontend en escrow** (clausula opcional).

### 3. "Como me fio de que estais midiendo bien las transacciones?"
**Respuesta:** Cada transaccion que facturamos lleva **el codigo de autorizacion
de Paytef cruzado**. Tu puedes ver en tu propio backoffice de Paytef cada
operacion con su numero, importe, hora. Si nosotros decimos "te cobro 750 € por
3.000 transacciones", tu puedes auditar las 3.000 una a una contra Paytef. Si
hay diferencia, no se factura. Auditoria publica, cero opacidad. Ver clausula 7
del contrato.

### 4. "1 % suena mucho. Paytef ya me cobra otro 0,4 %."
**Respuesta:** Cierto, y por eso este modelo no es para todos. Si tu sala procesa
mas de 80k €/mes por QR, **te recomendamos el plan SaaS fijo** (199-349 €/mes,
ver Idea 01) — es mas barato para ti. Si haces menos, este modelo es mas barato
porque **no pagas en los meses flojos**. Te paso la calculadora y lo vemos en 2
minutos con tus numeros reales.

### 5. "Y si la mitad de mis ventas QR son pequeñas (5-10 €)? El 0,10 € fijo me come."
**Respuesta:** Razon valida. En ese caso te pasamos al **plan ESTANDAR sin fee
fijo: 1,3 % puro, 0 € por transaccion**. En tickets pequeños sale mejor para ti,
en tickets grandes sale igual. Lo modelamos juntos con tu ticket medio real.

### 6. "Y si yo te corto el sistema y vuelvo a usar mi caja vieja?"
**Respuesta:** Despues de los 3 meses minimos puedes hacerlo con 30 dias de
preaviso. Lo unico que pedimos es que cumplas los 3 meses iniciales por respeto
al setup y formacion que ponemos gratis. Si nos cortas antes, te facturamos
**unicamente el coste de setup teorico (300 €)**, nada mas. Cero penalizacion
sobre volumen futuro.

### 7. "Y si tu sistema se cae una noche de viernes y pierdo 8.000 € de ventas?"
**Respuesta:** Tres respuestas. (1) Tu PAX **sigue funcionando** aunque NightPay
caiga — Paytef es independiente. Tu camarero teclea importe en el PAX y cobra.
(2) NightPay corre en multi-AZ con uptime SLA 99,5 % (ver `../../nightpay/HARDENING.md`).
(3) Si por nuestra culpa hay caida >2 h en horario de operacion, te abonamos el
**equivalente al 100 % de las comisiones del mes en credito**. Ver clausula SLA.

### 8. "Mi gestor me dice que no entiende como va el IVA de tu factura."
**Respuesta:** Te emitimos factura electronica espaņola estandar: base imponible
+ IVA 21 % sobre el total de comisiones. Es deducible al 100 % como gasto de
explotacion. Te mandamos plantilla para tu gestor en el onboarding.

### 9. "Yo ya tengo Glovo Pay, no quiero mas software."
**Respuesta:** Perfecto. Mantenemos coexistencia: tus camareros pueden seguir
cobrando con Glovo Pay para take-away o domicilio, y usar NightPay solo en barra.
Solo te cobramos las transacciones que pasen por NightPay. Si Glovo desaparece
manana (cosa que paso con otras pasarelas en 2024), tienes plan B sin coste.

### 10. "Y si me llega un inspector de Hacienda y pregunta por las transacciones?"
**Respuesta:** Cada cobro NightPay genera **ticket electronico Verifactu-ready**
(Real Decreto 1007/2023) con su hash, secuencia y datos fiscales del local.
Exportable a SII en CSV firmado. Estamos al dia con la normativa anti-fraude
de 2026. Mas tranquilo que tu caja vieja.

---

## Reglas de descuento (NO improvisar)

| Situacion                                            | Descuento autorizado     |
|------------------------------------------------------|--------------------------|
| Primer cliente del grupo (referencia)                | 0,8 % primeros 6 meses   |
| Compromiso anual prepago                             | -0,1 % sobre tier        |
| Multi-venue (3+ locales mismo grupo)                 | 0,7 % uniforme           |
| Caso de uso documentable publicamente                | 0,7 % indefinido         |
| **Resto**                                            | **Cero descuento**       |

Cualquier descuento fuera de esta tabla **requiere aprobacion explicita por
email**, no se cierra en llamada.

---

## Triggers para cerrar (señales de compra)

- Pregunta por "y cuando podriamos empezar"
- Pide ver el contrato
- Pregunta por el contrato de SEPA
- Pide hablar con un cliente actual de referencia
- Pregunta "y si lo probamos solo en una sala"

Si ves >=2 triggers en la misma conversacion, manda el contrato **antes de
colgar/cerrar el chat**.
