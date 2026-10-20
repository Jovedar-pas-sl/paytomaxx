-- Qué cobra cada puesto (2026-10-23): venues.postRules, la tabla puesto ×
-- sección que pone el dueño en Ajustes (secciones que cobra, propinas,
-- efectivo y recargas del saldo). NULL = lo de fábrica
-- (packages/contracts/src/post-rules.ts): las chicas solo Servicios; la barra
-- Copas, Entradas y Comida; recepción todo, el efectivo y las recargas.
--
-- Idempotente, columna nullable: no toca filas existentes.

-- Corre con el API anterior sirviendo (start-first): mejor fallar a los 5 s
-- (el deploy se repite) que dejar las escrituras en cola detrás del ALTER.
SET lock_timeout = '5s';

ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "postRules" JSONB;
ALTER TABLE "venues" DROP CONSTRAINT IF EXISTS "venues_post_rules_is_object";
ALTER TABLE "venues" ADD CONSTRAINT "venues_post_rules_is_object"
  CHECK ("postRules" IS NULL OR jsonb_typeof("postRules") = 'object');
