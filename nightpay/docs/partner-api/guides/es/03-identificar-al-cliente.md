---
en_sha256: 4ed6c5ab2a669cdb1fd6f5851f99cfdcfbca14bb088e47dcdb529d0a997da9c6
---
## 3. Identificar al cliente

El cajero lee **una de estas dos cosas** y la manda tal cual en `qr`. Nunca manda un código tecleado, un teléfono, un id interno ni un PIN. Manda solo textos que empiecen por `OXC1:`, `NPF:` o `https://`, o que sean exactamente 6 letras o cifras; lo demás (tarjetas de contacto, códigos de wifi, QR de otros pagos, texto suelto) no es de OxioPay: enseña el texto «No reconocemos este código» sin llamar.

**1. El código del móvil (código en vivo).** El cliente abre su página del saldo en el móvil y pulsa «Pagar o recargar en otro sistema». El botón sale en el idioma de la página del cliente: en inglés, "Pay or top up in another system". Sale un QR con un texto `OXC1:` + 26 caracteres, por ejemplo `OXC1:K3J7Q2M9X4T8R6V1N5B0C2D7F9`.
- En el piloto este código **solo identifica**: sirve para ver el saldo y cargar. Ver el saldo o cargar no lo gastan.
- Cada código vale **60 segundos**. La página lo renueva cada 45 segundos durante 5 minutos desde que el cliente pulsó el botón; después tiene que volver a pulsarlo.
- El lector debe leer QR en la pantalla de un móvil (QR en modo alfanumérico, en mayúsculas). Pon el lector en modo serie (COM virtual / USB-CDC, o su SDK), no como teclado, y quítale el prefijo o sufijo que añada: como teclado, `:` y `/` pueden salir como otros caracteres, y el texto pasa por la entrada de teclado del sistema operativo.

**2. La ficha por NFC.** La ficha lleva grabado un enlace `https://<host>/?ficha=<código>` en un registro NDEF de tipo URI.
- Manda en `qr` el enlace completo, con el prefijo del registro ya expandido (`https://…`), tal como lo abriría un móvil.
- Manda en `nfc_uid` el número de serie del chip (UID) en hexadecimal, en el orden en que lo envía el chip: el que dan Android (`Tag.getId()`) y PC/SC `GET DATA` (`FF CA 00 00 00`), y el que guarda OxioPay. Las fichas NTAG213/215/216 de los locales tienen 7 bytes que empiezan por `04` (`04A1B2C3D4E5F6`). Con o sin `:`, `-` o espacios entre bytes. **Nunca al revés ni en decimal**: algunos lectores lo dan así, y entonces cada ficha buena con número guardado responde `409 ficha_copy_suspected` y el dueño recibe aviso. Mándalo siempre que leas la ficha por NFC, y solo entonces: con un código del móvil es un error (`422 validation_failed`).
- Si OxioPay tiene guardado otro número para esa ficha, es una copia: `409 ficha_copy_suspected` (y el dueño recibe aviso). Una ficha sin número guardado, o un enlace de ficha mandado sin `nfc_uid`, se acepta como un enlace normal (entonces no se puede detectar una copia). OxioPay nunca guarda el número que mandas.
- Una ficha impresa como QR (el mismo enlace) también vale, como enlace normal.

**Antes de pedir el dinero**, identifica con `POST /wallet/balance`: los rechazos del saldo y de la ficha llegan antes de que el cliente meta billetes. Los del local (sus interruptores, pausas y tope de la noche) y los topes de cada saldo solo llegan con la carga; entonces el depósito devuelve los billetes (4.2).

**Lo que se rechaza y qué decirle al cliente.** OxioPay rechaza todo lo que no sea uno de esos dos. Con `422 wallet_ref_not_accepted` el campo `reason` dice qué enseñó el cliente. El rechazo depende solo de la forma del texto: la respuesta es la misma tanto si el enlace vale como si es desconocido o de otra sociedad.

