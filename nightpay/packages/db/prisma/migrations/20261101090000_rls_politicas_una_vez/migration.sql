-- Políticas de RLS más rápidas (2026-10-29), para cuando el API entre con
-- `oxiopay_app` (sin superusuario, docs/DB-ROLE.md):
--
-- Las políticas comparan con app_current_tenant() y app_rls_bypass(), dos
-- funciones plpgsql STABLE. Escritas tal cual, Postgres las vuelve a llamar en
-- CADA fila que lee: medido con 2 millones de filas de prueba, los informes
-- largos iban de 6 a 15 veces más lentos con RLS (el del año, de 0,09 s a 1 s).
-- Envueltas en un SELECT, Postgres las calcula UNA vez por consulta (InitPlan)
-- y el resultado es el mismo: qué filas ve cada local no cambia.
--
-- Recorre todas las políticas del esquema y envuelve las dos funciones en su
-- USING y su WITH CHECK. Se puede repetir: la ya envuelta no se toca. Hoy
-- producción entra como superusuario (RLS no se aplica), así que no cambia
-- nada de lo que se ve; solo deja listo el cambio de rol.
--
-- ALTER POLICY bloquea un momento cada tabla: si choca con el lock_timeout
-- (otra transacción con la tabla), se relanza el despliegue.

SET lock_timeout = '5s';

DO $$
DECLARE
  p record;
  using_expr text;
  check_expr text;
  sql text;
BEGIN
  FOR p IN
    SELECT schemaname, tablename, policyname, qual, with_check
      FROM pg_policies
     WHERE schemaname = 'public'
       AND (qual ~ 'app_(current_tenant|rls_bypass)\(\)' OR with_check ~ 'app_(current_tenant|rls_bypass)\(\)')
  LOOP
    using_expr := p.qual;
    check_expr := p.with_check;
    IF using_expr IS NOT NULL AND using_expr !~ 'SELECT (public\.)?app_' THEN
      using_expr := regexp_replace(using_expr, '(public\.)?app_current_tenant\(\)', '(SELECT public.app_current_tenant())', 'g');
      using_expr := regexp_replace(using_expr, '(public\.)?app_rls_bypass\(\)', '(SELECT public.app_rls_bypass())', 'g');
    END IF;
    IF check_expr IS NOT NULL AND check_expr !~ 'SELECT (public\.)?app_' THEN
      check_expr := regexp_replace(check_expr, '(public\.)?app_current_tenant\(\)', '(SELECT public.app_current_tenant())', 'g');
      check_expr := regexp_replace(check_expr, '(public\.)?app_rls_bypass\(\)', '(SELECT public.app_rls_bypass())', 'g');
    END IF;
    IF using_expr IS NOT DISTINCT FROM p.qual AND check_expr IS NOT DISTINCT FROM p.with_check THEN
      CONTINUE;
    END IF;
    sql := format('ALTER POLICY %I ON %I.%I', p.policyname, p.schemaname, p.tablename);
    IF using_expr IS NOT NULL THEN
      sql := sql || format(' USING (%s)', using_expr);
    END IF;
    IF check_expr IS NOT NULL THEN
      sql := sql || format(' WITH CHECK (%s)', check_expr);
    END IF;
    EXECUTE sql;
  END LOOP;
END
$$;
