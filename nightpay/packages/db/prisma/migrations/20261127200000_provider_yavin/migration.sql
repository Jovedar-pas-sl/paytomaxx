-- Yavin (26-nov-2026): segunda pasarela de tarjeta, solo enlace de pago online
-- que se enseña como QR (no es datáfono). YAVIN como proveedor del cobro. Va en
-- su propia migración porque un valor nuevo de enum no se puede usar en la
-- misma transacción en la que se añade. Se puede repetir.

SET lock_timeout = '5s';

ALTER TYPE "Provider" ADD VALUE IF NOT EXISTS 'YAVIN';
