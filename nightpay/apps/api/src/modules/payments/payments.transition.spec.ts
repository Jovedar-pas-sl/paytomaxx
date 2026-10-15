import { describe, it, expect, vi } from 'vitest';
import { PaymentsService, type LockedPaymentRow } from './payments.service';

/**
 * transition() con la base simulada: cada consulta cruda se responde según su
 * SQL. Comprueba qué se escribe (propina, comisión, saldo) sin Postgres.
 */

type Row = Record<string, unknown>;

const PAYMENT_ID = '11111111-2222-4333-8444-555555555555';

const baseRow: LockedPaymentRow = {
  id: PAYMENT_ID,
  tenantId: 'tenant-1',
  status: 'AUTHORIZING',
  amountCents: 10_000,
  availableAmountCents: 10_000,
  providerTxId: 'ORDER1',
  provider: 'REDSYS',
  createdByUserId: 'op-1',
  walletId: null,
  tipCents: 0,
  tipGoesTo: null,
  tipBeneficiaryUserId: null,
  revenueCategory: 'CHICA_SERVICE',
};

export interface FakeDb {
  locked: LockedPaymentRow;
  /** Propina del intento que aprobó el banco (null = no consta). */
  attemptTip?: number | null;
  creatorRole?: string;
  creatorBps?: number | null;
  /** Filas de client_wallets por id. */
  wallets?: Record<string, Row>;
  /** Códigos cortos ya usados por saldos ACTIVE. */
  takenCodes?: string[];
}

export function sqlOf(strings: unknown): string {
  return Array.isArray(strings) ? (strings as string[]).join('?') : String(strings);
}

export function makeTransitionService(db: FakeDb) {
  const executed: Array<{ sql: string; values: unknown[] }> = [];
  const queryRaw = vi.fn(async (strings: unknown, ...values: unknown[]) => {
    const sql = sqlOf(strings);
    if (sql.includes('FROM payments') && sql.includes('FOR UPDATE')) return [db.locked];
    if (sql.includes('FROM payment_attempts')) {
      return db.attemptTip === undefined ? [] : [{ tipCents: db.attemptTip, creatorRole: db.creatorRole ?? 'OPERATOR' }];
    }
    if (sql.includes('FROM users')) return [{ role: db.creatorRole ?? 'OPERATOR', commissionBps: db.creatorBps ?? null }];
    if (sql.includes('FROM venues')) return [{ operatorCommissionDefaults: null }];
    if (sql.includes('FROM client_wallets') && sql.includes('FOR UPDATE')) {
      const row = db.wallets?.[values[0] as string];
      return row ? [row] : [];
    }
    if (sql.includes('FROM client_wallets') && sql.includes('"shortCode"')) {
      return (db.takenCodes ?? []).includes(values[0] as string) ? [{ ok: 1 }] : [];
    }
    return [];
  });
  const executeRaw = vi.fn(async (strings: unknown, ...values: unknown[]) => {
    executed.push({ sql: sqlOf(strings), values });
    return 1;
  });
  const executeRawUnsafe = vi.fn(async () => 0);
  const tx = { $queryRaw: queryRaw, $executeRaw: executeRaw, $executeRawUnsafe: executeRawUnsafe };
  const prisma = {
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const metrics = {
    paymentsTransitioned: { inc: vi.fn() },
    walletCreditSkipped: { inc: vi.fn() },
  };
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const service = Object.create(PaymentsService.prototype) as PaymentsService;
  Object.assign(service, {
    prisma,
    cls: { get: () => ({ traceId: 'trace-1' }) },
    metrics,
    logger,
    realtime: { emitPaymentUpdate: vi.fn(), emitPaymentCompleted: vi.fn() },
  });
  const updates = (fragment: string) => executed.filter((e) => e.sql.includes(fragment));
  return { service, tx, executed, updates, metrics, logger, executeRawUnsafe };
}

const authorized = { type: 'AUTHORIZED' as const, provider: 'REDSYS' as const, providerTxId: 'ORDER1' };

describe('transition — como asSystem', () => {
  it('sin depender de un usuario de base superusuario: salta el RLS antes de leer el cobro', async () => {
    const { service, executeRawUnsafe, tx } = makeTransitionService({ locked: { ...baseRow } });
    await service.transition(PAYMENT_ID, authorized);
    expect(executeRawUnsafe).toHaveBeenCalledWith(`SET LOCAL app.bypass_rls = 'on'`);
    expect(executeRawUnsafe.mock.invocationCallOrder[0]!).toBeLessThan(tx.$queryRaw.mock.invocationCallOrder[0]!);
  });
});
