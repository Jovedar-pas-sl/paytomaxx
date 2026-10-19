import { describe, it, expect, vi } from 'vitest';
import type { Job } from 'bullmq';
import { OrphanReconcileProcessor, ordersToReconcile } from './orphan-reconcile.processor';
import { InvalidTransitionError } from '../payments/payment.machine';

const PAYMENT_ID = '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b';
const TENANT_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

interface Options {
  status?: string;
  provider?: string | null;
  providerTxId?: string | null;
  /** Intentos del más reciente al más antiguo (como los devuelve la consulta). */
  attempts?: Array<{ providerTxId: string; status: string }>;
  /** Estado de cada pedido en la pasarela (o un Error si la consulta falla). */
  gateway?: Record<string, string | Error>;
  attemptsMade?: number;
  maxAttempts?: number;
  duplicateAlreadyRecorded?: boolean;
  /** Pedidos cuyo aviso se rechazó por importe distinto (payment.amount_mismatch). */
  amountMismatch?: string[];
}

function makeProcessor(o: Options = {}) {
  const tx = {
    paymentAttempt: {
      findMany: vi.fn().mockResolvedValue(o.attempts ?? []),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    paymentEvent: {
      count: vi.fn().mockResolvedValue(o.duplicateAlreadyRecorded ? 1 : 0),
      create: vi.fn().mockResolvedValue({}),
      findMany: vi
        .fn()
        .mockResolvedValue([
          ...(o.amountMismatch ?? []).map((order) => ({ payload: { provider: 'REDSYS', providerTxId: order, chargedCents: 1 } })),
          { payload: null },
        ]),
    },
  };
  const prisma = { asSystem: vi.fn().mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const payments = {
    findById: vi.fn().mockResolvedValue({
      id: PAYMENT_ID,
      tenantId: TENANT_ID,
      status: o.status ?? 'AUTHORIZING',
      provider: o.provider === undefined ? 'REDSYS' : o.provider,
      providerTxId: o.providerTxId === undefined ? '2222NEWORDER' : o.providerTxId,
    }),
    transition: vi.fn().mockResolvedValue(undefined),
  };
  const adapter = {
    provider: o.provider ?? 'REDSYS',
    getStatus: vi.fn().mockImplementation(async (_t: string, order: string) => {
      const s = o.gateway?.[order] ?? 'UNKNOWN';
      if (s instanceof Error) throw s;
      return s;
    }),
  };
  const gateways = { get: vi.fn().mockReturnValue(adapter) };
  const processor = new OrphanReconcileProcessor(prisma as any, payments as any, gateways as any);
  const job = {
    data: { paymentId: PAYMENT_ID, tenantId: TENANT_ID },
    attemptsMade: o.attemptsMade ?? 0,
    opts: { attempts: o.maxAttempts ?? 5 },
  } as unknown as Job<{ paymentId: string; tenantId: string }>;
  return { processor, payments, adapter, tx, job };
}

describe('ordersToReconcile', () => {
  it('todos los intentos: primero los no denegados (más reciente antes), luego los denegados', () => {
    expect(
      ordersToReconcile(
        [
          { providerTxId: 'C', status: 'DENIED' },
          { providerTxId: 'B', status: 'PENDING' },
          { providerTxId: 'A', status: 'APPROVED' },
        ],
        'C',
      ),
    ).toEqual(['B', 'A', 'C']);
  });

  it('sin intentos (cobro antiguo) → el pedido del cobro; sin nada → vacío', () => {
    expect(ordersToReconcile([], 'OLD1')).toEqual(['OLD1']);
    expect(ordersToReconcile([], null)).toEqual([]);
  });
});

describe('OrphanReconcileProcessor — cada intento cuenta (#6)', () => {
  it('intento 1 aprobado (aviso perdido) + intento 2 denegado → AUTHORIZED con el pedido 1 (su propina)', async () => {
    const m = makeProcessor({
      attempts: [
        { providerTxId: '2222NEWORDER', status: 'DENIED' },
        { providerTxId: '1111OLDORDER', status: 'PENDING' },
      ],
      gateway: { '1111OLDORDER': 'AUTHORIZED', '2222NEWORDER': 'FAILED' },
    });
    await m.processor.process(m.job);
    expect(m.adapter.getStatus.mock.calls.map((c) => c[1])).toEqual(['1111OLDORDER', '2222NEWORDER']);
    expect(m.tx.paymentAttempt.updateMany).toHaveBeenCalledWith({
      where: {
        paymentId: PAYMENT_ID,
        provider: 'REDSYS',
        providerTxId: { in: ['1111OLDORDER'] },
        status: { not: 'APPROVED' },
      },
      data: { status: 'APPROVED' },
    });
    expect(m.payments.transition).toHaveBeenCalledWith(PAYMENT_ID, {
      type: 'AUTHORIZED',
      provider: 'REDSYS',
      providerTxId: '1111OLDORDER',
    });
  });

  it('un intento denegado que luego se pagó (mismo pedido) también se encuentra', async () => {
    const m = makeProcessor({
      attempts: [{ providerTxId: '1111OLDORDER', status: 'DENIED' }],
      gateway: { '1111OLDORDER': 'AUTHORIZED' },
    });
    await m.processor.process(m.job);
    expect(m.payments.transition).toHaveBeenCalledWith(PAYMENT_ID, expect.objectContaining({ providerTxId: '1111OLDORDER' }));
  });

  it('Redsys dice denegado en todo → NUNCA FAILED: se reintenta mientras queden intentos', async () => {
    const m = makeProcessor({
      attempts: [{ providerTxId: '2222NEWORDER', status: 'PENDING' }],
      gateway: { '2222NEWORDER': 'FAILED' },
      attemptsMade: 1,
    });
    await expect(m.processor.process(m.job)).rejects.toThrow('still-pending');
    expect(m.payments.transition).not.toHaveBeenCalled();
  });

  it('reintentos agotados sin aprobación → TIMEOUT (ORPHAN, a mano), no FAILED', async () => {
    const m = makeProcessor({
      attempts: [{ providerTxId: '2222NEWORDER', status: 'PENDING' }],
      gateway: { '2222NEWORDER': 'FAILED' },
      attemptsMade: 4,
      maxAttempts: 5,
    });
    await m.processor.process(m.job);
    expect(m.payments.transition).toHaveBeenCalledTimes(1);
    expect(m.payments.transition).toHaveBeenCalledWith(PAYMENT_ID, { type: 'TIMEOUT' });
  });

  it('ya ORPHAN y reintentos agotados → se queda ORPHAN (sin tocar nada)', async () => {
    const m = makeProcessor({ status: 'ORPHAN', attemptsMade: 4, maxAttempts: 5 });
    await m.processor.process(m.job);
    expect(m.payments.transition).not.toHaveBeenCalled();
  });

  it('la consulta a la pasarela falla (red, breaker abierto) → cuenta como "no se sabe", no rompe', async () => {
    const m = makeProcessor({
      attempts: [{ providerTxId: '2222NEWORDER', status: 'PENDING' }],
      gateway: { '2222NEWORDER': new Error('ECONNRESET') },
    });
    await expect(m.processor.process(m.job)).rejects.toThrow('still-pending');
  });

  it('dos intentos aprobados → se apunta uno y queda el doble cobro (una sola vez)', async () => {
    const m = makeProcessor({
      attempts: [
        { providerTxId: 'B2', status: 'PENDING' },
        { providerTxId: 'A1', status: 'PENDING' },
      ],
      gateway: { A1: 'AUTHORIZED', B2: 'AUTHORIZED' },
    });
    await m.processor.process(m.job);
    expect(m.payments.transition).toHaveBeenCalledWith(PAYMENT_ID, expect.objectContaining({ providerTxId: 'B2' }));
    expect(m.tx.paymentEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: 'payment.duplicate_charge',
        payload: { order: 'A1', source: 'conciliacion' },
      }),
    });

    const again = makeProcessor({
      attempts: [
        { providerTxId: 'B2', status: 'APPROVED' },
        { providerTxId: 'A1', status: 'APPROVED' },
      ],
      gateway: { A1: 'AUTHORIZED', B2: 'AUTHORIZED' },
      duplicateAlreadyRecorded: true,
    });
    await again.processor.process(again.job);
    expect(again.tx.paymentEvent.create).not.toHaveBeenCalled();
  });

  it('cobro FAILED que el banco sí aprobó → se apunta; si no, se deja (una sola pasada)', async () => {
    const paid = makeProcessor({ status: 'FAILED', gateway: { '2222NEWORDER': 'AUTHORIZED' } });
    await paid.processor.process(paid.job);
    expect(paid.payments.transition).toHaveBeenCalledWith(PAYMENT_ID, expect.objectContaining({ type: 'AUTHORIZED' }));

    const notPaid = makeProcessor({ status: 'FAILED', gateway: { '2222NEWORDER': 'FAILED' } });
    await notPaid.processor.process(notPaid.job);
    expect(notPaid.payments.transition).not.toHaveBeenCalled();
  });

  it('cobro ya pagado o caducado → ni se consulta la pasarela', async () => {
    for (const status of ['AUTHORIZED', 'EXPIRED', 'CANCELED', 'REFUNDED']) {
      const m = makeProcessor({ status });
      await m.processor.process(m.job);
      expect(m.adapter.getStatus).not.toHaveBeenCalled();
      expect(m.payments.transition).not.toHaveBeenCalled();
    }
  });

  it('sin pedido en la pasarela → FAILED (no hay nada cobrado)', async () => {
    const m = makeProcessor({ provider: null, providerTxId: null });
    await m.processor.process(m.job);
    expect(m.payments.transition).toHaveBeenCalledWith(PAYMENT_ID, {
      type: 'FAILED',
      reason: 'orphan-without-provider-tx',
    });
  });

  it('carrera con el aviso del banco (ya AUTHORIZED) → sin error', async () => {
    const m = makeProcessor({ gateway: { '2222NEWORDER': 'AUTHORIZED' } });
    m.payments.transition.mockRejectedValueOnce(new InvalidTransitionError('AUTHORIZED', 'AUTHORIZED'));
    await expect(m.processor.process(m.job)).resolves.toBeUndefined();
  });
});

