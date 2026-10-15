-- Devolver el saldo a la tarjeta sin dejar nada a medias (revisión #38).
-- Antes: la wallet se cerraba (REFUNDED), luego se apuntaban las devoluciones
-- en el banco y al final se creaba el wallet_payout; si el proceso se caía en
-- medio, quedaba una wallet cerrada con saldo y sin devolución apuntada.
-- Ahora la devolución a la tarjeta se crea primero como PENDING con todo el
-- saldo (que pasa de la wallet a la devolución) y se cierra (DONE) en la misma
-- transacción que cierra la wallet o le devuelve lo que no se pudo apuntar.
-- Una PENDING que quedó a medias se retoma al volver a pulsar.
--
-- Las filas que ya existen son devoluciones hechas: DONE. Sin reescribir la
-- tabla (ADD COLUMN con DEFAULT constante).
ALTER TABLE "wallet_payouts" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'DONE';
-- Quién la está apuntando ahora (un segundo clic no la apunta dos veces); si
-- es vieja, el proceso se cayó y se puede retomar.
ALTER TABLE "wallet_payouts" ADD COLUMN IF NOT EXISTS "claimedAt" TIMESTAMPTZ;

ALTER TABLE "wallet_payouts" DROP CONSTRAINT IF EXISTS "wallet_payouts_status_check";
ALTER TABLE "wallet_payouts"
  ADD CONSTRAINT "wallet_payouts_status_check" CHECK ("status" IN ('PENDING', 'DONE'));

-- Una sola devolución a medias por saldo.
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_payouts_one_pending_per_wallet"
  ON "wallet_payouts" ("walletId") WHERE "status" = 'PENDING';
