-- Devolver en efectivo los pagos con bitcoin (17-nov-2026), parte 1: columnas
-- nuevas en tablas que ya existen. Ninguna se rellena con datos (las de antes
-- quedan NULL o con su valor de fábrica) y el CHECK se añade NOT VALID y se
-- valida después (sin bloquear las escrituras). Se puede repetir.
--  - btcpay_invoices: lo que llegó de verdad en la factura (pago a medias, de
--    más o tardío), en BTC y en céntimos de euro al cambio de la factura.
--  - btcpay_stores: el interruptor del local para devolver en efectivo
--    (APAGADO de fábrica: lo enciende el dueño cuando lo confirme su abogado).
--  - refunds: la devolución se dio en efectivo (sale de la caja, no del banco
--    ni de la cartera de bitcoin) y el código del recibo que enseñó el cliente.

SET lock_timeout = '5s';

ALTER TABLE "btcpay_invoices" ADD COLUMN IF NOT EXISTS "paidBtc" TEXT;
ALTER TABLE "btcpay_invoices" ADD COLUMN IF NOT EXISTS "paidCents" INTEGER;
DO $$
BEGIN
  ALTER TABLE "btcpay_invoices"
    ADD CONSTRAINT "btcpay_invoices_paid_nonnegative" CHECK ("paidCents" IS NULL OR "paidCents" >= 0) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
-- La columna es nueva (todo NULL): validarla no bloquea las escrituras y es inmediato.
ALTER TABLE "btcpay_invoices" VALIDATE CONSTRAINT "btcpay_invoices_paid_nonnegative";

ALTER TABLE "btcpay_stores" ADD COLUMN IF NOT EXISTS "cashRefundEnabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "refunds" ADD COLUMN IF NOT EXISTS "paidInCash" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "refunds" ADD COLUMN IF NOT EXISTS "receiptCode" TEXT;
