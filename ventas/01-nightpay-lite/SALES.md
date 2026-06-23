# NightPay Lite — Comercial

> Pricing, propuesta 1-pager y top 10 objeciones / respuestas.
> Todo en EUR, IVA NO incluido salvo donde se indique.

---

## 1. Pricing — 3 tiers

| | **Starter** | **Pro** | **Enterprise** |
|--|--|--|--|
| **Para quien** | Sala unica <500 pax, 2-3 noches/semana | Sala 500-1.500 pax, 4+ noches | Cadena 2+ salas o gran formato 1.500+ pax |
| **Setup one-shot** | **800 €** | **1.200 €** | **1.500 €** + 500 €/sala adicional |
| **Suscripcion mensual** | **199 €/mes** | **279 €/mes** | **349 €/mes** primera sala + 199 €/mes salas extra |
| **Comision sobre volumen** | 0,5% | 0,4% | 0,3% (o 0% con compromiso 12m) |
| **Terminales TPV incluidas** | 2 | 5 | 10 |
| **Usuarios camareros** | hasta 8 | hasta 25 | ilimitado |
| **Realtime dashboard** | ✓ | ✓ | ✓ |
| **Refunds con TOTP** | ✓ | ✓ | ✓ |
| **Reconciliacion diaria automatica** | ✓ | ✓ | ✓ |
| **Auto-failover pasarela** | — | — | ✓ (Cecabank backup) |
| **SLA respuesta** | 24 h habil | 4 h habil | **2 h 24/7 fines de semana** |
| **Onboarding presencial** | remoto 1 h | presencial 2 h primera noche | presencial 2 noches |
| **Reporting personalizado** | export CSV | export + PowerBI | API dedicada |
| **Permanencia minima** | 3 meses | 6 meses | 12 meses (precio congelado) |

### Notas de pricing

- **Comision sobre volumen**: se aplica sobre el GMV procesado a traves de NightPay
  (no sobre las ventas totales de la sala). Negociable a la baja con compromiso
  anual y/o volumen >100 k€/mes.
- **Setup**: incluye creacion de venue, alta de owner + managers + camareros,
  configuracion credenciales Paytef del cliente, hardening del subdominio
  dedicado (`<cliente>.nightpay.app`), y 2 h de formacion al equipo.
- **No incluye**: hardware (PAX), conexion Paytef (es del cliente), TPM/datafonos,
  formacion mas alla de las horas pactadas.

### Pricing add-ons (todos los tiers)

| Add-on | Precio | Para que |
|--------|-------:|----------|
| Sala adicional (Pro) | +199 €/mes | Segundo local de la misma cadena |
| Terminal TPV extra | +29 €/mes | Mas de las incluidas |
| Soporte premium 24/7 | +199 €/mes | Eventos festivos / NYE |
| Modulo wallet (deposito) | +99 €/mes | Cliente carga 50 € y consume |
| Whitelabel completo | +149 €/mes | Dominio propio + branding total |
| Integracion contabilidad (Holded / A3 / Sage) | +149 €/mes | Cierre fiscal automatico |
| Modulo entradas / aforo | +199 €/mes | Vincular cobro a ticket evento |
| Importacion historico Paytef | 300 € one-shot | Migrar 12 m datos transaccionales |

---

## 2. Propuesta 1-pager (plantilla envio email)

```
Asunto: Propuesta NightPay Lite — [NOMBRE_CLIENTE]

[NOMBRE_CLIENTE] — propuesta NightPay Lite

Situacion actual (lo que vimos en la llamada del [FECHA]):
- PAX A920 ya activo en barra principal (serial [TBD])
- Operativa Paytef ya facturando con vuestra cuenta
- Software de caja: [ninguno / hoja Excel / sistema antiguo]
- Volumen aproximado: [TBD] € por noche
- Dolor principal: [no veo cuanto llevo / camareros lentos / cliente espera / sin reporting]

Lo que proponemos:
- Tier: [Pro 279 €/mes + 1.200 € setup]
- 5 terminales TPV (movil + tablet)
- Realtime dashboard owner + manager
- Cobro QR cliente + cobro contactless camarero
- Reconciliacion diaria con Paytef
- Refunds con TOTP (sin discusiones de barra)

Plazos:
- Firma propuesta: esta semana
- Setup: 72 h (martes-jueves)
- Primera noche en vivo: viernes [FECHA]
- Onboarding presencial 2 h: ese viernes 19:00

Compromiso:
- 6 meses minimo, precio congelado
- Tras los 6 m: cancelable con 30 dias de aviso
- SLA: respuesta 4 h habiles, 2 h fines de semana

Inversion total primer mes: 1.200 € (setup) + 279 € (mes 1) = 1.479 €
Mensualidades siguientes: 279 €/mes
Comision Paytef: NO cambia, la mantienes tal cual.
Nuestra comision sobre el volumen procesado: 0,4%.

Listo para empezar el [FECHA + 7 dias]. Confirmamos con tu firma electronica.

[FIRMA_COMERCIAL]
```

---

## 3. Top 10 objeciones y respuestas

### 1. "Ya tengo TPV. ¿Para que cambiar?"

