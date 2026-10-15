-- Revisión 2026-10-15 (#28) — un hash on-chain solo vale para UN pago a chica.
--
-- Antes el mismo externalTxId podía «verificar» varios pagos. Índice único
-- parcial por local sobre el hash normalizado (sin espacios, en minúsculas:
-- en EVM/Tron el hexadecimal no distingue mayúsculas) de los pagos por rails
-- cripto con verificación automática. Las referencias de métodos manuales
-- (efectivo, transferencia…) pueden repetirse y no entran.
--
-- Seguro con datos de producción: si ya hay hashes repetidos NO se crea
-- (aviso NOTICE) para no romper el despliegue; la API lo comprueba igualmente
-- antes de verificar o de apuntar un pago. Idempotente.
DO $$
DECLARE
  repetidos integer;
BEGIN
  IF to_regclass('public.operator_payouts_tenant_onchain_tx_key') IS NOT NULL THEN
    RAISE NOTICE 'operator_payouts_tenant_onchain_tx_key ya existe — nada que hacer';
    RETURN;
  END IF;

  SELECT COUNT(*) INTO repetidos FROM (
    SELECT 1
      FROM operator_payouts
     WHERE "externalTxId" IS NOT NULL
       AND "externalRail" IN ('USDT_TRC20', 'USDT_BEP20', 'USDC_POLY', 'USDC_SOL')
     GROUP BY "tenantId", lower(btrim("externalTxId"))
    HAVING COUNT(*) > 1
  ) d;

  IF repetidos > 0 THEN
    RAISE NOTICE 'operator_payouts: % hash(es) cripto repetidos en el mismo local — índice único NO creado; revísalos y vuelve a aplicar el SQL de esta migración', repetidos;
    RETURN;
  END IF;

  CREATE UNIQUE INDEX operator_payouts_tenant_onchain_tx_key
    ON operator_payouts ("tenantId", lower(btrim("externalTxId")))
    WHERE "externalTxId" IS NOT NULL
      AND "externalRail" IN ('USDT_TRC20', 'USDT_BEP20', 'USDC_POLY', 'USDC_SOL');
END $$;
