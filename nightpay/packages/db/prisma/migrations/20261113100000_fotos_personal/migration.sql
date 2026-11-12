-- «Mi perfil» del personal (13-nov-2026): la foto de perfil de cada persona
-- (compañeras, camareros, recepción, encargados y dueño), en la base y sin disco
-- ni servicios de fuera. WebP o JPEG de 256×256 como mucho y 150 KB.
--
-- Tabla nueva: no reescribe nada. La clave ajena lleva el local
-- (userId, tenantId): una foto nunca es de un local distinto del de su persona.
-- RLS forzado como el resto del dinero y de la carta del local. Todo con
-- IF NOT EXISTS: se puede repetir. lock_timeout para no frenar el arranque si
-- alguien tiene `users` bloqueada (el único índice nuevo sobre ella es único
-- por (id, tenantId), que ya es único por id).

SET lock_timeout = '5s';

-- Para la clave ajena compuesta (persona, local).
CREATE UNIQUE INDEX IF NOT EXISTS "users_id_tenantId_key" ON "users" ("id", "tenantId");

CREATE TABLE IF NOT EXISTS "user_photos" (
  "userId"      UUID        PRIMARY KEY,
  "tenantId"    UUID        NOT NULL REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "contentType" VARCHAR(16) NOT NULL DEFAULT 'image/webp',
  "data"        BYTEA       NOT NULL,
  "contentHash" CHAR(64)    NOT NULL,
  "width"       INTEGER     NOT NULL,
  "height"      INTEGER     NOT NULL,
  "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "user_photos_userId_tenantId_fkey" FOREIGN KEY ("userId", "tenantId")
    REFERENCES "users" ("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "user_photos_type_known" CHECK ("contentType" IN ('image/webp', 'image/jpeg')),
  CONSTRAINT "user_photos_size_valid" CHECK (octet_length("data") BETWEEN 12 AND 153600),
  CONSTRAINT "user_photos_dims_valid" CHECK ("width" BETWEEN 32 AND 256 AND "height" BETWEEN 32 AND 256),
  CONSTRAINT "user_photos_hash_valid" CHECK ("contentHash" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS "user_photos_userId_tenantId_key" ON "user_photos" ("userId", "tenantId");
CREATE INDEX IF NOT EXISTS "user_photos_tenantId_idx" ON "user_photos" ("tenantId");

ALTER TABLE "user_photos" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_photos" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_photos_tenant_isolation ON "user_photos";
CREATE POLICY user_photos_tenant_isolation ON "user_photos"
  USING ((SELECT app_rls_bypass()) OR "tenantId" = (SELECT app_current_tenant()))
  WITH CHECK ((SELECT app_rls_bypass()) OR "tenantId" = (SELECT app_current_tenant()));
