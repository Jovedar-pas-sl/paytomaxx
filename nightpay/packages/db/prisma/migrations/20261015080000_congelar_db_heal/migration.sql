-- Congela en una migración lo que db-heal hacía en CADA arranque del API
-- (revisión 2026-10-15). Desde aquí, una base nueva creada solo con
-- `prisma migrate deploy` coincide con schema.prisma, y db-heal ya no cambia
-- ni el esquema ni los datos al arrancar.
--
-- Idempotente y sin pérdida de datos: cada paso mira cómo está la base y solo
-- actúa si hace falta (en producción casi todo ya está así y no hace nada).
-- No borra filas: si hay datos que no cumplen un CHECK, el CHECK se añade
-- NOT VALID (obliga a las filas nuevas) y sale un WARNING en el log.
--
-- Lo que la base tiene a propósito y schema.prisma no describe (FKs que solo
-- están en la base, las tablas del saldo-en-el-móvil retirado, un índice de
-- informes) se queda: lo enumera packages/db/scripts/drift-allowlist.json y lo
-- comprueba CI con packages/db/scripts/check-drift.mjs.

-- Los rellenos de abajo tienen que ver todas las filas aunque la migración la
-- lance un rol sin superusuario (FORCE RLS). Solo dura esta transacción.
SELECT set_config('app.bypass_rls', 'on', true);

-- ─── 0. Ayudantes (funciones temporales: desaparecen al cerrar la sesión) ───

-- Rellena los NULL con `fill` y pone NOT NULL, solo si la columna aún admite NULL.
CREATE OR REPLACE FUNCTION pg_temp.np_not_null(t text, c text, fill text) RETURNS void
LANGUAGE plpgsql AS $f$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = t
       AND column_name = c AND is_nullable = 'YES'
  ) THEN
    EXECUTE format('UPDATE %I SET %I = %s WHERE %I IS NULL', t, c, fill, c);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I SET NOT NULL', t, c);
  END IF;
END
$f$;

-- CHECK que falte: se añade sin tocar datos; se valida solo si todo lo cumple.
CREATE OR REPLACE FUNCTION pg_temp.np_check(t text, name text, expr text) RETURNS void
LANGUAGE plpgsql AS $f$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass(format('%I', t)) AND conname = name) THEN
    RETURN;
  END IF;
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%s) NOT VALID', t, name, expr);
  BEGIN
    EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', t, name);
  EXCEPTION WHEN check_violation THEN
    RAISE WARNING 'np: hay filas de % que no cumplen %: queda NOT VALID (vale para filas nuevas). Revísalas a mano.', t, name;
  END;
END
$f$;

-- Índice con el nombre que espera Prisma (si existe el viejo y no el nuevo).
CREATE OR REPLACE FUNCTION pg_temp.np_rename_index(old_name text, new_name text) RETURNS void
LANGUAGE plpgsql AS $f$
BEGIN
  IF to_regclass(format('%I', old_name)) IS NOT NULL AND to_regclass(format('%I', new_name)) IS NULL THEN
    EXECUTE format('ALTER INDEX %I RENAME TO %I', old_name, new_name);
  END IF;
END
$f$;

-- Índice completo (sin WHERE) con el nombre de Prisma, en lugar de uno parcial.
-- Para un UNIQUE es lo mismo: Postgres ya no compara los NULL entre sí.
-- `replaces`: el parcial antiguo con otro nombre, que se quita al final.
CREATE OR REPLACE FUNCTION pg_temp.np_full_index(t text, idx text, cols text, is_unique boolean, replaces text) RETURNS void
LANGUAGE plpgsql AS $f$
DECLARE
  partial boolean;  -- NULL = no existe
