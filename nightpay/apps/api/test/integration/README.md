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
| `saldo-rls.int.spec.ts` | Saldo entre locales del grupo con RLS forzado; «Me voy» y devolución |
| `anulaciones-devoluciones.int.spec.ts` | Anular consumos (deuda de la chica si ya cobró) y devoluciones simultáneas |
| `cuadre-banco.int.spec.ts` | Importar el fichero de Redsys, clasificar líneas, Incidencias |
| `consumos-informes.int.spec.ts` | Consumos del saldo en informes y en «Mi noche» |
| `super-admin.int.spec.ts` | Super-admin con otro local activo |
| `personal-sin-superusuario.int.spec.ts` | Lo del personal sin asSystem en la prueba (solo el local en el contexto): chicas, comisiones y pagos (crear y verificar), devolución con deuda, tesorería, saldos del panel, «Mi noche» y Z, Incidencias, Peanpe |
| `aislamiento-rls.int.spec.ts` | RLS de la base aísla sola las tablas con FORCE RLS (también `approval_requests`): con el local A en la sesión no se ve ni se escribe nada de B aunque la consulta no filtre; el local no se queda en la conexión |
| `aprobaciones.int.spec.ts` | «Por aprobar»: el encargado pide el pago a la chica y el dueño lo aprueba con su 2FA (el pago existe y el saldo baja); quien pide no aprueba (ni la base lo deja); aprobar dos veces o a la vez paga una sola; dos peticiones a la vez no gastan de más; devoluciones desde el umbral a aprobación (202) y por debajo directas; rechazar; caducar a las 24 h; FAILED con la razón; Incidencias; otro local no la ve |

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
