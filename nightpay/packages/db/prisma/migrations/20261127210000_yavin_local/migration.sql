-- Yavin en un local (26-nov-2026):
--  1. venues."yavinSelected": el super-admin elige usar Yavin en el local. Solo
--     cuenta con una credencial YAVIN activa en gateway_credentials y con el
--     servidor encendido (YAVIN_ENABLED). Apagada (por defecto), todo como hoy.
--  2. payment_attempts."noticeTokenHash": SHA-256 del token secreto al azar de
--     la URL del aviso de Yavin de ese intento (Yavin no firma sus avisos). El
--     token no se guarda: solo su huella.
-- Se puede repetir.

SET lock_timeout = '5s';

ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "yavinSelected" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "payment_attempts" ADD COLUMN IF NOT EXISTS "noticeTokenHash" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "payment_attempts_noticeTokenHash_key" ON "payment_attempts"("noticeTokenHash");
