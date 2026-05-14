-- Bootstrap: marca el PRIMER OWNER existente como super admin si todavía
-- no hay ninguno marcado. Esto evita tener que entrar al Terminal de Dokploy
-- para ejecutar CLI — el deploy del Dockerfile aplica migraciones automático
-- y este UPDATE corre una vez.
--
-- Idempotente:
--   - Si ya existe un super admin: NO hace nada (NOT EXISTS guard).
--   - Si no hay OWNER: NO hace nada (subquery devuelve NULL → UPDATE 0 rows).
--   - Si hay varios OWNER: marca solo el más antiguo (createdAt ASC LIMIT 1).
--
-- Si en el futuro quieres degradar al super admin o cambiarlo, usa el CLI:
--   pnpm cli set-super-admin --email X@Y.Z [--revoke true]

UPDATE "users"
   SET "isSuperAdmin" = true
 WHERE id = (
   SELECT id FROM "users"
    WHERE role = 'OWNER'
      AND "deletedAt" IS NULL
    ORDER BY "createdAt" ASC
    LIMIT 1
 )
 AND NOT EXISTS (
   SELECT 1 FROM "users" WHERE "isSuperAdmin" = true
 );
