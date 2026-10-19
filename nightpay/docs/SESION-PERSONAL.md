# Sesión del personal: la llave larga en una cookie

Afecta al **panel** (admin), a la **app de la chica** (operator) y al **TPV**.
No cambia nada en la página de pago del cliente ni en el datáfono PAX (que
sigue con su propia credencial de aparato).

## Qué cambia y por qué

Antes, al entrar, cada app guardaba en el navegador (localStorage) dos
llaves: la corta (1 hora) y la larga (30 días, la que renueva la corta). Si
alguien conseguía meter un script en una de las apps (un fallo de seguridad
tipo XSS), se llevaba la llave larga y tenía la sesión de esa persona durante
30 días, desde cualquier sitio.

Ahora:

- **La llave larga va en una cookie que el navegador guarda pero que las apps
  no pueden leer** (HttpOnly). Solo viaja a `api.paytomaxx.com`, solo a las
  direcciones de sesión (`/v1/auth`) y solo por HTTPS. Cada vez que se usa,
  cambia (rotación); si alguien usa una copia vieja, se cierra la sesión
  entera, como antes.
- **La llave corta solo vive en la memoria de cada pestaña.** Al abrir la app
  (o recargarla), la pide con la cookie. En el navegador solo queda quién es
  la sesión (nombre, email, local) para pintar la pantalla; ninguna llave.
- Hay **una cookie por app**: entrar en el TPV no pisa la sesión del panel en
  el mismo ordenador, y un fallo en una app no puede pedir la sesión de otra.

## Qué nota el personal

- **Como mucho, entrar una vez después de la actualización.** Las apps
  nuevas intentan pasar a la cookie la sesión que ya tenían guardada, así que
  la mayoría ni lo notará. Si la versión antigua seguía abierta en otra
  pestaña, esa pestaña pedirá entrar.
- Todo lo demás sigue igual:
  - si la sesión caduca con un cobro abierto en la app de la chica, se entra
    encima sin perder el QR, la cuenta atrás ni el «PAGADO»;
  - si entra otra persona, la app empieza de cero;
  - «Salir» en una pestaña saca también a las otras pestañas de esa app;
  - cambiar de local (super-admin) recarga las otras pestañas del panel;
  - los avisos de «Tu sesión ha caducado» son los mismos.
- Si se borran los datos del navegador (cookies), hay que volver a entrar.

## Lo que hay que configurar

### `CORS_ORIGINS` (ya existía): ahora es obligatoria y exacta

Lista de direcciones de las apps, separadas por comas, **exactamente** como
salen en la barra del navegador, sin barra final:

```
CORS_ORIGINS=https://admin.paytomaxx.com,https://operator.paytomaxx.com,https://tpv.paytomaxx.com,https://pay.paytomaxx.com
```

Una app que no esté en la lista no puede entrar ni renovar la sesión (403).
En producción el API **no arranca** sin `CORS_ORIGINS` o con una dirección mal
escrita (sin `https://`, con barra final o con ruta): el log dice cuál.

### `AUTH_BODY_REFRESH_UNTIL` (nueva, opcional)

Mientras haya móviles u ordenadores con la versión antigua de la app
guardada, el API sigue aceptando la llave larga a la antigua (en la petición)
hasta esta fecha. Después, la app antigua pide entrar otra vez y, al
recargar, ya es la nueva.

- Sin poner: **hasta el martes 1 de diciembre de 2026 a las 12:00 (Madrid)**
  (de día y entre semana: ninguna app pide entrar a mitad de un cobro).
- Otra fecha: ISO con zona, mejor un martes o miércoles a mediodía, p. ej.
  `AUTH_BODY_REFRESH_UNTIL=2026-12-15T12:00:00+01:00`.
- `off`: cerrarla ya (a mano, en cuanto la métrica de abajo lleve días quieta).

Antes de la fecha, en `/v1/metrics` (con `METRICS_TOKEN`) la cuenta
`nightpay_auth_body_refresh_total{client="legacy"}` debería haber dejado de
subir: es la señal de que ya no quedan apps antiguas. `client="migration"`
son las apps nuevas pasando su sesión antigua a la cookie (una vez por
dispositivo).

Cerrar sesión con la llave a la antigua se acepta siempre (solo sirve para
cerrar).

## Reglas contra peticiones falsificadas (CSRF)

Entrar, renovar y salir con la cookie solo se acepta si la petición trae las
dos cosas; si no, el API contesta **403**:

1. La cabecera `Origin` es **exactamente** una de `CORS_ORIGINS` (el navegador
   la pone y una página no la puede falsificar). Sin `Origin`, con `null`, con
   barra al final o desde otro subdominio (incluido el propio API y sus
   páginas de pago): 403.
2. La cabecera propia `X-OxioPay-Client: 1`, que obliga al navegador a pedir
   permiso antes (preflight de CORS). Un formulario o un enlace de otra web no
   pueden mandarla.

Además la cookie es `SameSite=Strict`: el navegador no la manda en
peticiones que empiezan en otra web.

El cambio de local del super-admin va con la llave corta (no con la cookie)
y no necesita estas comprobaciones.

## Cloudflare

- No hace falta tocar nada: Cloudflare pasa `Origin`, la cabecera propia y
  `Set-Cookie` tal cual, y no guarda en caché los `POST`.
- No añadir reglas que quiten cabeceras de las peticiones a `api.` ni
  respuestas en caché para `/v1/auth/*`.

## Si algo va mal

- **Todos tienen que entrar a cada rato, o «Petición no permitida»**: revisa
  que `CORS_ORIGINS` tenga la dirección exacta de esa app (https, sin barra
  final). El log del API dice «Sesión con cookie rechazada (origin)».
- **Un iPhone pide entrar más a menudo de lo normal**: Safari puede acortar la
  vida de las cookies de webs que no se usan en días; basta con entrar.
- **Volver atrás sin esperar**: `AUTH_BODY_REFRESH_UNTIL` alarga la vía
  antigua para las apps de la versión anterior.

Detalle técnico: `apps/api/src/modules/auth/session-cookie.ts`,
`staff-session.transport.ts` y el cliente común `packages/api-client`.
