-- Cierre de la noche en pasos, con el arqueo de caja (2026-10-16).
--
--  - openingFloatCents: fondo de caja con el que empieza la noche (se pone al
--    abrir o al cerrar; null = nadie lo apuntó).
--  - cashExpectedCents: lo que debería haber al cerrar: fondo + entradas −
--    salidas en efectivo (saldo devuelto en efectivo y pagos en efectivo a las
--    chicas). OxioPay no cobra en efectivo: hoy no entra nada por el sistema.
--  - cashCountedCents: lo contado en la caja (null = no se contó: cierre
--    automático a las 08:00 o noche sin efectivo).
--  - cashDiffCents: contado − esperado (negativo = falta dinero).
--  - cashNote: explicación de la diferencia.
-- Lo mismo va congelado en el Z (zReport.caja); los Z de antes no lo traen.
--
-- Idempotente, columnas nullable: no toca filas existentes. Los CHECK solo
-- miran columnas nuevas (null en las noches de antes).

-- Corre con el API anterior sirviendo (start-first): si una transacción suya
-- tiene la tabla, mejor fallar a los 5 s (el deploy se repite) que dejar
-- todas las escrituras en cola detrás de este ALTER.
SET lock_timeout = '5s';

ALTER TABLE "venue_nights" ADD COLUMN IF NOT EXISTS "openingFloatCents" INTEGER;
ALTER TABLE "venue_nights" ADD COLUMN IF NOT EXISTS "cashCountedCents" INTEGER;
ALTER TABLE "venue_nights" ADD COLUMN IF NOT EXISTS "cashExpectedCents" INTEGER;
ALTER TABLE "venue_nights" ADD COLUMN IF NOT EXISTS "cashDiffCents" INTEGER;
ALTER TABLE "venue_nights" ADD COLUMN IF NOT EXISTS "cashNote" TEXT;

-- El fondo y lo contado son efectivo de verdad: nunca negativos.
ALTER TABLE "venue_nights" DROP CONSTRAINT IF EXISTS "venue_nights_cash_non_negative";
ALTER TABLE "venue_nights" ADD CONSTRAINT "venue_nights_cash_non_negative"
  CHECK (("openingFloatCents" IS NULL OR "openingFloatCents" >= 0)
     AND ("cashCountedCents" IS NULL OR "cashCountedCents" >= 0));

-- La diferencia es la de lo contado: sin contar no hay diferencia, y cuadra con las otras dos.
ALTER TABLE "venue_nights" DROP CONSTRAINT IF EXISTS "venue_nights_cash_diff_consistent";
ALTER TABLE "venue_nights" ADD CONSTRAINT "venue_nights_cash_diff_consistent"
  CHECK ("cashDiffCents" IS NULL
      OR ("cashCountedCents" IS NOT NULL AND "cashExpectedCents" IS NOT NULL
          AND "cashDiffCents" = "cashCountedCents" - "cashExpectedCents"));