> "No te pido que cambies el TPV. Tu PAX sigue siendo el de siempre y Paytef sigue
> cobrando. Yo te doy la **capa de software encima**: ver lo que vendes en tiempo
> real, gestionar refunds sin discusiones, y permitir al cliente pagar con QR.
> Conviven."

Pivot rapido: "¿Sabes ahora mismo, sin abrir Paytef, cuanto llevas vendido en la
ultima hora? ¿Por camarero?"

---

### 2. "199 € al mes es caro."

> "Una sola disputa de cobro mal gestionada cuesta mas que 4 meses del Pro. ¿Cuantas
> tienes al ano? Multiplica."

Alt: "Ofrecemos 3 meses Starter sin permanencia. Si no te aporta minimo el doble en
ahorro de tiempo + reduccion de chargebacks, te das de baja."

---

### 3. "¿Que pasa si os caeis un sabado a las 2 AM?"

> "El cobro Paytef sigue funcionando. Nuestra capa es admin + UX, no es el camino
> critico del cobro. Si nuestro panel cae, los camareros siguen cobrando con el PAX
> directamente. **No bloqueamos la caja jamas**."

Mas: SLA 2 h fines de semana en Pro/Enterprise. Status page publico. Bot Telegram
con alertas P0.

---

### 4. "¿Mis datos? ¿Quien los ve?"

> "Multi-tenant con RLS a nivel base de datos. Tu venue, tus datos. Ni siquiera
> nuestros propios admin pueden mirarlos sin proceso documentado. Cumplimos LOPD/RGPD,
> hosting en Hetzner (UE), backups cifrados en Backblaze (UE). Los webhooks Paytef
> entran firmados HMAC."

---

### 5. "¿Y si quiero darme de baja?"

> "Tras los 6 meses iniciales, 30 dias de aviso. Te exportamos toda tu historia
> transaccional en CSV. Tu cuenta Paytef es tuya, no la tocamos. Adios sin drama."

---

### 6. "¿Y si Paytef cambia algo?"

> "Tenemos integracion real con company 76861 (la que muchos clientes nuestros
> comparten). Si Paytef rompe algo, lo arreglamos a nivel plataforma, no tienes
> que tocar nada tu. Es nuestro trabajo, no el tuyo."

---

### 7. "Tengo un primo informatico que me lo hace gratis."

> "Genial. Pregunta a tu primo si va a estar el sabado a las 3 AM cuando un cobro
> de 800 € se quede 'pendiente' y el cliente se vaya sin pagar. Pregunta tambien
> si firma RGPD, si tiene SLA, y si te indemniza por chargeback evitable. Si la
> respuesta es si — adelante. Si es no — hablamos."

---

### 8. "Me lo apunto y lo veo despues del verano."

> "El verano es exactamente cuando lo necesitas. Te ofrezco arrancar Starter (199 €)
> con compromiso solo 1 mes para que pruebes en julio. Si en agosto no te ha
> aportado, lo paras. ¿Te parece?"

---

### 9. "¿Estais regulados?"

> "No movemos dinero. Quien mueve dinero es **Paytef** (regulado por Banco de Espana
> via Cecabank). Nosotros somos software puro: TPV + dashboard + reporting. No
> necesitamos licencia de pagos. Tampoco la necesitarias tu para usar nuestro
> software sobre tu Paytef."

---

### 10. "Mi cadena tiene 5 salas. ¿Volumen?"

> "Pasa a Enterprise. 1.500 € setup base + 500 € por sala adicional + 349 €/mes
> primera sala + 199 €/mes salas extra. Con compromiso 12 m, comision sobre
> volumen 0% y permanencia con descuento. Para 5 salas hablamos de unos
> 1.345 €/mes total + setup unico 3.500 €. Lo amortizas en 1-2 noches de buen
> fin de semana solo en tiempo recuperado."

---

## 4. Argumentario corto para la barra

Si te lo dice un camarero en la barra (no el dueno):

- "Camarero, tu trabajas mas rapido con esto. Cobras en 5 segundos en lugar de 25.
  Cobras a 3 mesas a la vez. Y no tienes que discutir con el cliente cuando no
  recuerda si pago. **Tu propinas suben porque sirves mas mesas por noche.**"

Si te lo dice el manager:

- "Manager, tu cierras caja en 10 minutos en lugar de 1 hora. Cuadre automatico,
  refunds con doble factor, alertas si un cobro queda colgado. **Te vas a casa
  antes y duermes mejor.**"

Si te lo dice el dueno:

- "Dueno, tu sabes cuanto vendes esa noche **mientras la noche pasa**, no al dia
  siguiente. Cambias precios al vuelo. Ves que camarero pierde el tiempo. Y los
  cobros con tarjeta van directos al banco con su comision Paytef, sin
  intermediarios extra."

---

## 5. Politicas comerciales internas

- **Descuento maximo autorizado sin aprobacion CEO:** -15% sobre tarifa.
- **Free trial:** NO se ofrece. La conviccion la genera la demo de 30 min + 72 h
  setup, no el "pruebalo gratis".
- **Devolucion setup:** SI, si en los primeros 30 dias el cliente no esta
  satisfecho, se devuelve el 50% del setup. Mensualidades no se devuelven.
- **Pago:** 30 dias fecha factura (Pro/Enterprise) o adelantado (Starter).
- **Referidos:** 1 mes gratis al cliente referidor cuando el referido firma.
