import { describe, it, expect, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { Prisma } from '@nightpay/db';
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
  /** Lo que lee el servicio antes de la transición (confirmar, cancelar). */
  payment?: Row | null;
  /** Otro cobro de este datáfono ya confirmado con el mismo código. */
  reusedAuthCode?: boolean;
}

function sqlOf(strings: unknown): string {
  return Array.isArray(strings) ? (strings as string[]).join('?') : String(strings);
}

function makeTransitionService(db: FakeDb) {
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
  const tx = {
    $queryRaw: queryRaw,
    $executeRaw: executeRaw,
    $executeRawUnsafe: executeRawUnsafe,
    payment: {
      findFirst: vi.fn(async () => (db.reusedAuthCode ? { id: 'other-payment' } : null)),
      update: vi.fn(async () => ({})),
    },
    paymentEvent: { create: vi.fn(async () => ({})) },
  };
  const prisma = {
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    payment: { findUnique: vi.fn(async () => db.payment ?? null) },
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

/** Valores del INSERT de la comisión: tenant, chica, cobro, importe, bps, comisión, propina. */
function earningInsert(executed: Array<{ sql: string; values: unknown[] }>) {
  return executed.find((e) => e.sql.includes('INSERT INTO operator_earnings'))?.values;
}

describe('transition — como asSystem', () => {
  it('sin depender de un usuario de base superusuario: salta el RLS antes de leer el cobro', async () => {
    const { service, executeRawUnsafe, tx } = makeTransitionService({ locked: { ...baseRow } });
    await service.transition(PAYMENT_ID, authorized);
    expect(executeRawUnsafe).toHaveBeenCalledWith(`SET LOCAL app.bypass_rls = 'on'`);
    expect(executeRawUnsafe.mock.invocationCallOrder[0]!).toBeLessThan(tx.$queryRaw.mock.invocationCallOrder[0]!);
  });
});

describe('transition — la propina es la que cobró el banco (#3)', () => {
  it('Redsys: la del intento aprobado pasa al cobro y a la chica', async () => {
    const { service, updates, executed } = makeTransitionService({ locked: { ...baseRow }, attemptTip: 500 });
    await service.transition(PAYMENT_ID, authorized);
    const tipUpdate = updates('SET "tipCents"')[0]!;
    expect(tipUpdate.values.slice(0, 3)).toEqual([500, 10_500, 'operator']);
    expect(earningInsert(executed)?.slice(-1)).toEqual([500]);
  });

  it('otra pasarela (solo cobra el importe): la propina que puso quien creó el cobro no cuenta', async () => {
    const locked = {
      ...baseRow,
      provider: 'PAYTEF' as const,
      tipCents: 3_000,
      availableAmountCents: 13_000,
      tipGoesTo: 'operator',
    };
    const { service, updates, executed } = makeTransitionService({ locked, attemptTip: null });
    await service.transition(PAYMENT_ID, { type: 'AUTHORIZED', provider: 'PAYTEF', providerTxId: 'ORDER1' });
    expect(updates('SET "tipCents"')[0]!.values.slice(0, 3)).toEqual([0, 10_000, null]);
    // Lo devolvible es solo el importe y la chica no se lleva propina.
    const statusUpdate = updates('SET status')[0]!;
    expect(statusUpdate.values[1]).toBe(10_000);
    expect(earningInsert(executed)?.slice(-1)).toEqual([0]);
  });

  it('Redsys sin intento que lo diga: sin propina', async () => {
    const locked = { ...baseRow, tipCents: 2_000, availableAmountCents: 12_000, tipGoesTo: 'operator' };
    const { service, updates, executed } = makeTransitionService({ locked });
    await service.transition(PAYMENT_ID, authorized);
    expect(updates('SET "tipCents"')[0]!.values.slice(0, 3)).toEqual([0, 10_000, null]);
    expect(earningInsert(executed)?.slice(-1)).toEqual([0]);
  });

  it('sin propina en ningún lado: no reescribe nada', async () => {
    const { service, updates } = makeTransitionService({ locked: { ...baseRow }, attemptTip: 0 });
    await service.transition(PAYMENT_ID, authorized);
    expect(updates('SET "tipCents"')).toHaveLength(0);
  });
});

describe('confirmPosPayment — el camarero confirma el cobro del datáfono (#13)', () => {
  const posRow = {
    id: PAYMENT_ID,
    tenantId: 'tenant-1',
    terminalId: 'term-1',
    captureMethod: 'POS_EXTERNAL',
    status: 'CREATED',
    createdByUserId: 'op-1',
  };
  const waiter = { userId: 'waiter-1', role: 'WAITER', tenantId: 'tenant-1' };
  const locked = {
    ...baseRow,
    status: 'CREATED' as const,
    provider: null,
    providerTxId: null,
    tipCents: 3_000,
    availableAmountCents: 13_000,
    tipGoesTo: 'operator',
  };

  it('código, prueba y pagado en la misma transacción; sin propina (nadie la confirmó)', async () => {
    const { service, tx, updates, executed } = makeTransitionService({ locked, payment: posRow });
    await expect(
      service.confirmPosPayment(PAYMENT_ID, waiter, { posReceiptRef: 'ab12 cd', notes: 'mesa 3' }),
    ).resolves.toEqual({ status: 'AUTHORIZED' });

    // Candado por datáfono + código antes de comprobar si ya se usó.
    const lockCall = tx.$queryRaw.mock.calls.find((c) => sqlOf(c[0]).includes('pg_advisory_xact_lock'))!;
    expect(lockCall[1]).toBe('pos-auth:term-1:AB12CD');
    expect(tx.payment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { not: PAYMENT_ID }, terminalId: 'term-1', authCode: 'AB12CD' }),
      }),
    );
    expect(tx.payment.update).toHaveBeenCalledWith({
      where: { id: PAYMENT_ID },
      data: expect.objectContaining({ authCode: 'AB12CD', tipCents: 0, availableAmountCents: 10_000, tipGoesTo: null }),
    });
    expect(tx.paymentEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: 'pos.confirmed',
          payload: expect.objectContaining({ confirmedByUserId: 'waiter-1', notes: 'mesa 3' }),
        }),
      }),
    );
    // Lo devolvible es solo el importe y la chica no se lleva la propina inventada.
    expect(updates('SET status')[0]!.values[1]).toBe(10_000);
    expect(earningInsert(executed)?.slice(-1)).toEqual([0]);
  });

  it('código ya usado en otro cobro de este datáfono → 409 y no se marca pagado', async () => {
    const { service, tx, updates } = makeTransitionService({ locked, payment: posRow, reusedAuthCode: true });
    await expect(service.confirmPosPayment(PAYMENT_ID, waiter, { posReceiptRef: 'AB12CD' })).rejects.toThrow(
      /ya se usó en otro cobro/,
    );
    expect(tx.payment.update).not.toHaveBeenCalled();
    expect(updates('SET status')).toHaveLength(0);
  });

  it('dos confirmaciones cruzadas: el índice único de la base → el mismo 409', async () => {
    const { service, tx } = makeTransitionService({ locked, payment: posRow });
    tx.payment.update.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' }),
    );
    await expect(service.confirmPosPayment(PAYMENT_ID, waiter, { posReceiptRef: 'AB12CD' })).rejects.toThrow(
      ConflictException,
    );
  });

  it('ya no está pendiente (lo cambió otro) → 409', async () => {
    const { service } = makeTransitionService({
      locked: { ...locked, status: 'CANCELED' as const },
      payment: posRow,
    });
    await expect(service.confirmPosPayment(PAYMENT_ID, waiter, { posReceiptRef: 'AB12CD' })).rejects.toThrow(
      /cannot be confirmed/,
    );
  });
});

