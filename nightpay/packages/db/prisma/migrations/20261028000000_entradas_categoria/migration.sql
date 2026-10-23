-- Entradas en el cobro (2026-10-28): VENUE_ENTRY en payments.revenueCategory.
--
-- El mapa del dinero (20261023100000) trajo la sección «Entradas» y
-- payment_lines la admite, pero el CHECK de payments.revenueCategory seguía
-- con la lista de 20260514002000 (sin VENUE_ENTRY). El cobro guarda ahí su
-- sección con más importe (charge-lines.ts, primaryCategory): un cobro de
-- solo entradas, con más entradas que lo demás o el «Otro importe» de
-- recepción sin sección no se podía guardar (500 al cobrar), y el cobro único
-- tampoco se podía pagar con el NFC (empieza creando el cobro con tarjeta).
--
-- Aquí: el CHECK con todas las secciones (SECTION_CODES de
-- packages/contracts/src/sections.ts) y «Otros» (EXTRA: los cobros antiguos y
-- las recargas de saldo). Solo amplía la lista: toda fila que cumplía el de
-- antes cumple este. No cambia ningún dato.
--
-- check-drift no lo ve: Prisma no compara los CHECK (ni drift-allowlist.json
-- los nombra). Lo comprueba apps/api/test/integration/entradas-categoria.int.spec.ts
-- contra SECTION_CODES. pg_temp.np_check (20261015080000) no vale para
-- cambiar un CHECK: si ya hay uno con ese nombre, no lo toca.
--
-- Candados: un solo ALTER (quitar el viejo y poner el nuevo NOT VALID, sin
-- recorrer la tabla) y después la validación, que lee payments una vez con el
-- candado aún puesto (es la misma transacción): ~0,1 s con 300.000 cobros.
-- Si hubiera filas fuera de la lista (no debería: el CHECK de antes las
-- impedía), no falla el despliegue: queda NOT VALID (obliga a las filas
-- nuevas), sale un WARNING y db-heal lo avisa en cada arranque.
-- Idempotente: lanzada otra vez deja lo mismo.

-- Corre con el API anterior sirviendo (start-first): si una transacción suya
-- tiene la tabla, mejor fallar a los 5 s que dejar los cobros en cola detrás
-- de este ALTER. Si falla, no cambia nada (sigue el CHECK de antes): se marca
-- como deshecha y se vuelve a desplegar (docs/DOKPLOY-STEPS.md, D.8).
SET lock_timeout = '5s';

-- El recuento del WARNING tiene que ver todas las filas aunque la lance un rol
-- sin superusuario. Solo dura esta transacción.
SELECT set_config('app.bypass_rls', 'on', true);

DO $$
DECLARE
  bad bigint;
BEGIN
  ALTER TABLE "payments"
    DROP CONSTRAINT IF EXISTS "payments_revenue_category_valid",
    ADD CONSTRAINT "payments_revenue_category_valid"
      CHECK ("revenueCategory" IN ('CHICA_SERVICE', 'VENUE_BAR', 'VENUE_ROOM', 'VENUE_FOOD', 'VENUE_ENTRY', 'EXTRA')) NOT VALID;
  BEGIN
    ALTER TABLE "payments" VALIDATE CONSTRAINT "payments_revenue_category_valid";
  EXCEPTION WHEN check_violation THEN
    SELECT count(*) INTO bad
      FROM "payments"
     WHERE "revenueCategory" NOT IN ('CHICA_SERVICE', 'VENUE_BAR', 'VENUE_ROOM', 'VENUE_FOOD', 'VENUE_ENTRY', 'EXTRA');
    RAISE WARNING 'np: % cobro(s) con revenueCategory fuera de la lista: payments_revenue_category_valid queda NOT VALID (vale para los nuevos). Revísalos a mano.', bad;
  END;
END
$$;
