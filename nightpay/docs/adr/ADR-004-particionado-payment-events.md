# ADR-004: Particionado mensual de `payment_events`

**Estado**: Accepted
**Fecha**: 2026-04-21
**Deciders**: Equipo de ingeniería NightPay
**Relacionado**: §5.3 del Master Plan V2

## Contexto

`payment_events` es la tabla **append-only** que captura cada cambio de estado de cada pago (creación, autorización, fallo, refund, reconciliación). Es la **fuente de verdad forense**: si dashboard dice algo y la tabla dice otra, la tabla gana.

Estimaciones de volumen:
- Pico 500 TPS × 5 min × ~4 eventos por pago = 600k eventos en pico único
- 1 noche de discoteca (6h): ~5M eventos en un venue medio
- 10 venues año 1, 3 noches/semana activas: ~60M eventos/mes
- Año 2 (50 venues): ~300M/mes

Sin particionado:
- Índices se hinchan → inserts más lentos.
- Vacío/autovacuum trabaja sobre tabla monolítica gigante.
- Consultas típicas ("eventos de los últimos 7 días") escanean índice enorme.
- Archivado (mover eventos >12 meses) requiere DELETE masivo con overhead WAL.

## Decisión

**Particionar `payment_events` por rango mensual en `occurred_at`** usando particionado declarativo de Postgres 16.

```sql
CREATE TABLE payment_events (
  id          BIGSERIAL,
  payment_id  UUID NOT NULL,
  tenant_id   UUID NOT NULL,
  event_type  TEXT NOT NULL,
  payload     JSONB NOT NULL,
  trace_id    TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, occurred_at)   -- requisito: incluir clave de partición en PK
) PARTITION BY RANGE (occurred_at);
```

Gestión automática de particiones con **`pg_partman`**:
- Crea la partición del mes actual + 4 meses futuros
- Archiva particiones >13 meses a tabla "archive" o elimina/exporta a S3

Job cron diario (01:00 AM): `CALL partman.run_maintenance();`

### Índices en la tabla padre
- `(tenant_id, occurred_at DESC)` — queries de dashboard
- `(payment_id)` — detalle de un pago
- `(trace_id)` — correlación OTel
- `(event_type)` (parcial, solo para `payment.authorized`) — reconciliación

Postgres propaga índices a particiones automáticamente desde la versión 11.

### Retención
- Mes actual + 12 anteriores → online (hot)
- Meses 13–24 → particiones detached archivadas en tabla `payment_events_archive` (compresión con `pg_repack` si necesario)
- >24 meses → exportar a Parquet en S3 + DROP partition

## Alternativas consideradas

### A1. Tabla monolítica + índices B-tree grandes
- **Pro**: Simple.
- **Contra**: A 300M filas los índices ocupan >50GB, autovacuum sufre, queries lentas sin partition pruning.
- **Rechazado** por performance previsible.

### A2. TimescaleDB (extensión de series temporales)
- **Pro**: Hypertables, compresión automática, funciones de agregación rápidas.
- **Contra**: Extensión extra (no disponible en Hetzner managed; self-host añade ops); lock-in; overkill para nuestros patterns de consulta.
- **Rechazado**: Postgres nativo cubre el caso; podemos revisitar si hacemos analytics pesado.

### A3. Archivado en S3 desde el principio (solo 1 mes online)
- **Pro**: DB pequeñita.
- **Contra**: Queries de reconciliación a 7/30 días requieren re-hidratar desde S3 (lento, complejo).
- **Rechazado**: No vale la pena para el volumen actual.

### A4. Particionado por `tenant_id` (hash)
- **Pro**: Equilibra carga entre particiones.
- **Contra**: No permite drop eficiente de datos antiguos (objetivo principal).
- **Rechazado** por no resolver el uso principal.

## Consecuencias

### Positivas
- **Partition pruning**: queries por rango de fecha solo tocan particiones relevantes. p95 "últimos 30 días" ~10× más rápido vs tabla monolítica a 100M filas.
- **Drop de datos antiguos O(1)**: `DROP TABLE payment_events_2025_01` vs `DELETE` masivo.
- **Inserts rápidos**: cada partición tiene índices menores.
- **Mantenimiento simple**: `pg_partman` automatiza creación/archivado.
- **Backup diferencial**: backups incrementales por partición vs tabla entera.

### Negativas
- **Prisma no soporta particiones nativamente**: requiere SQL raw en migraciones (aislamiento: un solo archivo `prisma/migrations/xxx_partition_payment_events/migration.sql`).
- **PRIMARY KEY compuesta** `(id, occurred_at)` en lugar de solo `id` — marginal; Prisma puede manejarlo declarando `@@id([id, occurredAt])`.
- **Extensión `pg_partman`** requerida en el cluster. Script de aprovisionamiento en `scripts/db/bootstrap.sql`.
- **Complejidad operativa** ligeramente mayor: ingenieros deben entender que los eventos son particionados al hacer queries ad-hoc.

### Neutras
- Cross-partition queries (e.g. `COUNT(*) WHERE tenant_id = X`) funcionan igual; el planner agrega resultados.
- **Foreign keys**: particiones no admiten FKs referenciando tabla particionada. Mitigación: FK solo en `payments.id` (la referencia es `payment_id → payments.id`, que no está particionada).

## Criterios de verificación

- [ ] Migración crea tabla particionada + 12 meses precargados + `pg_partman` configurado
- [ ] Query `SELECT COUNT(*) FROM payment_events WHERE occurred_at > NOW() - '7 days'::interval` usa partition pruning (verificable con `EXPLAIN`)
- [ ] Job `pg_partman` crea partición +4m y archiva -13m diariamente (test en staging con clock shift)
- [ ] Benchmark: insertar 1M eventos en tabla particionada vs monolítica → particionada ≥2× más rápida al llegar a 100M
- [ ] Backup + PITR validados sobre tabla particionada

## Revisión

Revisar si:
- Volumen crece >1B eventos/mes (considerar TimescaleDB o warehouse dedicado)
- Patrones de query cambian (e.g. analytics cross-tenant → otra estrategia)
- `pg_partman` introduce overhead operativo inesperado (considerar gestión manual o extensión diferente)
