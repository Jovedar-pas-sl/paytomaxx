-- Phase 1C — SoftPOS support
-- Añadir nuevos valores al enum Provider para Viva.com Smart Checkout
-- (Tap to Phone para Android NFC + iOS) y Stripe Tap to Pay (alternativa).
-- + columna Payment.captureMethod para diferenciar modos de cobro
-- (QR clásico vs tap-to-phone contactless vs wallet flows futuros).

ALTER TYPE "Provider" ADD VALUE IF NOT EXISTS 'VIVA_SOFTPOS';
ALTER TYPE "Provider" ADD VALUE IF NOT EXISTS 'STRIPE_TAP';

ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "captureMethod" TEXT;

COMMENT ON COLUMN "payments"."captureMethod" IS
  'Modo de cobro: "QR" | "SOFTPOS_TAP" | "WALLET_TOPUP" | "WALLET_CONSUMPTION". Null = legacy (asume QR).';
