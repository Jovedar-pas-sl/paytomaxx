# Google Wallet: el saldo del cliente en su móvil Android

Con esto, en la página del saldo del cliente (`/w/...`) sale el botón negro
oficial **«Añadir a Google Wallet»** (solo en móviles Android). El cliente lo
toca y guarda en Google Wallet una tarjeta con:

- la marca (OxioPay) y el nombre del local;
- el **saldo que le queda**, bien grande;
- un **código QR** que solo sirve para cobrarle en el datáfono (con su PIN);
  la página de su saldo se abre con el enlace «Ver mi saldo» de dentro.

La tarjeta **se actualiza sola**: cuando gasta, recarga o se le devuelve el
saldo, en unos 2 minutos cambia en su móvil. Cuando el saldo se cierra
(devuelto o caducado) pasa a «Pases caducados».

Mientras no pongas las variables del paso 6, el botón no sale y no pasa nada.

Tiempo: unos 30 minutos de tu parte, más lo que tarde Google en aprobar la
publicación (paso 7). Coste: 0 € (la API de Google Wallet es gratis).

Necesitas una cuenta de Google de la empresa (mejor que la personal) y un
móvil Android con esa u otra cuenta de Google para probar.

---

## 1. Crear la cuenta de emisor (Google Pay & Wallet Console)

1. Entra en <https://pay.google.com/business/console> con la cuenta de Google
   de la empresa. Esa cuenta quedará como **administradora**.
2. Rellena el formulario con el **nombre público del negocio** (el que verán
   los clientes, p. ej. «OxioPay») y acepta las condiciones.
3. En el panel, en la tarjeta **Google Wallet API**, pulsa **Create a pass**
   (Crear un pase) y luego **Build your first pass**; acepta las condiciones de
   la Google Wallet API. Ya tienes cuenta de emisor.
4. Abre **Google Wallet API** en el menú. Arriba verás el **Issuer ID** (ID de
   emisor): un número largo. **Apúntalo**: es `GOOGLE_WALLET_ISSUER_ID`.

La cuenta empieza en **modo demo**: los pases solo se pueden guardar en las
cuentas de prueba y salen con «[TEST ONLY]» delante. Así se prueba sin que lo
vea ningún cliente (paso 8).

## 2. Rellenar el perfil del negocio

En la consola, menú de la izquierda → **Business profile** (Perfil de la
empresa): datos de la empresa y dirección. Google lo pide para dar permiso de
publicación (paso 7).

## 3. Crear el proyecto de Google Cloud y activar la API

1. Entra en <https://console.cloud.google.com> con la misma cuenta.
2. Arriba, en el selector de proyectos → **Proyecto nuevo** → nombre
   `oxiopay-wallet` → **Crear**. Comprueba que arriba sale ese proyecto.
