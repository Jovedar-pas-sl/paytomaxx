-- Efectivo y fichas (revisión 3, 2026-10-21). Va con 20261021100000_recepcion_fichas.
--
--  1. wallet_cash_topups:
--       - anular una recarga en efectivo mal tecleada: una fila NEGATIVA que
--         apunta a la recarga (voidOfId, una por recarga). Resta en la caja,
--         en el Z y en los informes como cualquier otra fila;
--       - createdWallet: la recarga abrió un saldo nuevo (aviso de saldos
--         nuevos en efectivo seguidos de la misma persona o datáfono);
--       - FORCE ROW LEVEL SECURITY, como el resto del dinero de los saldos.
--  2. wallet_card_events: lo que pasa con cada ficha (dada, devuelta, perdida,
--     bloqueada) con el local de ese momento. Los contadores de la noche
--     cuentan estos eventos (una ficha dada dos veces cuenta dos), no la fila
--     de la ficha (que cambia cada vez que se vuelve a dar).
--
-- Idempotente: se puede lanzar dos veces sin cambiar nada la segunda.

SET lock_timeout = '5s';

-- Los rellenos tienen que ver todas las filas aunque la lance un rol sin
-- superusuario (FORCE RLS). Solo dura esta transacción.
SELECT set_config('app.bypass_rls', 'on', true);

-- ─── 1. Recargas en efectivo ────────────────────────────────────────────

ALTER TABLE "wallet_cash_topups" ADD COLUMN IF NOT EXISTS "createdWallet" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "wallet_cash_topups" ADD COLUMN IF NOT EXISTS "voidOfId" UUID;
ALTER TABLE "wallet_cash_topups" ADD COLUMN IF NOT EXISTS "reason" TEXT;

-- Positiva (recarga) o negativa (anulación de una recarga).
ALTER TABLE "wallet_cash_topups" DROP CONSTRAINT IF EXISTS "wallet_cash_topups_amount_positive";
ALTER TABLE "wallet_cash_topups" DROP CONSTRAINT IF EXISTS "wallet_cash_topups_amount_sign";
ALTER TABLE "wallet_cash_topups"
  ADD CONSTRAINT "wallet_cash_topups_amount_sign"
  CHECK (("voidOfId" IS NULL AND "amountCents" > 0) OR ("voidOfId" IS NOT NULL AND "amountCents" < 0));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_cash_topups_voidOfId_fkey') THEN
    ALTER TABLE "wallet_cash_topups"
      ADD CONSTRAINT "wallet_cash_topups_voidOfId_fkey" FOREIGN KEY ("voidOfId")
      REFERENCES "wallet_cash_topups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

-- Una anulación por recarga (dos clics a la vez no restan dos veces).
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_cash_topups_voidOfId_key" ON "wallet_cash_topups" ("voidOfId");
-- El efectivo de un saldo (y su cadena) en las últimas 24 h, para el tope legal.
DROP INDEX IF EXISTS "wallet_cash_topups_walletId_idx";
CREATE INDEX IF NOT EXISTS "wallet_cash_topups_walletId_createdAt_idx"
  ON "wallet_cash_topups" ("walletId", "createdAt");

ALTER TABLE "wallet_cash_topups" FORCE ROW LEVEL SECURITY;

-- ─── 2. Eventos de las fichas ───────────────────────────────────────────

-- Sin RLS, como wallet_cards: la ficha se mueve entre locales del grupo y el
-- local va siempre explícito (venueId).
CREATE TABLE IF NOT EXISTS "wallet_card_events" (
  "id"         UUID        NOT NULL DEFAULT gen_random_uuid(),
  "cardId"     UUID        NOT NULL,
  -- El local donde pasó (el que la dio, la recogió o la marcó).
  "venueId"    UUID,
  -- El saldo de ese momento (dada / devuelta).
  "walletId"   UUID,
  -- ISSUED dada · RETURNED devuelta al stock · LOST perdida (o sustituida) · BLOCKED bloqueada
  "kind"       TEXT        NOT NULL,
  "byUserId"   UUID,
  "terminalId" UUID,
  "at"         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "wallet_card_events_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_card_events_kind_valid') THEN
    ALTER TABLE "wallet_card_events"
      ADD CONSTRAINT "wallet_card_events_kind_valid" CHECK ("kind" IN ('ISSUED', 'RETURNED', 'LOST', 'BLOCKED'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_card_events_cardId_fkey') THEN
    ALTER TABLE "wallet_card_events"
      ADD CONSTRAINT "wallet_card_events_cardId_fkey" FOREIGN KEY ("cardId")
      REFERENCES "wallet_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_card_events_venueId_fkey') THEN
    ALTER TABLE "wallet_card_events"
      ADD CONSTRAINT "wallet_card_events_venueId_fkey" FOREIGN KEY ("venueId")
      REFERENCES "venues"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS "wallet_card_events_venueId_at_idx" ON "wallet_card_events" ("venueId", "at");
CREATE INDEX IF NOT EXISTS "wallet_card_events_cardId_idx" ON "wallet_card_events" ("cardId");

-- Las fichas que ya están dadas, perdidas o bloqueadas: su evento, con la
-- fecha de la fila (una vez: solo si la ficha aún no tiene ninguno). Las
-- devueltas por el relleno de 20261021100000 no: no se devolvieron esta noche.
INSERT INTO "wallet_card_events" ("cardId", "venueId", "walletId", "kind", "byUserId", "at")
SELECT c."id", c."venueId", c."walletId", 'ISSUED', c."linkedById", COALESCE(c."linkedAt", c."createdAt")
  FROM "wallet_cards" c
 WHERE c."status" IN ('ISSUED', 'ACTIVE') AND c."walletId" IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM "wallet_card_events" e WHERE e."cardId" = c."id");
INSERT INTO "wallet_card_events" ("cardId", "venueId", "walletId", "kind", "at")
SELECT c."id", c."venueId", c."walletId", c."status",
       CASE c."status" WHEN 'LOST' THEN COALESCE(c."lostAt", c."createdAt") ELSE COALESCE(c."blockedAt", c."createdAt") END
  FROM "wallet_cards" c
 WHERE c."status" IN ('LOST', 'BLOCKED')
   AND NOT EXISTS (SELECT 1 FROM "wallet_card_events" e WHERE e."cardId" = c."id");
