# Base de datos: el API con un rol sin superusuario (`oxiopay_app`)

Hasta ahora el API entra en Postgres como `np`, el **superusuario** del
contenedor `nightpay-postgres`. Un superusuario se salta la seguridad por filas
(RLS) de la base, así que hoy lo único que separa los datos de un local de los
de otro es el código del API.

Con este cambio el API entra con `oxiopay_app`: un rol normal (sin
superusuario) que es **dueño** de las tablas. Entonces la base aplica RLS en
las tablas con `FORCE ROW LEVEL SECURITY` (`client_wallets`,
`wallet_consumptions`, `operator_earnings`, `operator_payouts`,
`earning_reversals`, `peanpe_calls`, desde «Por aprobar»
`approval_requests` y, desde la recepción, `wallet_cash_topups`): aunque un fallo del código olvidara filtrar por local,
la base no enseñaría filas de otro local. **No todas las tablas del dinero
aíslan**: ver «Qué tablas aísla la base» justo debajo.

### Qué tablas aísla la base

A un dueño de la tabla (`oxiopay_app`) solo le aplica la política si la tabla
tiene `FORCE`. Sin `FORCE`, lo que separa los locales es solo el código del API
(`tenantId` en cada consulta).

| Tabla | ¿Aísla la base por local? | Por qué |
|---|---|---|
| `client_wallets`, `wallet_consumptions`, `operator_earnings`, `operator_payouts`, `earning_reversals`, `peanpe_calls` | **Sí** | RLS con `FORCE`. |
| `approval_requests` («Por aprobar») | **Sí** | RLS con `FORCE` (`20261016300000_aprobaciones`). |
| `wallet_cash_topups` (efectivo que entra en los saldos: recepción y datáfono) | **Sí** | RLS con `FORCE` (`20261021200000_efectivo_fichas`). |
| `wallet_payouts` (lo que se devuelve de un saldo) | **No** | RLS sin `FORCE`. |
| `wallet_passes` (Google Wallet) | **No** | Sin RLS: cuelga del saldo por `walletId`, no lleva `tenantId`. |
| `wallet_cards`, `wallet_card_events` (fichas NFC) | **No** | Sin RLS: la ficha se mueve entre locales del grupo y el local va siempre explícito en la consulta. |
| `businesses` (negocios de la consola) | **No es de ningún local** | Global: RLS sin `FORCE` que solo deja pasar el bypass del super-admin; `oxiopay_app` (dueño) la ve entera. |
| `payments`, `payment_events`, `refunds`, `reconciliations`, `users`, `terminals`, `gateway_credentials` | **No** | RLS sin `FORCE` desde `20260502000000_soften_rls_force`. |

Añadir `FORCE` a otra tabla es una migración
aparte que hay que probar antes con la suite de integración
(`aislamiento-rls`): todo lo que la toque tiene que llevar el local en la
sesión o el bypass.

- Tiempo: unos 20 minutos.
- Corte: lo que tarda un redeploy normal del API (como cualquier deploy).
- Vuelta atrás: cambiar una variable y redesplegar (apartado «Volver atrás»).
- Hazlo fuera de la noche de cobro (por la mañana o por la tarde).

> Todo el SQL de este documento se ha probado en un Postgres 16 creado como en
> producción (tablas creadas por el superusuario, con datos): ver «Cómo se
> probó» al final.

---

## Antes de empezar

1. **El API ya desplegado con la versión que trae este documento** (rama
   `feat/f2-bd-tenant` en `main`), todavía con `np`. Esa versión funciona igual
   con `np`; la anterior **no** funciona con un rol sin superusuario (los pagos
   a las chicas, Peanpe… saldrían vacíos o fallarían).
2. Con esa versión en marcha, mira la métrica nueva (apartado 5.4): tiene que
   estar a 0.
3. Genera la contraseña del rol nuevo y guárdala en el gestor de contraseñas:

   ```powershell
   node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
   ```

   (base64url: sin `@ : /`, que romperían `DATABASE_URL`).

---

## Paso 0 — Copia de seguridad (obligatorio)

1. Dokploy → proyecto `nightpay` → **nightpay-postgres** → pestaña
   **Backups** → en la copia programada, pulsa **Test** (hace una copia de
   verdad, ver [`BACKUPS.md`](BACKUPS.md) apartado 3). Comprueba en Cloudflare
   R2 (bucket `oxiopay-copias`) que el fichero nuevo está y no pesa 0 bytes.
