-- AuditEvent: append-only log de acciones sensibles.
-- No FK a users/venues — el log debe sobrevivir borrados.

CREATE TABLE "audit_events" (
  "id"          BIGSERIAL    PRIMARY KEY,
  "tenantId"    UUID,
  "actorId"     UUID,
  "actorEmail"  TEXT,
  "action"      TEXT         NOT NULL,
  "targetType"  TEXT,
  "targetId"    TEXT,
  "payload"     JSONB,
  "ip"          TEXT,
  "userAgent"   TEXT,
  "traceId"     TEXT,
  "occurredAt"  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX "audit_events_tenantId_occurredAt_idx"
  ON "audit_events"("tenantId", "occurredAt" DESC);
CREATE INDEX "audit_events_actorId_occurredAt_idx"
  ON "audit_events"("actorId", "occurredAt" DESC);
CREATE INDEX "audit_events_action_occurredAt_idx"
  ON "audit_events"("action", "occurredAt" DESC);
CREATE INDEX "audit_events_traceId_idx" ON "audit_events"("traceId");

-- No habilitar RLS — owner puede ver todo cross-tenant para investigaciones.
-- En su lugar: el AuditService valida role OWNER antes de exponer queries cross-tenant.
COMMENT ON TABLE "audit_events" IS 'Append-only audit log. No DELETE/UPDATE permitido a nivel app.';
