-- Fase 1B (2026-10-13) — página de pago del cliente.
--
-- El cliente elige propina y botón (Apple Pay / Google Pay o tarjeta) antes
-- de ir al banco. Cada intento guarda lo que se le mandó al banco: el total
-- (importe + propina), la propina y el botón. La propina del intento que el
-- banco aprueba es la que pasa al cobro. NULL = intento anterior a esta fase.
ALTER TABLE "payment_attempts"
  ADD COLUMN IF NOT EXISTS "amountCents" INTEGER,
  ADD COLUMN IF NOT EXISTS "tipCents"    INTEGER,
  ADD COLUMN IF NOT EXISTS "payMethod"   TEXT;
