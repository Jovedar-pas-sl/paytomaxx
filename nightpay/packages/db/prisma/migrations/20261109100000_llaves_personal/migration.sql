-- Llaves de acceso del personal (2026-11-09, «Detalle del pago», fase 2).
--
-- Quien no tiene la verificación en dos pasos (2FA) se verifica con una llave
-- de acceso en su móvil (Face ID, huella o el PIN del propio móvil): para ver
-- lo delicado de un cobro (5 minutos) y para las acciones que hoy piden la 2FA
-- (anular, devolver…), con una prueba de un solo uso por acción. Darla de alta
-- pide la contraseña otra vez (y el código, si tiene 2FA).
--
-- Aquí solo la clave pública (como wallet_passkeys, la de los clientes), el
-- contador, los transportes y el nombre del móvil con el que se dio de alta
-- («iPhone · iOS 18»). Cuelga de la persona (users) y se borra con ella. Sin
-- local ni RLS a propósito, como wallet_passkeys: el API la busca siempre por
-- la persona de la sesión o por el id de la credencial (docs/DB-ROLE.md).
--
-- Tabla nueva y vacía: no toca nada de lo que hay. Se puede repetir.

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "staff_passkeys" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "credentialId" TEXT NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMPTZ,

    CONSTRAINT "staff_passkeys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "staff_passkeys_credentialId_key" ON "staff_passkeys"("credentialId");

CREATE INDEX IF NOT EXISTS "staff_passkeys_userId_idx" ON "staff_passkeys"("userId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'staff_passkeys_userId_fkey') THEN
    ALTER TABLE "staff_passkeys"
      ADD CONSTRAINT "staff_passkeys_userId_fkey" FOREIGN KEY ("userId")
      REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

-- Reglas en la base (NOT VALID + VALIDATE, como todas las CHECK desde 20261029):
--  - el nombre del móvil, de 1 a 80 letras;
--  - el id de la credencial, en base64url y de 16 a 1024 letras (la longitud,
--    aparte: las expresiones de Postgres no repiten más de 255 veces);
--  - el contador nunca negativo.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'staff_passkeys_name_check') THEN
    ALTER TABLE "staff_passkeys"
      ADD CONSTRAINT "staff_passkeys_name_check" CHECK (char_length("name") BETWEEN 1 AND 80) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'staff_passkeys_credential_check') THEN
    ALTER TABLE "staff_passkeys"
      ADD CONSTRAINT "staff_passkeys_credential_check"
      CHECK (char_length("credentialId") BETWEEN 16 AND 1024 AND "credentialId" ~ '^[A-Za-z0-9_-]+$') NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'staff_passkeys_counter_check') THEN
    ALTER TABLE "staff_passkeys"
      ADD CONSTRAINT "staff_passkeys_counter_check" CHECK ("counter" >= 0) NOT VALID;
  END IF;
END
$$;

ALTER TABLE "staff_passkeys" VALIDATE CONSTRAINT "staff_passkeys_name_check";
ALTER TABLE "staff_passkeys" VALIDATE CONSTRAINT "staff_passkeys_credential_check";
ALTER TABLE "staff_passkeys" VALIDATE CONSTRAINT "staff_passkeys_counter_check";
