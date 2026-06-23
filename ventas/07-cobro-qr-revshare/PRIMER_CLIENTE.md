# PRIMER_CLIENTE — Reabordar leads de Idea 01 con RevShare

Esta carpeta es el plan B comercial de Idea 01 (NightPay Lite). Cada local que
dijo "no quiero pagar SaaS fijo" se reabordara con esta oferta. Tambien sirve
para abrir grupos hosteleria con >5 locales.

---

## Perfil ICP del cliente RevShare

| Atributo               | Valor                                                       |
|------------------------|-------------------------------------------------------------|
| Tipo de local          | Discoteca / sala de copas / pub con cobro tarjeta intenso   |
| Aforo                  | 200-1.500 personas                                          |
| Volumen QR estimado    | **20k - 80k €/mes** (sweet spot para 1,0 %)                 |
| Estado Paytef          | PAX A920 / IM30 activo (`paytefDeviceStatus = Conectado`)   |
| Software de caja actual| Ninguno / Excel / sistema viejo / Glop sin renovar          |
| Caracteristica clave   | **Ya rechazaron pagar SaaS fijo (Idea 01)** o son grupo grande |
| Disposicion            | "Solo pago si me hace ganar / ahorrar"                      |

---

## Lista de leads internos a reabordar

> **Accion:** revisar `../../shared_db.json` y filtrar por venues marcados como
> "rechazo Idea 01" o `paytefDeviceStatus=Conectado` sin software de caja activo.
> A dia de hoy ese mapping aun no esta sistematizado — manualmente identificar
> los 5-10 locales mas grandes del grupo.

Plantilla CSV a generar (`leads_revshare.csv`):

```csv
venueId,nombre,ciudad,volumenMensualEstimado,statusPaytef,razonRechazoIdea01,proximoContacto
v_001,Sala Atlantis,Madrid,55000,Conectado,no_quiere_fijo,2026-05-28
v_002,Discoteca Numero 9,Valencia,42000,Conectado,probara_3meses,2026-05-29
...
```

---

## Guion de llamada de reabordaje (12 min)

**Contexto:** este lead te dijo NO en las ultimas 4-8 semanas a 199-349 €/mes
SaaS. No le has llamado desde entonces. Hoy le llamas con oferta nueva.

### Apertura (1 min)
> "Hola [nombre], te llamo de NightPay, nos hablamos hace un mes y medio sobre
> el software de caja. Me dijiste que el SaaS fijo no te encajaba, y queria
> tenerte al corriente — hemos sacado un modelo nuevo que **se ajusta exactamente
> a lo que me pediste**: que solo pagues si yo te hago facturar. ¿Tienes 8 minutos?"

### Qualifier rapido (2 min)
- "¿Sigues con el PAX de Paytef activo? Si." (asumir si, ya estaba)
- "¿Ya buscaste alternativa en este tiempo?" — escucha objeciones nuevas
- "¿Cuanto cobras de media en tarjeta una noche tipica?" — para calibrar tier

### Pitch en 2 frases (1 min)
> "Te lo dejo claro en una frase: te instalo NightPay gratis, no pagas ni setup
> ni mensualidad, **solo me pagas el 1 % de cada cobro QR que pase por el sistema**.
> Si una semana no operas, no pagas nada esa semana. Es el modelo Stripe aplicado
> a software de caja."

### Calculadora en directo (4 min)
> "Vamos a verlo con tus numeros. Has dicho [X] €/mes en tarjeta y [Y] transacciones."
- Saca calculadora: `X * 0.010 + Y * 0.10 = Z €/mes`
- "Compara con los 199 € que te ofreci antes + lo que ahorras por no entrar SaaS."
- **Punto clave:** "Pero la diferencia es que si una semana cierras, no me debes nada."

### Cerrar objecion clave (2 min)
La mas comun: **"y como se que no me cobras de mas?"**
- "Cada transaccion que te factura va con el codigo de autorizacion de Paytef. Tu
  abres el panel de Paytef y cruzas linea a linea. Si hay diferencia, no la cobro.
  Esta en la clausula 7 del contrato."

### Cierre (2 min)
> "Te mando el contrato y el mandato SEPA por email hoy. Si lo firmas antes del
> [viernes], te activamos para que el siguiente fin de semana cobres con QR. Y
> recuerda: si el primer mes te cobro mucho, es porque has facturado mucho — y
> seguramente ya te he pagado yo solo el coste."

**Resultado esperado de llamada:**
- 70 %: pide ver contrato → mandar mismo dia
- 20 %: "dejame pensarlo" → seguimiento a 72 h
- 10 %: no para nada → marcar como `cold_definitivo` en CRM

---

## Email "te quito el coste fijo" (cold outreach a leads pasados)

**Asunto:** "[Nombre del local] — te quito los 199 €/mes que no querias pagar"

