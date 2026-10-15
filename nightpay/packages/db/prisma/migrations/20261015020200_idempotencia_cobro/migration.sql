-- Revisión 2026-10-15 (#32): la Idempotency-Key de POST /payments va ligada a
-- quién crea el cobro y a lo que pide (huella sha256). Misma clave con otra
-- persona u otra petición → 409, en vez de devolver el cobro de otro.
-- Nullable: los cobros ya creados no la tienen (se compara solo quién los creó).
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "idempotencyHash" TEXT;
