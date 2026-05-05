-- Add STRIPE to Provider enum
ALTER TYPE "Provider" ADD VALUE IF NOT EXISTS 'STRIPE';

-- Add stripeClientSecret column to payments
ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "stripeClientSecret" TEXT;
