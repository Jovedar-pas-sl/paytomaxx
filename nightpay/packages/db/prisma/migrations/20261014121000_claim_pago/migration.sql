-- El enlace del saldo solo para el móvil que pagó: cada intento de cobro
-- guarda la huella (sha256) de la cookie aleatoria del navegador que lo abrió.
-- Quien tenga el QR pero no sea ese navegador no ve el enlace del saldo.
ALTER TABLE "payment_attempts" ADD COLUMN IF NOT EXISTS "claimHash" TEXT;
