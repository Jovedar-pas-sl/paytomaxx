-- «Pantalla del cliente» en reposo (17-nov-2026): el mensaje del local (una
-- promoción, una fiesta) que enseña la tablet bajo el nombre del local cuando
-- no hay cobro. Una línea y otra opcional, 120 letras cada una como mucho (el
-- API las valida antes; VARCHAR(120) es el tope de la base). Lo cambian el
-- dueño y el encargado en Ajustes → Carta. NULL = sin esa línea.
--
-- Columnas sin valor por defecto (NULL): no reescriben la tabla. Se puede repetir.

SET lock_timeout = '5s';

ALTER TABLE "venues"
  ADD COLUMN IF NOT EXISTS "displayLine1" VARCHAR(120),
  ADD COLUMN IF NOT EXISTS "displayLine2" VARCHAR(120);
