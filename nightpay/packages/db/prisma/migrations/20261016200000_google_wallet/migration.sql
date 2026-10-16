-- Google Wallet: el cliente guarda su saldo en Google Wallet (Android) y un
-- repaso cada ~2 min pone el pase al día cuando cambian el saldo o su estado.
--
-- Idempotente (IF NOT EXISTS / comprobaciones): se puede lanzar dos veces y en
-- una base que ya la tenga a medias. Solo crea; no toca datos existentes.
--
-- Sin tenantId ni RLS a propósito, como wallet_passkeys y wallet_cards (hijas
-- del saldo): el saldo vale en todos los locales del grupo, así que el pase no
-- es "de un local". El acceso va siempre por el saldo: la página /w del
-- cliente (su enlace) o el repaso del sistema, que tiene que leer
-- client_wallets (FORCE RLS) con el bypass de asSystem. Aquí no hay dinero ni
-- el enlace: solo su hash y el id del pase en Google (que sale de ese hash).

DO $$ BEGIN
  CREATE TYPE "WalletPassProvider" AS ENUM ('GOOGLE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "wallet_passes" (
  "id"                     UUID                 NOT NULL DEFAULT gen_random_uuid(),
  "walletId"               UUID                 NOT NULL,
  "provider"               "WalletPassProvider" NOT NULL DEFAULT 'GOOGLE',
  -- Id del pase en Google: <emisor>.<clase>-<hash del enlace> (nunca el enlace).
  "objectId"               TEXT                 NOT NULL,
  -- sha256 del enlace del saldo cuando se hizo el pase (enlace nuevo → se apaga).
  "tokenHash"              TEXT                 NOT NULL,
  "lastSyncedBalanceCents" INTEGER              NOT NULL,
  "lastSyncedStatus"       "WalletStatus"       NOT NULL,
  "lastSyncedAt"           TIMESTAMPTZ          NOT NULL DEFAULT now(),
  -- Último intento del repaso (bien o mal): los que fallan van al final de la cola.
  "lastAttemptAt"          TIMESTAMPTZ,
  "revokedAt"              TIMESTAMPTZ,
  "createdAt"              TIMESTAMPTZ          NOT NULL DEFAULT now(),
  CONSTRAINT "wallet_passes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "wallet_passes_objectId_key" ON "wallet_passes" ("objectId");
CREATE INDEX IF NOT EXISTS "wallet_passes_walletId_idx" ON "wallet_passes" ("walletId");

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = to_regclass('"wallet_passes"') AND conname = 'wallet_passes_walletId_fkey'
  ) THEN
    ALTER TABLE "wallet_passes"
      ADD CONSTRAINT "wallet_passes_walletId_fkey" FOREIGN KEY ("walletId")
      REFERENCES "client_wallets" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