BEGIN
  SELECT i.indpred IS NOT NULL INTO partial FROM pg_index i WHERE i.indexrelid = to_regclass(format('%I', idx));
  BEGIN
    IF partial THEN
      EXECUTE format('DROP INDEX %I', idx);
    END IF;
    IF partial IS DISTINCT FROM false THEN
      EXECUTE format('CREATE %s INDEX %I ON %I (%s)', CASE WHEN is_unique THEN 'UNIQUE' ELSE '' END, idx, t, cols);
    END IF;
  EXCEPTION WHEN unique_violation THEN
    -- No debería pasar (el parcial ya obligaba a lo mismo). Se deshace este
    -- paso entero: los índices quedan como estaban.
    RAISE WARNING 'np: valores repetidos en %(%): no se crea %', t, cols, idx;
    RETURN;
  END;
  IF replaces IS NOT NULL AND to_regclass(format('%I', replaces)) IS NOT NULL THEN
    EXECUTE format('DROP INDEX %I', replaces);
  END IF;
END
$f$;

-- FK como la describe schema.prisma: ON DELETE <on_delete> ON UPDATE CASCADE.
-- Si ya está así, no se toca. Si no, se rehace; si hubiera filas huérfanas,
-- queda NOT VALID (obliga a las filas nuevas) con un WARNING.
CREATE OR REPLACE FUNCTION pg_temp.np_fk(t text, fk text, col text, ref text, on_delete text) RETURNS void
LANGUAGE plpgsql AS $f$
DECLARE
  want text := CASE on_delete WHEN 'CASCADE' THEN 'c' WHEN 'SET NULL' THEN 'n' WHEN 'RESTRICT' THEN 'r' END;
  cur record;
BEGIN
  SELECT confdeltype::text AS del, confupdtype::text AS upd INTO cur
    FROM pg_constraint
   WHERE conrelid = to_regclass(format('%I', t)) AND conname = fk AND contype = 'f';
  IF FOUND AND cur.del = want AND cur.upd = 'c' THEN
    RETURN;
  END IF;
  IF FOUND THEN
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, fk);
  END IF;
  EXECUTE format(
    'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I ("id") ON DELETE %s ON UPDATE CASCADE NOT VALID',
    t, fk, col, ref, on_delete);
  BEGIN
    EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', t, fk);
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE WARNING 'np: hay filas de % sin su % (%): queda NOT VALID. Revísalas a mano.', t, ref, fk;
  END;
END
$f$;

-- ─── 1. Columnas que hasta hoy solo creaba db-heal ────────────────────────
-- Estas cuatro no estaban en ninguna migración (una base nueva no las tenía
-- hasta que arrancaba el API).
ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "captureMethod"       TEXT,
  ADD COLUMN IF NOT EXISTS "gatewayPaymentUrl"   TEXT,
  ADD COLUMN IF NOT EXISTS "gatewayCheckoutForm" JSONB,
  ADD COLUMN IF NOT EXISTS "tokenizationData"    JSONB;

-- ─── 2. Columnas que db-heal "aseguraba" (las crean migraciones anteriores) ──
-- En una base al día no hacen nada. Son la red por si alguna de aquellas
-- migraciones se dio por aplicada sin aplicarse (pasó con el db-heal antiguo).
ALTER TABLE "venues"
  ADD COLUMN IF NOT EXISTS "operatorCommissionDefaults" JSONB NOT NULL DEFAULT '{"CHICA_SERVICE":9000,"VENUE_BAR":0,"VENUE_ROOM":0,"VENUE_FOOD":0,"EXTRA":0}'::jsonb,
  ADD COLUMN IF NOT EXISTS "platformCommissionBps" INTEGER NOT NULL DEFAULT 1000,
  ADD COLUMN IF NOT EXISTS "operatorMaxCobroCents" INTEGER NOT NULL DEFAULT 20000,
  ADD COLUMN IF NOT EXISTS "vatBps"                INTEGER NOT NULL DEFAULT 2100,
  ADD COLUMN IF NOT EXISTS "vatRegime"             TEXT    NOT NULL DEFAULT 'GENERAL';

ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "walletId"              UUID,
  ADD COLUMN IF NOT EXISTS "platformCommissionBps" INTEGER,
  ADD COLUMN IF NOT EXISTS "revenueCategory"       TEXT,
  ADD COLUMN IF NOT EXISTS "tipCents"              INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "tipGoesTo"             TEXT,
  ADD COLUMN IF NOT EXISTS "tipBeneficiaryUserId"  UUID;

