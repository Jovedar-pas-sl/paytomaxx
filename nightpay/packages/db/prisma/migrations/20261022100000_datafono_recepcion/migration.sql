-- Datáfonos de recepción y credencial del datáfono (2026-10-22).
--
--  1. terminals.reception: el datáfono es el de la recepción. Solo ese cobra
--     recargas en efectivo (el datáfono no sabe quién lo lleva: los de las
--     chicas no). Apagado por defecto: el dueño lo marca en Datáfonos.
--  2. terminals.deviceTokenNextIssuedAt: fecha de la credencial nueva de una
--     rotación. Rotar ya no rejuvenece la credencial en uso
--     (deviceTokenIssuedAt cambia solo cuando el datáfono usa la nueva).
--  3. operator_payouts.idempotencyKey / idempotencyHash: la Idempotency-Key de
--     «Marcar pagado» a una chica (repetirlo sin respuesta no paga dos veces).
--
-- Idempotente: se puede lanzar dos veces sin cambiar nada la segunda.

ALTER TABLE "terminals" ADD COLUMN IF NOT EXISTS "reception" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "terminals" ADD COLUMN IF NOT EXISTS "deviceTokenNextIssuedAt" TIMESTAMPTZ;

ALTER TABLE "operator_payouts" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;
ALTER TABLE "operator_payouts" ADD COLUMN IF NOT EXISTS "idempotencyHash" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "operator_payouts_tenantId_idempotencyKey_key"
  ON "operator_payouts" ("tenantId", "idempotencyKey");
