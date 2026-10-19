# Cobrar del saldo en el datáfono

El datáfono PAX A920 Pro, además de cobrar con tarjeta, lee el saldo OxioPay
del cliente y le cobra con su PIN, tecleado en el propio datáfono. Sirve para
el cliente que no quiere sacar el móvil, o que lleva una ficha NFC (pulsera o
tarjeta) que le dieron en recepción.

Necesita la app OxioPay del datáfono **0.2 o posterior** (cámara y NFC). Con
una app más vieja, «Cobrar con saldo» funciona igual con el código del cliente.

## Cómo cobra el personal

1. **La chica hace el cobro** en su app, como siempre: *Cobrar del saldo* →
   elige el servicio (o teclea el importe) → le sale un QR.
2. **En el datáfono**, en la pantalla de cobros: **Cobrar con saldo**.
   - Sale la lista de cobros del saldo que hay pendientes en el local
     (importe, chica y servicio): se toca el que es.
   - O **Escanear QR del cobro**: se apunta la cámara al QR del móvil de la chica.
3. **De qué saldo es**. Vale cualquiera de estas tres formas:
   - **Acercar ficha**: el cliente acerca su ficha a la parte de atrás del datáfono.
   - **Escanear QR del cliente**: el QR de la página de su saldo o el de su
     pase de Google Wallet.
   - **Código del cliente** (K7Q-4M2), tecleado.
4. El datáfono dice si **le llega el saldo** para ese cobro, sin enseñar
   cuánto tiene ni su nombre (solo «K7Q-•••»). Si no tiene PIN, lo tiene
   bloqueado o no le llega, lo dice antes de pedir nada.
5. **El cliente teclea su PIN**. Las cifras cambian de sitio cada vez: que
   lo tape con la mano.
6. Sale **PAGADO** a pantalla completa con el importe y lo que le queda de
   saldo, o por qué no se ha podido cobrar. A los pocos segundos vuelve solo
   a la pantalla de cobros.

La parte de la chica (su comisión) queda igual que si el cliente hubiera
pagado con su móvil: el cobro es el mismo.

### Si algo falla

- **PIN incorrecto**: se vuelve a teclear; quedan los intentos que dice la pantalla.
- **5 PIN fallidos**: el saldo se bloquea (igual que en la app). Lo
  desbloquea el encargado desde el panel.
- **«Este PIN lo puso el encargado»**: si el PIN lo eligió el personal (no
  el cliente en su móvil o justo al recargar), en el datáfono no vale, porque
  nadie sabe quién lo está sosteniendo. Ese cobro se hace desde la app de la
  chica, con el código del cliente y otra persona delante.
- **Sin conexión justo al poner el PIN**: el datáfono pregunta si el cobro
  quedó pagado antes de decir nada. Repetir el PIN nunca cobra dos veces: un
  cobro solo se puede pagar una vez.
- **El QR o el cobro ha caducado** (5 minutos): la chica hace otro.
- **«Este datáfono no deja leer fichas desde la app»**: el NFC está
  reservado por el lector de tarjetas (ver abajo). Mientras tanto, el QR o el
  código del cliente.

### Reglas que aplica el servidor

- El datáfono solo ve y cobra **cobros de su local**, y solo de **saldos de
  su grupo** (mismo dueño), igual que la app del personal.
- Siempre hace falta el **PIN del cliente**: la ficha, el pase o el código solo
  dicen de qué saldo es. Una ficha copiada (otro número de serie) no vale.
- Topes por IP propios del datáfono, más estrictos que los de la app: 30
  consultas de saldo y 20 intentos de PIN por minuto.
- Cada cobro y cada PIN fallido quedan en la auditoría con el datáfono que lo hizo.

## Cómo se dan las fichas en recepción

Las fichas son NTAG213/215/216 (pulsera o tarjeta). Llevan grabado un enlace
a la app con un código al azar (`…/?ficha=<código>`) y su número de serie.

1. Se cobra la recarga del saldo como siempre (tarjeta o enlace de pago).
2. En la recarga pagada: **Darle una ficha NFC**.
   - **Android (Chrome)**: se acerca la ficha a la parte de atrás del móvil.
     Si está vacía, se graba en ese momento; queda unida a ese saldo.
   - **iPhone**: la ficha tiene que estar grabada antes (con un Android). Se
     acerca a la parte de arriba del iPhone y se toca el aviso que sale.
3. Quien hizo la recarga la puede dar en sus 15 minutos siguientes; después,
   el encargado (a cualquier saldo del grupo, con su código).
