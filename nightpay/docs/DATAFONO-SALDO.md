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

## Recepción: recargar el saldo, darle la ficha y el PIN

En el datáfono (app **0.3 o posterior**), en la pantalla de cobros:
**Recepción: recargar saldo**. En un Android del personal (camarero,
encargado o dueño), la pestaña **Recepción** de la app. Es el mismo proceso:

1. **Importe** a cargar, con el teclado.
2. **Cómo paga**:
   - **Tarjeta**: en el datáfono, el cliente la acerca a su lector (la venta
     de Paytef de siempre, con el reenvío y la anulación de siempre). En el
     móvil, el cliente paga con el QR de la recarga en su propio móvil.
   - **Efectivo**: se guarda el dinero en la caja y se pulsa **Cobrado**. Se
     suma al saldo en el momento. Como mucho **999,99 € por recarga** (en
     España no se puede pagar en efectivo 1.000 € o más a un negocio).
3. **A qué saldo**: **saldo nuevo**, o **recargar su ficha** (el cliente
   acerca la que ya tiene; vale aunque el saldo esté a 0).
4. **La ficha** (saldo nuevo): se acerca una ficha. Si está en blanco se le
   graba su enlace ahí mismo (no la retires hasta que lo diga); si es una del
   stock, se le da. Nunca se graba encima de una ficha que ya tiene algo.
5. **El PIN**: el cliente lo elige en el teclado (las cifras cambian de sitio).
   En el datáfono ese PIN es suyo: le vale para pagar en el datáfono.
6. **Recargado**: pantalla completa con el importe, el código del saldo
   (K7Q-4M2: que le haga una foto), lo que tiene y si tiene ficha y PIN.

A un saldo que ya existía (recargar su ficha) no se le cambia la ficha ni el
PIN: si lo ha olvidado, el encargado lo borra en el panel y lo elige de nuevo.

### Quién cobra efectivo

- **Ajustes → Formas de cobro → Recarga en efectivo** (encendida por
  defecto) y **Pago con saldo** tienen que estar encendidos.
- **Ajustes → Permisos → Cobrar recargas en efectivo**: de entrada, los
  encargados sí y los camareros no (se les puede dar a todos o a uno).
- **Datáfonos de recepción**: el datáfono no sabe quién lo tiene en la mano,
  actúa como el local. Por eso tiene su propio permiso (de entrada, **no**):
  si se enciende, cualquiera con el datáfono cobra recargas en efectivo.
  Cada recarga queda con el datáfono que la cobró y cuadra en la caja.

### Lo que hace el efectivo en la noche y en los informes

- **Caja**: lo que debería haber = fondo + recargas en efectivo − saldo
  devuelto en efectivo − pagos en efectivo a las chicas. Sale en el paso
  «Efectivo» del cierre y en el bloque «Caja» del Z.
- **Informes**: la recarga en efectivo cuenta como cobrada al cargarla, igual
  que la de tarjeta (el IVA va con la recarga; los consumos del saldo no se
  facturan otra vez). No es un cobro del banco: no sale en el cuadre con BBVA
  ni se puede devolver «a la tarjeta». Va en su línea en el Z, en el resumen
  de la gestoría y en el aviso de las 9:00 («Recargas en efectivo»).
- **«Me voy»**: el saldo recargado en efectivo se devuelve en efectivo (la
  devolución a la tarjeta solo cubre lo que se recargó con tarjeta). Al
  devolverlo, su ficha vuelve al stock.

## «Preparar fichas» (para el stock)

En el datáfono (**Preparar fichas**) o en un Android (Recepción → Preparar
fichas): **Empezar** y acercar las fichas una detrás de otra. El contador dice
cuántas se han preparado.

- **Ficha en blanco**: se graba con un código del servidor y queda **en el
  stock** de este local.
- **Ya grabada**: no se vuelve a grabar. Si es de un saldo gastado o cerrado,
  **vuelve al stock**; si es de un cliente con saldo, dice de quién es
  (K7Q-•••) para apartarla; perdida, bloqueada o de otro local: se aparta.
- **Con otra cosa grabada** (no es nuestra): no se toca.
- **No se pudo grabar**: déjala quieta y vuelve a acercarla.

## Cómo se dan las fichas en recepción (desde una recarga ya pagada)

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

