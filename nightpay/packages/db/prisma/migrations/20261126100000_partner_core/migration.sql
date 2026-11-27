-- API de socios, el núcleo de las claves (26-nov-2026; PR 1 de la API de
-- socios, docs/partner-api). Otras plataformas (la primera, la red de cajeros
-- del dueño, que solo carga saldo en los locales) entran con una clave por
-- local. Esta migración no mueve dinero y la API sigue apagada
-- (PARTNER_API_ENABLED=false) hasta el PR 8.
--
-- (Se llama 20261126100000: tiene que ordenarse después de la última de main,
-- 20261120500000_alta_tres_caminos, y de la pendiente 20261125100000_cobro_encargado;
-- ver scripts/check-migration-order.mjs.)
--
--   partners             los socios (global, solo el super-admin): nombre que ve
--                        el cliente, razón social y NIF, correo de contacto, techo
--                        de permisos, canal, IP declaradas de sus servidores, KYB
--                        y contrato de datos. RLS solo con bypass, sin FORCE
--                        (como oxiopay_settlement_settings).
--   partner_connections  socio × local: la clave (solo su sha256, y el hueco de
--                        la anterior durante el solape), permisos, pausa, lista
--                        de IP, caducidad, enlace de un uso para entregarla y los
--                        topes de carga que enseña GET /me. FORCE RLS como stalls.
--   partner_api_state    una fila: la congelación de la API (none, money, all).
--                        RLS solo con bypass.
--
-- Hasta el PR 9 solo existe el modelo VENUE_COLLECTS (el dinero es del local):
-- un CHECK lo fija en las dos tablas. Las tablas son nuevas y vacías: los
-- CHECK van en el CREATE TABLE. Todo con IF NOT EXISTS: se puede repetir.

SET lock_timeout = '5s';

-- ─── Tipos ─────────────────────────────────────────────────────────────

