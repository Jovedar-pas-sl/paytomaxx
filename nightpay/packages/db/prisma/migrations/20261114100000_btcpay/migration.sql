-- «Pagar con bitcoin» (BTCPay Server), 14-nov-2026: BTCPAY como proveedor del
-- cobro. Va en su propia migración porque un valor nuevo de enum no se puede
-- usar en la misma transacción en la que se añade (la siguiente migración ya
-- puede usarlo). Se puede repetir.

SET lock_timeout = '5s';

ALTER TYPE "Provider" ADD VALUE IF NOT EXISTS 'BTCPAY';
