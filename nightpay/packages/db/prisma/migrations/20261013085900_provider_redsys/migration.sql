-- REDSYS estaba en schema.prisma pero ninguna migración lo creaba: en
-- producción lo añade db-heal al arrancar, pero en una base nueva db-heal
-- corre antes de que exista el tipo y no hace nada. Va en su propia
-- migración porque un valor nuevo de enum no se puede usar en la misma
-- transacción en la que se añade.
ALTER TYPE "Provider" ADD VALUE IF NOT EXISTS 'REDSYS';