3. Busca **Google Wallet API** en la barra de búsqueda (o en
   <https://console.cloud.google.com/apis/library/walletobjects.googleapis.com>)
   → **Habilitar** (Enable). Tarda unos segundos.

## 4. Crear la cuenta de servicio y su clave JSON

La «cuenta de servicio» es el usuario con el que el servidor de OxioPay habla
con Google. No es una persona.

1. En Google Cloud → menú ☰ → **IAM y administración** → **Cuentas de
   servicio** → **Crear cuenta de servicio**.
2. Nombre: `oxiopay-wallet` → **Crear y continuar** → no hace falta darle
   ningún rol → **Listo**.
3. Apunta su **correo** (algo como
   `oxiopay-wallet@oxiopay-wallet.iam.gserviceaccount.com`).
4. Pulsa en la cuenta → pestaña **Claves** (Keys) → **Agregar clave** →
   **Crear clave nueva** → tipo **JSON** → **Crear**. Se descarga un fichero
   `.json`.

**Ese fichero es una contraseña.** Guárdalo en un sitio seguro (tu gestor de
contraseñas). No lo mandes por WhatsApp ni por correo y no lo subas a ninguna
web «para convertirlo». Si alguna vez se filtra: Google Cloud → la cuenta de
servicio → **Claves** → bórrala, crea otra y cambia la variable del paso 6.

## 5. Dar permiso a la cuenta de servicio en la consola de Wallet

1. Vuelve a <https://pay.google.com/business/console>.
2. Menú de la izquierda → **Users** (Usuarios) → **Invite a user** (Invitar a
   un usuario).
3. Pega el **correo de la cuenta de servicio** del paso 4.3.
4. En **Access level** elige **Developer** → **Invite**.

Sin esto, Google contesta «permiso denegado» y el cliente ve «Google Wallet
no responde ahora».

## 6. Ponerlo en Dokploy

El fichero JSON ocupa varias líneas y Dokploy espera cada variable en una
línea, así que se pega **en base64** (el mismo contenido, en una sola línea).
Para sacarlo **en tu ordenador** (nunca en una web):

- **Windows** (PowerShell; cambia la ruta por la de tu fichero):

  ```powershell
  [Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\Users\TU_USUARIO\Downloads\oxiopay-wallet-xxxx.json")) | Set-Clipboard
  ```

- **Mac** (Terminal):

  ```bash
  base64 -i ~/Downloads/oxiopay-wallet-xxxx.json | tr -d '\n' | pbcopy
  ```

Queda copiado. Ahora:

1. Dokploy → proyecto → **nightpay-api** → pestaña **Environment**.
2. Añade estas líneas (sin espacios alrededor del `=`):

   ```
   GOOGLE_WALLET_ISSUER_ID=el número del paso 1.4
   GOOGLE_WALLET_SERVICE_ACCOUNT_JSON_B64=lo que acabas de copiar
   ```

   `GOOGLE_WALLET_CLASS_SUFFIX` no hace falta (por defecto `oxiopay_saldo`).
   Si en el futuro tienes una segunda instalación (pruebas) con el mismo
   emisor, ponle allí otro nombre, p. ej. `GOOGLE_WALLET_CLASS_SUFFIX=oxiopay_pruebas`.
3. **Save** → **Redeploy**.
4. Mira **Logs** de `nightpay-api` al arrancar. Si algo está mal escrito sale
   una línea `Google Wallet queda apagado (el botón no sale): ...` que dice qué
   falla (nunca enseña la clave). El API arranca igual: los cobros no se
   paran por esto. Corrígelo y vuelve a desplegar.

(Si prefieres pegar el JSON tal cual, existe `GOOGLE_WALLET_SERVICE_ACCOUNT_JSON`,
pero tiene que ir en una sola línea; con base64 no hay que pensar. Pon solo
una de las dos.)

## 7. Pedir permiso para publicar

Para que lo puedan guardar **todos** los clientes (no solo las cuentas de
prueba) Google tiene que aprobarlo:

1. Haz primero la prueba del paso 8: así Google ya ve la clase de pase creada
   (la crea el servidor la primera vez que alguien pulsa el botón).
2. Consola → **Google Wallet API** → en el recuadro **Get publishing access**
   pulsa **Request publishing access**.
3. Google revisa la cuenta y el perfil del negocio y avisa por correo cuando
   lo aprueba. Ya no piden capturas.

El pase solo lleva la marca, el nombre del local, el saldo y el QR: nada que
pueda dar problemas en la revisión.

## 8. Probar antes de publicar

En modo demo solo pueden guardarlo la cuenta administradora, los
desarrolladores y las **cuentas de prueba**:

1. Consola → **Google Wallet API** → pestaña **Manage** → **Set up test
   accounts** → escribe el correo de Google del móvil Android con el que vas a
   probar (uno por línea) → **Update testers**.
2. En ese móvil: haz una recarga pequeña de prueba y abre la página de su
   saldo (el enlace `/w/...`).
3. Debajo de las opciones («Elegir un PIN», «Me voy…») sale el botón negro
   **Añadir a Google Wallet**.
   Tócalo: se abre Google Wallet con la tarjeta (con «[TEST ONLY]» en el
   título mientras no esté publicado) → **Guardar**.
4. Gasta algo del saldo (o pide «Me voy» y devuélvelo). En unos 2 minutos el
   saldo de la tarjeta cambia solo; al devolverlo todo, pasa a «Pases
   caducados».

Si en vez de la tarjeta sale «Google Wallet no responde ahora»: mira los
**Logs** de `nightpay-api`; la línea `Google Wallet: no se pudo...` dice qué
contestó Google. Lo normal es que falte el paso 3.3 (API sin habilitar) o el
paso 5 (cuenta de servicio sin invitar), o que el Issuer ID no sea el de esa
cuenta.

## 9. Qué ve el cliente

- **En Android**, en la página de su saldo, el botón oficial «Añadir a Google
  Wallet» debajo de las opciones (en iPhone no sale: Apple Wallet vendrá
  después).
- Al tocarlo, Google Wallet le enseña la tarjeta y pulsa **Guardar**.
- En la tarjeta: arriba **OxioPay**, el **nombre del local**, el **saldo** en
  grande y un **QR**. Dentro, «Cómo se paga» y un enlace «Ver mi saldo».
- **Para verla tiene que desbloquear el móvil** (huella, cara o PIN), y solo
  la puede guardar una cuenta de Google: si otro consigue el enlace, no puede
  guardarla también.
- El saldo **se pone al día solo** (unos 2 minutos). Si el saldo se devuelve,
  caduca o se suma a otro saldo suyo, la tarjeta pasa a «Pases caducados».
- En la tarjeta **no hay PIN ni código** para pagar: para pagar sigue
  escaneando el QR del personal o diciendo su código y su PIN.
- Si le das un **enlace nuevo** a su saldo (móvil perdido), su tarjeta vieja
  se apaga («Enlace antiguo») y deja de recibir el saldo. Desde el enlace
  nuevo puede añadirla otra vez.

El QR de la tarjeta (`/c/...`) solo sirve para cobrarle en el datáfono: el
cliente teclea su PIN. Un móvil que lo escanee no abre nada (ni su saldo, ni
«Me voy», ni el Face ID). La página de su saldo se abre con «Ver mi saldo»,
dentro de la tarjeta, y por eso Google pide desbloquear el móvil para
enseñarla. Los pases hechos antes de este cambio (con el QR del enlace `/w/...`)
se ponen al día solos en el primer repaso tras la migración
`20261022100000_pase_qr_solo_cobro`; mientras tanto, el datáfono acepta los dos.

---

Documentación de Google usada:
<https://developers.google.com/wallet/generic>,
<https://developers.google.com/wallet/generic/getting-started/issuer-onboarding>,
<https://developers.google.com/wallet/generic/getting-started/auth/rest>,
<https://developers.google.com/wallet/generic/test-and-go-live/request-publishing-access>,
<https://developers.google.com/wallet/generic/resources/brand-guidelines>.
