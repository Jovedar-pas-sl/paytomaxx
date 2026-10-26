-- «Comisión del servicio», saldo cargado con y sin ella (decisión del dueño,
-- 2026-10-26; apps/api/src/modules/wallets/wallet-fee-saldo.ts): al gastar
-- del saldo, lo cargado CON comisión del servicio no paga nada más (ya la
-- pagó el cliente al recargar) y lo cargado SIN ella paga el % antiguo de
-- plataforma a cargo del local, como siempre. Se gasta primero lo más antiguo.
--
--   wallet_consumptions."serviceFeeSaldoCents": la parte del importe del
--   consumo (sin la propina) pagada con saldo cargado con comisión del
--   servicio; el % antiguo va sobre el resto. 0 de fábrica (los consumos de
--   antes y los del saldo sin comisión: el % antiguo entero, como hasta ahora).
--
-- Columna nueva con un valor por defecto constante (no reescribe la tabla; el
-- API anterior sigue insertando sin ella). El CHECK solo mira la columna
-- nueva y el importe: NOT VALID y se valida en la misma transacción (todas las
-- filas tienen 0); si una fila no lo cumpliera, queda NOT VALID con un
-- WARNING. Idempotente.
SET lock_timeout = '5s';

ALTER TABLE "wallet_consumptions"
  ADD COLUMN IF NOT EXISTS "serviceFeeSaldoCents" INTEGER NOT NULL DEFAULT 0;

-- El recuento del WARNING tiene que ver todas las filas aunque la lance un rol
-- sin superusuario (FORCE RLS en wallet_consumptions). Solo esta transacción.
SELECT set_config('app.bypass_rls', 'on', true);

DO $$
DECLARE
  bad bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'wallet_consumptions'::regclass AND conname = 'wallet_consumptions_fee_saldo_range'
  ) THEN
    ALTER TABLE "wallet_consumptions" ADD CONSTRAINT "wallet_consumptions_fee_saldo_range"
      CHECK ("serviceFeeSaldoCents" >= 0 AND "serviceFeeSaldoCents" <= "amountCents") NOT VALID;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'wallet_consumptions'::regclass AND conname = 'wallet_consumptions_fee_saldo_range'
       AND NOT convalidated
  ) THEN
    BEGIN
      ALTER TABLE "wallet_consumptions" VALIDATE CONSTRAINT "wallet_consumptions_fee_saldo_range";
    EXCEPTION WHEN check_violation THEN
      SELECT count(*) INTO bad FROM "wallet_consumptions"
       WHERE NOT ("serviceFeeSaldoCents" >= 0 AND "serviceFeeSaldoCents" <= "amountCents");
      RAISE WARNING 'np: % fila(s) de wallet_consumptions no cumplen wallet_consumptions_fee_saldo_range: queda NOT VALID (vale para las nuevas).', bad;
    END;
  END IF;
END
$$;
