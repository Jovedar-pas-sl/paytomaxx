-- Con el API anterior sirviendo, fallar pronto si la tabla está ocupada.
SET lock_timeout = '5s';

ALTER TABLE wallet_cards ADD COLUMN IF NOT EXISTS "printedNumber" VARCHAR(12);
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_cards_printedNumber_key" ON wallet_cards("printedNumber");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_cards_printedNumber_digits') THEN
    ALTER TABLE wallet_cards ADD CONSTRAINT "wallet_cards_printedNumber_digits" CHECK ("printedNumber" IS NULL OR "printedNumber" ~ '^[0-9]{1,12}$');
  END IF;
END $$;