2. Además, una copia en el propio contenedor: **nightpay-postgres** →
   **Terminal**:

   ```sh
   pg_dump -U np -d nightpay -Fc -f /tmp/antes-de-oxiopay-app.dump && ls -lh /tmp/antes-de-oxiopay-app.dump
   ```

   (Se borra si el contenedor se reinicia: es solo para estos minutos. La buena
   es la de R2.)

No sigas si alguna de las dos falla.

---

## Paso 1 — Crear el rol

En la misma **Terminal** de **nightpay-postgres**, entra en la base como `np`:

```sh
psql -U np -d nightpay
```

y crea el rol. `\password` pide la contraseña dos veces sin que quede en el
historial: pega la del gestor.

```sql
CREATE ROLE oxiopay_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
\password oxiopay_app
```

---

## Paso 2 — Que `oxiopay_app` sea el dueño de todo

Dueño de la base, del esquema `public` y de cada tabla, secuencia, función y
tipo (los enum de Prisma). Todo en una transacción: o cambia todo o nada.

> No uses `REASSIGN OWNED BY np TO oxiopay_app`: `np` es el superusuario con el
> que se creó el contenedor y Postgres lo rechaza («cannot reassign ownership
> of objects owned by role np because they are required by the database
> system»). Por eso va objeto a objeto.

Pega esto entero en `psql` (sigues como `np`):

```sql
BEGIN;

DO $$
DECLARE
  obj record;
BEGIN
  -- La base y el esquema.
  EXECUTE format('ALTER DATABASE %I OWNER TO oxiopay_app', current_database());
  ALTER SCHEMA public OWNER TO oxiopay_app;

  -- Tablas (con sus índices y las secuencias de sus columnas BIGSERIAL),
  -- vistas y vistas materializadas.
  FOR obj IN
    SELECT c.relname, c.relkind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  LOOP
    EXECUTE format(
      'ALTER %s public.%I OWNER TO oxiopay_app',
      CASE obj.relkind
        WHEN 'v' THEN 'VIEW'
        WHEN 'm' THEN 'MATERIALIZED VIEW'
        WHEN 'f' THEN 'FOREIGN TABLE'
        ELSE 'TABLE'
      END,
      obj.relname
    );
  END LOOP;

  -- Secuencias sueltas (las de una columna ya cambiaron con su tabla).
  FOR obj IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'S'
       AND NOT EXISTS (
         SELECT 1 FROM pg_depend d
          WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('a', 'i')
       )
  LOOP
    EXECUTE format('ALTER SEQUENCE public.%I OWNER TO oxiopay_app', obj.relname);
  END LOOP;

  -- Funciones (app_current_tenant, app_rls_bypass, audit_events_append_only).
  FOR obj IN
    SELECT p.oid::regprocedure AS fn
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind IN ('f', 'p')
       AND NOT EXISTS (
         SELECT 1 FROM pg_depend d
          WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
       )
  LOOP
    EXECUTE format('ALTER ROUTINE %s OWNER TO oxiopay_app', obj.fn);
  END LOOP;

  -- Tipos: los enum de Prisma (PaymentStatus, Provider, Role…) y dominios.
  FOR obj IN
    SELECT t.typname
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public'
       AND t.typtype IN ('e', 'd')
  LOOP
    EXECUTE format('ALTER TYPE public.%I OWNER TO oxiopay_app', obj.typname);
  END LOOP;
END
$$;

COMMIT;
```

Tiene que acabar con `COMMIT`. Si sale un `ERROR`, Postgres ya ha deshecho
todo: no sigas y guarda el mensaje.

### Comprobación: nada sigue siendo de `np`

```sql
SELECT 'base' AS tipo, d.datname AS nombre, pg_get_userbyid(d.datdba) AS dueno
  FROM pg_database d
 WHERE d.datname = current_database() AND d.datdba <> 'oxiopay_app'::regrole
UNION ALL
SELECT 'esquema', n.nspname, pg_get_userbyid(n.nspowner)
  FROM pg_namespace n
 WHERE n.nspname = 'public' AND n.nspowner <> 'oxiopay_app'::regrole
UNION ALL
SELECT 'tabla/secuencia', c.relname, pg_get_userbyid(c.relowner)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relowner <> 'oxiopay_app'::regrole
UNION ALL
SELECT 'función', p.proname, pg_get_userbyid(p.proowner)
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proowner <> 'oxiopay_app'::regrole
UNION ALL
SELECT 'tipo', t.typname, pg_get_userbyid(t.typowner)
  FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
 WHERE n.nspname = 'public' AND t.typowner <> 'oxiopay_app'::regrole;
```

Tiene que salir **`(0 rows)`**. Se puede repetir el paso 2 sin problema (no
cambia nada de lo que ya es de `oxiopay_app`).

