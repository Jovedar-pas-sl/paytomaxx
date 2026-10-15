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
| `saldo-rls.int.spec.ts` | Saldo entre locales del grupo con RLS forzado; «Me voy» y devolución |
| `anulaciones-devoluciones.int.spec.ts` | Anular consumos (deuda de la chica si ya cobró) y devoluciones simultáneas |
| `cuadre-banco.int.spec.ts` | Importar el fichero de Redsys, clasificar líneas, Incidencias |
| `consumos-informes.int.spec.ts` | Consumos del saldo en informes y en «Mi noche» |
| `super-admin.int.spec.ts` | Super-admin con otro local activo |

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

- Producción entra hoy en Postgres como superusuario, así que allí RLS no se
  aplica. `consumos-informes` lo refleja: los informes y «Mi noche» leen
  `wallet_consumptions` (FORCE RLS) fuera de una transacción con local, y con
  un rol sin superusuario saldrían vacíos; la prueba les da una conexión con el
  bypass puesto. Si el API pasa a entrar con un rol normal, eso hay que
  arreglarlo antes (y esta prueba, cambiarla).
- `consumos-informes` fija el reloj (23:00 de Madrid): «Mi noche» cuenta desde
  las 08:00 y sin eso fallaría según la hora a la que corra.