describe('transition — recarga de saldo cobrada (#7, #56)', () => {
  const WALLET = '22222222-3333-4444-8555-666666666666';
  const TARGET = '33333333-4444-4555-8666-777777777777';
  const topUp = { ...baseRow, walletId: WALLET, revenueCategory: 'EXTRA', amountCents: 5_000, availableAmountCents: 5_000 };
  const w = (o: Row = {}) => ({
    id: WALLET,
    tenantId: 'tenant-1',
    walletGroup: 'grupo',
    balanceCents: 0,
    status: 'ACTIVE',
    mergedIntoId: null,
    shortCode: 'K7Q4M2',
    ...o,
  });
  const credits = (executed: Array<{ sql: string; values: unknown[] }>) =>
    executed.filter((e) => e.sql.includes('UPDATE client_wallets'));
  const audits = (executed: Array<{ sql: string; values: unknown[] }>) =>
    executed.filter((e) => e.sql.includes('INSERT INTO audit_events'));

  it('saldo activo → se suma ahí', async () => {
    const { service, executed } = makeTransitionService({ locked: topUp, attemptTip: 0, wallets: { [WALLET]: w() } });
    await service.transition(PAYMENT_ID, authorized);
    const c = credits(executed);
    expect(c).toHaveLength(1);
    expect(c[0]!.values).toEqual([5_000, 'K7Q4M2', WALLET]);
    expect(audits(executed)).toHaveLength(0);
  });

  it('saldo ya sumado a otro (Face ID) → al saldo bueno, con constancia', async () => {
    const { service, executed } = makeTransitionService({
      locked: topUp,
      attemptTip: 0,
      wallets: {
        [WALLET]: w({ status: 'DEPLETED', mergedIntoId: TARGET }),
        [TARGET]: w({ id: TARGET, tenantId: 'tenant-2', balanceCents: 4_000, shortCode: 'AAA222' }),
      },
    });
    await service.transition(PAYMENT_ID, authorized);
    expect(credits(executed)[0]!.values).toEqual([5_000, 'AAA222', TARGET]);
    const audit = audits(executed)[0]!;
    expect(audit.sql).toContain('wallet.credit_followed_merge');
    expect(JSON.parse(audit.values[2] as string)).toEqual({ from: WALLET, to: TARGET, amountCents: 5_000 });
  });

  it('saldo a cero cuyo código cogió otro saldo activo → se reactiva con código nuevo', async () => {
    const { service, executed } = makeTransitionService({
      locked: topUp,
      attemptTip: 0,
      wallets: { [WALLET]: w({ status: 'DEPLETED' }) },
      takenCodes: ['K7Q4M2'],
    });
    await service.transition(PAYMENT_ID, authorized);
    const code = credits(executed)[0]!.values[1] as string;
    expect(code).toMatch(/^[A-Z0-9]{6}$/);
    expect(code).not.toBe('K7Q4M2');
  });

  it('saldo devuelto → no se suma; incidencia con importe, cobro y qué hacer', async () => {
    const { service, executed, metrics } = makeTransitionService({
      locked: topUp,
      attemptTip: 0,
      wallets: { [WALLET]: w({ status: 'REFUNDED' }) },
    });
    await service.transition(PAYMENT_ID, authorized);
    expect(credits(executed)).toHaveLength(0);
    expect(metrics.walletCreditSkipped.inc).toHaveBeenCalledWith({ venue: 'tenant-1', wallet_status: 'REFUNDED' });
    const audit = audits(executed)[0]!;
    expect(audit.sql).toContain('wallet.credit_skipped_critical');
    expect(JSON.parse(audit.values[2] as string)).toMatchObject({
      walletId: WALLET,
      walletStatus: 'REFUNDED',
      amountCents: 5_000,
      paymentId: PAYMENT_ID,
      cause: 'closed',
      action: 'Devolver la recarga en el banco o reactivar el saldo y sumarle el importe',
      detail: expect.stringContaining('Recarga de 50,00 € cobrada'),
    });
  });
});

describe('transition — comisión con el % fijado al crear (#54)', () => {
  it('el dueño cambió el % mientras el cliente pagaba → cuenta el del momento de crear', async () => {
    const { service, executed } = makeTransitionService({
      locked: { ...baseRow, operatorCommissionBps: 5_000 },
      attemptTip: 0,
      creatorBps: 9_000,
    });
    await service.transition(PAYMENT_ID, authorized);
    // tenant, chica, cobro, importe, bps, comisión, propina
    expect(earningInsert(executed)?.slice(3)).toEqual([10_000, 5_000, 5_000, 0]);
  });

  it('cobro de antes (sin % guardado) → el de ahora, como siempre', async () => {
    const { service, executed } = makeTransitionService({
      locked: { ...baseRow, operatorCommissionBps: null },
      attemptTip: 0,
      creatorBps: 8_000,
    });
    await service.transition(PAYMENT_ID, authorized);
    expect(earningInsert(executed)?.slice(3)).toEqual([10_000, 8_000, 8_000, 0]);
  });
});
