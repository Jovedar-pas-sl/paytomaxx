-- «Pantalla del cliente» (17-nov-2026, segunda parte): el cliente elige su
-- propina en la tablet antes de pagar. Se guarda aquí la que eligió para el
-- cobro que enseña la pantalla (0 = «Sin propina», lo de partida): va en el
-- QR (?tip=) y, si hay cobro del saldo, también en el cobro con ficha.
--
-- Columna nueva con valor por defecto en una tabla nueva y pequeña: no
-- reescribe nada. Se puede repetir.

SET lock_timeout = '5s';

ALTER TABLE "customer_displays" ADD COLUMN IF NOT EXISTS "tipCents" INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customer_displays_tip_range') THEN
    ALTER TABLE "customer_displays"
      ADD CONSTRAINT "customer_displays_tip_range" CHECK ("tipCents" BETWEEN 0 AND 50000);
  END IF;
END $$;
