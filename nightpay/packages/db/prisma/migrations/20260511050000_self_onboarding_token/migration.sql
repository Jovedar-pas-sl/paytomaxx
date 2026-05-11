-- Self-onboarding token: admin genera un link único 72h para que la chica
-- rellene su perfil ella misma si sabe manejar la web + KYC. Si no, el admin
-- lo hace desde la tab Onboarding como hasta ahora.
--
-- El token JWT no se guarda; solo el hash sha256, para invalidación al
-- enviar uno nuevo o al completar el flow.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "selfOnboardingToken" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "users_selfOnboardingToken_key"
  ON "users"("selfOnboardingToken")
  WHERE "selfOnboardingToken" IS NOT NULL;

COMMENT ON COLUMN "users"."selfOnboardingToken" IS
  'sha256 hex hash del JWT self-onboarding. Null = sin link activo. TTL 72h del JWT controla expiración real.';
