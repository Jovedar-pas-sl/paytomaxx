---
en_sha256: c9914b59d5f740705c00c6f5a3bc093fbcb65f881267e678c81def6e36156da2
---
## 2. Claves y seguridad

**Dónde vive la clave.** En los servidores de la plataforma de cajeros, en su gestor de secretos o en una variable de entorno. **Nunca dentro de cada cajero**: los cajeros hablan con vuestros servidores y son vuestros servidores los que llaman a OxioPay. Una clave sirve para **un local** (una conexión = la plataforma de cajeros × un local): si los cajeros están en dos locales, hay dos claves, y cada cajero usa la de su local.

**Qué puede hacer.** La clave de los cajeros tiene solo `wallet:balance` (ver el saldo) y `wallet:load` (cargar, anular su propia carga, listar sus cargas y su resumen). No puede pagar con saldo, ni cobrar, ni leer ventas. Solo llega a saldos del grupo de su local (la misma comprobación que hace el personal del local) cuyo local de origen, donde se creó el saldo, es de la misma sociedad (mismo CIF) que su local; un local de origen sin sociedad cuenta como otra. Cualquier otro saldo responde `404 wallet_not_found`, igual que uno que no existe.

**Cómo se envía.** Solo en la cabecera `Authorization: Bearer oxp_live_…` (real) o `Bearer oxp_test_…` (demo).
- Nunca en la URL (`400 api_key_in_url`, y al dueño le llega aviso para rotarla) ni en el cuerpo (`400 api_key_in_body`).
- Sin cabecera `Origin`: la API es de servidor a servidor y una petición con `Origin` recibe `403 browser_not_allowed`.
- Cuerpo de 16 KB como mucho (`413 body_too_large`). Un POST sin cuerpo (una anulación sin motivo) va sin `Content-Type`.
- La real no acepta claves de prueba ni la demo claves reales (`401 wrong_environment`).

**Transporte.** Solo `https://`, TLS 1.2 o superior, con la comprobación del certificado encendida. Nunca `http://` (una clave que ha ido por http hay que rotarla) y nunca a través de un proxy que abra el TLS o registre la cabecera `Authorization` o los cuerpos; las IP fijas de salida suelen venir de un proxy así, así que revisadlo. El enlace entre cada cajero y vuestros servidores lleva los mismos secretos (enlace de la ficha, UID del chip, código del móvil): cifradlo también, y apagad cualquier registro del texto leído o de los UID en el cajero, en los SDK de sus lectores NFC y QR y en sus informes de fallos.

**IP fijas, obligatorias en real.** En real, una clave con `wallet:load` solo funciona desde las IP de vuestros servidores que el dueño registró (en la demo es opcional): hasta 10, cada una una sola dirección (IPv4, o un bloque IPv6 /64 si vuestro proveedor os da ese /64 entero solo a vosotros; si no, la dirección suelta), dentro de las que OxioPay tiene declaradas para vuestra empresa. La dirección que se compara es la pública con la que vuestra petición llega al borde de OxioPay: después de vuestro NAT, proxy de salida o pasarela de la nube, no la privada del servidor. Desde otra IP: `403 ip_not_allowed`, el dueño recibe aviso por cada dirección nueva, y con 3 direcciones ajenas en 24 horas se paran las cargas nuevas en todos los cajeros del local (4.6). Así que nunca probéis la clave real desde un portátil, la CI o un servidor de pruebas. Si uno de vuestros servidores recibe `ip_not_allowed`, preguntad al dueño: su panel enseña la dirección rechazada. Da también vuestras IPv6 si vuestros servidores salen por IPv6, o fuerza IPv4 en el cliente: si no, la llamada puede salir por una dirección que no está en la lista.

**Rotación.** La hace el dueño, con su 2FA. La clave nueva se ve una sola vez: OxioPay manda un **enlace de un solo uso** (24 horas) al correo de contacto que vuestra empresa tiene registrado, o el dueño os la da en mano. Abrid el enlace solo cuando vayáis a guardar la clave, en la máquina que la guarda; nunca le hagáis captura ni la peguéis en un chat o un correo. Si el enlace dice que ya no vale y nadie de vuestro equipo lo abrió, avisad al dueño en seguida: otro ha visto la clave y hay que rotarla sin solape. La vieja sigue funcionando durante el solape que elija el dueño (nada si hubo una fuga, 24 horas por defecto, o 7 días); mientras tanto `GET /me` con la clave vieja enseña `key.replaced: true` y `key.expires_at` al final del solape: avisad a vuestros operadores en cuanto lo veáis. Después responde `401 api_key_rotated` durante 30 días, para que veáis por qué falla. Una rotación mantiene la conexión: el mismo id `pc_`, vuestras cargas y vuestros ids de transacción.

**Revocación.** El dueño o el encargado, de un toque. Vale desde la siguiente petición: `401 api_key_revoked`. Si alguna vez sospecháis que la clave se ha filtrado, avisad al dueño para que la rote sin solape.

**Caducidad y reposo.** Una clave con `wallet:load` caduca como mucho a los 365 días (`key.expires_at` en `GET /me`; después `401 api_key_expired`): avisad a vuestros operadores 30 días antes y pedid al dueño una rotación con 7 días de solape. Una clave que no hace ninguna llamada de saldo (saldo, cargas, anulaciones, `/wallet/operations`, `/statement`) en 90 días se suspende (`401 api_key_suspended`) y el dueño la reactiva; `GET /me` solo no la mantiene viva.

**Lo que nunca se registra ni se guarda:**
- **La clave**: ni en logs, ni en el código, ni en el repositorio, ni en los cajeros, ni en URLs.
- **El texto crudo del QR** (el código del móvil o el enlace de la ficha).
- **El número del chip (UID)** más allá de la transacción.
- **Los códigos en vivo** (`OXC1:…`).
- **Los saldos de los clientes** (`available`, `balance_after`): solo en la pantalla y en el tique.
- Y en `description` y en `reference` nada personal: ni teléfonos, ni correos, ni números largos.

Sí se registra, en cada llamada: la cabecera `Request-Id` de la respuesta, el id de la carga (`wl_…`), vuestra `reference`, el importe y el código de error. De un error, registrad `code`, `status`, `request_id`, `param` y `limit`, nunca el cuerpo entero. Si mandáis `X-Request-Id` (letras, cifras y `-`, hasta 64), OxioPay os lo devuelve como `Request-Id`.