ALTER TABLE "terminals"
  ADD COLUMN IF NOT EXISTS "zone"          TEXT,
  ADD COLUMN IF NOT EXISTS "hardwareModel" TEXT,
  ADD COLUMN IF NOT EXISTS "deviceSerial"  TEXT;

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "isSuperAdmin"        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "displayName"         TEXT,
  ADD COLUMN IF NOT EXISTS "invitedAt"           TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "inviteToken"         TEXT,
  ADD COLUMN IF NOT EXISTS "selfOnboardingToken" TEXT,
  ADD COLUMN IF NOT EXISTS "commissionBps"       INTEGER,
  ADD COLUMN IF NOT EXISTS "payoutMethod"        TEXT,
  ADD COLUMN IF NOT EXISTS "payoutAddress"       TEXT,
  ADD COLUMN IF NOT EXISTS "payoutMetadata"      JSONB,
  ADD COLUMN IF NOT EXISTS "payoutLabel"         TEXT,
  ADD COLUMN IF NOT EXISTS "phone"               TEXT,
  ADD COLUMN IF NOT EXISTS "passportCountry"     TEXT,
  ADD COLUMN IF NOT EXISTS "passportLast4"       TEXT,
  ADD COLUMN IF NOT EXISTS "hasEmpadronamiento"  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "hasNie"              BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "hasTie"              BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "walletProvider"      TEXT,
  ADD COLUMN IF NOT EXISTS "walletStatus"        TEXT,
  ADD COLUMN IF NOT EXISTS "walletTestPassed"    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "walletTestAt"        TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "needsHelpWallet"     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "needsHelpDocs"       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "onboardingStatus"    TEXT    NOT NULL DEFAULT 'NEW',
  ADD COLUMN IF NOT EXISTS "onboardingNotes"     TEXT;

-- Valores por defecto como en schema.prisma (solo catálogo, no toca filas).
ALTER TABLE "venues"
  ALTER COLUMN "operatorCommissionDefaults" SET DEFAULT '{"CHICA_SERVICE":9000,"VENUE_BAR":0,"VENUE_ROOM":0,"VENUE_FOOD":0,"EXTRA":0}'::jsonb,
  ALTER COLUMN "platformCommissionBps" SET DEFAULT 1000,
  ALTER COLUMN "operatorMaxCobroCents" SET DEFAULT 20000,
  ALTER COLUMN "vatBps" SET DEFAULT 2100,
  ALTER COLUMN "vatRegime" SET DEFAULT 'GENERAL';
ALTER TABLE "payments"
  ALTER COLUMN "revenueCategory" SET DEFAULT 'EXTRA',
  ALTER COLUMN "tipCents" SET DEFAULT 0;
ALTER TABLE "users"
  ALTER COLUMN "isSuperAdmin" SET DEFAULT false,
  ALTER COLUMN "hasEmpadronamiento" SET DEFAULT false,
  ALTER COLUMN "hasNie" SET DEFAULT false,
  ALTER COLUMN "hasTie" SET DEFAULT false,
  ALTER COLUMN "walletTestPassed" SET DEFAULT false,
  ALTER COLUMN "needsHelpWallet" SET DEFAULT false,
  ALTER COLUMN "needsHelpDocs" SET DEFAULT false,
  ALTER COLUMN "onboardingStatus" SET DEFAULT 'NEW';

-- NOT NULL donde schema.prisma lo pide (rellenando antes los NULL, como hacía
-- db-heal en cada arranque; aquí una sola vez).
SELECT pg_temp.np_not_null('venues', 'operatorCommissionDefaults',
  $j$'{"CHICA_SERVICE":9000,"VENUE_BAR":0,"VENUE_ROOM":0,"VENUE_FOOD":0,"EXTRA":0}'::jsonb$j$);
