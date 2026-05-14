-- Super admin flag — usuario que opera sobre TODOS los locales.
-- Puede listar venues, crear venues y switchear su JWT entre tenants.
-- Se setea via CLI (no via UI) por seguridad.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "isSuperAdmin" BOOLEAN NOT NULL DEFAULT false;

-- Index parcial — solo indexa los TRUE (esperamos pocos super admins).
CREATE INDEX IF NOT EXISTS users_is_super_admin_idx
  ON "users"("isSuperAdmin") WHERE "isSuperAdmin" = true;
