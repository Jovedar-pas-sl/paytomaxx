-- Migración 20261029400100_check_dinero: las filas que NO cumplirían las
-- restricciones de dinero nuevas. Solo lee: lánzalo en producción ANTES de
-- publicar (Dokploy → nightpay-postgres → Terminal, o desde el API):
--
--   psql "$DATABASE_URL" -f packages/db/scripts/dinero-check-afectados.sql
--
-- Con todo a 0, la migración las deja validadas. Con alguna fila, la migración
-- no falla: esa restricción queda NOT VALID (obliga a las filas nuevas) y
-- db-heal lo avisa en cada arranque; revisa esas filas a mano (y, si es un
-- error, corrígelas con copia de seguridad) y vuelve a lanzar la migración
-- (prisma migrate resolve --rolled-back 20261029400100_check_dinero + Redeploy)
-- para validarla.
--
-- operator_earnings tiene FORCE RLS: con un rol sin superusuario hace falta
-- el bypass (solo dura esta transacción).
BEGIN READ ONLY;
SELECT set_config('app.bypass_rls', 'on', true);

-- Cuántas, por restricción.
SELECT 'payments_amount_positive' AS restriccion, count(*) AS filas
  FROM payments WHERE NOT ("amountCents" > 0)
UNION ALL
SELECT 'payments_commission_bps_range', count(*)
  FROM payments
 WHERE NOT (("platformCommissionBps" IS NULL OR "platformCommissionBps" BETWEEN 0 AND 10000)
        AND ("operatorCommissionBps" IS NULL OR "operatorCommissionBps" BETWEEN 0 AND 10000))
UNION ALL
SELECT 'refunds_amount_positive', count(*)
  FROM refunds WHERE NOT ("amountCents" > 0)
UNION ALL
SELECT 'operator_earnings_commission_nonneg', count(*)
  FROM operator_earnings WHERE NOT ("commissionCents" >= 0)
UNION ALL
SELECT 'operator_earnings_commission_bps_range', count(*)
  FROM operator_earnings WHERE NOT ("commissionBps" BETWEEN 0 AND 10000);

-- Cuáles (las 50 primeras de cada una), con el local.
SELECT 'payments' AS tabla, p.id, v.name AS local, p.status::text, p."amountCents", p."platformCommissionBps",
       p."operatorCommissionBps", p."createdAt"
  FROM payments p JOIN venues v ON v.id = p."tenantId"
 WHERE NOT (p."amountCents" > 0)
    OR NOT ((p."platformCommissionBps" IS NULL OR p."platformCommissionBps" BETWEEN 0 AND 10000)
        AND (p."operatorCommissionBps" IS NULL OR p."operatorCommissionBps" BETWEEN 0 AND 10000))
 ORDER BY p."createdAt" LIMIT 50;

SELECT 'refunds' AS tabla, r.id, v.name AS local, r."paymentId", r.status::text, r."amountCents", r."createdAt"
  FROM refunds r JOIN venues v ON v.id = r."tenantId"
 WHERE NOT (r."amountCents" > 0)
 ORDER BY r."createdAt" LIMIT 50;

SELECT 'operator_earnings' AS tabla, e.id, v.name AS local, e."operatorId", e."paymentId", e."consumptionId",
       e."commissionBps", e."commissionCents", e."createdAt"
  FROM operator_earnings e JOIN venues v ON v.id = e."tenantId"
 WHERE NOT ("commissionCents" >= 0) OR NOT ("commissionBps" BETWEEN 0 AND 10000)
 ORDER BY e."createdAt" LIMIT 50;

ROLLBACK;
