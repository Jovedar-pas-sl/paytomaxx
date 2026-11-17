-- «Pantalla del cliente» (17-nov-2026): la tablet (o el móvil viejo) de la
-- barra que mira al cliente y le enseña el importe y el QR del cobro que
-- espera el camarero, «Pagado» al pagarse y, en reposo, el nombre del local.
--
-- Una fila por persona del personal: su pantalla. Se empareja con un código
-- corto que caduca a los 5 minutos y la tablet lo canjea por su credencial.
-- Solo se guardan las huellas (sha256) del código y de la credencial, nunca
-- los valores. La unión caduca sola (expiresAt, 12 h) y se puede revocar
-- (revokedAt) desde la app del personal o desde la tablet.
--
-- paymentId / chargeId: el cobro que enseña ahora (el de tarjeta, el del
-- saldo o los dos). Sin clave ajena a propósito: así esta migración no
-- bloquea `payments` ni `wallet_charge_requests` (el API comprueba que el
-- cobro es de esa persona y de su local). clearedAt: el camarero salió de ese
-- cobro (el último se recuerda para enseñar su «Pagado» unos segundos).
--
-- Tabla nueva: no reescribe nada. La clave ajena lleva el local
-- (userId, tenantId): una pantalla nunca es de un local distinto del de su
-- persona. FORCE RLS como el resto de tablas por local. Todo con
-- IF NOT EXISTS: se puede repetir.

SET lock_timeout = '5s';

-- Para la clave ajena compuesta (persona, local). Ya existe desde 20261113100000.
CREATE UNIQUE INDEX IF NOT EXISTS "users_id_tenantId_key" ON "users" ("id", "tenantId");

CREATE TABLE IF NOT EXISTS "customer_displays" (
  "id"                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"             UUID        NOT NULL REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "userId"               UUID        NOT NULL,
  "pairingCodeHash"      TEXT,
  "pairingCodeExpiresAt" TIMESTAMPTZ,
  "tokenHash"            TEXT,
  "pairedAt"             TIMESTAMPTZ,
  "expiresAt"            TIMESTAMPTZ,
  "revokedAt"            TIMESTAMPTZ,
  "lastSeenAt"           TIMESTAMPTZ,
  "paymentId"            UUID,
  "chargeId"             UUID,
  "shownAt"              TIMESTAMPTZ,
  "clearedAt"            TIMESTAMPTZ,
  "createdAt"            TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "customer_displays_userId_tenantId_fkey" FOREIGN KEY ("userId", "tenantId")
    REFERENCES "users" ("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "customer_displays_hashes_valid" CHECK (
    ("pairingCodeHash" IS NULL OR "pairingCodeHash" ~ '^[0-9a-f]{64}$')
    AND ("tokenHash" IS NULL OR "tokenHash" ~ '^[0-9a-f]{64}$')
  ),
  -- Una credencial siempre caduca.
  CONSTRAINT "customer_displays_token_expires" CHECK ("tokenHash" IS NULL OR "expiresAt" IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS "customer_displays_userId_key" ON "customer_displays" ("userId");
CREATE UNIQUE INDEX IF NOT EXISTS "customer_displays_pairingCodeHash_key" ON "customer_displays" ("pairingCodeHash");
CREATE UNIQUE INDEX IF NOT EXISTS "customer_displays_tokenHash_key" ON "customer_displays" ("tokenHash");
CREATE INDEX IF NOT EXISTS "customer_displays_tenantId_idx" ON "customer_displays" ("tenantId");

ALTER TABLE "customer_displays" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_displays" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS customer_displays_tenant_isolation ON "customer_displays";
CREATE POLICY customer_displays_tenant_isolation ON "customer_displays"
  USING ((SELECT app_rls_bypass()) OR "tenantId" = (SELECT app_current_tenant()))
  WITH CHECK ((SELECT app_rls_bypass()) OR "tenantId" = (SELECT app_current_tenant()));
