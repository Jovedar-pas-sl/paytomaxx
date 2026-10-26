-- Restricciones de dinero que faltaban en la base (revisión total 2026-10-26,
-- DI-07). Hasta ahora solo las validaban zod y los servicios: un fallo, un
-- script o la CLI podían guardar un cobro de 0 € o negativo, una devolución
-- negativa (availableAmountCents <= amountCents + tipCents no lo ve si los dos
-- son negativos), una comisión negativa o un porcentaje fuera de 0–100 %.
--
--   payments          "amountCents" > 0
--   payments          "platformCommissionBps" y "operatorCommissionBps": NULL o 0–10000
--   refunds           "amountCents" > 0
--   operator_earnings "commissionCents" >= 0 y "commissionBps" 0–10000
--
-- Comprobado en el código antes de ponerlas: ningún camino guarda esos valores
-- (cobro: charge-lines.ts rechaza un total <= 0; devoluciones: zod positive y
-- el reparto de la devolución del saldo no da partes de 0; comisiones:
-- round(importe × % / 10000) con % de 0 a 10000 validado en zod, la CLI y la
-- consola; la parte de una invitación no pasa de su línea).
--
-- ANTES de publicar: packages/db/scripts/dinero-check-afectados.sql (solo lee)
-- dice cuántas filas de producción no las cumplirían. Si hay alguna, la
-- migración no falla: esa restricción queda NOT VALID (obliga a las filas
-- nuevas), sale un WARNING y db-heal lo avisa en cada arranque.
--
-- Candados: cada ALTER pone su restricción NOT VALID (sin recorrer la tabla) y
-- la valida en la misma transacción (lee la tabla una vez con el candado
-- puesto): medido con 320.000 cobros, ~0,4 s las dos de payments. Si una transacción
-- del API anterior tiene la tabla, falla a los 5 s y no cambia nada: se marca
-- como deshecha y se vuelve a desplegar (docs/DOKPLOY-STEPS.md, D.8).
-- check-drift no las ve (Prisma no compara los CHECK): las comprueba
-- apps/api/test/integration/check-dinero.int.spec.ts. Idempotente.
SET lock_timeout = '5s';

-- El recuento del WARNING tiene que ver todas las filas aunque la lance un rol
-- sin superusuario (operator_earnings tiene FORCE RLS). Solo esta transacción.
SELECT set_config('app.bypass_rls', 'on', true);

CREATE OR REPLACE FUNCTION pg_temp.np_money_check(t text, name text, expr text) RETURNS void
LANGUAGE plpgsql AS $f$
DECLARE
  bad bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass(format('%I', t)) AND conname = name) THEN
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%s) NOT VALID', t, name, expr);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass(format('%I', t)) AND conname = name AND NOT convalidated) THEN
    BEGIN
      EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', t, name);
    EXCEPTION WHEN check_violation THEN
      EXECUTE format('SELECT count(*) FROM %I WHERE NOT (%s)', t, expr) INTO bad;
      RAISE WARNING 'np: % fila(s) de % no cumplen %: queda NOT VALID (vale para las nuevas). Ver packages/db/scripts/dinero-check-afectados.sql.', bad, t, name;
    END;
  END IF;
END
$f$;

SELECT pg_temp.np_money_check('payments', 'payments_amount_positive', '"amountCents" > 0');
SELECT pg_temp.np_money_check('payments', 'payments_commission_bps_range',
  '("platformCommissionBps" IS NULL OR "platformCommissionBps" BETWEEN 0 AND 10000) AND ("operatorCommissionBps" IS NULL OR "operatorCommissionBps" BETWEEN 0 AND 10000)');
SELECT pg_temp.np_money_check('refunds', 'refunds_amount_positive', '"amountCents" > 0');
SELECT pg_temp.np_money_check('operator_earnings', 'operator_earnings_commission_nonneg', '"commissionCents" >= 0');
SELECT pg_temp.np_money_check('operator_earnings', 'operator_earnings_commission_bps_range', '"commissionBps" BETWEEN 0 AND 10000');

DROP FUNCTION pg_temp.np_money_check(text, text, text);
