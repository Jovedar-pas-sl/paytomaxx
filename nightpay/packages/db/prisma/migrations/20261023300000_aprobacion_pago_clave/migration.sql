-- «Por aprobar» del pago a una chica con Idempotency-Key (2026-10-23).
--
-- El encargado pide el pago con la clave del intento (la misma que el pago
-- directo de «Marcar pagado»). Repetirlo sin respuesta devuelve la misma
-- solicitud; la misma clave con otra petición, 409. La cifra que vio va en el
-- payload (expectedTotalCents): si ya no es lo pagable, ni se pide ni se paga.
--
-- approval_requests es pequeña: el índice se crea sin CONCURRENTLY.
-- Idempotente: se puede lanzar dos veces sin cambiar nada la segunda.

SET lock_timeout = '5s';

ALTER TABLE "approval_requests" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;
ALTER TABLE "approval_requests" ADD COLUMN IF NOT EXISTS "idempotencyHash" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "approval_requests_tenantId_idempotencyKey_key"
  ON "approval_requests" ("tenantId", "idempotencyKey");
