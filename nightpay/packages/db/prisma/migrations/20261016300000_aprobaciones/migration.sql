-- «Por aprobar» (2026-10-16): el encargado pide, el dueño aprueba con 2FA.
--
--  - Pagos a las chicas cuando el local tiene payoutRequiresApproval.
--  - Devoluciones por la pasarela desde refundApprovalThresholdCents.
--
-- Una fila por solicitud. `payload` lleva lo necesario para hacerla luego
-- (chica, método, cuenta tapada, comisiones y deudas que entran; o cobro,
-- importe y motivo). `targetId` = la chica (PAYOUT) o el cobro (REFUND): con
-- él se reserva mientras está pendiente (una pendiente por chica; el importe
-- pedido no se puede devolver por otro lado).
--
-- RLS con FORCE, como operator_payouts: una fila es un permiso para mover
-- dinero. Con FORCE, una consulta sin el local en la sesión (o sin el bypass
-- de asSystem/acrossVenues) no ve nada, también con el rol dueño de las
-- tablas, y los guardas del API la cortan (rls.ts).
--
-- Idempotente y segura con datos: tabla y tipos nuevos, nada se reescribe.

-- Corre con el API anterior sirviendo (start-first): si una transacción suya
-- tiene la tabla, mejor fallar a los 5 s (el deploy se repite) que dejar
-- todas las escrituras en cola detrás de este ALTER.
SET lock_timeout = '5s';

DO $$
BEGIN
  CREATE TYPE "ApprovalKind" AS ENUM ('PAYOUT', 'REFUND');
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;

CREATE TABLE IF NOT EXISTS "approval_requests" (
  "id"            UUID             NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"      UUID             NOT NULL,
  "kind"          "ApprovalKind"   NOT NULL,
  "status"        "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
  -- La chica (PAYOUT) o el cobro (REFUND).
  "targetId"      UUID             NOT NULL,
  "amountCents"   INTEGER          NOT NULL,
  "payload"       JSONB            NOT NULL,
  "requestedById" UUID             NOT NULL,
  "requestedAt"   TIMESTAMPTZ      NOT NULL DEFAULT now(),
  "decidedById"   UUID,
  "decidedAt"     TIMESTAMPTZ,
  "decisionNote"  TEXT,
  -- Pago a la chica o devolución que salió al aprobarla.
  "resultRef"     UUID,
  "failureReason" TEXT,
  "updatedAt"     TIMESTAMPTZ      NOT NULL DEFAULT now(),
  CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'approval_requests_tenantId_fkey') THEN
    ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "venues" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS "approval_requests_tenantId_status_idx"
  ON "approval_requests" ("tenantId", "status");

-- Una sola petición de pago pendiente por chica: dos encargados a la vez no
-- piden dos veces las mismas comisiones (y la base lo asegura aunque el API
-- fallase).
CREATE UNIQUE INDEX IF NOT EXISTS "approval_requests_one_pending_payout"
  ON "approval_requests" ("tenantId", "targetId")
  WHERE "kind" = 'PAYOUT' AND "status" = 'PENDING';

-- Lo que reservan las devoluciones pendientes de aprobar de un cobro.
CREATE INDEX IF NOT EXISTS "approval_requests_pending_refund_idx"
  ON "approval_requests" ("targetId")
  WHERE "kind" = 'REFUND' AND "status" = 'PENDING';

-- ─── Reglas que la base asegura sola ─────────────────────────────────────
ALTER TABLE "approval_requests" DROP CONSTRAINT IF EXISTS "approval_requests_amount_positive";
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_amount_positive"
  CHECK ("amountCents" > 0);

-- Separación de funciones: quien pide nunca decide.
ALTER TABLE "approval_requests" DROP CONSTRAINT IF EXISTS "approval_requests_decider_not_requester";
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_decider_not_requester"
  CHECK ("decidedById" IS NULL OR "decidedById" <> "requestedById");

-- Decidida (o caducada) ⇒ con fecha; rechazada ⇒ con motivo; fallida ⇒ con razón.
ALTER TABLE "approval_requests" DROP CONSTRAINT IF EXISTS "approval_requests_decided_consistent";
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_decided_consistent"
  CHECK (
    ("status" = 'PENDING' AND "decidedAt" IS NULL AND "decidedById" IS NULL)
    OR ("status" <> 'PENDING' AND "decidedAt" IS NOT NULL)
  );
ALTER TABLE "approval_requests" DROP CONSTRAINT IF EXISTS "approval_requests_reject_has_note";
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_reject_has_note"
  CHECK ("status" <> 'REJECTED' OR length(btrim(coalesce("decisionNote", ''))) >= 3);
ALTER TABLE "approval_requests" DROP CONSTRAINT IF EXISTS "approval_requests_failed_has_reason";
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_failed_has_reason"
  CHECK ("status" <> 'FAILED' OR "failureReason" IS NOT NULL);
-- Solo lo aprobado (o lo que falló al hacerlo) apunta a lo que salió.
ALTER TABLE "approval_requests" DROP CONSTRAINT IF EXISTS "approval_requests_result_when_approved";
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_result_when_approved"
  CHECK ("resultRef" IS NULL OR "status" IN ('APPROVED', 'FAILED'));

-- ─── RLS (FORCE) ─────────────────────────────────────────────────────────
ALTER TABLE "approval_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "approval_requests" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS approval_requests_tenant_isolation ON "approval_requests";
CREATE POLICY approval_requests_tenant_isolation ON "approval_requests"
  USING (app_rls_bypass() OR "tenantId" = app_current_tenant())
  WITH CHECK (app_rls_bypass() OR "tenantId" = app_current_tenant());