describe('OrphanReconcileProcessor — importe (P3)', () => {
  it('pedido aprobado cuyo aviso se rechazó por importe → no se da por pagado (sigue a ORPHAN)', async () => {
    const m = makeProcessor({
      attempts: [{ providerTxId: '1111OLDORDER', status: 'APPROVED' }],
      gateway: { '1111OLDORDER': 'AUTHORIZED' },
      amountMismatch: ['1111OLDORDER'],
      attemptsMade: 4,
      maxAttempts: 5,
    });
    await m.processor.process(m.job);
    expect(m.tx.paymentEvent.findMany).toHaveBeenCalledWith({
      where: { paymentId: PAYMENT_ID, eventType: 'payment.amount_mismatch' },
      select: { payload: true },
    });
    expect(m.payments.transition).toHaveBeenCalledTimes(1);
    expect(m.payments.transition).toHaveBeenCalledWith(PAYMENT_ID, { type: 'TIMEOUT' });
    expect(m.tx.paymentAttempt.updateMany).not.toHaveBeenCalled();
  });

  it('con otro pedido aprobado sin problema de importe → se apunta ese, sin doble cobro por el del importe', async () => {
    const m = makeProcessor({
      attempts: [
        { providerTxId: '2222NEWORDER', status: 'PENDING' },
        { providerTxId: '1111OLDORDER', status: 'PENDING' },
      ],
      gateway: { '1111OLDORDER': 'AUTHORIZED', '2222NEWORDER': 'AUTHORIZED' },
      amountMismatch: ['2222NEWORDER'],
    });
    await m.processor.process(m.job);
    expect(m.payments.transition).toHaveBeenCalledWith(
      PAYMENT_ID,
      expect.objectContaining({ type: 'AUTHORIZED', providerTxId: '1111OLDORDER' }),
    );
    expect(m.tx.paymentEvent.create).not.toHaveBeenCalled();
  });

  it('sin aprobados no mira las incidencias de importe', async () => {
    const m = makeProcessor({ attempts: [{ providerTxId: '1111OLDORDER', status: 'PENDING' }], gateway: {} });
    await expect(m.processor.process(m.job)).rejects.toThrow('still-pending');
    expect(m.tx.paymentEvent.findMany).not.toHaveBeenCalled();
  });
});
