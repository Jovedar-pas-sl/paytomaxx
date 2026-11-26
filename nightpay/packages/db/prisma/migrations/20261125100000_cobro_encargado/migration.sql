-- Cobro por el encargado, fase 1 (25-nov-2026, decisión del dueño).
--  1. venues."operatorsChargeFromPhone": «Las compañeras cobran desde su
--     móvil» (super-admin → Reglas del local). Apagada, la compañera (OPERATOR)
--     no crea cobros ni recargas: sus servicios los cobra el encargado, el dueño
--     o recepción con permiso, a su nombre. Los locales de antes quedan como hoy
--     (encendida: el DEFAULT rellena las filas sin reescribir la tabla); los
--     nuevos los crea el API con ella apagada (como el datáfono).
--  2. payment_lines."serviceOperatorId": la compañera del servicio cuando lo
--     cobra otra persona. Solo en líneas de Servicios (CHECK). Su parte va en
--     "operatorCommissionBps" de la línea, fijada al cobrar.
--  3. Índice de wallet_charge_requests."consumptionId": la ganancia de un
--     servicio pagado con el saldo llega a sus líneas por su consumo («Mi
--     noche», cada 15 s; Ganancias y «No es mío»). La tabla es pequeña: sin
--     CONCURRENTLY, como en 20261024100000_cobro_unico.
-- Se puede repetir.

SET lock_timeout = '5s';

ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "operatorsChargeFromPhone" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "payment_lines" ADD COLUMN IF NOT EXISTS "serviceOperatorId" UUID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_lines_serviceOperatorId_fkey') THEN
    ALTER TABLE "payment_lines" ADD CONSTRAINT "payment_lines_serviceOperatorId_fkey"
      FOREIGN KEY ("serviceOperatorId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  ALTER TABLE "payment_lines"
    ADD CONSTRAINT "payment_lines_service_operator_in_services"
    CHECK ("serviceOperatorId" IS NULL OR "category" = 'CHICA_SERVICE') NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
-- Columna nueva (todas NULL): validarla es inmediato.
ALTER TABLE "payment_lines" VALIDATE CONSTRAINT "payment_lines_service_operator_in_services";

CREATE INDEX IF NOT EXISTS "wallet_charge_requests_consumptionId_idx" ON "wallet_charge_requests" ("consumptionId");
