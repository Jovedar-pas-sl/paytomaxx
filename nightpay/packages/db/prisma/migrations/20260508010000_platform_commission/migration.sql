-- Comisión NightPay por venue (modelo: 10% plataforma + 90% chica).
-- Editable desde el admin por el OWNER.

ALTER TABLE "venues"
  ADD COLUMN IF NOT EXISTS "platformCommissionBps" INTEGER NOT NULL DEFAULT 1000;

COMMENT ON COLUMN "venues"."platformCommissionBps" IS
  'Comisión NightPay en basis points (1000 = 10.00%). 0..10000.';
