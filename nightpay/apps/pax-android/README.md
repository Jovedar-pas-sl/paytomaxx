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

## Compilar

Sin Android Studio: en GitHub → Actions → **pax-android** → *Run workflow*.
El APK de prueba sale en *Artifacts* de la ejecución.

Con Android Studio: abrir esta carpeta y `gradle assembleDebug` (Gradle 8.7, JDK 17).

## Instalar en los datáfonos

Los PAX de producción solo instalan apps a través de **PAXSTORE** de Paytef:
hay que pedirles que publiquen el APK (y quién lo firma). Para probar,
Paytef puede dar un terminal de desarrollo que acepta APKs sin firmar.

## Ajustes

Pulsando **atrás cinco veces seguidas** se abre el ajuste de la clave de la
Device API (`X-Api-Key`), si Paytef la ha activado. Se guarda en el propio
datáfono (SharedPreferences: el aparato es de uso exclusivo del local).

## Pendiente de confirmar con Paytef

- Que la Device API esté activa en nuestros PAX, con clave y HTTPS.
- Importe en céntimos (`requestedAmount`) y longitud de `transactionReference`
  (usamos 20 caracteres: `NP` + id del cobro).
- Formato exacto de los errores y de la lista de `manageWorkShift`.
