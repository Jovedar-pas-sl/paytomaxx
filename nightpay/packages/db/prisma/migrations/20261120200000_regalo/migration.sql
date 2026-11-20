-- «Regala una noche» (20-nov-2026, apps/api/src/modules/home-topup).
--
--   venues "homeTopUpGiftsEnabled"  «Para regalar» en el enlace del local
--          (/r/<código>): apagado de serie; el dueño lo enciende con el visto
--          bueno del abogado.
--   wallet_gifts  el regalo: el saldo nuevo que paga quien regala (su cobro de
--          recarga con tarjeta de siempre) y el enlace del regalo
--          (/r/regalo/<token>), que no es el del saldo. Quien lo recibe lo
--          guarda en su móvil con el QR de activación de siempre (via 'gift');
--          al gastarse ese QR, claimedAt, y el enlace ya no da nada. El nombre
--          y el mensaje son datos personales: se borran a los 30 días de
--          guardarlo o al caducar sin guardar (DeviceIpRetentionService).
--   wallet_activation_tokens.via  admite 'gift' (el QR que emite el enlace del regalo).
--
-- Una tabla nueva y vacía y una columna con valor por defecto constante: no
-- reescriben nada ni bloquean el arranque. FORCE RLS en la tabla nueva.
-- Se puede repetir.

SET lock_timeout = '5s';

ALTER TABLE "venues"
  ADD COLUMN IF NOT EXISTS "homeTopUpGiftsEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "wallet_gifts" (
  "id"        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"  UUID        NOT NULL REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "walletId"  UUID        NOT NULL REFERENCES "client_wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "paymentId" UUID        NOT NULL REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "token"     TEXT        NOT NULL,
  "toName"    TEXT,
  "message"   TEXT,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "claimedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "wallet_gifts_token_shape" CHECK ("token" ~ '^[A-Za-z0-9_-]{32}$'),
  CONSTRAINT "wallet_gifts_to_name_len" CHECK ("toName" IS NULL OR char_length("toName") BETWEEN 1 AND 40),
  CONSTRAINT "wallet_gifts_message_len" CHECK ("message" IS NULL OR char_length("message") BETWEEN 1 AND 120),
  CONSTRAINT "wallet_gifts_expiry" CHECK ("expiresAt" > "createdAt")
);
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_gifts_walletId_key" ON "wallet_gifts" ("walletId");
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_gifts_paymentId_key" ON "wallet_gifts" ("paymentId");
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_gifts_token_key" ON "wallet_gifts" ("token");
CREATE INDEX IF NOT EXISTS "wallet_gifts_tenantId_createdAt_idx" ON "wallet_gifts" ("tenantId", "createdAt" DESC);

-- El QR de activación que emite el enlace del regalo (via 'gift').
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_activation_tokens_via_check'
              AND pg_get_constraintdef(oid) NOT LIKE '%gift%') THEN
    ALTER TABLE "wallet_activation_tokens" DROP CONSTRAINT "wallet_activation_tokens_via_check";
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_activation_tokens_via_check') THEN
    ALTER TABLE "wallet_activation_tokens"
      ADD CONSTRAINT "wallet_activation_tokens_via_check" CHECK ("via" IN ('reception', 'relink', 'gift')) NOT VALID;
  END IF;
END
$$;
ALTER TABLE "wallet_activation_tokens" VALIDATE CONSTRAINT "wallet_activation_tokens_via_check";

-- FORCE RLS: el local de la sesión o el bypass (como reservations).
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['wallet_gifts']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING ((SELECT app_rls_bypass()) OR "tenantId" = (SELECT app_current_tenant())) '
      'WITH CHECK ((SELECT app_rls_bypass()) OR "tenantId" = (SELECT app_current_tenant()))',
      t || '_tenant_isolation', t);
  END LOOP;
END $$;