4. Que el cliente elija su PIN ahí mismo (o en su móvil al pagar la recarga).

Una ficha perdida la bloquea el encargado; el saldo sigue valiendo con el
código + PIN o con Face ID. Una ficha de un saldo ya gastado se puede volver a dar.

## Qué preguntar a PAX / Paytef si el NFC no aparece

La app usa el NFC estándar de Android (`NfcAdapter`, modo lector NFC-A). En
el A920 Pro el lector sin contacto puede estar **reservado para las
tarjetas** (lo maneja el módulo PICC de PAX, que usa la app de Paytef para
EMV) y no aparecer para otras apps. La app lo detecta sola y avisa «Este
datáfono no deja leer fichas desde la app».

Preguntas para PAX / Paytef:

1. ¿El A920 Pro de producción expone el NFC a apps de terceros por
   `NfcAdapter` (Android estándar)? ¿Con qué versión de firmware o ajuste de
   PAXSTORE?
2. Si no: ¿nos dais el **SDK de PAX con la API PICC** (NeptuneLite o el que
   toque) para detectar una tarjeta Mifare Ultralight / NTAG21x, leer su UID y
   leer sus páginas de memoria (el NDEF)? ¿Con qué licencia y permisos?
3. ¿Puede nuestra app usar el lector sin contacto **cuando no hay una venta en
   curso** sin chocar con la app de Paytef? ¿Hay que liberarlo o pedirlo de
   alguna forma?
4. ¿La Device API de Paytef (`127.0.0.1:8887`) tiene alguna llamada para leer
   una tarjeta sin contacto que no sea de pago (UID / NDEF)?
5. ¿PAXSTORE acepta los permisos `CAMERA` y `NFC` en nuestra app?

Con la respuesta, el cambio va en `apps/pax-android` (`LocalReaders.readNfc`):
la pantalla web no cambia, porque el puente ya devuelve `{ uid, url }`.

## Qué hay que comprobar en el datáfono de verdad

Nada de esto se ha podido probar en un A920 Pro (solo compila en GitHub Actions):

- [ ] La app 0.2 se instala por PAXSTORE con los permisos de cámara y NFC.
- [ ] **Escanear QR**: pide el permiso la primera vez, la vista previa sale
      derecha (no girada), enfoca de cerca y lee el QR del móvil de la chica,
      el de la página del saldo y el del pase de Google Wallet, con poca luz.
- [ ] «Cancelar» y el botón atrás cierran la cámara y la pantalla sigue.
- [ ] **NFC**: qué dice «Cobrar con saldo» (ficha disponible o «no deja
      leer fichas»). Si está disponible: lee la ficha (número de serie y
      enlace), y en qué zona del aparato hay que acercarla.
- [ ] Una venta con tarjeta justo después de leer una ficha sigue funcionando
      (el NFC queda libre para Paytef).
- [ ] Apagar la pantalla durante «Acerca la ficha» no deja la app colgada.
- [ ] Cobro completo: PAGADO, «le quedan», el cobro sale pagado en la app de
      la chica y en el panel, y la comisión de la chica es la de siempre.

## Para desarrolladores

- Pantalla: `apps/operator/src/components/pax/PaxSaldoFlow.tsx`; lógica y
  llamadas: `apps/operator/src/lib/pax-saldo.ts`; puente:
  `apps/operator/src/lib/pax-bridge.ts`.
- App: `apps/pax-android` (`LocalReaders.kt`, `ScanActivity.kt`, `PaxBridge.kt`).
- API (credencial del datáfono, `Authorization: Device …`):
  - `GET  /v1/pos-device/saldo/charges`: cobros con QR sin pagar del local.
  - `POST /v1/pos-device/saldo/charges/scan` `{ payToken }`: el cobro del QR escaneado.
  - `GET  /v1/pos-device/saldo/charges/:id`: ¿se pagó? (tras un corte).
  - `POST /v1/pos-device/saldo/charges/:id/check` `{ card, uid? } | { walletToken } | { code }`:
    ¿le llega? (sin enseñar el saldo).
  - `POST /v1/pos-device/saldo/charges/:id/pin`: lo mismo + `pin`.
- Pendiente:
  - Ajuste por local de las formas de cobro (ficha NFC / datáfono): cuando
    exista en el panel, ocultar «Cobrar con saldo» si está apagado.
  - Cobros del saldo que crea el propio datáfono (barra, sin chica): hoy cada
    cobro lo hace una persona (`requestedByUserId`); un cobro «del datáfono»
    pide decidir en la base de datos quién figura como quien lo hizo.
