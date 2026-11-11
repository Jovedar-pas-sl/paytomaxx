-- Carta con logo o foto (11-nov-2026): cada producto puede llevar un icono de
-- la colección cerrada de la app (service_items.icon; NULL = el de su sección)
-- y una imagen pequeña propia (service_item_images: WebP, o PNG para los
-- navegadores que no codifican WebP, de 128×128 como mucho y 64 KB), en la base y sin disco ni servicios de fuera.
--
-- Columna nueva y vacía (sin valor por defecto: no reescribe la tabla) y su
-- CHECK con NOT VALID + VALIDATE (no bloquea las escrituras mientras mira). La
-- tabla de imágenes es nueva: lleva el local en la propia clave ajena
-- (serviceItemId, tenantId), así que una imagen nunca puede ser de un local
-- distinto del de su producto, y RLS forzado como el resto del local.
-- Se puede repetir.

SET lock_timeout = '5s';

-- Los iconos permitidos: los mismos que CARTA_ICON_CODES (packages/contracts).
ALTER TABLE "service_items" ADD COLUMN IF NOT EXISTS "icon" VARCHAR(24);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'service_items_icon_known') THEN
    ALTER TABLE "service_items"
      ADD CONSTRAINT "service_items_icon_known"
      CHECK ("icon" IS NULL OR "icon" IN (
        'copa', 'gin_tonic', 'cerveza', 'cava', 'vino', 'chupito', 'coctel', 'refresco',
        'agua', 'zumo', 'botella', 'cafe', 'entrada', 'entrada_copa', 'habitacion', 'reservado',
        'nachos', 'tapa', 'tabla', 'hamburguesa', 'postre', 'cachimba', 'ticket', 'estrella',
        'plato'
      )) NOT VALID;
  END IF;
END $$;

ALTER TABLE "service_items" VALIDATE CONSTRAINT "service_items_icon_known";

-- Para la clave ajena compuesta (producto, local).
CREATE UNIQUE INDEX IF NOT EXISTS "service_items_id_tenantId_key" ON "service_items" ("id", "tenantId");

CREATE TABLE IF NOT EXISTS "service_item_images" (
  "serviceItemId" UUID        PRIMARY KEY,
  "tenantId"      UUID        NOT NULL REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "contentType"   VARCHAR(16) NOT NULL DEFAULT 'image/webp',
  "data"          BYTEA       NOT NULL,
  "contentHash"   CHAR(64)    NOT NULL,
  "width"         INTEGER     NOT NULL,
  "height"        INTEGER     NOT NULL,
  "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "service_item_images_serviceItemId_tenantId_fkey" FOREIGN KEY ("serviceItemId", "tenantId")
    REFERENCES "service_items" ("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "service_item_images_type_known" CHECK ("contentType" IN ('image/webp', 'image/png')),
  CONSTRAINT "service_item_images_size_valid" CHECK (octet_length("data") BETWEEN 12 AND 65536),
  CONSTRAINT "service_item_images_dims_valid" CHECK ("width" BETWEEN 16 AND 128 AND "height" BETWEEN 16 AND 128),
  CONSTRAINT "service_item_images_hash_valid" CHECK ("contentHash" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS "service_item_images_serviceItemId_tenantId_key" ON "service_item_images" ("serviceItemId", "tenantId");
CREATE INDEX IF NOT EXISTS "service_item_images_tenantId_idx" ON "service_item_images" ("tenantId");

ALTER TABLE "service_item_images" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "service_item_images" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_item_images_tenant_isolation ON "service_item_images";
CREATE POLICY service_item_images_tenant_isolation ON "service_item_images"
  USING ((SELECT app_rls_bypass()) OR "tenantId" = (SELECT app_current_tenant()))
  WITH CHECK ((SELECT app_rls_bypass()) OR "tenantId" = (SELECT app_current_tenant()));
