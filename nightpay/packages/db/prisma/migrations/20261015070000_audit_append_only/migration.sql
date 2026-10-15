-- audit_events es solo de añadir: hasta ahora lo decía un comentario. Con
-- este trigger, UPDATE, DELETE y TRUNCATE sobre la tabla fallan para el rol
-- de la aplicación, así que un fallo en el código (o alguien con acceso a la
-- app) no puede reescribir ni borrar el rastro de auditoría.
--
-- OJO: no protege de un superusuario ni del dueño de la tabla, que pueden
-- desactivarlo (ALTER TABLE audit_events DISABLE TRIGGER ...). Para eso la
-- app tiene que conectarse con un rol que no sea dueño ni superusuario.
--
-- Idempotente y sin tocar datos: se puede aplicar varias veces.

CREATE OR REPLACE FUNCTION audit_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_events es solo de añadir: % no permitido', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS audit_events_no_update_delete ON audit_events;
CREATE TRIGGER audit_events_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();

DROP TRIGGER IF EXISTS audit_events_no_truncate ON audit_events;
CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_append_only();

COMMENT ON FUNCTION audit_events_append_only() IS
  'audit_events es append-only (UPDATE/DELETE/TRUNCATE rechazados). Un superusuario o el dueño de la tabla puede desactivar los triggers.';
