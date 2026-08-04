-- Fija (PIN) las tarifas + domicilio de MARBELLA, IBIZA y VALENCIA.
-- (Madrid ya se fija con scripts/update_madrid_prices.sql.)
--
-- PRECIOS (los que diste):
--   MARBELLA : 30min 140€ · 1h 240€ · domicilio 280€ + taxi
--   IBIZA    : 30min 100€ · 45min 150€ · 1h 200€ · salida 250€ + taxi
--   VALENCIA : 30min 60€ · 45min 80€ · 1h 100€ · domicilio 150€ + taxi
--
-- POR QUÉ manual_mode = true:
--   La sync del sitio web REESCRIBE casa_profile.rates cada ~20 min salvo que la casa
--   esté en modo manual. Para que los precios NO cambien hasta que los cambies TÚ, cada
--   casa pasa a manual_mode = true. El `outcall` (domicilio) la sync NUNCA lo toca.
--
--   ⚠ EFECTO 1: en modo manual el cron deja de auto-importar chicas/fotos/horario de esa
--     casa (se gestionan desde el panel Ficha; el botón de "sync" manual sigue y es
--     aditivo). Las TARIFAS son lo que se blinda a cambio.
--   ⚠ EFECTO 2: en modo manual, Sara pasa a modo "Backoffice": se fía del roster del panel
--     ("disponibles hoy") para esa casa. Coherente si gestionas por panel; que lo sepas.
--
-- ✅ DOMICILIO / TAXI: el bot suma un rango de taxi calculado ENCIMA del base (outcall.py)
--   cuando la casa está geocodificada y el cliente manda su ubicación. Las TRES van así
--   (base + taxi): Marbella 280 + taxi, Ibiza 250 + taxi, Valencia 150 + taxi.
--
-- ℹ IBIZA · regla por duración: si el domicilio es de MÁS de 2 horas, la tarifa baja a
--   200€/hora (+ taxi). El calculador usa un base único (no cobra por horas), así que ESTO
--   NO se codifica aquí: la base fija queda 250€ + taxi para lo estándar, y la regla de +2h
--   se gestiona a mano / como FAQ. Dime si quieres que la añada como FAQ para que Sara la
--   ofrezca ("a partir de 2h, 200€/hora + taxi").
--
-- SEGURIDAD: cada casa va en su propia transacción con un GUARD que ABORTA sola si el
-- número de casas que casa el nombre no es el esperado (Marbella/Ibiza=1, Valencia=1-2).
-- Así, aunque lo corras del tirón, no puede pintar la casa equivocada: si algo no cuadra,
-- ese bloque no hace COMMIT y para (nada se toca). Igualmente el eco ANTES te enseña qué
-- casó. Idempotente: re-ejecutar deja el mismo estado.
SET client_encoding TO 'UTF8';
\set ON_ERROR_STOP on

-- ============================ MARBELLA ============================
BEGIN;
\echo '=== MARBELLA · ANTES ==='
SELECT c.id, c.name, cp.manual_mode,
       (cp.address_lat IS NOT NULL) AS geocoded,
       cp.rates->'items' AS rates_items, cp.outcall
FROM casa c LEFT JOIN casa_profile cp ON cp.casa_id = c.id
WHERE c.name ILIKE '%marbella%';

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM casa WHERE name ILIKE '%marbella%';
  IF n <> 1 THEN
    RAISE EXCEPTION 'MARBELLA: esperaba 1 casa, encontre % — revisa el nombre y reintenta (no se toca nada)', n;
  END IF;
END $$;

INSERT INTO casa_profile (casa_id, rates, outcall, manual_mode, updated_at)
SELECT c.id,
       jsonb_build_object('items', jsonb_build_array(
           jsonb_build_object('label_es','1 hora','label_en','1 hour','price','240€'),
           jsonb_build_object('label_es','30 min','label_en','30 min','price','140€'),
           jsonb_build_object('label_es','Salida (hotel/domicilio)','label_en','Outcall','price','280€ + taxi')
       )),
       COALESCE(cp.outcall, '{}'::jsonb) || jsonb_build_object('base_price_eur', 280),
       true, now()
FROM casa c LEFT JOIN casa_profile cp ON cp.casa_id = c.id
WHERE c.name ILIKE '%marbella%'
ON CONFLICT (casa_id) DO UPDATE SET
    rates       = EXCLUDED.rates,
    outcall     = EXCLUDED.outcall,   -- ya viene MERGEADO (|| preserva taxi_surcharge_pct)
    manual_mode = true,
    updated_at  = now();

\echo '=== MARBELLA · DESPUES (debe verse 240/140/280 y manual_mode=t) ==='
SELECT c.id, c.name, cp.manual_mode, cp.rates->'items' AS rates_items, cp.outcall
FROM casa c JOIN casa_profile cp ON cp.casa_id = c.id
WHERE c.name ILIKE '%marbella%';
COMMIT;

