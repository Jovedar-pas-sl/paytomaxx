-- API de socios, las cargas de saldo (26-nov-2026; PR 3 de la API de socios,
-- docs/partner-api). Los cajeros del dueño, dentro del local, cargan saldo en
-- efectivo: cargar, leer, anular en 10 minutos, listar y el resumen. La API
-- sigue apagada (PARTNER_API_ENABLED=false) hasta el PR 8.
--
-- (Se llama 20261126200000: tiene que ordenarse después de la última de la
-- rama, 20261126100000_partner_core; ver scripts/check-migration-order.mjs.)
--
--   partner_wallet_operations  el libro de las cargas de los socios: una fila
--                              LOAD por carga (con su huella y la respuesta
--                              guardada para repetirla) y una LOAD_VOID por
--                              anulación. Solo de añadir (trigger, como
--                              audit_events) y FORCE RLS (como stalls).
--   wallet_cash_topups         + "partnerConnectionId": el efectivo de un cajero
--                              entra por aquí (es del local, VENUE_COLLECTS), así
--                              el tope legal de 1.000 €, el IVA y el % de la
--                              plataforma ya lo ven. Sin comisión del servicio ni
--                              saldo nuevo.
--   wallet_cash_topups_taken_by, partner_connections_paused_reason
--                              reemplazados (como payments_available_in_range en
--                              20261030100000): la fila de un cajero no lleva
--                              persona ni datáfono, y las pausas automáticas de
--                              las cargas (load_refusals, load_burst, load_voids).
--
-- La tabla es nueva y vacía: sus CHECK van en el CREATE TABLE. Lo de
-- wallet_cash_topups y partner_connections (columnas nuevas o reglas más
-- amplias): NOT VALID y VALIDATE con el ayudante de 20261029400100_check_dinero.
-- check-drift no ve los CHECK ni el trigger: los comprueba
-- apps/api/test/integration/socios-cargas-migracion.int.spec.ts. Idempotente.

SET lock_timeout = '5s';

-- ─── Tipos ─────────────────────────────────────────────────────────────