SELECT pg_temp.np_not_null('venues', 'platformCommissionBps', '1000');
SELECT pg_temp.np_not_null('venues', 'operatorMaxCobroCents', '20000');
SELECT pg_temp.np_not_null('venues', 'vatBps', '2100');
SELECT pg_temp.np_not_null('venues', 'vatRegime', $j$'GENERAL'$j$);
SELECT pg_temp.np_not_null('payments', 'revenueCategory',
  $j$CASE WHEN "walletId" IS NULL AND "createdByUserId" IS NOT NULL THEN 'CHICA_SERVICE' ELSE 'EXTRA' END$j$);
SELECT pg_temp.np_not_null('payments', 'tipCents', '0');
SELECT pg_temp.np_not_null('users', 'isSuperAdmin', 'false');
SELECT pg_temp.np_not_null('users', 'hasEmpadronamiento', 'false');
SELECT pg_temp.np_not_null('users', 'hasNie', 'false');
SELECT pg_temp.np_not_null('users', 'hasTie', 'false');
SELECT pg_temp.np_not_null('users', 'walletTestPassed', 'false');
SELECT pg_temp.np_not_null('users', 'needsHelpWallet', 'false');
SELECT pg_temp.np_not_null('users', 'needsHelpDocs', 'false');
SELECT pg_temp.np_not_null('users', 'onboardingStatus', $j$'NEW'$j$);

-- ─── 3. Pasarelas del enum (ya las añadían migraciones de 2026-05 y 2026-10) ─
ALTER TYPE "Provider" ADD VALUE IF NOT EXISTS 'PAYTEF';
ALTER TYPE "Provider" ADD VALUE IF NOT EXISTS 'REDSYS';

-- ─── 4. CHECKs que db-heal reponía (y antes "arreglaba" borrando pagos) ─────
-- Ahora: si faltan, se añaden SIN borrar ni cambiar datos.
SELECT pg_temp.np_check('operator_payouts', 'operator_payouts_total_positive', '"totalCents" > 0');
SELECT pg_temp.np_check('operator_earnings', 'operator_earnings_reversed_bounded',
  '"reversedCents" >= 0 AND "reversedCents" <= "commissionCents" + COALESCE("tipCents", 0)');
SELECT pg_temp.np_check('payments', 'payments_revenue_category_valid',
  $j$"revenueCategory" IN ('CHICA_SERVICE', 'VENUE_BAR', 'VENUE_ROOM', 'VENUE_FOOD', 'EXTRA')$j$);

-- ─── 5. Índices con el nombre y la forma de schema.prisma ─────────────────
-- Mismas columnas, solo cambia el nombre (nadie los nombra en el código).
SELECT pg_temp.np_rename_index('client_wallets_tenant_created_idx', 'client_wallets_tenantId_createdAt_idx');
SELECT pg_temp.np_rename_index('client_wallets_tenant_identifier_idx', 'client_wallets_tenantId_identifier_idx');
SELECT pg_temp.np_rename_index('client_wallets_tenant_status_idx', 'client_wallets_tenantId_status_idx');
SELECT pg_temp.np_rename_index('operator_earnings_paymentId_unique', 'operator_earnings_paymentId_key');
SELECT pg_temp.np_rename_index('operator_earnings_tenant_operator_created_idx', 'operator_earnings_tenantId_operatorId_createdAt_idx');
SELECT pg_temp.np_rename_index('operator_earnings_tenant_operator_payout_idx', 'operator_earnings_tenantId_operatorId_payoutId_idx');
SELECT pg_temp.np_rename_index('operator_payouts_tenant_operator_created_idx', 'operator_payouts_tenantId_operatorId_createdAt_idx');
SELECT pg_temp.np_rename_index('wallet_consumptions_category_idx', 'wallet_consumptions_tenantId_category_idx');
SELECT pg_temp.np_rename_index('wallet_consumptions_provider_created_idx', 'wallet_consumptions_tenantId_providedByUserId_createdAt_idx');
SELECT pg_temp.np_rename_index('wallet_consumptions_tenant_idempotency_key', 'wallet_consumptions_tenantId_idempotencyKey_key');
SELECT pg_temp.np_rename_index('wallet_consumptions_wallet_created_idx', 'wallet_consumptions_tenantId_walletId_createdAt_idx');

