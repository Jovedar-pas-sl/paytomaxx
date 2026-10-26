// Integración (Postgres real, np_app): los índices de los informes y del
// barrido de cobros caducados (migración 20261029400000_indices_informes).
//
// Dos son de SQL (expresión y parcial): schema.prisma no puede describirlos y
// check-drift no los compara, así que si una migración los quitara, o si una
// consulta dejara de escribir la expresión igual que el índice (otro COALESCE,
// un cast), nada avisaría: el Z volvería a recorrer todo el historial del
// local. Aquí: que existen y que el planificador los puede usar con las
// consultas tal como las escribe el código (reporting-sql.ts paymentAt).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { Prisma } from '@nightpay/db';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { PAID_STATUSES_SQL, paymentAt } from '../../src/modules/reports/reporting-sql';

const prisma = new PrismaService(new ClsService(new AsyncLocalStorage()) as never);

/**
 * Un local con historial (3.000 cobros en 300 días, 4 eventos cada uno): con
 * la base casi vacía de las pruebas el planificador no distingue un índice de
 * otro. Se borra al terminar.
 */
const VENUE = randomUUID();

beforeAll(async () => {
  await prisma.asSystem(async (tx) => {
    await tx.$executeRaw`INSERT INTO venues (id, name, slug, "updatedAt") VALUES (${VENUE}::uuid, 'Índices', ${`indices-${VENUE}`}, now())`;
    const terminal = randomUUID();
    await tx.$executeRaw`INSERT INTO terminals (id, "tenantId", "externalId", label) VALUES (${terminal}::uuid, ${VENUE}::uuid, 'BARRA', 'Barra')`;
    await tx.$executeRaw`
      INSERT INTO payments (id, "tenantId", "terminalId", "idempotencyKey", "amountCents", "availableAmountCents",
                            "qrToken", "qrExpiresAt", "updatedAt", status, "createdAt", "authorizedAt")
      SELECT gen_random_uuid(), ${VENUE}::uuid, ${terminal}::uuid, 'idx-' || g, 1000, 1000, ${VENUE} || '-' || g,
             ts + interval '5 minutes', ts, (CASE WHEN g % 10 < 8 THEN 'AUTHORIZED' ELSE 'EXPIRED' END)::"PaymentStatus",
             ts, CASE WHEN g % 10 < 8 THEN ts + interval '40 seconds' END
        FROM generate_series(1, 3000) g, LATERAL (SELECT now() - interval '300 days' * (g::float / 3000) AS ts) x`;
    await tx.$executeRaw`
      INSERT INTO payment_events ("paymentId", "tenantId", "eventType", payload, "traceId", "occurredAt")
      SELECT p.id, p."tenantId", e.t, '{}'::jsonb, 'idx', p."createdAt"
        FROM payments p, (VALUES ('payment.created'), ('payment.authorizing'), ('payment.authorized'), ('payment.qr_viewed')) e(t)
       WHERE p."tenantId" = ${VENUE}::uuid`;
  });
  await prisma.$executeRawUnsafe('ANALYZE payments');
  await prisma.$executeRawUnsafe('ANALYZE payment_events');
}, 60_000);

afterAll(async () => {
  await prisma.asSystem(async (tx) => {
    await tx.$executeRaw`DELETE FROM payment_events WHERE "tenantId" = ${VENUE}::uuid`;
    await tx.$executeRaw`DELETE FROM payments WHERE "tenantId" = ${VENUE}::uuid`;
    await tx.$executeRaw`DELETE FROM terminals WHERE "tenantId" = ${VENUE}::uuid`;
    await tx.$executeRaw`DELETE FROM venues WHERE id = ${VENUE}::uuid`;
  });
  await prisma.$disconnect();
});

/** El plan de una consulta, sin escaneo secuencial: ¿qué índice elige? */
async function planOf(query: Prisma.Sql): Promise<string> {
  const rows = await prisma.asSystem(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
    return tx.$queryRaw<Array<{ 'QUERY PLAN': string }>>`EXPLAIN ${query}`;
  });
  return rows.map((r) => r['QUERY PLAN']).join('\n');
}

describe('índices de los informes (20261029400000)', () => {
  it('existen los cuatro', async () => {
    const rows = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname IN ('payments_tenant_paid_at_idx', 'payments_open_qr_expires_idx',
                           'wallet_consumptions_tenantId_createdAt_idx', 'payment_events_tenantId_eventType_occurredAt_idx')`;
    expect(rows.map((r) => r.indexname).sort()).toEqual([
      'payment_events_tenantId_eventType_occurredAt_idx',
      'payments_open_qr_expires_idx',
      'payments_tenant_paid_at_idx',
      'wallet_consumptions_tenantId_createdAt_idx',
    ]);
  });

  it('el «momento del cobro» de los informes (paymentAt) usa el índice de expresión', async () => {
    // Una noche de hace 100 días.
    const from = new Date(Date.now() - 100 * 86_400_000);
    const to = new Date(from.getTime() + 12 * 3_600_000);
    const plan = await planOf(Prisma.sql`
      SELECT p.status, COUNT(*) FROM payments p
       WHERE p."tenantId" = ${VENUE}::uuid
         AND ${paymentAt('p')} >= ${from} AND ${paymentAt('p')} < ${to}
       GROUP BY p.status`);
    expect(plan).toContain('payments_tenant_paid_at_idx');
    const paid = await planOf(Prisma.sql`
      SELECT p.id FROM payments p
       WHERE p."tenantId" = ${VENUE}::uuid
         AND p.status IN ${PAID_STATUSES_SQL}
         AND ${paymentAt('p')} >= ${from} AND ${paymentAt('p')} < ${to}`);
    expect(paid).toContain('payments_tenant_paid_at_idx');
  });

  it('el barrido de cobros caducados usa el índice parcial de los abiertos', async () => {
    const plan = await planOf(Prisma.sql`
      SELECT id FROM payments
       WHERE status IN ('CREATED', 'AWAITING_CAPTURE') AND "qrExpiresAt" < ${new Date()}
       ORDER BY "qrExpiresAt" ASC LIMIT 200`);
    expect(plan).toContain('payments_open_qr_expires_idx');
  });

  it('la bandeja de incidencias busca los eventos por tipo con su índice', async () => {
    const plan = await planOf(Prisma.sql`
      SELECT e.id FROM payment_events e
       WHERE e."tenantId" = ${VENUE}::uuid AND e."eventType" = 'payment.duplicate_charge'
         AND e."occurredAt" >= ${new Date(Date.now() - 60 * 86_400_000)}
       ORDER BY e."occurredAt" DESC LIMIT 100`);
    expect(plan).toContain('payment_events_tenantId_eventType_occurredAt_idx');
  });
});
