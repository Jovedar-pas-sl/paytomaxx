-- Ajustes del local que pone el dueño en el panel (2026-10-20).
--
--  - paymentMethods: formas de cobro encendidas (QR con tarjeta, saldo, ficha
--    NFC, datáfono) y las propinas (sí/no y las sugeridas).
--  - staffPermissions: qué deja hacer el dueño al encargado (por rol y por
--    persona): devolver, dar efectivo / anular consumos, cerrar la noche,
--    pagos a las chicas e informes.
--  - alertSettings: avisos de Telegram (qué grupos salen, chat propio del
--    local, si llevan los nombres de las chicas).
--
-- NULL = lo de siempre (todo encendido, los permisos de hoy, todos los avisos
-- al chat del entorno y sin nombres): un local sin ajustes no cambia. El API
-- rellena lo que falte (packages/contracts/src/venue-settings.ts).
--
-- Idempotente, columnas nullable: no toca filas existentes.

-- Corre con el API anterior sirviendo (start-first): si una transacción suya
-- tiene la tabla, mejor fallar a los 5 s (el deploy se repite) que dejar
-- todas las escrituras en cola detrás de este ALTER.
SET lock_timeout = '5s';

ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "paymentMethods" JSONB;
ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "staffPermissions" JSONB;
ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "alertSettings" JSONB;

-- Siempre un objeto JSON (nunca una lista o un texto suelto).
ALTER TABLE "venues" DROP CONSTRAINT IF EXISTS "venues_settings_are_objects";
ALTER TABLE "venues" ADD CONSTRAINT "venues_settings_are_objects"
  CHECK (("paymentMethods" IS NULL OR jsonb_typeof("paymentMethods") = 'object')
     AND ("staffPermissions" IS NULL OR jsonb_typeof("staffPermissions") = 'object')
     AND ("alertSettings" IS NULL OR jsonb_typeof("alertSettings") = 'object'));
