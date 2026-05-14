-- Bootstrap: activa gateway_credentials PAYTEF para luna-vlc (venue de
-- pruebas inicial). El adapter Paytef requiere una fila con
-- (tenantId, provider='PAYTEF', active=true) para que el routing funcione.
--
-- Las credenciales reales (PAYTEF_API_TOKEN, etc.) están en env vars, no
-- en esta tabla — encKey/encNonce/encTag son dummy bytes para satisfacer
-- los NOT NULL del schema (estos 3 campos solo se usan si el adapter
-- almacenase claves por-venue, lo cual no hacemos para Paytef Payment LINK).
--
-- El UNIQUE en (tenantId, provider, active) significa que pueden existir
-- 2 filas: una active=true y otra active=false. Por eso primero limpiamos
-- las inactivas del par y luego upserteamos la activa.

DO $$
DECLARE
  v_tenant_id UUID;
  v_paytef_exists BOOLEAN;
BEGIN
  SELECT id INTO v_tenant_id FROM venues WHERE slug = 'luna-vlc' LIMIT 1;
  IF v_tenant_id IS NULL THEN
    RAISE NOTICE 'luna-vlc venue not found — skipping Paytef activation';
    RETURN;
  END IF;

  -- ¿Ya hay una fila active=true de PAYTEF para este tenant?
  SELECT EXISTS (
    SELECT 1 FROM gateway_credentials
     WHERE "tenantId" = v_tenant_id
       AND provider = 'PAYTEF'
       AND active = true
  ) INTO v_paytef_exists;

  IF NOT v_paytef_exists THEN
    -- Borrar cualquier inactiva primero (evita conflicto unique al activar).
    DELETE FROM gateway_credentials
     WHERE "tenantId" = v_tenant_id
       AND provider = 'PAYTEF';

    INSERT INTO gateway_credentials (
      id, "tenantId", provider, active,
      "encKey", "encNonce", "encTag", "kekVersion",
      "createdAt"
    ) VALUES (
      gen_random_uuid(),
      v_tenant_id,
      'PAYTEF',
      true,
      '\x00'::bytea,
      '\x00'::bytea,
      '\x00'::bytea,
      1,
      now()
    );

    RAISE NOTICE 'PAYTEF activated for luna-vlc (tenantId=%)', v_tenant_id;
  ELSE
    RAISE NOTICE 'PAYTEF already active for luna-vlc — no-op';
  END IF;

  -- Desactivar otros providers del mismo venue (Wipay, Peanpe) para que
  -- el routing prefiera Paytef. Idempotente.
  UPDATE gateway_credentials
     SET active = false
   WHERE "tenantId" = v_tenant_id
     AND provider <> 'PAYTEF'
     AND active = true;
END $$;