---

## Paso 3 — Permisos para las migraciones

El API, al arrancar, ejecuta `db-heal`, `prisma migrate deploy` y otra vez
`db-heal` con el mismo `DATABASE_URL` (ver `apps/api/Dockerfile`). Como
`oxiopay_app` es dueño de la base, del esquema y de cada objeto, puede hacer
todo lo que hacen las migraciones (crear y cambiar tablas, enum, funciones,
triggers, políticas de RLS y las funciones temporales de las migraciones). **No
hace falta ningún `GRANT`**: está probado aplicando con `oxiopay_app` las
últimas migraciones (un `ALTER TYPE … ADD VALUE`, una función con triggers y
los CHECK de `congelar_db_heal`).

Lo único que `oxiopay_app` no puede hacer: `CREATE EXTENSION` de extensiones
no «trusted», `ALTER SYSTEM`, crear roles o bases. Ninguna migración lo usa
hoy; si alguna lo necesitara en el futuro, se aplica esa parte a mano con `np`
y después se repite el paso 2.

`np` se queda como está (superusuario): lo usan las copias de seguridad y sirve
para emergencias. No le quites nada.

### Comprobación: RLS ya aplica a `oxiopay_app`

Sigues como `np` en `psql`; `SET ROLE` hace de `oxiopay_app` sin su contraseña:

```sql
SELECT count(*) AS todas FROM operator_earnings;
BEGIN;
SELECT set_config('app.current_tenant_id', (SELECT "tenantId"::text FROM operator_earnings LIMIT 1), true);
SET LOCAL ROLE oxiopay_app;
SELECT current_user AS rol, count(*) AS las_de_un_local FROM operator_earnings;
COMMIT;
SET ROLE oxiopay_app;
SELECT current_user AS rol, count(*) AS sin_local FROM operator_earnings;
RESET ROLE;
```

Lo esperado (los números dependen de tus datos):

| Consulta | Qué tiene que salir |
|---|---|
| `todas` | todas las comisiones (como `np`, que lo ve todo) |
| `las_de_un_local` | solo las de un local (menos que `todas` si hay más de un local con comisiones) |
| `sin_local` | **0**: sin local en la sesión, RLS no deja ver ninguna |

Sal de `psql` con `\q`.

---

## Paso 4 — `DATABASE_URL` del API

Dokploy → **nightpay-api** → pestaña **Environment**. Cambia solo el usuario y
la contraseña:

```env
DATABASE_URL=postgresql://oxiopay_app:<CONTRASEÑA-DE-OXIOPAY_APP>@nightpay-postgres:5432/nightpay
```

Deja `TENANCY_UNSCOPED_QUERIES` como esté (sin poner = `log`). **Save**.

Apunta en el gestor de contraseñas el `DATABASE_URL` anterior (con `np`): es la
vuelta atrás.

---

## Paso 5 — Deploy y comprobar

1. **nightpay-api** → **Deploy**. En **Logs**, al arrancar:
   - `[db-heal] migraciones: ninguna fallida` (dos veces) y
     `No pending migrations to apply` (o la lista de las aplicadas);
   - `Prisma connected` y el arranque de Nest;
   - **ninguna** línea con `permission denied`, `must be owner` o
     `row-level security`.
2. Salud:

   ```powershell
   curl.exe -s https://api.paytomaxx.com/v1/health
   ```

   Tiene que dar `"status":"ok"` con `"db":"ok"` y `"redis":"ok"` (y la marca
   de despliegue `build` de esta versión).
3. Que entra con el rol nuevo (**Terminal** de **nightpay-postgres**):

   ```sh
   psql -U np -d nightpay -c "SELECT usename, count(*) FROM pg_stat_activity WHERE datname = 'nightpay' GROUP BY 1;"
   ```

   Tiene que salir `oxiopay_app` con varias conexiones.
4. La métrica de consultas fuera de sitio (desde tu equipo, con el
   `METRICS_TOKEN` de la Fase 0):

   ```powershell
   curl.exe -s -H "Authorization: Bearer <METRICS_TOKEN>" https://api.paytomaxx.com/v1/metrics | Select-String "nightpay_rls_outside_transaction_total|nightpay_tenant_unscoped_queries_total"
   ```

   No tiene que salir nada (o todo a 0). Si sube, en los logs del API sale la
   consulta («fuera de una transacción…»): avisa antes de seguir usándolo.
