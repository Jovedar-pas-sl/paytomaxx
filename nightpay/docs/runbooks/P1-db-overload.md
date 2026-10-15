# Runbook P1: base de datos lenta o caída

**Severidad**: P1; P0 si `/v1/health` da `db: fail` (no se puede cobrar).
**Objetivo**: 15 min.

## Síntomas

- `https://api.paytomaxx.com/v1/health` → 503 con `"db":"fail"` (lo ve el
  monitor externo → Telegram).
- El panel y los cobros van lentos; en el log del API,
  `P2024` (*connection pool timeout*) o `Can't reach database server`.

## Diagnóstico (5 min)

1. **Dokploy → nightpay-postgres**: ¿está *Running*? Pestaña **Monitoring**:
   CPU, memoria. **Logs**: `FATAL`, `out of memory`, `No space left on device`.
2. **Disco del VPS lleno** (causa típica): en el VPS, `df -h` y
   `docker system df`. Imágenes viejas de despliegues:
   `docker image prune -a` (no borra volúmenes ni contenedores en marcha;
   **nunca** `docker volume prune`).
3. **Consultas colgadas**: `nightpay-postgres` → **Terminal**:

   ```bash
   psql -U np -d nightpay -c "
     SELECT pid, now() - query_start AS dura, state, left(query, 80) AS consulta
       FROM pg_stat_activity
      WHERE state <> 'idle' AND pid <> pg_backend_pid()
      ORDER BY dura DESC LIMIT 10;"
   ```

   Una que lleve minutos y bloquee al resto:
   `psql -U np -d nightpay -c "SELECT pg_cancel_backend(<pid>);"`
   (cancela la consulta; `pg_terminate_backend` corta la conexión, solo si lo
   anterior no basta).

## Acciones

- **Postgres parado**: Deploy de `nightpay-postgres`. Si no arranca por disco
  lleno, libera espacio (punto 2) y vuelve a intentarlo.
- **API con el pool agotado** tras un pico: **Redeploy** de `nightpay-api`
  (con `start-first` no hay corte).
- **VPS sin memoria**: Dokploy → Monitoring del servidor. Para salir del paso,
  parar lo que no sea imprescindible; luego, más RAM.
- **Base dañada**: no repares a mano. Restaura la última copia buena:
  [`../BACKUPS.md`](../BACKUPS.md) apartado 6.

## Comprobar

- [ ] `/v1/health` → `"db":"ok"`.
- [ ] Un cobro de prueba de 1 € sale bien.
- [ ] Si hubo corte con clientes pagando: [P0-pagos-atascados.md](P0-pagos-atascados.md).
