-- «Copa con invitación» (2026-10-28): «Copa» es la copa normal y la invitación
-- de la chica es su propio producto, justo después: «Copa con invitación»
-- (20 €; se escanea el QR de la chica y se reparte entre ella y el local). La
-- carta de referencia ya no trae «Copa premium» y la invitación ya no se llama
-- «Invitar a una copa» (packages/contracts/src/carta-template.ts).
--
-- Los locales que aplicaron la referencia de antes y no la tocaron se ponen
-- igual. Conservador: nunca se borra nada y solo se toca lo que sigue tal como
-- lo dejó la referencia de antes (los productos que el dueño cambió, no):
--
--  1. La invitación «Invitar a una copa» (isInvitation, ese nombre exacto)
--     pasa a llamarse «Copa con invitación», si en sus Copas no hay ya otro
--     producto con ese nombre. Si sigue en su sitio de la referencia de antes
--     (sortOrder 12, la última), va justo detrás de «Copa» (sortOrder 1).
--  2. «Copa premium» se apaga (active = false: el personal deja de verla; el
--     dueño la vuelve a encender en Carta si la quiere) solo si sigue como la
--     dejó la referencia (Copas, 14,00 €, sin pack, sin duración, no es una
--     invitación, encendida) y NUNCA se ha cobrado: ninguna línea de cobro
--     (con tarjeta o del saldo) ni cobro de antes de las líneas la nombra. Si
--     se ha vendido, se queda como está: lo decide el dueño.
--
-- Lo ya cobrado no cambia: cada cobro guarda su propio nombre (label) y las
-- partes de cada invitación se fijaron al cobrar.
--
-- No se tocan las partes guardadas en Ajustes → Invitaciones
-- (venues.invitationRules): un local que guardó una parte para el camarero la
-- conserva (Ajustes la enseña abierta para que la quite si quiere). La clave
-- «inviteFirst» («Invitar» primero), que ya no se usa, se lee sin error y se
-- olvida la próxima vez que el local guarde.
--
-- Idempotente: la segunda vez no encuentra nada que cambiar.

-- Con el API anterior sirviendo: si una transacción suya tiene la tabla,
-- mejor fallar en 5 s (y reintentar el despliegue) que encolar sus escrituras.
SET lock_timeout = '5s';

-- Ver las líneas de cobro de todos los locales (payment_lines tiene FORCE RLS)
-- aunque la lance un rol sin superusuario. Solo dura esta transacción.
SELECT set_config('app.bypass_rls', 'on', true);

-- ─── 1. La invitación de la referencia de antes, con su nombre de ahora ────

UPDATE "service_items" s
   SET "name" = 'Copa con invitación',
       "sortOrder" = CASE WHEN s."sortOrder" = 12 THEN 1 ELSE s."sortOrder" END,
       "updatedAt" = now()
 WHERE s."isInvitation"
   AND s."name" = 'Invitar a una copa'
   AND NOT EXISTS (
     SELECT 1
       FROM "service_items" o
      WHERE o."tenantId" = s."tenantId"
        AND o.id <> s.id
        AND o."category" = s."category"
        -- Sin depender del idioma de la base: mayúsculas con tilde a mano.
        AND lower(translate(btrim(o."name"), 'ÁÉÍÓÚÑ', 'áéíóúñ')) = 'copa con invitación'
   );

-- ─── 2. «Copa premium» de la referencia de antes, si nunca se ha cobrado ───

UPDATE "service_items" s
   SET "active" = false,
       "updatedAt" = now()
 WHERE s."name" = 'Copa premium'
   AND s."category" = 'VENUE_BAR'
   AND s."priceCents" = 1400
   AND s."durationMin" IS NULL
   AND s."components" IS NULL
   AND NOT s."isInvitation"
   AND s."active"
   AND NOT EXISTS (SELECT 1 FROM "payment_lines" l WHERE l."serviceItemId" = s.id)
   AND NOT EXISTS (SELECT 1 FROM "payments" p WHERE p."serviceItemId" = s.id);
