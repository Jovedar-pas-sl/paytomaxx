-- Cobro único (2026-10-24): un cobro, dos formas de pagar.
--
-- La pantalla de espera enseña a la vez el QR (el cliente paga con su
-- tarjeta, o con su saldo desde la página de pago) y espera el NFC. Por eso
-- el cobro con tarjeta (payments) lleva enlazado un cobro del saldo
-- (wallet_charge_requests) con el mismo importe, la misma referencia (C-0001)
-- y un solo juego de líneas.
--
-- Gana el primero que se paga: los dos caminos bloquean primero la fila del
-- cobro con tarjeta (FOR UPDATE). Si paga el saldo, el cobro con tarjeta pasa
-- a CANCELED y no se puede autorizar; si paga la tarjeta, el del saldo pasa a
-- CANCELED y un NFC acercado después contesta «Ya está pagado».
--
-- Uno como mucho por cobro con tarjeta (índice único). Si se borra el cobro
-- con tarjeta, su enlace también (CASCADE, como las líneas).
--
-- wallet_charge_requests es pequeña: el índice se crea sin CONCURRENTLY.
-- Idempotente: se puede lanzar dos veces sin cambiar nada la segunda.

SET lock_timeout = '5s';

ALTER TABLE "wallet_charge_requests" ADD COLUMN IF NOT EXISTS "linkedPaymentId" UUID;

CREATE UNIQUE INDEX IF NOT EXISTS "wallet_charge_requests_linkedPaymentId_key"
  ON "wallet_charge_requests" ("linkedPaymentId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_charge_requests_linkedPaymentId_fkey') THEN
    ALTER TABLE "wallet_charge_requests" ADD CONSTRAINT "wallet_charge_requests_linkedPaymentId_fkey"
      FOREIGN KEY ("linkedPaymentId") REFERENCES "payments" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;
