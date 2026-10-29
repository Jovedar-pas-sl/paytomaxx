-- QR de activación de un solo uso (2026-10-29, 03-seguridad.md M-2).
--
-- Antes, el QR de activación que enseña recepción (pantalla «Cargado») era el
-- enlace PERMANENTE del saldo (/w/<qrToken>): quien lo fotografiara antes que
-- el cliente podía registrar su Face ID o su PIN y gastar el saldo. Ahora es
-- /w/a/<token>: un token aparte, aleatorio (192 bits), que vale 10 minutos y
-- una sola vez. Aquí solo se guarda su sha256, con el saldo, quién lo emitió y
-- dónde, cuándo caduca y cuándo se usó (y para qué: passkey o pin). Emitir
-- otro para el mismo saldo anula los anteriores sin usar (revokedAt).
--
-- Tabla nueva y vacía: no toca nada de lo que hay. Sin RLS a propósito, como
-- wallet_passkeys: cuelga del saldo y el API la busca siempre por el hash del
-- token o por el saldo (docs/DB-ROLE.md). Se puede repetir (IF NOT EXISTS).

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "wallet_activation_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "walletId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "venueId" UUID,
    "issuedById" UUID,
    "via" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "usedAt" TIMESTAMPTZ,
    "usedFor" TEXT,
    "revokedAt" TIMESTAMPTZ,

    CONSTRAINT "wallet_activation_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "wallet_activation_tokens_tokenHash_key" ON "wallet_activation_tokens"("tokenHash");

CREATE INDEX IF NOT EXISTS "wallet_activation_tokens_walletId_idx" ON "wallet_activation_tokens"("walletId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_activation_tokens_walletId_fkey') THEN
    ALTER TABLE "wallet_activation_tokens"
      ADD CONSTRAINT "wallet_activation_tokens_walletId_fkey" FOREIGN KEY ("walletId")
      REFERENCES "client_wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

-- Reglas en la base (NOT VALID + VALIDATE, como todas las CHECK desde 20261029):
--  - caduca después de emitirse;
--  - se usa para el primer Face ID o el primer PIN, y usado ⇔ con su para qué;
--  - lo emite recepción o un enlace nuevo del dueño / super-admin;
--  - el hash es un sha256 en hexadecimal (nunca el token).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_activation_tokens_expiry_check') THEN
    ALTER TABLE "wallet_activation_tokens"
      ADD CONSTRAINT "wallet_activation_tokens_expiry_check" CHECK ("expiresAt" > "createdAt") NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_activation_tokens_used_check') THEN
    ALTER TABLE "wallet_activation_tokens"
      ADD CONSTRAINT "wallet_activation_tokens_used_check"
      CHECK ((("usedAt" IS NULL) = ("usedFor" IS NULL)) AND ("usedFor" IS NULL OR "usedFor" IN ('passkey', 'pin'))) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_activation_tokens_via_check') THEN
    ALTER TABLE "wallet_activation_tokens"
      ADD CONSTRAINT "wallet_activation_tokens_via_check" CHECK ("via" IN ('reception', 'relink')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_activation_tokens_hash_check') THEN
    ALTER TABLE "wallet_activation_tokens"
      ADD CONSTRAINT "wallet_activation_tokens_hash_check" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$') NOT VALID;
  END IF;
END
$$;

ALTER TABLE "wallet_activation_tokens" VALIDATE CONSTRAINT "wallet_activation_tokens_expiry_check";
ALTER TABLE "wallet_activation_tokens" VALIDATE CONSTRAINT "wallet_activation_tokens_used_check";
ALTER TABLE "wallet_activation_tokens" VALIDATE CONSTRAINT "wallet_activation_tokens_via_check";
ALTER TABLE "wallet_activation_tokens" VALIDATE CONSTRAINT "wallet_activation_tokens_hash_check";