5. Prueba de uso (lo que antes saldría vacío si algo fallara):
   - Panel: **Operadoras** (el saldo de cada chica), **Tesorería**,
     **Wallets** (lista y una ficha), **Incidencias**, el **Z** de la noche y
     un informe.
   - App de las chicas: **Mi noche** y **Mis pagos**.
   - Un cobro de prueba pequeño de punta a punta.

Si algo de esto falla: **Volver atrás** y avisa con el mensaje del log.

---

## Volver atrás

1. Dokploy → **nightpay-api** → **Environment** → `DATABASE_URL` otra vez con
   `np` (el que apuntaste en el paso 4) → **Save** → **Deploy**.
2. Comprueba `/v1/health`.

Funciona en el acto: `np` es superusuario y puede con todo aunque el dueño sea
`oxiopay_app` (probado). RLS de la base vuelve a no aplicarse, como antes.

- No borres `oxiopay_app`.
- Si mientras estás con `np` se aplica alguna migración nueva, lo que cree
  será de `np`: antes de volver a `oxiopay_app`, repite el paso 2 y su
  comprobación.
- Para devolverle todo a `np` (no hace falta para volver atrás): el SQL del
  paso 2 cambiando `oxiopay_app` por `np`.

---

## Copias y restauración

- Las copias (Dokploy, restic) siguen con `np`: no cambian.
- Las copias nuevas dicen que el dueño es `oxiopay_app`.
  `scripts/restore-check.sh` restaura con `--no-owner`, así que no le afecta.
- **Cualquier restauración** (Dokploy → Restore, restic, servidor nuevo): antes
  de arrancar el API, el **paso 2 y su comprobación** (`(0 rows)`). En un
  servidor nuevo, antes el paso 1 (crear el rol). Lo restaurado queda de `np`
  (o, con `--no-owner`, de quien restaura): sin el paso 2 el API da
  «permission denied» y RLS deja de aplicarse. Comandos en
  [`BACKUPS.md`](BACKUPS.md) apartados 6 y 7.

---

## Qué hace el API (para entender los avisos)

- El trabajo de un local (panel, app de las chicas, datáfono) abre sus
  transacciones con el local en la sesión de Postgres
  (`app.current_tenant_id`, solo mientras dura la transacción):
  `PrismaService.withTenant(local, …)`, y cualquier `$transaction` con local en
  el contexto. RLS solo deja ver y escribir filas de ese local.
- Lo que cruza locales a propósito (avisos del banco sin local, el saldo
  NightPay del grupo, tareas del sistema) usa `asSystem` / `acrossVenues`
  (bypass de RLS), y el código comprueba el acceso.
- Una consulta a una de esas tablas fuera de una transacción no lleva ni
  el local ni el bypass: con `oxiopay_app` no vería filas. El API la avisa en
  el log y en `nightpay_rls_outside_transaction_total`, y con
  `TENANCY_UNSCOPED_QUERIES=throw` la corta. Una prueba
  (`apps/api/src/common/prisma/rls-guard.spec.ts`) impide que entren en el
  código, y las pruebas de integración corren con `throw`.

### `TENANCY_UNSCOPED_QUERIES=throw`

Recomendado **una semana después** del cambio, si en esa semana
`nightpay_rls_outside_transaction_total` y
`nightpay_tenant_unscoped_queries_total` siguen a 0: Dokploy → nightpay-api →
Environment → `TENANCY_UNSCOPED_QUERIES=throw` → Deploy. A partir de ahí una
consulta sin aislamiento da error en vez de solo avisar. Para quitarlo, borra
la variable y redespliega.

---

## Cómo se probó

En un Postgres 16 embebido, con el superusuario `postgres` haciendo de `np`:

1. Base creada por el superusuario, con las migraciones hasta
   `20261015030000_saldo_devolucion_pendiente` aplicadas por él (como en
   producción) y datos de dos locales.
2. Pasos 1 y 2 tal cual están aquí. `REASSIGN OWNED BY postgres` falla con el
   mensaje de arriba. La comprobación del paso 2 da `0 rows`; la del paso 3,
   `todas = 2`, `las_de_un_local = 1`, `sin_local = 0`.
3. Arranque del API como `oxiopay_app` (`db-heal`, `prisma migrate deploy`,
   `db-heal`): aplicó las tres últimas migraciones sin errores. Como
   `oxiopay_app` también se pudieron rehacer una función, añadir un valor a un
   enum, tocar un trigger y crear una tabla (y se deshizo).
4. Las 104 pruebas de integración del API contra esa base con `oxiopay_app`:
   todas bien.
5. Vuelta atrás: con el superusuario el API funciona igual (las pruebas del
   personal pasan); solo deja de aislar RLS de la base, como se espera.
