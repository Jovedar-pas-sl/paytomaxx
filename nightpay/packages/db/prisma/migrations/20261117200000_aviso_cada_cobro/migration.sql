-- «Aviso en cada cobro», 17-nov-2026: los móviles que el cliente apunta para
-- recibir un aviso (Web Push) cada vez que se cobra de su saldo o de su ficha.
-- Una fila por saldo y navegador: la dirección del servicio de avisos del
-- navegador y sus dos claves públicas (para cifrar el aviso). Sin nombre,
-- teléfono ni nada del cliente. Tabla nueva: no toca nada que ya exista y no
-- bloquea el arranque. FORCE RLS, como las demás tablas del saldo.
-- Se puede repetir.

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "wallet_push_subscriptions" (
  "id"         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"   UUID        NOT NULL REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "walletId"   UUID        NOT NULL REFERENCES "client_wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "endpoint"   TEXT        NOT NULL,
  "p256dh"     TEXT        NOT NULL,
  "auth"       TEXT        NOT NULL,
  "lang"       TEXT        NOT NULL DEFAULT 'es',
  "failCount"  INTEGER     NOT NULL DEFAULT 0,
  "lastSentAt" TIMESTAMPTZ,
  "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "wallet_push_subscriptions_endpoint_https" CHECK ("endpoint" LIKE 'https://%' AND length("endpoint") <= 1024),
  CONSTRAINT "wallet_push_subscriptions_lang_known" CHECK ("lang" IN ('es', 'en', 'fr', 'pt')),
  CONSTRAINT "wallet_push_subscriptions_fail_count" CHECK ("failCount" >= 0)
);

-- Un navegador se apunta una vez por saldo (dos saldos en el mismo móvil, dos filas).
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_push_subscriptions_walletId_endpoint_key"
  ON "wallet_push_subscriptions" ("walletId", "endpoint");
-- Al caducar (404/410) se borran todas las filas de esa dirección.
CREATE INDEX IF NOT EXISTS "wallet_push_subscriptions_endpoint_idx" ON "wallet_push_subscriptions" ("endpoint");
CREATE INDEX IF NOT EXISTS "wallet_push_subscriptions_tenantId_idx" ON "wallet_push_subscriptions" ("tenantId");

ALTER TABLE "wallet_push_subscriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "wallet_push_subscriptions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wallet_push_subscriptions_tenant_isolation ON "wallet_push_subscriptions";
CREATE POLICY wallet_push_subscriptions_tenant_isolation ON "wallet_push_subscriptions"
  USING ((SELECT app_rls_bypass()) OR "tenantId" = (SELECT app_current_tenant()))
  WITH CHECK ((SELECT app_rls_bypass()) OR "tenantId" = (SELECT app_current_tenant()));
