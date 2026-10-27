# Pruebas de integración del API (Postgres de verdad)

Los servicios del dinero (saldo, cobros con QR / Face ID / PIN / ficha,
anulaciones, devoluciones, cuadre con el banco, informes) contra un Postgres
real con las migraciones aplicadas, **con RLS forzado**: la base es de un rol
normal (`np_app`, sin superusuario), así que las políticas de RLS se aplican
también a su dueño (`FORCE ROW LEVEL SECURITY`). Con un superusuario no
probarían nada de eso.

`vitest run` (las pruebas unitarias) no las coge: van aparte.

| Fichero | Qué prueba |
|---|---|
| `saldo-qr-faceid.int.spec.ts` | Cobro con QR + Face ID, PIN del saldo, ficha NFC, carreras (dos pagos del mismo QR) |
| `superadmin.int.spec.ts` | Consola del super-admin: vista general de dos locales de dos negocios, búsqueda de clientes en todos los locales (FORCE RLS), saldo bloqueado, pausa (423) con 2FA de verdad, personal, cuentas de cobro y registro |
| `saldo-pin-concurrencia.int.spec.ts` | PIN del saldo a la vez: diez PIN malos en paralelo cuentan uno a uno y bloquean al quinto; dos cobros distintos del mismo saldo a la vez no lo dejan en negativo |
| `saldo-rls.int.spec.ts` | Saldo entre locales del grupo con RLS forzado; «Me voy» y devolución |
| `anulaciones-devoluciones.int.spec.ts` | Anular consumos (deuda de la chica si ya cobró) y devoluciones simultáneas |
| `devoluciones-concurrencia.int.spec.ts` | Reserva de las devoluciones con el FSM real: varias a la vez (misma persona y personas distintas) no pasan de lo cobrado, la comisión de la chica se descuenta entera sin céntimos sueltos, rechazo del banco libera la reserva y «sin confirmar» la mantiene |
| `cuadre-banco.int.spec.ts` | Importar el fichero de Redsys, clasificar líneas, Incidencias |
| `consumos-informes.int.spec.ts` | Consumos del saldo en informes y en «Mi noche» |
| `cierre-noche.int.spec.ts` | Cierre de la noche en pasos con arqueo: efectivo esperado (fondo − saldo devuelto en efectivo − pagos en efectivo a las chicas), diferencia congelada en el Z, un cobro pagándose bloquea, los avisos se confirman (y la nota de los cobros), lista de las chicas con 0 y 7 días de espera, caja sin contar al cerrarse sola |
| `super-admin.int.spec.ts` | Super-admin con otro local activo |
| `personal-sin-superusuario.int.spec.ts` | Lo del personal sin asSystem en la prueba (solo el local en el contexto): chicas, comisiones y pagos (crear y verificar), devolución con deuda, tesorería, saldos del panel, «Mi noche» y Z, Incidencias, Peanpe |
| `aislamiento-rls.int.spec.ts` | RLS de la base aísla sola las tablas con FORCE RLS (también `approval_requests`): con el local A en la sesión no se ve ni se escribe nada de B aunque la consulta no filtre; el local no se queda en la conexión |
| `google-wallet.int.spec.ts` | Migración de `wallet_passes` (sin RLS, cascada, idempotente), consulta del repaso de Google Wallet con RLS forzado y el repaso entero con un Google de mentira |
| `aprobaciones.int.spec.ts` | «Por aprobar»: el encargado pide el pago a la chica y el dueño lo aprueba con su 2FA (el pago existe y el saldo baja); quien pide no aprueba (ni la base lo deja); aprobar dos veces o a la vez paga una sola; dos peticiones a la vez no gastan de más; devoluciones desde el umbral a aprobación (202) y por debajo directas; rechazar; caducar a las 24 h; FAILED con la razón; Incidencias; otro local no la ve |
| `doble-cobro.int.spec.ts` | Doble cobro: dos aprobaciones del banco de dos pedidos del mismo cobro a la vez → una lo paga y la otra queda como doble cobro una sola vez (candado del cobro), intentos APPROVED, una comisión; avisos repetidos no duplican la incidencia (también con el cobro devuelto). Venta anulada en el datáfono con el cobro aún pagado → Incidencias hasta devolverlo |
| `recarga-movil.int.spec.ts` | «Recargar» desde la página del saldo (/w): cobro de recarga del local del saldo (sin propina, sin chica, sin saldo nuevo), se suma una sola vez, doble toque = el mismo cobro, dos pedidos aprobados = doble cobro (saldo sumado una vez), lo caducado o abandonado en el banco no bloquea, a cero vuelve a activo, vuelta al saldo con su «Pagado», saldo bloqueado / pausa (423) / «Formas de cobro» apagadas (409) y en el Z como recarga, no como venta |
| `noche-facil.int.spec.ts` | «Noche fácil»: NFC sin PIN hasta el máximo y el tope de la noche (dos cobros a la vez con el saldo bloqueado: pasa uno y el otro pide el PIN; tras el PIN vuelve a contar), la noche de 08:00 a 08:00 de Madrid, saldos sumados, cómo se autorizó cada consumo (nfc_nopin, pin, passkey, staff); recarga pendiente de asignar (cobrar primero, Incidencias a los 10 min, asignarla con el código); local nuevo con el datáfono apagado; los CHECK de la migración |
| `recepcion-expres.int.spec.ts` | Recepción exprés: el número de la ficha (seguido y único), el NFC acercado (del stock → nuevo; dado a un saldo → lo que tiene y lo que sale en efectivo; por el código, con el número de su NFC), solo quien carga saldos (barra, 403) y a la salida, devolver en efectivo deja el NFC en el stock |
| `recepcion-salida-r5.int.spec.ts` | Salida de recepción y número impreso (R5): efectivo + tarjeta (el resto pedido «A la tarjeta»: Incidencias, cierre y Saldos), saldo de otro local del grupo y de otro grupo, el tope de 1.000 € en 24 h, devolución a la tarjeta a medias, saldos sumados, permisos (sin puesto, «devolver en efectivo» quitado, encargado sin «Dar efectivo»), registro en la transacción, el tope de la noche por recepcionista (Incidencias una vez y 2FA del encargado en el panel), el Face ID del cliente en su móvil, y el número impreso por local y grupo (con ceros), tapado al buscarlo y sin cargar fichas nuevas por número |
| `saldo-nfc-cliente.int.spec.ts` | El cliente y su NFC: QR de activación de recepción (recepción, encargado y dueño sí; barra y chicas 403; solo 15 min tras una recarga del local; con passkey 404; en audit_events sin el enlace), sesión de consulta deslizante con la app Nest y una passkey de software de verdad (se alarga mirando, 15 min sin actividad la cierran, tope de una hora, un enlace nuevo la invalida) y «He perdido mi NFC» (bloqueado con su passkey, ya no paga; el saldo sí con código + PIN y passkey; Incidencias; NFC nuevo en recepción) |
| `copa-con-invitacion.int.spec.ts` | «Copa con invitación» de 20 € que cobra el camarero (con tarjeta y con el NFC del saldo, junto a 2 copas con propina): en el mapa del dinero, la ficha de la chica y la del camarero, sus cobros, sus invitaciones, «Mi noche», el Z, los CSV de la gestoría y el Z del periodo, 10 € del local en Copas y 10 € de la chica (sin parte para el camarero); devolver la mitad, el resto y anular el consumo le quitan su parte en proporción y todo sigue cuadrando; el Z congelado al cerrar; un local que da una parte al camarero (la eligió en Ajustes) la mantiene y los informes la restan de lo del local |
| `copa-escenarios.int.spec.ts` | «Copa con invitación», un local por escenario: dos chicas (un cobro lleva una sola invitada; dos invitaciones la misma noche, con tarjeta y con el NFC; un cobro con una línea para cada una y su devolución a medias), invitación con propina (la chica, su mitad de la copa; devolver la mitad y el resto), devolución en parte otra noche (la noche congelada no cambia) y después de pagar a la chica (lo que debe), y la invitación del saldo con el NFC (y anular el consumo); en todos, el mapa del dinero, la ficha de cada chica y el Z cuadran |
| `copa-migracion.int.spec.ts` | Migración 20261028100000 con datos de producción: la referencia de antes sin tocar («Invitar a una copa» → «Copa con invitación» justo detrás de «Copa», «Copa premium» apagada), cambiada por el dueño, con la «Copa premium» vendida (con tarjeta o solo con el saldo de antes de las líneas: se queda encendida y la invitación sigue justo detrás de «Copa»), la primera referencia sin invitación (la de ahora la crea en su sitio) y con otro «Copa con invitación» (no se toca); la parte del camarero del formulario de antes (50 %) pasa a 0 % con su registro, la que eligió el dueño se queda, antes y después de la migración en un cobro de verdad, y el JSON con «inviteFirst»; sin borrar nada e idempotente (la segunda vez no cambia ni registra nada) |
| `pasarela-abrir-pago.int.spec.ts` | La pasarela no abre el pago: un fallo pasajero deja el cobro como estaba (sin pedido, intento ni eventos) y el reintento lo abre de verdad; uno definitivo lo deja FAILED (`payment.checkout_failed`) y la página dice lo mismo; dos «Pagar» a la vez abren un solo pedido; al abrir otro intento con Redsys, un definitivo no mata el cobro y un pasajero sí reintenta |
| `alta-enlace.int.spec.ts` | El enlace de alta de la chica es de un solo uso: guarda una vez y el mismo enlace otra vez (respuesta perdida, o lo vuelve a abrir) da 409 «ya se guardaron tus datos» sin tocar nada; dos «Guardar» a la vez guardan una sola vez; un enlace nuevo del admin vale y el usado pasa a 401 |
| `sesion-revocada.int.spec.ts` | Cerrar una sesión corta al momento el token de acceso (app Nest de verdad con AuthGuard): logout (solo esa sesión), revocar todas las sesiones (móvil perdido), revocar una (reuso del refresh), baja y reset de contraseña de la chica, token sin `sid`, Redis caído (503 sin cerrar la sesión) y el tiempo real (conexiones cortadas, subscribe y handshake rechazados) |
| `entradas-categoria.int.spec.ts` | Entradas (VENUE_ENTRY) en el cobro: «Cobrar → Entrada», «Otro importe → Entradas», recepción con la app antigua y más entradas que copas con tarjeta (antes, 500 por el CHECK de `payments.revenueCategory`); cobro único pagado con el NFC y cobro solo del saldo; las entradas en el Z de la noche, el Z del periodo, el mapa del dinero, la lista de cobros y el CSV; el CHECK admite justo SECTION_CODES + EXTRA (check-drift no mira los CHECK) y la migración 20261028000000 sustituye el antiguo, se puede repetir y con filas raras no rompe el despliegue (NOT VALID + aviso de db-heal) |
| `comision-servicio.int.spec.ts` | «Comisión del servicio» (migración 20261030100000) encendida y apagada: pago directo con propina por Redsys (firma y webhook de verdad: 33 € + 3,30 € + 2 € = 38,30 €) y por datáfono (el lector pide 36,30 €; 33 € es MISMATCH), recargas con tarjeta y en efectivo al 12 % (50 € → 56 €; la app anterior sin el campo, 409), cobro único pagado con el saldo (sin comisión ni % antiguo), «Devolver saldo» (la comisión de la recarga se queda), devolución parcial y total de un pago directo (la comisión vuelve en proporción), cierre con la caja cuadrada (la comisión en su línea), mapa del dinero, Z, CSV y totales del periodo con la comisión aparte y la parte de la chica sobre el consumo; apagada, las cifras de siempre y sin sus campos ni columnas; encenderla no cambia los cobros ya creados; los CHECK y repetir la migración |
| `liquidacion-oxiopay.int.spec.ts` | «Liquidación OxioPay» (migración 20261031100000: CHECK, RLS con FORCE, una activa por local y semana, repetible, pagos solo de añadir): semana normal con la comisión del servicio encendida, apagada (comisión de plataforma) y saldo cargado antes de encenderla, por noche y por concepto, y el total **igual al mapa del dinero** de la misma ventana (y cada noche igual al mapa de esa noche); la semana del cambio de hora (169 h, la noche del sábado de 25 h con las 02:30 dos veces); la noche que cruza el corte del lunes repartida entre dos semanas; devolución dentro de la semana y otra de BBVA apuntada tarde con fecha de la semana ya liquidada (la congelada no cambia; ajuste en la siguiente con su semana, noche y referencia); el repaso del lunes con dos réplicas a la vez (candado SET NX) y tres generaciones a la vez sin candado (la base); pagada en parte (con motivo), entera, de más (no), anulada con pagos (no), anulada y regenerada (-2) y su registro; el dueño solo ve lo suyo; 2FA de verdad (código malo, al registro y sin pago); aviso de 7 días (panel y Telegram una vez al día); la cuenta de OxioPay (sin ella se emite y avisa; IBAN tapado en el registro) |

