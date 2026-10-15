# Runbook P0: cobros atascados (el cliente pagó y aquí no consta)

**Severidad**: P0 de noche (hay clientes esperando), P1 de día.
**Objetivo**: cada cobro resuelto en 15 min.

## Síntomas

- Telegram / panel → **Incidencias**: «Cobro atascado esperando al banco»
  (AUTHORIZING más de 15 min) o «Cobro sin confirmar por el banco» (ORPHAN).
- La chica o el camarero: «el cliente dice que ha pagado y aquí sigue
  pendiente».
- Por la mañana, en **Banco** (cuadre): «Cobrado en el banco, aquí sin pagar».

## Qué pasa casi siempre

El banco cobró pero su aviso (Redsys → `POST /v1/webhooks/…`) no llegó o no
se pudo comprobar, y la consulta automática tampoco lo confirmó. El dinero
está en el banco; solo falta apuntarlo.

## Diagnóstico (2 min)

1. **Panel → Incidencias**: importe, hora y el cobro afectado.
2. **canales.redsys.es** (usuario del comercio) → **Consultas** → busca por
   importe y hora, o por el código de pedido (`providerTxId` del cobro, en
   **Pagos** → el cobro).
   - **Autorizada** → el banco cobró → Acción A.
   - **Denegada / no aparece** → no se cobró → Acción B.
3. ¿Son muchos a la vez (varios locales, más de 5)? → Acción C.

## Acciones

### A — El banco cobró

**Panel → Pagos → el cobro → Resolver → Cobrado**, con el número de
autorización de Redsys. Queda auditado, la chica ve su parte y el TPV se
actualiza. Solo el OWNER puede hacerlo, y solo con cobros ORPHAN o
AUTHORIZING de más de 15 min.

### B — El banco no cobró

**Pagos → el cobro → Resolver → Fallido**. Que el cliente vuelva a pagar
(cobro nuevo).

### C — Muchos a la vez: problema general

1. `https://api.paytomaxx.com/v1/health` → ¿`status: ok`? Si no: ver
   [P1-db-overload.md](P1-db-overload.md) (db) o Redis.
2. **Dokploy → nightpay-api → Logs**: busca `webhook` / `Redsys`. Avisos que
   llegan con firma inválida → `REDSYS_SECRET_KEY` mal o cambiada por el banco.
   Avisos que no llegan → siguiente punto.
3. **Cloudflare → Security → Events**: ¿se están bloqueando peticiones a
   `/v1/webhooks/`? (reglas WAF, Bot Fight Mode). Los avisos del banco tienen
   que pasar.
4. `NEXT_PUBLIC_API_URL` del API tiene que ser la URL pública
   (`https://api.paytomaxx.com`): con ella se construye la URL de avisos que
   se manda al banco.
5. Métricas (opcional): `curl -s -H "Authorization: Bearer $METRICS_TOKEN"
   https://api.paytomaxx.com/v1/metrics | grep nightpay_webhooks_received_total`
   — si no sube con cobros nuevos, los avisos no llegan.
6. Si la pasarela entera está caída: [P0-pasarela-caida.md](P0-pasarela-caida.md).

### Lista de cobros atascados (solo lectura)

Dokploy → `nightpay-postgres` → **Terminal**:

```bash
psql -U np -d nightpay -c "
  SELECT id, \"tenantId\", \"amountCents\", status, provider, \"providerTxId\",
         now() - \"updatedAt\" AS esperando
    FROM payments
   WHERE status IN ('AUTHORIZING', 'ORPHAN')
     AND \"updatedAt\" < now() - interval '15 minutes'
   ORDER BY \"updatedAt\";"
```

No cambies estados a mano en la base: hazlo con **Resolver** (deja rastro,
calcula la parte de la chica y avisa a las pantallas).

## Comprobar que está resuelto

- [ ] **Incidencias** sin cobros atascados.
- [ ] Al día siguiente, el cuadre de **Banco** de esa noche sale bien.

## Después

Si afectó a más de 10 cobros, a más de 3 locales o tardó más de 30 min:
postmortem con [`../postmortems/TEMPLATE.md`](../postmortems/TEMPLATE.md).
