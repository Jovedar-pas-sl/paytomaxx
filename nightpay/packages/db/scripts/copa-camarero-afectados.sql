-- Migración 20261028100000_copa_con_invitacion, paso 4: los locales que tienen
-- guardada en Ajustes → Invitaciones la parte del camarero de fábrica de antes
-- (50 %, la que el formulario anterior traía rellena y guardaba siempre). La
-- migración la pone a 0 % (la chica 50 % y el resto, del local); lo demás que
-- guardaron se queda. Solo lee: se puede lanzar en producción cuando se quiera.
--
--   psql "$DATABASE_URL" -f packages/db/scripts/copa-camarero-afectados.sql
--
-- ANTES de publicar: cuántos y cuáles cambiarán.
SELECT count(*) AS locales_afectados
  FROM venues
 WHERE jsonb_typeof("invitationRules") = 'object'
   AND "invitationRules" -> 'camarero' = '{"kind": "PERCENT", "bps": 5000}'::jsonb;

SELECT id, name, slug, "invitationRules" -> 'chica' AS chica, "invitationRules" -> 'camarero' AS camarero
  FROM venues
 WHERE jsonb_typeof("invitationRules") = 'object'
   AND "invitationRules" -> 'camarero' = '{"kind": "PERCENT", "bps": 5000}'::jsonb
 ORDER BY name;

-- Los que dan al camarero otra parte (la eligió el dueño): la migración no los toca.
SELECT id, name, slug, "invitationRules" -> 'camarero' AS camarero
  FROM venues
 WHERE jsonb_typeof("invitationRules") = 'object'
   AND "invitationRules" ? 'camarero'
   AND "invitationRules" -> 'camarero' NOT IN ('{"kind": "PERCENT", "bps": 5000}'::jsonb, '{"kind": "PERCENT", "bps": 0}'::jsonb)
 ORDER BY name;

-- DESPUÉS de publicar: los que cambió la migración (con lo que había y lo que hay).
SELECT a."occurredAt", v.name, a.payload -> 'before' -> 'camarero' AS antes, a.payload -> 'after' -> 'camarero' AS ahora
  FROM audit_events a
  JOIN venues v ON v.id = a."tenantId"
 WHERE a.action = 'venue.invitation_rules.updated'
   AND a.payload ->> 'migration' = '20261028100000_copa_con_invitacion'
 ORDER BY v.name;