-- Parciales (WHERE … IS NOT NULL) → completos: Prisma no ve los parciales.
SELECT pg_temp.np_full_index('users', 'users_selfOnboardingToken_key', '"selfOnboardingToken"', true, NULL);
SELECT pg_temp.np_full_index('terminals', 'terminals_deviceTokenHash_key', '"deviceTokenHash"', true, NULL);
SELECT pg_temp.np_full_index('terminals', 'terminals_pairingCodeHash_key', '"pairingCodeHash"', true, NULL);
SELECT pg_temp.np_full_index('payments', 'payments_posTerminalId_posOperationNumber_key', '"posTerminalId", "posOperationNumber"', true, NULL);
SELECT pg_temp.np_full_index('operator_earnings', 'operator_earnings_consumptionId_key', '"consumptionId"', true, 'operator_earnings_consumptionId_unique');
SELECT pg_temp.np_full_index('payments', 'payments_tipBeneficiaryUserId_idx', '"tipBeneficiaryUserId"', false, 'payments_tipBeneficiary_idx');
SELECT pg_temp.np_full_index('operator_payouts', 'operator_payouts_tenantId_reconciliationStatus_idx', '"tenantId", "reconciliationStatus"', false, 'operator_payouts_recon_status_idx');

-- ─── 6. client_wallets.updatedAt: lo pone Prisma (@updatedAt), sin DEFAULT ──
ALTER TABLE "client_wallets" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- ─── 7. Claves ajenas con las acciones de schema.prisma ───────────────────
-- Casi todas solo cambian ON UPDATE (NO ACTION → CASCADE: los id no cambian
-- nunca). Las de operator_earnings a pagos/consumos pasan a SET NULL como dice
-- el esquema; el CHECK operator_earnings_source_xor sigue impidiendo borrar
-- un cobro o un consumo que tenga comisión.
SELECT pg_temp.np_fk('peanpe_calls', 'peanpe_calls_paymentId_fkey', 'paymentId', 'payments', 'CASCADE');
SELECT pg_temp.np_fk('peanpe_calls', 'peanpe_calls_tenantId_fkey', 'tenantId', 'venues', 'CASCADE');
SELECT pg_temp.np_fk('payments', 'payments_createdByUserId_fkey', 'createdByUserId', 'users', 'SET NULL');
SELECT pg_temp.np_fk('payments', 'payments_walletId_fkey', 'walletId', 'client_wallets', 'SET NULL');
SELECT pg_temp.np_fk('payments', 'payments_tipBeneficiaryUserId_fkey', 'tipBeneficiaryUserId', 'users', 'SET NULL');
SELECT pg_temp.np_fk('payment_attempts', 'payment_attempts_paymentId_fkey', 'paymentId', 'payments', 'CASCADE');
SELECT pg_temp.np_fk('wallet_charge_requests', 'wallet_charge_requests_walletId_fkey', 'walletId', 'client_wallets', 'CASCADE');
SELECT pg_temp.np_fk('wallet_payouts', 'wallet_payouts_walletId_fkey', 'walletId', 'client_wallets', 'CASCADE');
SELECT pg_temp.np_fk('pos_terminal_ops', 'pos_terminal_ops_tenantId_fkey', 'tenantId', 'venues', 'CASCADE');
SELECT pg_temp.np_fk('pos_terminal_ops', 'pos_terminal_ops_terminalId_fkey', 'terminalId', 'terminals', 'CASCADE');
SELECT pg_temp.np_fk('incident_acks', 'incident_acks_tenantId_fkey', 'tenantId', 'venues', 'CASCADE');
SELECT pg_temp.np_fk('venue_nights', 'venue_nights_tenantId_fkey', 'tenantId', 'venues', 'CASCADE');
SELECT pg_temp.np_fk('service_items', 'service_items_tenantId_fkey', 'tenantId', 'venues', 'CASCADE');
SELECT pg_temp.np_fk('operator_earnings', 'operator_earnings_tenantId_fkey', 'tenantId', 'venues', 'RESTRICT');
SELECT pg_temp.np_fk('operator_earnings', 'operator_earnings_operatorId_fkey', 'operatorId', 'users', 'RESTRICT');
SELECT pg_temp.np_fk('operator_earnings', 'operator_earnings_paymentId_fkey', 'paymentId', 'payments', 'SET NULL');
SELECT pg_temp.np_fk('operator_earnings', 'operator_earnings_consumptionId_fkey', 'consumptionId', 'wallet_consumptions', 'SET NULL');
SELECT pg_temp.np_fk('operator_earnings', 'operator_earnings_payoutId_fkey', 'payoutId', 'operator_payouts', 'SET NULL');
SELECT pg_temp.np_fk('earning_reversals', 'earning_reversals_earningId_fkey', 'earningId', 'operator_earnings', 'CASCADE');
SELECT pg_temp.np_fk('earning_reversals', 'earning_reversals_refundId_fkey', 'refundId', 'refunds', 'CASCADE');
SELECT pg_temp.np_fk('operator_payouts', 'operator_payouts_tenantId_fkey', 'tenantId', 'venues', 'RESTRICT');
SELECT pg_temp.np_fk('operator_payouts', 'operator_payouts_operatorId_fkey', 'operatorId', 'users', 'RESTRICT');
SELECT pg_temp.np_fk('operator_payouts', 'operator_payouts_paidByUserId_fkey', 'paidByUserId', 'users', 'RESTRICT');
SELECT pg_temp.np_fk('operator_payouts', 'operator_payouts_reconciledByUserId_fkey', 'reconciledByUserId', 'users', 'SET NULL');
SELECT pg_temp.np_fk('client_wallets', 'client_wallets_tenantId_fkey', 'tenantId', 'venues', 'RESTRICT');
SELECT pg_temp.np_fk('wallet_cards', 'wallet_cards_walletId_fkey', 'walletId', 'client_wallets', 'SET NULL');
SELECT pg_temp.np_fk('wallet_passkeys', 'wallet_passkeys_walletId_fkey', 'walletId', 'client_wallets', 'CASCADE');
SELECT pg_temp.np_fk('wallet_consumptions', 'wallet_consumptions_tenantId_fkey', 'tenantId', 'venues', 'RESTRICT');
SELECT pg_temp.np_fk('wallet_consumptions', 'wallet_consumptions_walletId_fkey', 'walletId', 'client_wallets', 'RESTRICT');
SELECT pg_temp.np_fk('wallet_consumptions', 'wallet_consumptions_providedByUserId_fkey', 'providedByUserId', 'users', 'RESTRICT');
SELECT pg_temp.np_fk('wallet_consumptions', 'wallet_consumptions_reversedByUserId_fkey', 'reversedByUserId', 'users', 'SET NULL');
SELECT pg_temp.np_fk('bank_statement_items', 'bank_statement_items_statementId_fkey', 'statementId', 'bank_statements', 'CASCADE');

-- ─── 8. Fuera los ayudantes ───────────────────────────────────────────────
DROP FUNCTION pg_temp.np_not_null(text, text, text);
DROP FUNCTION pg_temp.np_check(text, text, text);
DROP FUNCTION pg_temp.np_rename_index(text, text);
DROP FUNCTION pg_temp.np_full_index(text, text, text, boolean, text);
DROP FUNCTION pg_temp.np_fk(text, text, text, text, text);
