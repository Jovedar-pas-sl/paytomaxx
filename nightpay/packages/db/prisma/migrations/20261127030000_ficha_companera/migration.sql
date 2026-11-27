-- Cobro por el encargado, fase 2 (26-nov-2026): la ficha NFC de la compañera.
-- El encargado o el dueño le graban una ficha en blanco desde su hoja (con un
-- Android, como las de los clientes) y, al cobrar un servicio a su nombre, se
-- acerca su ficha además de su «Mi QR». Vale solo la original: se guarda el
-- número de serie del chip y una copia (otro chip con el mismo código) no vale.
-- Una sola ficha viva por compañera: al darle otra, la de antes queda anulada
-- (revokedAt) en la misma operación. El número visible («Ficha nº 0522») sale de
-- la misma secuencia que las fichas de los clientes: nunca se repite entre unas
-- y otras. Tabla nueva, pequeña: no toca nada que ya exista. FORCE RLS, como las
-- demás tablas del personal. Se puede repetir.

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "staff_cards" (
  "id"            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"      UUID        NOT NULL REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "userId"        UUID        NOT NULL,
  "token"         TEXT        NOT NULL,
  "uid"           TEXT        NOT NULL,
  -- Lo pone el API con nextval('wallet_cards_number_seq') (sin DEFAULT: la secuencia es de wallet_cards).
  "number"        INTEGER     NOT NULL,
  "issuedById"    UUID,
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "revokedAt"     TIMESTAMPTZ,
  "revokedById"   UUID,
  "revokedReason" TEXT,
  -- La compañera y su local van juntos.
  CONSTRAINT "staff_cards_userId_tenantId_fkey" FOREIGN KEY ("userId", "tenantId")
    REFERENCES "users" ("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "staff_cards_token_format" CHECK ("token" ~ '^[A-Za-z0-9_-]{16,64}$'),
  CONSTRAINT "staff_cards_revoked_reason" CHECK (
    ("revokedAt" IS NULL AND "revokedReason" IS NULL)
    OR ("revokedAt" IS NOT NULL AND "revokedReason" IN ('replaced', 'revoked', 'offboarded'))
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "staff_cards_token_key" ON "staff_cards" ("token");
CREATE UNIQUE INDEX IF NOT EXISTS "staff_cards_number_key" ON "staff_cards" ("number");
CREATE INDEX IF NOT EXISTS "staff_cards_userId_idx" ON "staff_cards" ("userId");
CREATE INDEX IF NOT EXISTS "staff_cards_tenantId_idx" ON "staff_cards" ("tenantId");
-- Una ficha viva por compañera, y un chip vivo para una sola.
CREATE UNIQUE INDEX IF NOT EXISTS "staff_cards_one_live_per_user" ON "staff_cards" ("userId") WHERE "revokedAt" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "staff_cards_one_live_per_uid" ON "staff_cards" ("uid") WHERE "revokedAt" IS NULL;

ALTER TABLE "staff_cards" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "staff_cards" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS staff_cards_tenant_isolation ON "staff_cards";
CREATE POLICY staff_cards_tenant_isolation ON "staff_cards"
  USING ((SELECT app_rls_bypass()) OR "tenantId" = (SELECT app_current_tenant()))
  WITH CHECK ((SELECT app_rls_bypass()) OR "tenantId" = (SELECT app_current_tenant()));
