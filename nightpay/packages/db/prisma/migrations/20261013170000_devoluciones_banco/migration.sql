-- Fase 1C (2026-10-13) — devoluciones hechas en el portal de BBVA.
--
-- Redsys no devuelve por API desde NightPay: el dueño devuelve en el portal
-- del banco y la apunta en el panel. Se marca como registrada a mano y se
-- guarda el día real de la devolución en el banco (para los informes).
ALTER TABLE "refunds"
  ADD COLUMN IF NOT EXISTS "registeredManually" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "bankRefundedAt"     TIMESTAMPTZ;
