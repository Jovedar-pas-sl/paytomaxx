-- Actualiza las tarifas de Maxxage Madrid.
--   1 hora  -> 130€
--   45 min  -> 100€
--   30 min  ->  80€
--   Salida  -> 180€ + taxi   (base en casa_profile.outcall.base_price_eur)
--
-- rates: se fija a los mismos valores que el sitio público (maxxagemadrid.com),
--        así el website-sync no lo descuadra en las horas.
-- outcall: se MERGEA {base_price_eur:180} para preservar taxi_surcharge_pct y
--          cualquier coordenada ya guardada. El sync NUNCA toca outcall.
--
-- Idempotente. Transaccional: si algo falla, no se aplica nada.
SET client_encoding TO 'UTF8';
\set ON_ERROR_STOP on
BEGIN;

\echo '=== ANTES ==='
SELECT c.id, c.name, cp.manual_mode,
       (cp.address_lat IS NOT NULL) AS geocoded,
       cp.rates->'items' AS rates_items,
       cp.outcall
FROM casa c
LEFT JOIN casa_profile cp ON cp.casa_id = c.id
WHERE c.name ILIKE '%madrid%';

UPDATE casa_profile cp
SET rates = jsonb_build_object('items', jsonb_build_array(
        jsonb_build_object('label_es','1 hora','label_en','1 hour','price','130€'),
        jsonb_build_object('label_es','45 min','label_en','45 min','price','100€'),
        jsonb_build_object('label_es','30 min','label_en','30 min','price','80€'),
        jsonb_build_object('label_es','Salida (hotel/domicilio)','label_en','Outcall','price','180€ + taxi')
    )),
    outcall = COALESCE(cp.outcall, '{}'::jsonb) || jsonb_build_object('base_price_eur', 180),
    updated_at = now()
FROM casa c
WHERE c.id = cp.casa_id AND c.name ILIKE '%madrid%';

\echo '=== DESPUES ==='
SELECT c.id, c.name, cp.rates->'items' AS rates_items, cp.outcall
FROM casa c
JOIN casa_profile cp ON cp.casa_id = c.id
WHERE c.name ILIKE '%madrid%';

COMMIT;
