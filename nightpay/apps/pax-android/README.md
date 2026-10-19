# App NightPay para el datáfono PAX

App Android mínima que se instala en los datáfonos PAX de Paytef. Abre la
pantalla `https://operator.paytomaxx.com/pax` y le da acceso al lector a
través de la Device API de Paytef en el propio aparato (`127.0.0.1:8887`).
Toda la lógica está en la web y en la API: la app casi nunca hay que tocarla.

## Cómo funciona

1. En el panel: **Datáfonos → Vincular app** da un código de 8 letras (15 min).
2. En el datáfono, la app pide ese código una vez y queda vinculada.
3. El camarero ve los cobros por datáfono de las chicas, toca uno, el cliente
   acerca la tarjeta y el resultado vuelve a NightPay: cobro pagado, con la
   tarjeta y el número de operación de Paytef. Nadie teclea el ticket.
4. **Cuadrar con el datáfono** compara las ventas de la jornada del datáfono
   con NightPay; las que faltan salen en Incidencias.

Contrato del puente web ↔ app: `apps/operator/src/lib/pax-bridge.ts`.

## Cobrar con saldo (app 0.2+)

La pantalla /pax también cobra del saldo del cliente con su PIN tecleado en
el datáfono (ver `docs/DATAFONO-SALDO.md`). Para eso la app expone:

- `capabilities` → si hay NFC de Android (`ready`, `disabled`, `unavailable`) y cámara.
- `scanQr` → abre la cámara trasera (`ScanActivity`, ZXing) y devuelve el texto del QR.
- `readNfc` → modo lector de Android (NFC-A, fichas NTAG213/215/216): `{ uid, url }`.
- `cancelRead` → corta la espera de la ficha (también la de `writeNfc`).

## Recepción y «Preparar fichas» (app 0.3+)

- `writeNfc { url, onlyIfBlank, timeoutMs }` → graba el enlace de la ficha
  (un registro NDEF URI; una ficha de fábrica sin formatear se formatea con
  él) y devuelve `{ uid, url, written }`. Con `onlyIfBlank` (por defecto), una
  ficha que ya tiene algo no se toca: `written: false` y `url` lo que tenía.
  Solo graba enlaces `…/?ficha=<código>` del dominio de la pantalla
  (`PAX_URL`). Errores: `readOnly`, `tooSmall`, `writeFailed`, `timeout`,
  `cancelled`, `nfcUnavailable`, `nfcDisabled`.

Única dependencia: `com.google.zxing:core:3.3.3` (Java puro, sin AndroidX ni
Google Play, que los PAX no traen; la 3.4+ pide Android 7). Permisos:
`CAMERA` (se pide al abrir la cámara) y `NFC`; cámara y NFC son opcionales en
el manifiesto. Si el A920 Pro no deja el NFC a Android (lo reserva el lector
de tarjetas), `capabilities` dice `unavailable` y la pantalla usa el QR o el
código del cliente.

## Compilar

Sin Android Studio: en GitHub → Actions → **pax-android** → *Run workflow*.
En *Artifacts* de la ejecución sale el APK de prueba (debug) y, si están los
secretos de firma, el APK de producción firmado (release). El `versionCode` es
el número de la ejecución: cada APK sube de versión y se instala encima del
anterior.

Secretos de firma (GitHub → Settings → Secrets and variables → Actions):
`PAX_KEYSTORE_BASE64` (el `.jks` en base64: `base64 -w0 pax.jks`),
`PAX_KEYSTORE_PASSWORD`, `PAX_KEY_ALIAS` y `PAX_KEY_PASSWORD`. Guarda el
`.jks` y sus contraseñas también fuera de GitHub: sin esa misma clave no se
puede publicar una actualización de la app.

Con Android Studio / Gradle 8.7 y JDK 17: `gradle assembleDebug`
(`-PversionCode=N` para fijar la versión; para firmar el release, las
variables de entorno `PAX_KEYSTORE_FILE`, `PAX_KEYSTORE_PASSWORD`,
`PAX_KEY_ALIAS` y `PAX_KEY_PASSWORD`). No hay Gradle wrapper en el repo:
generarlo pide tener Gradle instalado (`gradle wrapper --gradle-version 8.7`).

## Instalar en los datáfonos

Los PAX de producción solo instalan apps a través de **PAXSTORE** de Paytef:
hay que pedirles que publiquen el APK (y quién lo firma). Para probar,
Paytef puede dar un terminal de desarrollo que acepta APKs sin firmar.

## Ajustes

Pulsando **atrás cinco veces seguidas** se abre el ajuste de la clave de la
Device API (`X-Api-Key`), si Paytef la ha activado. Se guarda en el propio
datáfono (SharedPreferences: el aparato es de uso exclusivo del local).

## Pendiente de confirmar con Paytef

- Que el NFC del A920 Pro se pueda usar desde una app con `NfcAdapter`
  (fichas del saldo) sin chocar con el lector de tarjetas; si no, la API
  PICC del SDK de PAX (ver `docs/DATAFONO-SALDO.md`).

- Que la Device API esté activa en nuestros PAX, con clave y HTTPS.
- Importe en céntimos (`requestedAmount`) y longitud de `transactionReference`
  (usamos 20 caracteres: `NP` + id del cobro).
- Formato exacto de los errores y de la lista de `manageWorkShift`.