## Lanzarlas en local

1. Un Postgres 16 **de pruebas** (nunca el de producción: crean locales,
   usuarios y cobros) con un rol dueño sin superusuario:

   ```sql
   CREATE ROLE np_app LOGIN PASSWORD 'np_app' NOSUPERUSER;
   CREATE DATABASE nightpay_test OWNER np_app;
   ```

2. Las migraciones, como en el arranque del API (desde `packages/db`):

   ```bash
   export DATABASE_URL=postgresql://np_app:np_app@localhost:5432/nightpay_test
   ./node_modules/.bin/tsx scripts/db-heal.ts
   ./node_modules/.bin/prisma migrate deploy
   ./node_modules/.bin/tsx scripts/db-heal.ts
   ```

3. Las pruebas (desde `apps/api`, con el mismo `DATABASE_URL`):

   ```bash
   pnpm test:integration
   ```

`ENCRYPTION_KEK` coge un valor de pruebas si no está definida. Con
`NODE_ENV=production` se niegan a arrancar.

Se pueden repetir sobre la misma base: cada fichero crea sus datos con nombres
aleatorios.

## En CI

El job `integracion` de `.github/workflows/nightpay-ci.yml` levanta un
`postgres:16`, crea `np_app` como arriba, aplica las migraciones como `np_app`
y lanza `pnpm test:integration`.

## Notas

- Producción entraba en Postgres como superusuario (`np`), que salta RLS.
  Para pasar a un rol normal, dueño de las tablas: [`docs/DB-ROLE.md`](../../../../docs/DB-ROLE.md).
  El API ya funciona así: el trabajo de un local va con su local en la sesión
  (`withTenant`, o cualquier `$transaction` con local en el contexto) y lo de
  sistema con bypass (`asSystem` / `acrossVenues`).
- `setup.ts` pone `TENANCY_UNSCOPED_QUERIES=throw`: una consulta por local sin
  local, o a una tabla con FORCE RLS fuera de una transacción, hace fallar la
  prueba (en producción solo se avisa, salvo que se active).
- `consumos-informes` fija el reloj (23:00 de Madrid): «Mi noche» cuenta desde
  las 08:00 y sin eso fallaría según la hora a la que corra.
