-- «Los más pedidos arriba», fijo cada noche (12-nov-2026): la noche guarda el
-- orden de la carta que se calculó al pedirla por primera vez, con las unidades
-- vendidas de cada producto en las últimas 4 noches cerradas. Así el orden no
-- se mueve durante la noche. Columna nueva y vacía (sin valor por defecto: no
-- reescribe la tabla) y sin restricciones que validar. Se puede repetir.

SET lock_timeout = '5s';

ALTER TABLE "venue_nights" ADD COLUMN IF NOT EXISTS "cartaOrder" JSONB;
