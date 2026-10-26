-- «Comisión del servicio» (2026-10-26, packages/contracts/src/service-fee.ts):
-- lo que paga el CLIENTE encima del precio, ingreso de OxioPay. Con el
-- interruptor del local encendido (solo el super-admin, con 2FA):
--   - pago directo con tarjeta o datáfono: importe + venues."serviceFeeBps";
--   - recarga del saldo (tarjeta o efectivo): recarga + venues."topUpServiceFeeBps";
--   - gastar del saldo: sin comisión (ya se cobró al recargar).
-- Apagado (de fábrica, también en los locales de antes): todo como hasta ahora.
--
--   venues              "serviceFeeEnabled" (false), "serviceFeeBps" y
--                       "topUpServiceFeeBps" (1000 = 10 %), de 0 a 1200
--   businesses          "defaultServiceFeeBps" y "defaultTopUpServiceFeeBps"
--                       (null = la de fábrica) para sus locales nuevos
--   payments            "serviceFeeBps" (el % del momento; null = sin comisión)
--                       y "serviceFeeCents" (0)
--   wallet_cash_topups  lo mismo (en una anulación, la comisión en negativo)
--   wallet_consumptions "platformCommissionBps" (null = el % del local como
--                       siempre; 0 = con la comisión del servicio encendida)
--   refunds             "serviceFeeCents" (la parte de la devolución que era
--                       comisión del servicio; 0)
--
-- Columnas nuevas que admiten NULL o con un valor por defecto constante: en
-- Postgres 11+ no reescriben la tabla y el API anterior (start-first) sigue
-- insertando sin ellas. Los CHECK solo miran columnas nuevas: se ponen NOT
-- VALID (sin recorrer la tabla) y se validan en la misma transacción (todas
-- las filas tienen ya el valor por defecto). Si una fila no los cumpliera, la
-- migración no falla: queda NOT VALID (obliga a las nuevas), sale un WARNING y
-- db-heal lo avisa en cada arranque. check-drift no los ve (Prisma no compara
-- los CHECK): los comprueba apps/api/test/integration/comision-servicio.int.spec.ts.
-- Idempotente.
SET lock_timeout = '5s';

ALTER TABLE "venues"
  ADD COLUMN IF NOT EXISTS "serviceFeeEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "serviceFeeBps" INTEGER NOT NULL DEFAULT 1000,
  ADD COLUMN IF NOT EXISTS "topUpServiceFeeBps" INTEGER NOT NULL DEFAULT 1000;

ALTER TABLE "businesses"
  ADD COLUMN IF NOT EXISTS "defaultServiceFeeBps" INTEGER,
  ADD COLUMN IF NOT EXISTS "defaultTopUpServiceFeeBps" INTEGER;

ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "serviceFeeBps" INTEGER,
  ADD COLUMN IF NOT EXISTS "serviceFeeCents" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "wallet_cash_topups"
  ADD COLUMN IF NOT EXISTS "serviceFeeBps" INTEGER,
  ADD COLUMN IF NOT EXISTS "serviceFeeCents" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "wallet_consumptions"
  ADD COLUMN IF NOT EXISTS "platformCommissionBps" INTEGER;

ALTER TABLE "refunds"
  ADD COLUMN IF NOT EXISTS "serviceFeeCents" INTEGER NOT NULL DEFAULT 0;

-- El recuento del WARNING tiene que ver todas las filas aunque la lance un rol
-- sin superusuario (FORCE RLS en payments, refunds, wallet_cash_topups y
-- wallet_consumptions). Solo esta transacción.
SELECT set_config('app.bypass_rls', 'on', true);

CREATE OR REPLACE FUNCTION pg_temp.np_fee_check(t text, name text, expr text) RETURNS void
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
      RAISE WARNING 'np: % fila(s) de % no cumplen %: queda NOT VALID (vale para las nuevas).', bad, t, name;
    END;
  END IF;
END
$f$;

SELECT pg_temp.np_fee_check('venues', 'venues_service_fee_bps_range',
  '"serviceFeeBps" BETWEEN 0 AND 1200 AND "topUpServiceFeeBps" BETWEEN 0 AND 1200');
SELECT pg_temp.np_fee_check('businesses', 'businesses_service_fee_bps_range',
  '("defaultServiceFeeBps" IS NULL OR "defaultServiceFeeBps" BETWEEN 0 AND 1200) AND ("defaultTopUpServiceFeeBps" IS NULL OR "defaultTopUpServiceFeeBps" BETWEEN 0 AND 1200)');
SELECT pg_temp.np_fee_check('payments', 'payments_service_fee_range',
  '("serviceFeeBps" IS NULL OR "serviceFeeBps" BETWEEN 0 AND 1200) AND "serviceFeeCents" >= 0 AND ("serviceFeeBps" IS NOT NULL OR "serviceFeeCents" = 0)');
SELECT pg_temp.np_fee_check('wallet_cash_topups', 'wallet_cash_topups_service_fee_range',
  '("serviceFeeBps" IS NULL OR "serviceFeeBps" BETWEEN 0 AND 1200) AND (("voidOfId" IS NULL AND "serviceFeeCents" >= 0) OR ("voidOfId" IS NOT NULL AND "serviceFeeCents" <= 0))');
SELECT pg_temp.np_fee_check('wallet_consumptions', 'wallet_consumptions_platform_bps_range',
  '"platformCommissionBps" IS NULL OR "platformCommissionBps" BETWEEN 0 AND 10000');
SELECT pg_temp.np_fee_check('refunds', 'refunds_service_fee_nonneg', '"serviceFeeCents" >= 0');

DROP FUNCTION pg_temp.np_fee_check(text, text, text);