```
Hola [Nombre],

Hace un mes y medio te ofreci NightPay a 199 €/mes y me dijiste que no
querias pagar fijo. Lo entendi. He tirado de ese feedback y he sacado
algo nuevo que creo que si te encaja.

Tres puntos:

1. Cero coste fijo. Cero setup. Cero mensualidad.
2. Solo pagas el 1 % + 0,10 € por cada cobro QR/NFC que pase por nuestro
   sistema. Si un mes no operas, no pagas nada.
3. Permanencia 3 meses. Despues, baja con 30 dias y sin penalizacion.

Si en una noche normal cobras 4.000 € por QR (200 tickets), me pagarias
60 € + 20 € = 80 € la noche. Si haces 10 noches al mes, son 800 €/mes,
pero ya me has facturado 40.000 €. Cero riesgo para ti, y tu lo controlas:
cada transaccion lleva el numero de autorizacion de Paytef cruzado.

¿Te paso el contrato y miramos numeros 10 min esta semana?

Saludos,
[firma]

PD: si quieres calcular tu caso en 30 segundos, esta la calculadora aqui:
[link a landing/index.html]
```

**Cuando enviar:** martes o miercoles, entre 10:30 y 12:00 (no mañana de
domingo ni viernes tarde — es el ocio nocturno, no hay nadie operando).

**Followup automatico (D+3 si no responde):**

```
[Nombre], 

Vi que no me respondiste al ultimo. Sin presion. Solo dejo aqui el numero
con tu volumen estimado:

  Si haces 45.000 €/mes en QR ≈ 3.000 transacciones
  Coste NightPay RevShare: ~750 €/mes
  Coste SaaS competencia: ~265 €/mes (con setup amortizado)
  Diferencia: 485 €/mes mas caro... pero arrancas con 0 € fuera de bolsillo
  y puedes parar cuando quieras.

Si en cualquier mes me sale a cuenta seguir contigo, lo seguiremos. Si no,
te dejo libre. Esa es la propuesta.

¿Te paso contrato?
```

---

## Carta de exclusividad para grupos hosteleria (>5 locales)

**Para:** dueño/director general de grupo con 5+ salas (Pacha, ChaChaCha,
Opium Group, etc.)

```
Estimado/a [Nombre],

NightPay es el stack de cobro QR + NFC + admin que ya esta operando en
50+ PAX Paytef en España. Nos hemos enfocado en ocio nocturno especifico
y hemos llegado a un punto en el que podemos ofrecer **exclusividad
territorial o por grupo**.

La propuesta para tu grupo seria:

  - **0,7 % comision uniforme** en todas tus salas
  - **Cero coste mensual, cero hardware**
  - **Exclusividad de proveedor de cobro QR** para tu grupo por 2 años
  - **Soporte presencial 1 vez/trimestre por sala**
  - **API publica para integracion con tu ERP**
  - **Codigo del frontend en escrow** si lo pides
  - **Dashboard ejecutivo agregado** del grupo

A cambio:

  - Compromiso de procesar >150k €/mes agregados entre tus salas
  - Caso de estudio publicable (1 sala minimo, anonimizado si prefieres)
  - 6 meses minimo de servicio

Si te interesa profundizar, te puedo mandar un dossier completo con
proyeccion financiera basada en tus volumenes estimados y un piloto
gratuito en 1 sala durante 30 dias.

Saludos cordiales,
[firma]
```

**Distribucion:** 5 grupos identificados (lista privada). Enviar por correo
postal **fisico**, no email, para destacar — el coste extra de 6 € por carta
postal certificada justifica el efecto.

---

## Que decir cuando vuelvan a decir NO

### "Sigo pensando que sale caro a la larga"
**Tu:** "Cuando llegues a ese punto, te paso a SaaS fijo a 199 €/mes y dejas de
pagar comision. La oferta sigue ahi cuando quieras. Manda mensaje."

### "Prefiero pagar fijo y tener control"
**Tu:** "Perfecto, entonces vuelvo a Idea 01: setup + 199 €/mes. ¿Lo cerramos?"

### "No me hace falta nada de esto"
**Tu:** "Vale, no insisto. ¿Conoces otro local de la zona al que le pueda hacer
falta? Por la referencia te paso 3 meses sin comision si firmas tu o ellos."

---

## Metricas a trackear de este reabordaje

| Metrica                                    | Target Sem 1 | Target Sem 2 |
|--------------------------------------------|--------------|--------------|
| Leads contactados (llamada + email)        | 15           | 30           |
| Llamadas atendidas                         | 8            | 18           |
| Demos/contratos enviados                   | 3            | 7            |
| Contratos firmados                         | 1            | 3            |
| MRR esperado mes 1                         | 600 €        | 1.800 €      |
| ARPU promedio                              | 600 €        | 600 €        |

Si al final de semana 2 no hay >=1 firma, **rebobinar:** la oferta no esta
clara o el precio no es competitivo en este segmento. Iterar `SALES.md`.
