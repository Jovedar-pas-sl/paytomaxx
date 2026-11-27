## 3. Identifying the customer

The ATM reads **one of these two things** and sends it as is in `qr`. It never sends a typed code, a phone number, an internal id or a PIN. Send only texts that start with `OXC1:`, `NPF:` or `https://`, or that are exactly 6 letters or digits; anything else (contact cards, Wi-Fi codes, other payment QRs, plain text) is not OxioPay's: show the «No reconocemos este código» text without calling.

**1. The phone code (live code).** The customer opens their balance page on their phone and taps «Pagar o recargar en otro sistema». The button follows the language of the customer's page: in English, "Pay or top up in another system". A QR appears holding the text `OXC1:` + 26 characters, for example `OXC1:K3J7Q2M9X4T8R6V1N5B0C2D7F9`.
- In the pilot this code **only identifies**: it serves to read the balance and to load. Reading the balance or loading does not use it up.
- Each code is valid for **60 seconds**. The page renews it every 45 seconds for 5 minutes from when the customer tapped the button; after that they have to tap it again.
- The reader must read QR codes from a phone screen (QR in alphanumeric mode, uppercase). Set the scanner to serial mode (virtual COM / USB-CDC, or its SDK), not keyboard emulation, and turn off any prefix or suffix it adds: with keyboard emulation `:` and `/` can come out as other characters, and the text passes through the operating system's keyboard input.

**2. The ficha by NFC.** The ficha (the venue's NFC tag) carries a link `https://<host>/?ficha=<code>` written in an NDEF record of type URI.
- Send in `qr` the full link, with the record's prefix already expanded (`https://…`), exactly as a phone would open it.
- Send in `nfc_uid` the chip's serial number (UID) in hexadecimal, in the order the chip sends it: the order Android (`Tag.getId()`) and PC/SC `GET DATA` (`FF CA 00 00 00`) give, and the one OxioPay stores. The venues' NTAG213/215/216 fichas have 7 bytes starting with `04` (`04A1B2C3D4E5F6`). With or without `:`, `-` or spaces between bytes. **Never reversed and never as a decimal number**: some readers give it that way, and then every genuine ficha with a stored number answers `409 ficha_copy_suspected` and the owner gets an alert. Send it whenever you read the ficha by NFC, and only then: with a phone code it is an error (`422 validation_failed`).
- If OxioPay has a different number stored for that ficha, it is a copy: `409 ficha_copy_suspected` (and the owner gets an alert). A ficha with no stored number, or a ficha link sent without `nfc_uid`, is accepted as a plain link (a copy cannot be detected then). OxioPay never stores the number you send.
- A ficha printed as a QR (the same link) also works, as a plain link.

**Before asking for the money**, identify with `POST /wallet/balance`: the refusals of the wallet and of the ficha arrive before the customer inserts any notes. The venue's refusals (its switches, pauses and night limit) and the per-wallet limits only come with the load; the escrow then gives the notes back (4.2).

**What is refused and what to tell the customer.** OxioPay refuses anything that is not one of those two. With `422 wallet_ref_not_accepted`, the field `reason` says what the customer showed. The refusal depends only on the shape of the text: the answer is the same whether the link is valid, unknown or of another company.

| What they showed | Response | Text for the customer (ES) | Text for the customer (EN) |
|---|---|---|---|
| The Google Wallet card (`https://<host>/c/…`) | `422 wallet_ref_not_accepted`, `reason: wallet_pass` | La tarjeta de Google Wallet no sirve en el cajero. Abre tu página del saldo y pulsa «Pagar o recargar en otro sistema», o acerca tu ficha. | The Google Wallet card does not work at this machine. Open your balance page and tap "Pay or top up in another system", or tap your NFC tag. |
| The private link to their wallet (`…/w/<code>` or one of its pages) | `reason: private_link` (the owner gets an alert) | Ese es el enlace privado de tu saldo: no lo enseñes a nadie. Abre tu página y pulsa «Pagar o recargar en otro sistema». | That is the private link to your balance: never show it to anyone. Open your page and tap "Pay or top up in another system". |
| The reception QR (`NPF:…`) | `reason: reception_qr` | Ese QR es para recoger tu ficha en recepción. Acerca tu ficha o enseña el código de «Pagar o recargar en otro sistema». | That QR is for collecting your NFC tag at reception. Tap your NFC tag or show the code from "Pay or top up in another system". |
| The 6-character code (or a link with `?saldo=`) | `reason: short_code` | El código de 6 letras no sirve en el cajero. Acerca tu ficha o enseña el código de tu página del saldo. | The 6-character code does not work at this machine. Tap your NFC tag or show the code on your balance page. |
| A charge link (`/s/…`, `/pay/…`) | `reason: charge_link` | Eso es un cobro, no tu saldo. Enseña el código de «Pagar o recargar en otro sistema». | That is a payment request, not your balance. Show the code from "Pay or top up in another system". |
| An activation, reservation or gift link, or another `/w/` link (`/w/a/…`, `/w/card/…`, `/w/salida/…`, `/w/no/…`) | `reason: other_link` | Ese enlace no es tu saldo. Abre tu página del saldo y pulsa «Pagar o recargar en otro sistema». | That link is not your balance. Open your balance page and tap "Pay or top up in another system". |
| Anything else | `422 wallet_ref_unrecognized` | No reconocemos este código. Acerca tu ficha o enseña el código de tu página del saldo. | We do not recognise this code. Tap your NFC tag or show the code on your balance page. |
| An expired or unknown phone code | `422 live_code_invalid` | El código ha caducado. Vuelve a enseñarlo. | The code has expired. Please show it again. |

And the refusals of the wallet or the ficha (with the same text in chapter 5):

| Response | What is going on | Text for the customer (ES) | Text for the customer (EN) |
|---|---|---|---|
| `404 wallet_not_found` | It does not exist, or it belongs to another group, or to a venue of another company | Este saldo no se puede cargar en este cajero. | This balance cannot be topped up at this machine. |
| `409 wallet_blocked` | Wallet blocked | Este saldo está bloqueado. Habla con el personal. | This balance is blocked. Please speak to the staff. |
| `409 wallet_closed` | Wallet closed | Este saldo está cerrado. Habla con el personal. | This balance is closed. Please speak to the staff. |
| `409 ficha_lost` | Ficha reported lost | Esta ficha está dada de baja. Si es tuya, ve a recepción. | This NFC tag has been reported lost. If it is yours, please go to reception. |
| `409 ficha_blocked` | Ficha blocked | Esta ficha está bloqueada. Ve a recepción. | This NFC tag is blocked. Please go to reception. |
| `409 ficha_copy_suspected` | The chip number is not the ficha's | Esta ficha no se puede usar aquí. Ve a recepción. | This NFC tag cannot be used here. Please go to reception. |

An empty wallet is not an error: `available: 0`, and a load reopens it.
