# OxioCard: continuidad de Wallet y recepción

Fecha: 21 de octubre de 2026. Rama local: `codex/peanpe-wallet-finish`.

## Concepto y punto recuperado

Herramienta interna de cobros y gestión de los locales. El código conserva el
nombre NightPay; OxioPay aparece en la documentación operativa y las maquetas
aprobadas usan OxioCard.

El cliente puede pagar un consumo con tarjeta desde el QR o con su saldo
precargado acercando una ficha NFC. El cobro común admite ambas vías: la primera
que se confirma paga el consumo; una aprobación bancaria tardía se trata como
doble cobro, con devolución o incidencia. La ficha identifica el saldo; el dinero
y las operaciones se registran en el servidor. El NFC de saldo y el cobro
contactless de una tarjeta bancaria son flujos distintos.

La base recuperada es `feat/integ-ola3`, commit `1876bbf`. Ya incluía recargas,
saldo con PIN, flujos de cobro, recepción exprés, gestión de fichas, panel de
encargado/dueño y cierre de noche. La conversación de Claude «Peanpe wallet para
cobros card y peanpe» terminó después de integrar las pantallas de las maquetas A
y aprobar las dos decisiones que se implementan aquí. El objetivo actual es
Android; no se ha reactivado PAX. Redsys/BBVA es la integración bancaria efectiva;
la existencia del adaptador Peanpe no demuestra su validación en producción.

## Fichas con número impreso

1. En recepción, abrir **Preparar fichas** y acercar la ficha original.
2. Si no tiene número registrado, copiar sus cifras de fábrica, incluidos los
   ceros iniciales, y pulsar **Guardar y seguir**.
3. La ficha se cuenta después de guardar el número. Una ya numerada lo conserva.
4. Se puede buscar ese número desde recepción y desde el panel de fichas.

El número es texto de 1–12 cifras y único. Se guarda en `printedNumber`; el número
interno anterior se conserva para compatibilidad. Solo se numeran fichas
disponibles del stock del local, comprobando el UID original y los permisos.
Buscar por número permite consultar el estado, pero no devuelve credenciales NFC
ni autoriza una devolución de efectivo.

## Salida de recepción

1. Abrir **Salida**, acercar el NFC original y revisar el importe que puede salir
   en efectivo.
2. El cliente confirma con su PIN en el teléfono de recepción. No necesita abrir
   su propia página de saldo.
3. Hasta 100 € se puede devolver desde recepción, salvo que el local exija una
   aprobación antes. Solo sale la parte procedente de efectivo.
4. Por encima de ese límite, la solicitud queda pendiente y la pantalla indica
   que todavía no se ha devuelto dinero. El encargado la confirma desde su panel
   con su propia 2FA; no introduce su código en la sesión de otro trabajador.
5. Una devolución completada muestra **DEVUELTO**. Si el saldo queda a cero, la
   ficha vuelve al stock; si queda saldo de tarjeta, sigue vinculada al cliente.

El encargado usa su 2FA para efectivo desde el umbral del local, limitado a
100 €, tanto en la nueva ruta como en la confirmación administrativa. Se mantiene
la autoridad y los permisos existentes del dueño. El PIN conserva su contador y
su bloqueo tras intentos fallidos. Los reintentos de la misma petición conservan
un recibo y no vuelven a descontar dinero.

## Instalación y comprobación

Se añaden las migraciones `20261025000000_ficha_printed_number` y
`20261025010000_recepcion_salida_nfc`. El despliegue debe ejecutar el procedimiento
habitual de migraciones y regenerar Prisma. Los campos nuevos son opcionales, de
modo que las fichas y devoluciones existentes siguen siendo legibles.

Las comprobaciones de esta rama se registran al terminar en el plan
[de implementación](superpowers/plans/2026-10-21-peanpe-wallet-finish.md).
Se usa una base PostgreSQL temporal local con un rol sin superusuario; no se
ejecutan cobros ni migraciones contra producción.

## Pendiente

- Regla de comisión de OxioPay: pendiente por indicación del usuario. Se conserva
  el cálculo existente, sin darlo por aprobado.
- Comisión bancaria de BBVA: desconocida; no se estima.
- Validación en Android con lector y fichas reales: preparación, búsqueda de
  `0522`, PIN, devolución, saldo mixto y confirmación del encargado.
- Comprobación visual en navegador: el navegador integrado no estaba disponible
  en esta sesión.
- Revisión y despliegue del resultado; la rama local no equivale a producción.

El documento histórico `ESTADO-DEL-PROYECTO.md` es de mayo de 2026. Sus porcentajes,
pasarelas y fases no sustituyen las decisiones recuperadas en esta continuidad.
