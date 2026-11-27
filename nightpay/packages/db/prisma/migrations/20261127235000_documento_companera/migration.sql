-- Cobro por el encargado, fase 3 (26-nov-2026): el documento de la compañera.
-- El tipo (DNI, NIE o pasaporte) y el número, cifrados como su cuenta de cobro
-- (pa1:… con ENCRYPTION_KEK, cada uno con su campo y su persona): con una copia
-- de la base no se leen. El encargado lo ve tapado; entero, solo el dueño con su
-- 2FA. Se borran al darla de baja. "passportCountry" y "passportLast4" (en
-- claro, de antes) no se tocan. Dos columnas nuevas, vacías: sin reescribir la
-- tabla. Se puede repetir.

SET lock_timeout = '5s';

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "idDocumentType" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "idDocumentNumber" TEXT;
