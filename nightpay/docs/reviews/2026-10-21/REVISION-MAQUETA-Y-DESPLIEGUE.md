# Revisión de la maqueta y candidato para la web actual

21 de octubre de 2026. Se recuperó la conversación de Claude «Peanpe wallet para
cobros card y peanpe», la maqueta OxioCard y la elección de A en todas las opciones.
El usuario confirma que ya realizó pruebas reales y pide preparar el despliegue
en la web actual. Las comisiones de OxioPay y BBVA siguen pendientes.

## Qué está implementado

| Maqueta | Resultado de la revisión |
| --- | --- |
| Cobrar A | Losetas por sección, cuenta y otro importe; cobro único con tarjeta QR y saldo NFC |
| Invitaciones | Selección de chica mediante QR y reparto configurado |
| Esperando / PIN / resultado | Flujo conectado; el primer pago gana y una aprobación bancaria tardía se trata aparte |
| Recepción 4.1–4.5 | Entrada/Salida, NFC primero, importe rápido, método, cargado, guardar o devolver |
| Recargar saldo 4.6–4.7 | Saldo identificado antes del pago y asignación pendiente como recuperación |
| Mapa del dinero A | Barras apiladas con datos reales; noche abierta y cierre congelado |
| Fichas del saldo y del personal | Vistas conectadas a los endpoints correspondientes |
| Decisiones finales de Claude | Número impreso literal y buscable; devolución con NFC original + PIN; encargado y 2FA por encima de 100 € |

La pantalla del cliente `/w` funciona, pero su composición actual no reproduce
por completo la pantalla 5.1. El autoservicio **He perdido mi NFC** de 5.2 todavía
no está implementado; el bloqueo administrativo sí existe. El **kiosco autónomo**,
la **mesa compartida con invitados/topes** y **dividir cuentas** son pantallas de la
maqueta que permanecían en fases posteriores del plan. Esta entrega no las
presenta como disponibles.

## Comprobación visual nueva

Se arrancó el operador compilado en localhost y se revisó con Chromium headless
a 390 × 844. La API y la lectura NFC se interceptaron con datos de prueba: no hubo
peticiones a producción ni cobros reales. El navegador integrado no estaba
disponible; se usó el navegador de las pruebas locales del proyecto.

Once capturas, sin errores JavaScript, peticiones API inesperadas ni desbordamiento
horizontal. Recorridos comprobados: losetas y selección de copa; entrada → importe
→ método; salida → guardar; salida → PIN → pendiente del encargado; error de ficha
y búsqueda de `000522`, que conserva ceros y exige NFC original para devolver.
También se verificó por HTTP que operador y administración sirven HTML, JS y CSS.

Capturas con datos simulados:

- [Cobrar, losetas A](barra-cobrar.png).
- [Recepción, cómo paga](recepcion-metodo.png).
- [Salida pendiente del encargado](recepcion-pendiente-encargado.png).

La verificación de estas pantallas complementa las pruebas reales que el usuario
ya realizó. No convierte los datos simulados en una prueba de pago o de hardware.

## Versión publicada y candidata

Las referencias remotas se comprobaron en vivo: `main` está en `08c03ec` y
`feat/integ-ola3` en `0369a26`. El trabajo local conserva los 83 commits de Claude
posteriores a `main`, incluidos los merges de pantallas que todavía no estaban
subidos, más las correcciones de recepción de Codex.

API, panel, operador, página de pago y TPV públicos responden HTTP 200. El health
del API muestra `revision3-2026-10-20`, sin SHA que permita identificar exactamente
el contenedor. El operador publicado envía `camera=()`; el candidato envía
`camera=(self)`, necesario para el escaneo QR. Los CI verdes anteriores no cubren
los últimos cambios de pantallas: se necesita un run nuevo del candidato.

## Preparación del despliegue

Procedimiento vigente: [DOKPLOY-STEPS.md](../../DOKPLOY-STEPS.md). Preparar una rama
candidata `feat/peanpe-wallet-deploy-20261021` para activar `nightpay-ci` en Linux.
Conservar el estado de producción hasta tener los checks de ese commit en verde.

1. CI: check, integración, orden de migraciones y cinco imágenes Docker.
2. Identificar el commit exacto, comprobar la copia de seguridad y las migraciones
   realmente aplicadas; hay diez migraciones nuevas respecto a `main` remoto.
3. Desplegar API primero, que aplica migraciones automáticamente, y después
   administración, operador, web-client y TPV desde el mismo commit.
4. Fijar `GIT_SHA` y una marca de build explícita; comprobar health y cabeceras,
   especialmente `camera=(self)` en el operador.
5. Revisar los recorridos anteriores en la web actual y las incidencias de pago.

Se añadió `lock_timeout = '5s'` a la migración del número impreso antes de publicarla.
Las 66 migraciones se aplicaron en una base nueva. Con la tabla bloqueada, la
migración se corta en 5,013 s (`55P03`); liberado el bloqueo, se aplicó dos veces
correctamente. Así evita quedar esperando indefinidamente durante una operación.

Los builds locales de Windows compilan y generan páginas, pero no terminan el
empaquetado standalone por permisos de symlink. Docker Desktop tampoco tiene un
motor utilizable en esta sesión. El job Docker de CI es la comprobación de Linux
que debe resolver esa validación antes de desplegar.

GitHub está accesible. El acceso autenticado a Dokploy no está establecido en
esta sesión y no hay un webhook de despliegue configurado en Actions. Publicar
la candidata y ejecutar CI no equivale a desplegar ni a actualizar `main`.