| Lo que enseñó | Respuesta | Texto al cliente (ES) | Texto al cliente (EN) |
|---|---|---|---|
| La tarjeta de Google Wallet (`https://<host>/c/…`) | `422 wallet_ref_not_accepted`, `reason: wallet_pass` | La tarjeta de Google Wallet no sirve en el cajero. Abre tu página del saldo y pulsa «Pagar o recargar en otro sistema», o acerca tu ficha. | The Google Wallet card does not work at this machine. Open your balance page and tap "Pay or top up in another system", or tap your NFC tag. |
| El enlace privado de su saldo (`…/w/<código>` o una de sus páginas) | `reason: private_link` (el dueño recibe aviso) | Ese es el enlace privado de tu saldo: no lo enseñes a nadie. Abre tu página y pulsa «Pagar o recargar en otro sistema». | That is the private link to your balance: never show it to anyone. Open your page and tap "Pay or top up in another system". |
| El QR de recepción (`NPF:…`) | `reason: reception_qr` | Ese QR es para recoger tu ficha en recepción. Acerca tu ficha o enseña el código de «Pagar o recargar en otro sistema». | That QR is for collecting your NFC tag at reception. Tap your NFC tag or show the code from "Pay or top up in another system". |
| El código de 6 letras (o un enlace con `?saldo=`) | `reason: short_code` | El código de 6 letras no sirve en el cajero. Acerca tu ficha o enseña el código de tu página del saldo. | The 6-character code does not work at this machine. Tap your NFC tag or show the code on your balance page. |
| El enlace de un cobro (`/s/…`, `/pay/…`) | `reason: charge_link` | Eso es un cobro, no tu saldo. Enseña el código de «Pagar o recargar en otro sistema». | That is a payment request, not your balance. Show the code from "Pay or top up in another system". |
| Un enlace de activación, de reserva o de regalo, u otro enlace `/w/` (`/w/a/…`, `/w/card/…`, `/w/salida/…`, `/w/no/…`) | `reason: other_link` | Ese enlace no es tu saldo. Abre tu página del saldo y pulsa «Pagar o recargar en otro sistema». | That link is not your balance. Open your balance page and tap "Pay or top up in another system". |
| Cualquier otra cosa | `422 wallet_ref_unrecognized` | No reconocemos este código. Acerca tu ficha o enseña el código de tu página del saldo. | We do not recognise this code. Tap your NFC tag or show the code on your balance page. |
| Un código del móvil caducado o desconocido | `422 live_code_invalid` | El código ha caducado. Vuelve a enseñarlo. | The code has expired. Please show it again. |

Y los rechazos del saldo o de la ficha (con el mismo texto en el capítulo 5):

| Respuesta | Qué pasa | Texto al cliente (ES) | Texto al cliente (EN) |
|---|---|---|---|
| `404 wallet_not_found` | No existe, o es de otro grupo, o de un local de otra sociedad | Este saldo no se puede cargar en este cajero. | This balance cannot be topped up at this machine. |
| `409 wallet_blocked` | Saldo bloqueado | Este saldo está bloqueado. Habla con el personal. | This balance is blocked. Please speak to the staff. |
| `409 wallet_closed` | Saldo cerrado | Este saldo está cerrado. Habla con el personal. | This balance is closed. Please speak to the staff. |
| `409 ficha_lost` | Ficha dada como perdida | Esta ficha está dada de baja. Si es tuya, ve a recepción. | This NFC tag has been reported lost. If it is yours, please go to reception. |
| `409 ficha_blocked` | Ficha bloqueada | Esta ficha está bloqueada. Ve a recepción. | This NFC tag is blocked. Please go to reception. |
| `409 ficha_copy_suspected` | El número del chip no es el de la ficha | Esta ficha no se puede usar aquí. Ve a recepción. | This NFC tag cannot be used here. Please go to reception. |

Un saldo vacío no es un error: `available: 0`, y una carga lo vuelve a abrir.