-- ============================ IBIZA ============================
BEGIN;
\echo '=== IBIZA · ANTES ==='
SELECT c.id, c.name, cp.manual_mode,
       (cp.address_lat IS NOT NULL) AS geocoded,
       cp.rates->'items' AS rates_items, cp.outcall
FROM casa c LEFT JOIN casa_profile cp ON cp.casa_id = c.id
WHERE c.name ILIKE '%ibiza%';

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM casa WHERE name ILIKE '%ibiza%';
  IF n <> 1 THEN
    RAISE EXCEPTION 'IBIZA: esperaba 1 casa, encontre % — revisa el nombre y reintenta (no se toca nada)', n;
  END IF;
END $$;

INSERT INTO casa_profile (casa_id, rates, outcall, manual_mode, updated_at)
SELECT c.id,
       jsonb_build_object('items', jsonb_build_array(
           jsonb_build_object('label_es','1 hora','label_en','1 hour','price','200€'),
           jsonb_build_object('label_es','45 min','label_en','45 min','price','150€'),
           jsonb_build_object('label_es','30 min','label_en','30 min','price','100€'),
           jsonb_build_object('label_es','Salida (hotel/domicilio)','label_en','Outcall','price','250€ + taxi')
       )),
       COALESCE(cp.outcall, '{}'::jsonb) || jsonb_build_object('base_price_eur', 250),
       true, now()
FROM casa c LEFT JOIN casa_profile cp ON cp.casa_id = c.id
WHERE c.name ILIKE '%ibiza%'
ON CONFLICT (casa_id) DO UPDATE SET
    rates       = EXCLUDED.rates,
    outcall     = EXCLUDED.outcall,
    manual_mode = true,
    updated_at  = now();

\echo '=== IBIZA · DESPUES (debe verse 200/150/100/250 y manual_mode=t) ==='
SELECT c.id, c.name, cp.manual_mode, cp.rates->'items' AS rates_items, cp.outcall
FROM casa c JOIN casa_profile cp ON cp.casa_id = c.id
WHERE c.name ILIKE '%ibiza%';
COMMIT;

-- ============================ VALENCIA ============================
-- La casa real se llama "Maxxag VLC" y/o "Maxxage Valencia" → match por AMBOS.
-- Va la ÚLTIMA: si su nombre no casa (0 filas) el guard aborta SOLO este bloque, sin
-- bloquear Marbella/Ibiza (ya commiteadas arriba).
BEGIN;
\echo '=== VALENCIA · ANTES ==='
SELECT c.id, c.name, cp.manual_mode,
       (cp.address_lat IS NOT NULL) AS geocoded,
       cp.rates->'items' AS rates_items, cp.outcall
FROM casa c LEFT JOIN casa_profile cp ON cp.casa_id = c.id
WHERE c.name ILIKE '%valencia%' OR c.name ILIKE '%vlc%';

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM casa WHERE name ILIKE '%valencia%' OR name ILIKE '%vlc%';
  IF n = 0 OR n > 2 THEN
    RAISE EXCEPTION 'VALENCIA: esperaba 1-2 casas, encontre % — revisa el nombre (Maxxag VLC / Valencia) y reintenta', n;
  END IF;
END $$;

INSERT INTO casa_profile (casa_id, rates, outcall, manual_mode, updated_at)
SELECT c.id,
       jsonb_build_object('items', jsonb_build_array(
           jsonb_build_object('label_es','1 hora','label_en','1 hour','price','100€'),
           jsonb_build_object('label_es','45 min','label_en','45 min','price','80€'),
           jsonb_build_object('label_es','30 min','label_en','30 min','price','60€'),
           jsonb_build_object('label_es','Salida (hotel/domicilio)','label_en','Outcall','price','150€ + taxi')
       )),
       COALESCE(cp.outcall, '{}'::jsonb) || jsonb_build_object('base_price_eur', 150),
       true, now()
FROM casa c LEFT JOIN casa_profile cp ON cp.casa_id = c.id
WHERE c.name ILIKE '%valencia%' OR c.name ILIKE '%vlc%'
ON CONFLICT (casa_id) DO UPDATE SET
    rates       = EXCLUDED.rates,
    outcall     = EXCLUDED.outcall,
    manual_mode = true,
    updated_at  = now();

\echo '=== VALENCIA · DESPUES (debe verse 100/80/60/150 y manual_mode=t) ==='
SELECT c.id, c.name, cp.manual_mode, cp.rates->'items' AS rates_items, cp.outcall
FROM casa c JOIN casa_profile cp ON cp.casa_id = c.id
WHERE c.name ILIKE '%valencia%' OR c.name ILIKE '%vlc%';
COMMIT;
