-- Recepción y fichas (2026-10-21).
--
--  1. wallet_cash_topups: recargas del saldo en efectivo (recepción). El
--     efectivo no pasa por el banco, así que no es un cobro (payments): es la
--     entrada simétrica a la devolución en efectivo (wallet_payouts CASH).
--     Suma al saldo al momento y entra en la caja de la noche.
--  2. wallet_cards: ciclo de vida de la ficha y el local donde está.
--       STOCK    grabada y sin dar (antes: ACTIVE sin saldo)
--       ISSUED   dada a un saldo   (antes: ACTIVE con saldo)
--       RETURNED devuelta, otra vez en el stock (tras «Me voy» o gastada)
--       LOST     perdida
--       BLOCKED  bloqueada (como antes)
--     Las fichas que ya existen siguen valiendo: las dadas pasan a ISSUED con
--     su saldo y las sin dar a STOCK.
--
-- Idempotente: se puede lanzar dos veces sin cambiar nada la segunda.

-- Los rellenos tienen que ver todas las filas aunque la lance un rol sin
-- superusuario (FORCE RLS en client_wallets). Solo dura esta transacción.
SELECT set_config('app.bypass_rls', 'on', true);

-- ─── 1. Recargas en efectivo ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "wallet_cash_topups" (
  "id"             UUID        NOT NULL DEFAULT gen_random_uuid(),
  -- Local que cobró (el de la caja). El saldo puede ser de otro local del grupo.
  "tenantId"       UUID        NOT NULL,
  "walletId"       UUID        NOT NULL,
  "amountCents"    INTEGER     NOT NULL,
  -- Quién la cobró: la persona o el datáfono de recepción (al menos uno).
  "takenByUserId"  UUID,
  "terminalId"     UUID,
  "idempotencyKey" TEXT        NOT NULL,
  "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "wallet_cash_topups_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_cash_topups_amount_positive') THEN
    ALTER TABLE "wallet_cash_topups"
      ADD CONSTRAINT "wallet_cash_topups_amount_positive" CHECK ("amountCents" > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_cash_topups_taken_by') THEN
    ALTER TABLE "wallet_cash_topups"
      ADD CONSTRAINT "wallet_cash_topups_taken_by" CHECK ("takenByUserId" IS NOT NULL OR "terminalId" IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_cash_topups_tenantId_fkey') THEN
    ALTER TABLE "wallet_cash_topups"
      ADD CONSTRAINT "wallet_cash_topups_tenantId_fkey" FOREIGN KEY ("tenantId")
      REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_cash_topups_walletId_fkey') THEN
    ALTER TABLE "wallet_cash_topups"
      ADD CONSTRAINT "wallet_cash_topups_walletId_fkey" FOREIGN KEY ("walletId")
      REFERENCES "client_wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

-- La misma Idempotency-Key (el mismo botón pulsado dos veces) no carga dos veces.
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_cash_topups_tenantId_idempotencyKey_key"
  ON "wallet_cash_topups" ("tenantId", "idempotencyKey");
CREATE INDEX IF NOT EXISTS "wallet_cash_topups_tenantId_createdAt_idx"
  ON "wallet_cash_topups" ("tenantId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "wallet_cash_topups_walletId_idx"
  ON "wallet_cash_topups" ("walletId");

-- ENABLE sin FORCE, como wallet_payouts (20260502000000_soften_rls_force).
ALTER TABLE "wallet_cash_topups" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wallet_cash_topups_tenant_isolation ON "wallet_cash_topups";
CREATE POLICY wallet_cash_topups_tenant_isolation ON "wallet_cash_topups"
  USING (app_rls_bypass() OR "tenantId" = app_current_tenant())
  WITH CHECK (app_rls_bypass() OR "tenantId" = app_current_tenant());

-- ─── 2. Ciclo de vida de las fichas ─────────────────────────────────────

ALTER TABLE "wallet_cards" ADD COLUMN IF NOT EXISTS "venueId" UUID;
ALTER TABLE "wallet_cards" ADD COLUMN IF NOT EXISTS "stockedAt" TIMESTAMPTZ;
ALTER TABLE "wallet_cards" ADD COLUMN IF NOT EXISTS "returnedAt" TIMESTAMPTZ;
ALTER TABLE "wallet_cards" ADD COLUMN IF NOT EXISTS "lostAt" TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_cards_venueId_fkey') THEN
    ALTER TABLE "wallet_cards"
      ADD CONSTRAINT "wallet_cards_venueId_fkey" FOREIGN KEY ("venueId")
      REFERENCES "venues"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;

-- Dónde está cada ficha que ya existe: el local de su saldo o, sin saldo, el
-- de quien la grabó.
UPDATE "wallet_cards" c
   SET "venueId" = w."tenantId"
  FROM "client_wallets" w
 WHERE c."venueId" IS NULL AND c."walletId" = w."id";
UPDATE "wallet_cards" c
   SET "venueId" = u."tenantId"
  FROM "users" u
 WHERE c."venueId" IS NULL AND c."linkedById" = u."id";

-- ACTIVE → ISSUED (con saldo) o STOCK (sin saldo). El índice «una ficha dada
-- por saldo» pasa a mirar ISSUED: se quita antes y se vuelve a crear.
DROP INDEX IF EXISTS "wallet_cards_one_active_per_wallet";
UPDATE "wallet_cards" SET "status" = 'ISSUED' WHERE "status" = 'ACTIVE' AND "walletId" IS NOT NULL;
UPDATE "wallet_cards"
   SET "status" = 'STOCK', "stockedAt" = COALESCE("stockedAt", "createdAt")
 WHERE "status" = 'ACTIVE' AND "walletId" IS NULL;
ALTER TABLE "wallet_cards" ALTER COLUMN "status" SET DEFAULT 'STOCK';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_cards_status_valid') THEN
    ALTER TABLE "wallet_cards"
      ADD CONSTRAINT "wallet_cards_status_valid"
      CHECK ("status" IN ('STOCK', 'ISSUED', 'RETURNED', 'LOST', 'BLOCKED'));
  END IF;
END
$$;

-- Una ficha dada por saldo (dos «dar ficha» a la vez no dejan dos).
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_cards_one_active_per_wallet"
  ON "wallet_cards" ("walletId") WHERE "status" = 'ISSUED' AND "walletId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "wallet_cards_venueId_status_idx" ON "wallet_cards" ("venueId", "status");
