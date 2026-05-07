-- Sprint 2 hotfix: quitamos FORCE ROW LEVEL SECURITY porque la app corre como
-- table owner `np`. FORCE haria que la app tenga que setear el GUC
-- `app.current_tenant_id` en CADA query (complejo con pool de conexiones).
--
-- Decision: RLS queda ENABLED (para cuando anadamos rol DB separado en Sprint 6),
-- pero NO FORCED → el owner bypassea las policies y el aislamiento real lo hace
-- el middleware Prisma app-layer (defensa tipo 1 de ADR-002).
--
-- TODO Sprint 6: crear rol `nightpay_app` sin ownership, conectar la app con
-- ese rol, reactivar FORCE y setear GUC por request via interceptor NestJS.

ALTER TABLE users NO FORCE ROW LEVEL SECURITY;
ALTER TABLE terminals NO FORCE ROW LEVEL SECURITY;
ALTER TABLE gateway_credentials NO FORCE ROW LEVEL SECURITY;
ALTER TABLE payments NO FORCE ROW LEVEL SECURITY;
ALTER TABLE payment_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE refunds NO FORCE ROW LEVEL SECURITY;
ALTER TABLE reconciliations NO FORCE ROW LEVEL SECURITY;
