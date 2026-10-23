-- «Copa con invitación» (2026-10-28): «Copa» es la copa normal y la invitación
-- de la chica es su propio producto, justo después: «Copa con invitación»
-- (20 €; se escanea el QR de la chica y se reparte entre ella y el local). La
-- carta de referencia ya no trae «Copa premium» y la invitación ya no se llama
-- «Invitar a una copa» (packages/contracts/src/carta-template.ts). El reparto
-- de fábrica es la chica 50 % y el local el resto; el camarero, nada.
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
--     invitación, encendida, en su sitio: sortOrder 1) y NUNCA se ha cobrado:
--     ni una línea de cobro (con tarjeta o del saldo) la apunta ni ningún
--     cobro del local la nombra (los del saldo de antes de las líneas, hasta
--     el 2026-10-20, solo guardaban el nombre: en el cobro del saldo y en el
--     consumo). Si se ha vendido, se queda encendida: lo decide el dueño.
--  3. Lo que queda en Copas en el sitio de «Copa premium» (sortOrder 1, sin ser
--     la invitación: la de antes, encendida o no, con su nombre o el que le
--     puso el dueño) pasa al sitio siguiente (sortOrder 2, delante de
--     «Botella» por precio), así «Copa con invitación» queda justo detrás de
--     «Copa» en cualquier caso: aunque «Copa premium» se quede encendida, la
--     vuelvan a encender o la invitación llegue luego con la referencia de
--     ahora (también va al sitio 1). El sitio solo lo pone la referencia (el
--     panel no lo cambia), así que no se pisa nada que eligiera el dueño.
--  4. Ajustes → Invitaciones: el formulario anterior venía relleno con la parte
--     del camarero de fábrica de entonces (50 %) y la guardaba siempre, la
--     eligiera el dueño o no. Donde la del camarero es EXACTAMENTE ese valor
--     ({"kind": "PERCENT", "bps": 5000}) pasa a 0 %, como la de fábrica de
--     ahora; lo demás que guardó (la parte de la chica, el QR) se queda, y lo
--     que eligió distinto (otro %, € por copa), también. Cada cambio queda en
--     audit_events (venue.invitation_rules.updated, sin persona). Para ver
--     antes de publicar a qué locales afecta:
--     packages/db/scripts/copa-camarero-afectados.sql.
--
-- Lo ya cobrado no cambia: cada cobro guarda su propio nombre (label) y las
-- partes de cada invitación se fijaron en su línea al cobrar.
--
-- La clave «inviteFirst» («Invitar» primero), que ya no se usa, se lee sin
-- error y se olvida la próxima vez que el local guarde.
--
-- Idempotente: la segunda vez no encuentra nada que cambiar (ni escribe otra
-- vez en audit_events).

-- Con el API anterior sirviendo: si una transacción suya tiene la tabla,
-- mejor fallar en 5 s (y reintentar el despliegue) que encolar sus escrituras.
SET lock_timeout = '5s';

-- Ver los cobros de todos los locales (payments, payment_lines, los del saldo
-- y sus consumos tienen FORCE RLS) aunque la lance un rol sin superusuario.
-- Solo dura esta transacción.
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
   AND s."sortOrder" = 1
   AND NOT EXISTS (SELECT 1 FROM "payment_lines" l WHERE l."serviceItemId" = s.id)
   AND NOT EXISTS (SELECT 1 FROM "payments" p WHERE p."serviceItemId" = s.id)
   -- Por el nombre: cualquier cobro del local que la nombre (también los de
   -- antes de las líneas y los de un producto con ese nombre ya borrado).
   AND NOT EXISTS (
     SELECT 1 FROM "payment_lines" l
      WHERE l."tenantId" = s."tenantId" AND lower(btrim(l."label")) = 'copa premium'
   )
   AND NOT EXISTS (
     SELECT 1 FROM "payments" p
      WHERE p."tenantId" = s."tenantId" AND lower(btrim(p."serviceName")) = 'copa premium'
   )
   AND NOT EXISTS (
     SELECT 1 FROM "wallet_charge_requests" w
      WHERE w."tenantId" = s."tenantId" AND lower(btrim(w."serviceName")) = 'copa premium'
   )
   AND NOT EXISTS (
     SELECT 1 FROM "wallet_consumptions" c
      WHERE c."tenantId" = s."tenantId" AND lower(btrim(split_part(c."notes", E'\n', 1))) = 'copa premium'
   );

-- ─── 3. El sitio justo detrás de «Copa», para la invitación ───────────────

UPDATE "service_items" s
   SET "sortOrder" = 2,
       "updatedAt" = now()
 WHERE s."category" = 'VENUE_BAR'
   AND s."sortOrder" = 1
   AND NOT s."isInvitation";

-- ─── 4. La parte del camarero de fábrica de antes (50 %) → 0 % ────────────

WITH antes AS (
  SELECT v.id, v."invitationRules" AS rules
    FROM "venues" v
   WHERE jsonb_typeof(v."invitationRules") = 'object'
     AND v."invitationRules" -> 'camarero' = '{"kind": "PERCENT", "bps": 5000}'::jsonb
     FOR NO KEY UPDATE
), cambiados AS (
  UPDATE "venues" v
     SET "invitationRules" = jsonb_set(a.rules, '{camarero}', '{"kind": "PERCENT", "bps": 0}'::jsonb),
         "updatedAt" = now()
    FROM antes a
   WHERE v.id = a.id
  RETURNING v.id, a.rules AS antes, v."invitationRules" AS despues
)
INSERT INTO "audit_events" ("tenantId", "action", "targetType", "targetId", "payload")
SELECT c.id,
       'venue.invitation_rules.updated',
       'Venue',
       c.id::text,
       jsonb_build_object(
         'before', c.antes,
         'after', c.despues,
         'migration', '20261028100000_copa_con_invitacion',
         'reason', 'La parte del camarero de fábrica de antes (50 %) que guardaba el formulario anterior pasa a la de ahora (0 %).'
       )
  FROM cambiados c;
