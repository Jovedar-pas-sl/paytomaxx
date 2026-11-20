-- «Agotado» en la carta (20-nov-2026): cuándo se marcó un producto como agotado.
-- Vale solo si es de la noche abierta (soldOutAt >= openedAt de la noche): al
-- cambiar la noche vuelve solo, sin tarea programada. NULL = hay.
--
-- La columna no tiene valor por defecto: no reescribe la tabla. La policy RLS
-- de service_items es por fila (tenantId), no por columna: no hace falta otra.
-- Se puede repetir.

SET lock_timeout = '5s';

ALTER TABLE "service_items" ADD COLUMN IF NOT EXISTS "soldOutAt" TIMESTAMPTZ;
