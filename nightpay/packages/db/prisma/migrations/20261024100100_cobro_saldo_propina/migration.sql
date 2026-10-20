-- Propina en el cobro del saldo (2026-10-24).
--
-- «Propina» en la pantalla de cobrar (losetas de Propinas u «Otro importe»
-- en Propinas): el cliente que paga con su saldo (NFC, PIN o Face ID) paga
-- también la propina que pidió. Va aparte del importe, como en los cobros con
-- tarjeta: el consumo la guarda en wallet_consumptions."tipCents" (ya existía)
-- y, si cobra una chica, es entera para ella.
--
-- Idempotente: se puede lanzar dos veces sin cambiar nada la segunda.

SET lock_timeout = '5s';

ALTER TABLE "wallet_charge_requests" ADD COLUMN IF NOT EXISTS "tipCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "wallet_charge_requests" DROP CONSTRAINT IF EXISTS "wallet_charge_requests_tip_not_negative";
ALTER TABLE "wallet_charge_requests" ADD CONSTRAINT "wallet_charge_requests_tip_not_negative" CHECK ("tipCents" >= 0);