DO $$ BEGIN CREATE TYPE "PartnerWalletOpKind" AS ENUM ('LOAD', 'LOAD_VOID'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── wallet_cash_topups: el efectivo de un cajero ──────────────────────

ALTER TABLE "wallet_cash_topups" ADD COLUMN IF NOT EXISTS "partnerConnectionId" UUID;

-- ─── partner_wallet_operations: el libro ───────────────────────────────

CREATE TABLE IF NOT EXISTS "partner_wallet_operations" (
  "id"                 UUID                  NOT NULL DEFAULT gen_random_uuid(),
  -- El local de la conexión (no el del saldo, que puede ser otro del grupo).
  "tenantId"           UUID                  NOT NULL,
  "connectionId"       UUID                  NOT NULL,
  "kind"               "PartnerWalletOpKind" NOT NULL,
  -- LOAD_VOID: la carga que anula (una anulación por carga).
  "reversesId"         UUID,
  -- El saldo vivo en el que se cargó (nunca sale en una respuesta).
  "walletId"           UUID                  NOT NULL,
  "amountCents"        INTEGER               NOT NULL,
  "balanceBeforeCents" INTEGER               NOT NULL,
  "balanceAfterCents"  INTEGER               NOT NULL,
  "description"        TEXT,
  "reference"          TEXT,
  "device"             TEXT,
  "funding"            TEXT,
  "cashTopupId"        UUID,
  "refKind"            TEXT,
  "reason"             TEXT,
  -- LOAD_VOID desde el panel: quién (null = la plataforma, por la API).
  "voidedByUserId"     UUID,
  "idempotencyKey"     TEXT                  NOT NULL,
  -- LOAD: sha256 de la petición (stableJson) y la respuesta 201 guardada.
  "requestHash"        TEXT,
  "response"           JSONB,
  -- Del código (el mismo `now` que la fila de caja): sin DEFAULT.
  "createdAt"          TIMESTAMPTZ           NOT NULL,

  CONSTRAINT "partner_wallet_operations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "partner_wallet_operations_tenantId_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "partner_wallet_operations_connectionId_fkey" FOREIGN KEY ("connectionId")
    REFERENCES "partner_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "partner_wallet_operations_reversesId_fkey" FOREIGN KEY ("reversesId")
    REFERENCES "partner_wallet_operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "partner_wallet_operations_walletId_fkey" FOREIGN KEY ("walletId")
    REFERENCES "client_wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "partner_wallet_operations_cashTopupId_fkey" FOREIGN KEY ("cashTopupId")
    REFERENCES "wallet_cash_topups"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "partner_wallet_operations_amount_positive" CHECK ("amountCents" > 0),
  -- El saldo de antes y el de después: nunca negativos, y después = antes ± importe.
  CONSTRAINT "partner_wallet_operations_balances" CHECK (
    "balanceBeforeCents" >= 0 AND "balanceAfterCents" >= 0
    AND (("kind" = 'LOAD' AND "balanceAfterCents" = "balanceBeforeCents" + "amountCents")
      OR ("kind" = 'LOAD_VOID' AND "balanceAfterCents" = "balanceBeforeCents" - "amountCents"))
  ),
  -- Una carga: forma de pago, descripción de 1 a 60 (puntos de código), cómo se
  -- identificó el saldo, huella, respuesta y, en efectivo, su fila de caja
  -- (hasta el PR 9 solo hay efectivo y tarjeta del local).
  CONSTRAINT "partner_wallet_operations_load" CHECK (
    "kind" <> 'LOAD'
    OR ("reversesId" IS NULL
        AND "funding" IN ('cash', 'card', 'transfer', 'bank_app')
        AND "description" IS NOT NULL AND char_length("description") BETWEEN 1 AND 60
        AND "refKind" IN ('live_code', 'ficha', 'ficha_nfc')
        AND "requestHash" ~ '^[0-9a-f]{64}$'
        AND "response" IS NOT NULL
        AND ("funding" <> 'cash' OR "cashTopupId" IS NOT NULL)
        AND "voidedByUserId" IS NULL
        AND "idempotencyKey" ~ '^[A-Za-z0-9_-]{8,200}$')
  ),
  -- Una anulación: la carga que anula y nada de lo de la carga salvo su fila de caja.
  CONSTRAINT "partner_wallet_operations_void" CHECK (
    "kind" <> 'LOAD_VOID'
    OR ("reversesId" IS NOT NULL
        AND "funding" IS NULL AND "description" IS NULL AND "reference" IS NULL AND "device" IS NULL
        AND "refKind" IS NULL AND "requestHash" IS NULL AND "response" IS NULL
        AND "idempotencyKey" = 'void:' || "reversesId"::text)
  ),
  -- El motivo, solo en las anulaciones.
  CONSTRAINT "partner_wallet_operations_reason" CHECK (
    "reason" IS NULL OR ("kind" = 'LOAD_VOID' AND char_length("reason") BETWEEN 1 AND 140)
  ),
  -- Los patrones del contrato (Reference y Device).
  CONSTRAINT "partner_wallet_operations_texts" CHECK (
    ("reference" IS NULL OR "reference" ~ '^[A-Za-z0-9._:/#-]{1,64}$')
    AND ("device" IS NULL OR "device" ~ '^[A-Za-z0-9_-]{1,32}$')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "partner_wallet_operations_reversesId_key" ON "partner_wallet_operations"("reversesId");
CREATE UNIQUE INDEX IF NOT EXISTS "partner_wallet_operations_cashTopupId_key" ON "partner_wallet_operations"("cashTopupId");
CREATE UNIQUE INDEX IF NOT EXISTS "partner_wallet_operations_connectionId_idempotencyKey_key"
  ON "partner_wallet_operations"("connectionId", "idempotencyKey");
CREATE INDEX IF NOT EXISTS "partner_wallet_operations_connectionId_createdAt_idx" ON "partner_wallet_operations"("connectionId", "createdAt");
CREATE INDEX IF NOT EXISTS "partner_wallet_operations_walletId_createdAt_idx" ON "partner_wallet_operations"("walletId", "createdAt");

ALTER TABLE "partner_wallet_operations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "partner_wallet_operations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS partner_wallet_operations_tenant_isolation ON "partner_wallet_operations";
CREATE POLICY partner_wallet_operations_tenant_isolation ON "partner_wallet_operations"
  USING ((SELECT app_rls_bypass()) OR "tenantId" = (SELECT app_current_tenant()))
  WITH CHECK ((SELECT app_rls_bypass()) OR "tenantId" = (SELECT app_current_tenant()));

-- Solo de añadir: UPDATE, DELETE y TRUNCATE fallan (como audit_events). Un
-- superusuario o el dueño de la tabla puede desactivar los triggers.
CREATE OR REPLACE FUNCTION partner_wallet_operations_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'partner_wallet_operations es solo de añadir: % no permitido', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS partner_wallet_operations_no_update_delete ON "partner_wallet_operations";
CREATE TRIGGER partner_wallet_operations_no_update_delete
  BEFORE UPDATE OR DELETE ON "partner_wallet_operations"
  FOR EACH ROW EXECUTE FUNCTION partner_wallet_operations_append_only();

DROP TRIGGER IF EXISTS partner_wallet_operations_no_truncate ON "partner_wallet_operations";
CREATE TRIGGER partner_wallet_operations_no_truncate
  BEFORE TRUNCATE ON "partner_wallet_operations"
  FOR EACH STATEMENT EXECUTE FUNCTION partner_wallet_operations_append_only();

-- ─── Lo que cambia en tablas que ya tienen filas ───────────────────────

-- El recuento del WARNING tiene que ver todas las filas aunque la lance un rol
-- sin superusuario (FORCE RLS en wallet_cash_topups y partner_connections).
-- Solo esta transacción.
SELECT set_config('app.bypass_rls', 'on', true);

CREATE OR REPLACE FUNCTION pg_temp.np_partner_check(t text, name text, expr text) RETURNS void
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

-- La FK de la columna nueva: NOT VALID (sin recorrer la tabla) y validada (todas a NULL).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_cash_topups_partnerConnectionId_fkey') THEN
    ALTER TABLE "wallet_cash_topups"
      ADD CONSTRAINT "wallet_cash_topups_partnerConnectionId_fkey" FOREIGN KEY ("partnerConnectionId")
      REFERENCES "partner_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_cash_topups_partnerConnectionId_fkey' AND NOT convalidated) THEN
    ALTER TABLE "wallet_cash_topups" VALIDATE CONSTRAINT "wallet_cash_topups_partnerConnectionId_fkey";
  END IF;
END
$$;
CREATE INDEX IF NOT EXISTS "wallet_cash_topups_partnerConnectionId_idx" ON "wallet_cash_topups"("partnerConnectionId");

-- La fila de un cajero: sin comisión del servicio y sin saldo nuevo (VENUE_COLLECTS).
SELECT pg_temp.np_partner_check('wallet_cash_topups', 'wallet_cash_topups_partner',
  '"partnerConnectionId" IS NULL OR ("serviceFeeBps" IS NULL AND "serviceFeeCents" = 0 AND NOT "createdWallet")');

-- Quién cogió el efectivo: una persona, un datáfono o (ahora) la conexión de un
-- cajero. Más amplio que el de 20261021100000: las filas de antes lo cumplen.
-- Solo se cambia si aún es el de antes (repetirla no lo toca).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'wallet_cash_topups'::regclass AND conname = 'wallet_cash_topups_taken_by'
       AND pg_get_constraintdef(oid) NOT LIKE '%partnerConnectionId%'
  ) THEN
    ALTER TABLE "wallet_cash_topups" DROP CONSTRAINT "wallet_cash_topups_taken_by";
  END IF;
END
$$;
SELECT pg_temp.np_partner_check('wallet_cash_topups', 'wallet_cash_topups_taken_by',
  '"takenByUserId" IS NOT NULL OR "terminalId" IS NOT NULL OR "partnerConnectionId" IS NOT NULL');

-- Las pausas automáticas de las cargas (PARTNER_PAUSE_REASONS).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'partner_connections'::regclass AND conname = 'partner_connections_paused_reason'
       AND pg_get_constraintdef(oid) NOT LIKE '%load_refusals%'
  ) THEN
    ALTER TABLE "partner_connections" DROP CONSTRAINT "partner_connections_paused_reason";
  END IF;
END
$$;
SELECT pg_temp.np_partner_check('partner_connections', 'partner_connections_paused_reason',
  '"pausedReason" IS NULL OR "pausedReason" IN (''owner'', ''manager'', ''foreign_ip'', ''oxiopay'', ''load_refusals'', ''load_burst'', ''load_voids'')');

DROP FUNCTION pg_temp.np_partner_check(text, text, text);