### El stock de fichas (panel → Clientes → Fichas)

Cada ficha pasa por **En stock** (grabada, sin dar) → **Entregada** (dada a un
saldo) → **Devuelta** (otra vez en el stock: tras «Me voy» o al prepararla con
su saldo gastado) | **Perdida** | **Bloqueada**. Solo una entregada paga. En el
panel: cuántas hay en el stock y entregadas, lo de cada noche (entregadas,
devueltas, perdidas y el stock al cerrar, congelado en el Z) y la lista para
buscar una por su número de serie o el código del saldo, **bloquearla** o
**marcarla perdida**. Las fichas que ya existían siguen valiendo (las dadas
quedan «Entregada»; las sin dar, «En stock»).

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

Nada de esto se ha podido probar en un A920 Pro (solo compila en GitHub Actions).

Recepción y fichas (app 0.3):

- [ ] **Grabar**: una ficha NTAG213 nueva (de fábrica, sin formatear) y una ya
      formateada en blanco se graban con `writeNfc`; el móvil de un cliente
      abre luego ese enlace.
- [ ] Una ficha ya grabada (nuestra o de otra cosa) **no** se sobrescribe.
- [ ] Retirar la ficha a medio grabar da «No se ha podido grabar» y al
      acercarla otra vez se graba bien (no queda a medias).
- [ ] «Preparar fichas»: 10 fichas seguidas, el contador sube de una en una y
      dejar una apoyada no la cuenta dos veces.
- [ ] Recepción con tarjeta: la venta sale en el lector por el importe exacto,
      sin pedir propina (si la pide, la pantalla pide anularla), y el saldo
      queda sumado; después, la ficha y el PIN en el mismo datáfono.
- [ ] Recepción en efectivo con el permiso de los datáfonos encendido; sin él,
      el botón «Efectivo» sale apagado con el motivo.
- [ ] Una venta con tarjeta de una chica justo después de grabar fichas sigue
      funcionando (el NFC queda libre para Paytef).

Cobrar con saldo (app 0.2):

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
- Recepción y fichas: `apps/operator/src/components/reception/*`
  (`ReceptionFlow`, `PrepareFichas`), lógica en `lib/reception.ts` y
  `lib/chip-tap.ts` (leer y grabar la ficha por el puente o con Web NFC); en el
  API, `wallets/wallet-cash-topup.service.ts`, `wallets/wallet-cards.service.ts`
  y `pos-device/pos-device-reception.*`. Migración `20261021100000_recepcion_fichas`
  (`wallet_cash_topups` y el ciclo de vida de `wallet_cards`).
- API de la recepción en el datáfono (`Authorization: Device …`, topes por IP,
  todo con el `terminalId` en la auditoría):
  - `GET  /v1/pos-device/reception/options`: tarjeta, efectivo (y por qué no) y fichas.
  - `POST /v1/pos-device/reception/cash` `{ amountCents, idempotencyKey, wallet }`: recarga en efectivo.
  - `POST /v1/pos-device/reception/card` `{ amountCents, idempotencyKey, wallet }`:
    prepara la recarga con tarjeta (cobro del datáfono, sin persona) y da la
    referencia para el lector; se confirma con `/charges/:id/result`.
  - `POST /v1/pos-device/reception/lookup` `{ card, uid? }`: de qué saldo es la ficha (sin enseñarlo).
  - `GET  /v1/pos-device/reception/wallets/:id`, `POST …/wallets/:id/card`,
    `POST …/wallets/:id/pin`: el saldo recién recargado en ESTE datáfono (15 min).
  - `POST /v1/pos-device/reception/fichas/token` y `…/fichas/stock`: «Preparar fichas».
- App del personal: `GET /v1/reception/options`, `POST /v1/reception/cash`
  (permiso `cashTopUp`), `POST /v1/reception/lookup`, `POST /v1/reception/fichas/token|stock`.
  Panel: `GET /v1/wallet-cards?q=&status=`, `GET /v1/wallet-cards/summary`,
  `POST /v1/wallet-cards/:id/block|lost`.
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
    pide decidir en la base de datos quién figura como quien lo hizo. (Las
    recargas de la recepción ya lo resuelven: figuran sin persona, con el
    `terminalId` del datáfono.)
