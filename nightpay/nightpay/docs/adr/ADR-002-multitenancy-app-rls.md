# ADR-002: Multi-tenancy app-layer + Postgres RLS (defensa en profundidad)

**Estado**: Accepted
**Fecha**: 2026-04-21
**Deciders**: Equipo de ingeniería NightPay
**Relacionado**: §4 del Master Plan V2

## Contexto

NightPay es SaaS multi-tenant: muchos venues comparten una misma instancia de aplicación y una misma base de datos. Cada registro (`payments`, `users`, `refunds`, …) lleva un `tenant_id`.

Un bug de aislamiento → una discoteca ve pagos de otra → **incidente reputacional terminal**. Las consecuencias legales también son severas. Por tanto el aislamiento debe ser **imposible de romper por un bug aislado**.

Opciones existentes:
- **Schema-per-tenant** (N esquemas PG): buen aislamiento pero migraciones exponenciales y sin cross-tenant analytics.
- **DB-per-tenant**: aún peor para la operación; imposible con <€30/mes.
- **Shared schema + `tenant_id` filtrado en código**: común pero frágil — un `where` olvidado = leak.
- **Shared schema + Postgres Row-Level Security (RLS)**: garantía a nivel DB incluso si la app tiene bugs.

## Decisión

Aplicar **tres capas de aislamiento**, cada una independiente:

### L1 — Aplicación (JWT + Guards)
El `tenant_id` va firmado en el JWT del usuario. Un `@TenantGuard` lo extrae y lo mete en `AsyncLocalStorage`. Controllers declarativos:

```typescript
@UseGuards(AuthGuard, TenantGuard) @Roles('manager')
async listPayments(@Tenant() tenantId: string) { /* ... */ }
```

### L2 — Prisma middleware
Intercepta toda query Prisma. Si no hay `tenantId` en `where` → inyecta desde `AsyncLocalStorage`. Si el contexto está vacío → throw (dev) / log WARN + reject (prod).

```typescript
prisma.$use(async (params, next) => {
  const ctx = als.getStore();
  if (requiresTenant(params.model) && !params.args?.where?.tenantId) {
    if (!ctx?.tenantId) throw new Error('Missing tenant context');
    params.args.where = { ...params.args.where, tenantId: ctx.tenantId };
  }
  return next(params);
});
```

### L3 — Postgres RLS (defensa final)
Cada tabla con `tenant_id` tiene RLS activo + policy que filtra por `current_setting('app.current_tenant_id')`. El backend setea este GUC al inicio de cada transacción:

```sql
SET LOCAL app.current_tenant_id = '<uuid>';
```

Policy ejemplo:
```sql
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payments
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
```

Aunque L1 y L2 tengan bug y se emita `SELECT * FROM payments`, Postgres devolverá solo filas del tenant actual.

## Alternativas consideradas

### A1. Solo app-layer (sin RLS)
- **Pro**: Menos ceremonia, queries más flexibles.
- **Contra**: Un `WHERE` olvidado = leak. Un admin con bug podría ver todo. Error humano en SQL ad-hoc = riesgo.
- **Rechazado**: La seguridad no puede depender de "no olvidarse".

### A2. Solo RLS (sin app-layer)
- **Pro**: Garantía máxima a nivel DB.
- **Contra**: Setear GUC por transacción es fácil de olvidar en paths no-HTTP (jobs, CLI). Menos self-documenting.
- **Rechazado**: Mejor cinturón y tirantes.

### A3. Schema-per-tenant
- **Pro**: Aislamiento total.
- **Contra**: Migraciones × N esquemas; cross-tenant analytics complicado; operación pesa.
- **Rechazado**: Overhead desproporcionado para escala objetivo (<100 venues año 1).

## Consecuencias

### Positivas
- **Triple red de seguridad**: un bug aislado no basta para leak.
- **RLS se documenta solo**: el policy es la verdad; no depende de convenciones de código.
- **Postgres performance**: RLS bien indexado tiene overhead mínimo (<5% en queries con índice en `tenant_id`).
- **Admin queries seguras**: incluso un `psql` manual ejecutado por ingeniero devuelve solo el tenant set.

### Negativas
- **Complejidad de test**: necesitamos tests E2E cross-tenant específicos.
- **Overhead en migraciones**: cada nueva tabla con `tenant_id` requiere habilitar RLS + crear policy. Mitigación: macro en migración Prisma raw SQL.
- **Connection pooling**: con PgBouncer en modo transaction, `SET LOCAL` funciona. En modo session o con PgBouncer statement, no. Decidimos usar `transaction` pooling con pgbouncer.

### Neutras
- Owner role que ve múltiples venues requiere mecanismo de "cambio de tenant": endpoint `POST /v1/auth/switch-tenant` que emite JWT con nuevo `tenant_id`. No RLS bypass — se setea nuevo tenant válido.

## Criterios de verificación

- [ ] Las 8 tablas con `tenant_id` tienen RLS habilitado (`SELECT relrowsecurity FROM pg_class` en test)
- [ ] Policy `tenant_isolation` existe en todas las tablas sensibles
- [ ] Test E2E: manager de venue A hace `GET /v1/payments/<id_de_B>` → 404
- [ ] Test integración: JWT manipulado con `tenant_id` alterado → RLS bloquea
- [ ] Test: Prisma middleware detecta query sin `tenantId` y rechaza en staging/prod
- [ ] Benchmark: queries con RLS overhead <5% vs sin RLS

## Revisión

Revisar si:
- Venue count > 1000 y analytics cross-tenant se vuelve bottleneck (considerar warehouse dedicado)
- PgBouncer cambia a modo statement por razones de perf (romper este ADR)
- Detectamos que admin multi-venue tiene fricción UX notable
