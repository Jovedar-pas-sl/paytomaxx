# Runbook P1: Base de datos sobrecargada

**Severidad**: P1 (P0 si CPU sostenido >95% o connections pool agotado)
**Tiempo objetivo**: 15 min

## Síntomas

- Alerta: `[P1] NightPay: db_cpu > 80% for 5m` o `pg_connections_used > 18/20`
- API latency p95 subiendo (>1s)
- Logs: `PrismaClientKnownRequestError: P2024 connection pool timeout`
- Dashboard **Database** muestra picos en `active queries`

## Diagnóstico en 30 segundos

### Queries más lentas

```bash
docker exec nightpay_postgres psql -U np -d nightpay -c "
  SELECT pid, now() - pg_stat_activity.query_start AS duration,
         usename, application_name, state, query
  FROM pg_stat_activity
  WHERE state != 'idle'
    AND query NOT ILIKE '%pg_stat_activity%'
  ORDER BY duration DESC
  LIMIT 10;
"
```

### Locks

```sql
SELECT blocked_locks.pid AS blocked_pid,
       blocking_locks.pid AS blocking_pid,
       blocked_activity.query AS blocked_query,
       blocking_activity.query AS blocking_query
FROM pg_locks blocked_locks
JOIN pg_stat_activity blocked_activity ON blocked_activity.pid = blocked_locks.pid
JOIN pg_locks blocking_locks
  ON blocking_locks.locktype = blocked_locks.locktype
  AND blocking_locks.database IS NOT DISTINCT FROM blocked_locks.database
  AND blocking_locks.pid != blocked_locks.pid
JOIN pg_stat_activity blocking_activity ON blocking_activity.pid = blocking_locks.pid
WHERE NOT blocked_locks.granted;
```

### Pool connections

```bash
curl -s http://localhost:3000/internal/metrics | grep pg_pool
# pg_pool_active 18
# pg_pool_idle 1
# pg_pool_waiting 5   ← malo
```

## Acciones

### Caso A — Query ad-hoc o reporte bloqueando

Si ves una query `SELECT ... FROM payment_events JOIN ...` de más de 10s:

```sql
-- cancelar con precaución
SELECT pg_cancel_backend(<pid>);
-- si no responde, terminate (más agresivo)
SELECT pg_terminate_backend(<pid>);
```

Contactar a quien la lanzó. Probable export CSV masivo sin stream.

### Caso B — Connection pool agotado por slow queries

1. **Reducir keep-alive en exports**: los jobs de export CSV deben usar cursor streaming (verificar `workers/export-csv.ts`).
2. **Aumentar pool temporalmente** (precaución con memoria Postgres):
   ```bash
   # editar DATABASE_URL con connection_limit=40 (de 20)
   # Coolify env vars, luego rolling restart
   ```
3. Solución de fondo: identificar endpoint que consume pool — probable N+1 o JOIN no indexado.

### Caso C — Autovacuum behind

Si `pg_stat_user_tables` muestra `n_dead_tup > 100k` en `payments` o `payment_events`:

```sql
-- disparar manual
VACUUM ANALYZE payments;
VACUUM ANALYZE payment_events_2026_04;  -- partición activa del mes
```

Revisar config autovacuum:
```sql
SHOW autovacuum_vacuum_cost_delay;  -- default 2ms, bajar a 10ms si lentísimo
SHOW autovacuum_max_workers;        -- default 3, considerar 4 si tablas grandes
```

### Caso D — Índice falta o no usado

```sql
EXPLAIN (ANALYZE, BUFFERS) SELECT ... ;  -- query lenta del caso
-- buscar "Seq Scan on X rows=..."
```

Si falta índice → crear con `CREATE INDEX CONCURRENTLY` (no bloquea):

```sql
CREATE INDEX CONCURRENTLY idx_xxx ON tabla (col1, col2);
```

Luego commit a migrations para perpetuar:
```bash
pnpm prisma migrate dev --name add_idx_xxx
```

### Caso E — Disk I/O saturado

```bash
docker exec nightpay_postgres iostat -x 1 3
# %util >90% → saturado
```

Causa probable: particiones muy grandes sin pruning. Verificar:
```sql
SELECT tablename, pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC
LIMIT 10;
```

Si `payment_events_2026_XX` >20GB → archivar particiones viejas (`DETACH + export`).

## Verificación

- [ ] CPU postgres <50% sostenido
- [ ] p95 API <800ms
- [ ] Pool `waiting = 0`
- [ ] `pg_stat_statements` no muestra queries >5s
- [ ] Dashboard **Database** verde

## Prevención

- Alertas proactivas: `pg_waiting_queries > 0 for 1m`, `pg_slow_queries_1s > 10/min`
- Job weekly: `VACUUM ANALYZE` preventivo (fuera de horario nocturno)
- Review de query performance tras cada release (comparar `pg_stat_statements` snapshots)
- Considerar réplica read-only cuando haya >50 venues o queries admin saturando primary

## Postmortem si

- Incidente duró >1h
- Algún pago se perdió o duplicó por locks
- Requirió aumentar resources (CPX upgrade) permanentemente
