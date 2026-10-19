# Cómo escribimos las pruebas del API

Reglas cortas para que las pruebas digan algo y no se rompan al refactorizar.

## Dónde

- **Unitarias**: `src/**/*.spec.ts`, junto al código (`pnpm test`).
- **Integración** (Postgres real, RLS forzado): `test/integration/*.int.spec.ts`
  (`pnpm test:integration`, ver [integration/README.md](integration/README.md)).
  Solo para lo que necesita la base de verdad: candados (`FOR UPDATE`,
  `pg_advisory_xact_lock`), RLS, índices únicos, carreras.
- Un fichero nuevo por tema antes que crecer uno que ya es largo.

## Qué se prueba

- **Comportamiento por la puerta pública**: métodos públicos de los servicios y
  funciones puras. Nada de llamar a métodos privados ni de comprobar el orden
  interno de las llamadas: así la prueba aguanta un refactor.
- **Resultados, no llamadas**: importes, estados, filas guardadas, valores que
  llegan al `INSERT`/`UPDATE`, la vista que se devuelve. `toHaveBeenCalledWith`
  solo cuando la llamada *es* el resultado (lo que se escribe o se encola).
- **Datos realistas y en castellano**: «Sala Bambú (Madrid)», Lola, céntimos
  (4.500 = 45,00 €), horas de Madrid, ids con forma de UUID.
- Nombres de las pruebas en castellano, diciendo qué pasa
  («devuelve 409 si la Idempotency-Key la usó otra persona»).

## Errores

- Se comprueba la **clase** (`rejects.toBeInstanceOf(ConflictException)`) y, si
  el error trae **`code`** (`TOTP_INVALID`, `VENUE_PAUSED`,
  `REFUND_OUTCOME_UNKNOWN`, `PAYOUT_TX_ALREADY_USED`…), el código.
- Del texto, como mucho una **palabra clave** con regex (`/incorrecto/`), nunca
  la frase entera: el texto se retoca sin cambiar el comportamiento.
- Excepción: cuando el texto *es* lo que se prueba (CSV, páginas, avisos de
  Telegram, un mensaje que no debe decir «0 días»).

## El local (tenant)

- Toda consulta SQL cruda de datos de un local va **filtrada por el local**, y
  la prueba lo comprueba: con `Prisma.sql(strings, ...values)` en el
  `$queryRaw` de mentira, el texto lleva `"tenantId" = $` y los valores llevan
  el id del local. Patrón: `expectTenantScoped` en
  `src/modules/reports/period-reports.service.spec.ts`.
- Un `withTenant` de mentira que ignora su primer argumento no nota que falte
  el local: comprueba con qué local se llamó.

## El reloj

- Nada de `Date.now()` con márgenes de «menos de 5 s». Reloj fijo:
  `vi.useFakeTimers({ toFake: ['Date'] })` + `vi.setSystemTime(...)` y
  `vi.useRealTimers()` en `afterEach`; o pasar `now` si la función lo acepta.
- Días de Madrid: probar también los cambios de hora (29-mar-2026, día de
  23 h; 25-oct-2026, día de 25 h).
- La zona horaria del equipo no cuenta: producción corre en UTC. Si el código
  usa la hora local, la prueba fija `vi.stubEnv('TZ', 'UTC')`.

## Integración

- Corren con `TENANCY_UNSCOPED_QUERIES=throw`: las tablas con FORCE RLS se leen
  y escriben dentro de `asSystem` / `acrossVenues` / `withTenant`, o con el
  local en el contexto (`cls`).
- Datos con nombres aleatorios (se puede repetir sobre la misma base).
- Carreras: `Promise.allSettled` de N peticiones a la vez y comprobar las filas
  finales (cuántas salieron, saldo, lo reservado), no solo las respuestas.
- El 2FA de las devoluciones se pide por lo devuelto acumulado por persona:
  un dueño nuevo por prueba si no es eso lo que se prueba.

## Antes de dar algo por terminado

1. `pnpm test` tres veces seguidas en verde (sin pruebas que fallen a ratos).
2. `pnpm test:integration` en verde si se tocó algo de la base.
3. `pnpm test:coverage`: pasa los umbrales de `vitest.config.ts`. Los umbrales
   son un suelo (un punto por debajo de lo medido): al añadir pruebas, súbelos.
4. `npx tsc --noEmit -p tsconfig.json` y `npx eslint --max-warnings 0` sobre
   los ficheros tocados.
