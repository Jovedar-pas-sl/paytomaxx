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
--     Las fichas que ya existen: ISSUED solo las de un saldo vivo (ACTIVE y
--     sin sumar a otro); las de un saldo ya cerrado, gastado o sumado vuelven
--     al stock (RETURNED, sin saldo); las sin saldo, a STOCK.
--
-- Paso 1 de 2 (se puede volver al API anterior, docs/DOKPLOY-STEPS.md):
--   - el CHECK aún admite ACTIVE y el valor por defecto sigue siendo ACTIVE:
--     el API anterior puede seguir creando y dando fichas;
--   - el API nuevo lee ACTIVE como ISSUED (con saldo) o STOCK (sin saldo);
--   - para volver atrás basta un UPDATE (ISSUED/STOCK/RETURNED → ACTIVE),
--     sin tocar el esquema.
--   El paso 2, en otra versión: convertir las ACTIVE que queden, cerrar el
--   CHECK y poner STOCK por defecto.
--
-- Idempotente: se puede lanzar dos veces sin cambiar nada la segunda.

-- Con el API anterior sirviendo: si una transacción suya tiene las tablas,
-- mejor fallar en 5 s (y reintentar el despliegue) que encolar sus escrituras.
SET lock_timeout = '5s';

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

-- FORCE ROW LEVEL SECURITY: en 20261021200000_efectivo_fichas.
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

-- ACTIVE → ISSUED solo si su saldo sigue vivo (ACTIVE y sin sumar a otro): el
-- API anterior nunca soltaba la ficha al devolver, al gastarse o al sumar el
-- saldo, así que las de saldos cerrados vuelven al stock (RETURNED, sin
-- saldo). Las sin saldo, a STOCK. El índice «una ficha dada por saldo» se
-- quita antes y se vuelve a crear (ahora mira ISSUED y ACTIVE).
DROP INDEX IF EXISTS "wallet_cards_one_active_per_wallet";
UPDATE "wallet_cards" c
   SET "status" = 'ISSUED'
  FROM "client_wallets" w
 WHERE c."status" = 'ACTIVE' AND c."walletId" = w."id"
   AND w."status" = 'ACTIVE' AND w."mergedIntoId" IS NULL;
UPDATE "wallet_cards"
   SET "status" = 'RETURNED', "walletId" = NULL, "returnedAt" = now()
 WHERE "status" = 'ACTIVE' AND "walletId" IS NOT NULL;
UPDATE "wallet_cards"
   SET "status" = 'STOCK', "stockedAt" = COALESCE("stockedAt", "createdAt")
 WHERE "status" = 'ACTIVE' AND "walletId" IS NULL;

-- ACTIVE sigue valiendo (paso 1 de 2): el API anterior la escribe.
ALTER TABLE "wallet_cards" DROP CONSTRAINT IF EXISTS "wallet_cards_status_valid";
ALTER TABLE "wallet_cards"
  ADD CONSTRAINT "wallet_cards_status_valid"
  CHECK ("status" IN ('STOCK', 'ISSUED', 'RETURNED', 'LOST', 'BLOCKED', 'ACTIVE'));

-- Una ficha dada por saldo (dos «dar ficha» a la vez no dejan dos).
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_cards_one_active_per_wallet"
  ON "wallet_cards" ("walletId") WHERE "status" IN ('ISSUED', 'ACTIVE') AND "walletId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "wallet_cards_venueId_status_idx" ON "wallet_cards" ("venueId", "status");
