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
