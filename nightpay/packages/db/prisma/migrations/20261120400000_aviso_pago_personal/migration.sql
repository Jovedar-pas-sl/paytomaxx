-- «Te han pagado», 19-nov-2026: los móviles que una persona del personal apunta
-- para recibir un aviso (Web Push) cuando el local le paga. Una fila por
-- persona y navegador: la dirección del servicio de avisos del navegador y sus
-- dos claves públicas (para cifrar el aviso). Nada más de la persona. Las
-- mismas claves VAPID que el «Aviso en cada cobro» del cliente. Tabla nueva: no
-- toca nada que ya exista y no bloquea el arranque. FORCE RLS, como las demás
-- tablas del dinero del personal. Se puede repetir.

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "staff_push_subscriptions" (
  "id"         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"   UUID        NOT NULL REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "userId"     UUID        NOT NULL,
  "endpoint"   TEXT        NOT NULL,
  "p256dh"     TEXT        NOT NULL,
  "auth"       TEXT        NOT NULL,
  "failCount"  INTEGER     NOT NULL DEFAULT 0,
  "lastSentAt" TIMESTAMPTZ,
  "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- La persona y su local van juntos: una fila no puede ser de otro local que su persona.
  CONSTRAINT "staff_push_subscriptions_userId_tenantId_fkey" FOREIGN KEY ("userId", "tenantId")
    REFERENCES "users" ("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "staff_push_subscriptions_endpoint_https" CHECK ("endpoint" LIKE 'https://%' AND length("endpoint") <= 1024),
  CONSTRAINT "staff_push_subscriptions_fail_count" CHECK ("failCount" >= 0)
);

-- Un navegador avisa a una sola persona (si entra otra en ese móvil y lo activa, pasa a ella).
CREATE UNIQUE INDEX IF NOT EXISTS "staff_push_subscriptions_endpoint_key" ON "staff_push_subscriptions" ("endpoint");
CREATE INDEX IF NOT EXISTS "staff_push_subscriptions_userId_idx" ON "staff_push_subscriptions" ("userId");
CREATE INDEX IF NOT EXISTS "staff_push_subscriptions_tenantId_idx" ON "staff_push_subscriptions" ("tenantId");

ALTER TABLE "staff_push_subscriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "staff_push_subscriptions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS staff_push_subscriptions_tenant_isolation ON "staff_push_subscriptions";
CREATE POLICY staff_push_subscriptions_tenant_isolation ON "staff_push_subscriptions"
  USING ((SELECT app_rls_bypass()) OR "tenantId" = (SELECT app_current_tenant()))
  WITH CHECK ((SELECT app_rls_bypass()) OR "tenantId" = (SELECT app_current_tenant()));