DO $$ BEGIN CREATE TYPE "PartnerStatus" AS ENUM ('ACTIVE', 'SUSPENDED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "PartnerConnectionStatus" AS ENUM ('ACTIVE', 'PAUSED', 'REVOKED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "PartnerCollectionModel" AS ENUM ('VENUE_COLLECTS', 'PARTNER_AGENT', 'LICENSED_PSP'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "PartnerChannel" AS ENUM ('IN_VENUE', 'ONLINE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "PartnerDataRole" AS ENUM ('PROCESSOR_OF_VENUE', 'INDEPENDENT_CONTROLLER'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── partners: los socios ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "partners" (
  "id"                UUID                     NOT NULL DEFAULT gen_random_uuid(),
  "name"              TEXT                     NOT NULL,
  "legalName"         TEXT                     NOT NULL,
  "taxId"             TEXT                     NOT NULL,
  "contactEmail"      TEXT                     NOT NULL,
  "status"            "PartnerStatus"          NOT NULL DEFAULT 'ACTIVE',
  "allowedScopes"     TEXT[]                   NOT NULL,
  "collectionModel"   "PartnerCollectionModel" NOT NULL DEFAULT 'VENUE_COLLECTS',
  "channel"           "PartnerChannel"         NOT NULL DEFAULT 'IN_VENUE',
  "egressIps"         TEXT[]                   NOT NULL DEFAULT ARRAY[]::TEXT[],
  "egressRangeReason" TEXT,
  "kybCheckedAt"      TIMESTAMPTZ,
  "kybNotes"          TEXT,
  "dataRole"          "PartnerDataRole",
  "dpaSignedAt"       TIMESTAMPTZ,
  "dpaVersion"        TEXT,
  "dataCountry"       TEXT,
  "transferMechanism" TEXT,
  "notes"             TEXT,
  "createdById"       UUID                     NOT NULL,
  "createdAt"         TIMESTAMPTZ              NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMPTZ              NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "partners_pkey" PRIMARY KEY ("id"),
  -- El nombre que ve el cliente («Carga · {socio}: …»).
  CONSTRAINT "partners_name_length" CHECK (char_length("name") BETWEEN 2 AND 30),
  -- Como lo guarda el API: mayúsculas, sin espacios ni guiones.
  CONSTRAINT "partners_tax_id_format" CHECK ("taxId" ~ '^[A-Z0-9]{5,20}$'),
  CONSTRAINT "partners_allowed_scopes_known" CHECK (
    "allowedScopes" <@ ARRAY['wallet:balance', 'wallet:load', 'wallet:pay', 'charges:write', 'charges:read', 'reports:read']::TEXT[]
  ),
  CONSTRAINT "partners_egress_ips_max" CHECK (cardinality("egressIps") <= 20),
  -- País de los datos (ISO 3166) y, fuera del EEE (la UE, IS, LI y NO), el mecanismo de transferencia.
  CONSTRAINT "partners_data_country" CHECK (
    "dataCountry" IS NULL
    OR ("dataCountry" ~ '^[A-Z]{2}$'
        AND ("dataCountry" = ANY (ARRAY['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU',
                                        'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK',
                                        'IS', 'LI', 'NO']::TEXT[])
             OR "transferMechanism" IS NOT NULL))
  ),
  -- Hasta el PR 9 (cargas que cobra el socio), solo «el local cobra».
  CONSTRAINT "partners_collection_model_venue" CHECK ("collectionModel" = 'VENUE_COLLECTS')
);

ALTER TABLE "partners" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS partners_bypass_only ON "partners";
CREATE POLICY partners_bypass_only ON "partners"
  USING ((SELECT app_rls_bypass()))
  WITH CHECK ((SELECT app_rls_bypass()));

-- ─── partner_connections: socio × local ────────────────────────────────

CREATE TABLE IF NOT EXISTS "partner_connections" (
  "id"                    UUID                      NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"              UUID                      NOT NULL,
  "partnerId"             UUID                      NOT NULL,
  -- La sociedad del local al conectar: si cambia, la clave deja de valer.
  "businessId"            UUID                      NOT NULL,
  "status"                "PartnerConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
  "collectionModel"       "PartnerCollectionModel"  NOT NULL,
  "channel"               "PartnerChannel"          NOT NULL,
  "pausedScopes"          TEXT[]                    NOT NULL DEFAULT ARRAY[]::TEXT[],
  "pausedReason"          TEXT,
  "scopes"                TEXT[]                    NOT NULL,
  "keyMode"               TEXT                      NOT NULL,
  "keyHash"               TEXT                      NOT NULL,
  "keyHint"               TEXT                      NOT NULL,
  "keyCreatedAt"          TIMESTAMPTZ               NOT NULL,
  "keyExpiresAt"          TIMESTAMPTZ,
  "prevKeyHash"           TEXT,
  "prevKeyExpiresAt"      TIMESTAMPTZ,
  "keyExposedAt"          TIMESTAMPTZ,
  "keySuspendedAt"        TIMESTAMPTZ,
  "keyResumedAt"          TIMESTAMPTZ,
  "keyClaimHash"          TEXT,
  "keyClaimSealed"        TEXT,
  "keyClaimExpiresAt"     TIMESTAMPTZ,
  "lastUsedAt"            TIMESTAMPTZ,
  "lastUsedIp"            TEXT,
  "ipAllowlist"           TEXT[]                    NOT NULL DEFAULT ARRAY[]::TEXT[],
  "loadPerOpMaxCents"     INTEGER                   NOT NULL DEFAULT 30000,
  "loadWalletDayMaxCents" INTEGER                   NOT NULL DEFAULT 60000,
  "loadNightMaxCents"     INTEGER                   NOT NULL DEFAULT 500000,
  "createdById"           UUID                      NOT NULL,
  "createdAt"             TIMESTAMPTZ               NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMPTZ               NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "partner_connections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "partner_connections_tenantId_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "partner_connections_partnerId_fkey" FOREIGN KEY ("partnerId")
    REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  -- De 1 a 6 permisos, todos de la lista; los pausados, de los suyos.
  CONSTRAINT "partner_connections_scopes_known" CHECK (
    cardinality("scopes") BETWEEN 1 AND 6
    AND "scopes" <@ ARRAY['wallet:balance', 'wallet:load', 'wallet:pay', 'charges:write', 'charges:read', 'reports:read']::TEXT[]
  ),
  CONSTRAINT "partner_connections_paused_scopes_subset" CHECK ("pausedScopes" <@ "scopes"),
  CONSTRAINT "partner_connections_paused_reason" CHECK (
    "pausedReason" IS NULL OR "pausedReason" IN ('owner', 'manager', 'foreign_ip', 'oxiopay')
  ),
  CONSTRAINT "partner_connections_key_mode" CHECK ("keyMode" IN ('live', 'test')),
  -- Solo el sha256 (hex) de la clave, de la anterior y del enlace de un uso.
  CONSTRAINT "partner_connections_key_hash_format" CHECK ("keyHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "partner_connections_prev_key" CHECK (
    ("prevKeyHash" IS NULL) = ("prevKeyExpiresAt" IS NULL)
    AND ("prevKeyHash" IS NULL OR "prevKeyHash" ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "partner_connections_claim" CHECK (
    ("keyClaimHash" IS NULL OR "keyClaimHash" ~ '^[0-9a-f]{64}$')
    AND ("keyClaimSealed" IS NULL OR ("keyClaimHash" IS NOT NULL AND "keyClaimExpiresAt" IS NOT NULL))
  ),
  -- Caducidad: como mucho un año (365 × 24 h, sin depender de la zona de la sesión);
  -- obligatoria con wallet:load, wallet:pay o reports:read.
  CONSTRAINT "partner_connections_key_expiry" CHECK (
    ("keyExpiresAt" IS NULL OR "keyExpiresAt" <= "keyCreatedAt" + interval '8760 hours')
    AND ("keyExpiresAt" IS NOT NULL OR NOT ("scopes" && ARRAY['wallet:load', 'wallet:pay', 'reports:read']::TEXT[]))
  ),
  -- Hasta 10 IP; en real, con wallet:load o wallet:pay, al menos una (la anchura de cada una la mira el API).
  CONSTRAINT "partner_connections_ip_allowlist" CHECK (
    cardinality("ipAllowlist") <= 10
    AND ("keyMode" <> 'live' OR NOT ("scopes" && ARRAY['wallet:load', 'wallet:pay']::TEXT[]) OR cardinality("ipAllowlist") >= 1)
  ),
  CONSTRAINT "partner_connections_collection_model_venue" CHECK ("collectionModel" = 'VENUE_COLLECTS'),
  -- Los topes de carga que enseña GET /me (céntimos).
  CONSTRAINT "partner_connections_load_caps" CHECK (
    "loadPerOpMaxCents" BETWEEN 1 AND 99999
    AND "loadWalletDayMaxCents" BETWEEN 1 AND 99999
    AND "loadNightMaxCents" BETWEEN 1 AND 5000000
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "partner_connections_keyHash_key" ON "partner_connections"("keyHash");
CREATE UNIQUE INDEX IF NOT EXISTS "partner_connections_prevKeyHash_key" ON "partner_connections"("prevKeyHash");
CREATE UNIQUE INDEX IF NOT EXISTS "partner_connections_keyClaimHash_key" ON "partner_connections"("keyClaimHash");
CREATE INDEX IF NOT EXISTS "partner_connections_tenantId_idx" ON "partner_connections"("tenantId");
CREATE INDEX IF NOT EXISTS "partner_connections_partnerId_idx" ON "partner_connections"("partnerId");
-- Una conexión viva por socio y local (la anulada no cuenta). Parcial: schema.prisma
-- no lo describe (drift-allowlist.json).
CREATE UNIQUE INDEX IF NOT EXISTS "partner_connections_tenant_partner_live_key"
  ON "partner_connections"("tenantId", "partnerId") WHERE "status" <> 'REVOKED';

ALTER TABLE "partner_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "partner_connections" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS partner_connections_tenant_isolation ON "partner_connections";
CREATE POLICY partner_connections_tenant_isolation ON "partner_connections"
  USING ((SELECT app_rls_bypass()) OR "tenantId" = (SELECT app_current_tenant()))
  WITH CHECK ((SELECT app_rls_bypass()) OR "tenantId" = (SELECT app_current_tenant()));

-- ─── partner_api_state: la congelación (una fila) ─────────────────────

CREATE TABLE IF NOT EXISTS "partner_api_state" (
  "id"          SMALLINT    NOT NULL DEFAULT 1,
  "freeze"      TEXT        NOT NULL DEFAULT 'none',
  "reason"      TEXT,
  "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedById" UUID,

  CONSTRAINT "partner_api_state_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "partner_api_state_single_row" CHECK ("id" = 1),
  CONSTRAINT "partner_api_state_freeze" CHECK ("freeze" IN ('none', 'money', 'all'))
);

INSERT INTO "partner_api_state" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;

ALTER TABLE "partner_api_state" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS partner_api_state_bypass_only ON "partner_api_state";
CREATE POLICY partner_api_state_bypass_only ON "partner_api_state"
  USING ((SELECT app_rls_bypass()))
  WITH CHECK ((SELECT app_rls_bypass()));
