import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { GATEWAY_ERROR_PUBLIC, GATEWAY_FAILED_PUBLIC, PaymentsService } from './payments.service';
import { InvalidTransitionError } from './payment.machine';
import { GatewayTransientError } from '../gateways/gateway-errors';

/**
 * startAuthorization (endpoint público antiguo, sin página de pago) y las
 * comprobaciones previas de cancelar y confirmar un cobro con datáfono.
 */

const NOW = new Date('2026-10-17T01:30:00+02:00');
const TENANT = '5b0c8f7e-2d1a-4c3b-9e8f-0a1b2c3d4e5f';
const PAYMENT_ID = '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b';
const OPERATOR = 'a7b6c5d4-e3f2-4a1b-9c8d-7e6f5a4b3c2d';
const QR = 'c9d8e7f6-a5b4-4c3d-8e2f-1a0b9c8d7e6f';
const PAYTEF_URL = 'https://pagos.paytef.es/checkout/9f3a77';

type Row = Record<string, unknown>;

interface Opts {
  payment?: Row | null;
  provider?: string | null;
  authorize?: (input: Row) => Promise<Row>;
}

function makeService(opts: Opts = {}) {
  const payment =
    opts.payment === null
      ? null
      : {
          id: PAYMENT_ID,
          tenantId: TENANT,
          status: 'CREATED',
          amountCents: 4_500,
          tipCents: 300,
          currency: 'EUR',
          qrExpiresAt: new Date(NOW.getTime() + 4 * 60_000),
          captureMethod: null,
          createdByUserId: OPERATOR,
          terminalId: 'f0e1d2c3-b4a5-4968-8776-655443322110',
          ...(opts.payment ?? {}),
        };
  const updates: Row[] = [];
  const attempts: Row[] = [];
  const provider = opts.provider === undefined ? 'REDSYS' : opts.provider;
  const db = {
    payment: {
      findUnique: vi.fn(async () => payment),
      update: vi.fn(async ({ data }: { data: Row }) => {
        updates.push(data);
        return {};
      }),
    },
    paymentAttempt: {
      create: vi.fn(async ({ data }: { data: Row }) => {
        attempts.push(data);
        return data;
      }),
    },
    gatewayCredential: { findFirst: vi.fn(async () => (provider === null ? null : { provider })) },
    venue: { findUnique: vi.fn(async () => ({ pausedAt: null, business: null, paymentMethods: null })) },
  };
  const prisma = { ...db, asSystem: vi.fn(async (fn: (tx: typeof db) => unknown) => fn(db)) };
  const authorize: (input: Row) => Promise<Row> =
    opts.authorize ?? (async () => ({ providerTxId: '2610170130A1', paymentLinkUrl: PAYTEF_URL }));
  const adapter = { authorize: vi.fn(authorize) };
  const orphanQueue = { add: vi.fn(async () => ({})) };
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const service = new PaymentsService(
    prisma as never,
    { get: () => ({ traceId: 'trace-auth-1' }), set: vi.fn(), run: (_o: unknown, fn: () => unknown) => fn() } as never,
    {} as never,
    orphanQueue as never,
    { get: vi.fn(() => adapter) } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  Object.assign(service, { logger });
  // La transición real (fila bloqueada, FSM) tiene sus pruebas: aquí ejecuta lo
  // que el llamador guarda en su misma transacción (opts.prepare).
  const transition = vi.spyOn(service, 'transition').mockImplementation(async (_id, _event, _tenant, opts) => {
    if (opts?.prepare && payment) await opts.prepare(db as never, payment as never);
  });
  return { service, db, updates, attempts, adapter, orphanQueue, logger, transition };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startAuthorization — antes de ir al banco', () => {
  it('token desconocido → 404', async () => {
    const { service } = makeService({ payment: null });
    await expect(service.startAuthorization(QR)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('QR caducado → 409 sin mover el cobro ni llamar al banco', async () => {
    const { service, transition, adapter } = makeService({ payment: { qrExpiresAt: new Date(NOW.getTime() - 1_000) } });
    await expect(service.startAuthorization(QR)).rejects.toThrow(/expired/);
    expect(transition).not.toHaveBeenCalled();
    expect(adapter.authorize).not.toHaveBeenCalled();
  });

  it('local sin pasarela activa → no se puede pagar con tarjeta: FAILED y 409 sin reintento', async () => {
    const { service, transition, adapter } = makeService({ provider: null });
    const err = await service.startAuthorization(QR).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: 'GATEWAY_FAILED', message: GATEWAY_FAILED_PUBLIC });
    expect(transition).toHaveBeenCalledWith(PAYMENT_ID, { type: 'CHECKOUT_FAILED', reason: 'no-active-gateway' });
    expect(adapter.authorize).not.toHaveBeenCalled();
  });

  it('ya en AUTHORIZING (otro POST abrió el pago) o terminado → 409 sin llamar al banco ni tocar el cobro', async () => {
    for (const status of ['AUTHORIZING', 'ORPHAN', 'FAILED', 'AUTHORIZED']) {
      const { service, transition, adapter } = makeService({ payment: { status } });
      await expect(service.startAuthorization(QR)).rejects.toBeInstanceOf(ConflictException);
      expect(adapter.authorize).not.toHaveBeenCalled();
      expect(transition).not.toHaveBeenCalled();
    }
  });

  it('otro POST lo abrió mientras la pasarela preparaba este → 409 y de este no se guarda nada', async () => {
    const { service, transition, attempts, updates, orphanQueue } = makeService();
    transition.mockRejectedValueOnce(new InvalidTransitionError('AUTHORIZING', 'AUTHORIZING'));
    await expect(service.startAuthorization(QR)).rejects.toBeInstanceOf(ConflictException);
    expect(attempts).toHaveLength(0);
    expect(updates).toHaveLength(0);
    expect(orphanQueue.add).not.toHaveBeenCalled();
  });

  it('fallo de la base al mover el cobro → sale ese error (no se disfraza de 409)', async () => {
    const { service, transition } = makeService();
    const dbDown = new Error('Connection terminated unexpectedly');
    transition.mockRejectedValueOnce(dbDown);
    await expect(service.startAuthorization(QR)).rejects.toBe(dbDown);
  });
});

describe('startAuthorization — lo que se cobra y se guarda', () => {
  it('Redsys sin página de pago: al banco importe + la propina que ya traía el cobro', async () => {
    const { service, adapter, attempts, updates, orphanQueue } = makeService({
      authorize: async () => ({ providerTxId: '2610170130A1', checkoutForm: { action: 'https://sis.redsys.es', fields: {} } }),
    });
    await expect(service.startAuthorization(QR)).resolves.toEqual({ status: 'AUTHORIZING', providerTxId: '2610170130A1' });
    const sent = adapter.authorize.mock.calls[0]![0] as Row;
    expect(sent).toMatchObject({ tenantId: TENANT, paymentId: PAYMENT_ID, amountCents: 4_800, currency: 'EUR' });
    expect(sent).not.toHaveProperty('payMethod');
    expect(sent).not.toHaveProperty('language');
    expect(attempts).toEqual([
      {
        paymentId: PAYMENT_ID,
        tenantId: TENANT,
        provider: 'REDSYS',
        providerTxId: '2610170130A1',
        amountCents: 4_800,
        tipCents: 300,
        payMethod: null,
        claimHash: null,
      },
    ]);
    // Pasarela, pedido y formulario a la vez que el AUTHORIZING (misma transacción).
    expect(updates).toEqual([
      { provider: 'REDSYS', providerTxId: '2610170130A1', gatewayCheckoutForm: { action: 'https://sis.redsys.es', fields: {} } },
    ]);
    expect(orphanQueue.add).toHaveBeenCalledWith(
      'orphan-reconcile',
      { paymentId: PAYMENT_ID, tenantId: TENANT },
      expect.objectContaining({ jobId: `orphan-${PAYMENT_ID}`, delay: 120_000 }),
    );
  });

  it('el cobro pasa a AUTHORIZING solo cuando la pasarela ya abrió el pago, con su pedido en la misma transacción', async () => {
    const { service, db, adapter, transition } = makeService({ provider: 'PAYTEF' });
    await service.startAuthorization(QR);
    expect(adapter.authorize.mock.invocationCallOrder[0]!).toBeLessThan(transition.mock.invocationCallOrder[0]!);
    expect(transition).toHaveBeenCalledTimes(1);
    expect(transition).toHaveBeenCalledWith(
      PAYMENT_ID,
      { type: 'AUTHORIZING' },
      TENANT,
      expect.objectContaining({ prepare: expect.any(Function) }),
    );
    // Lo guarda el prepare de la transición (con la fila bloqueada), no antes.
    expect(db.payment.update).toHaveBeenCalledTimes(1);
    expect(db.paymentAttempt.create).toHaveBeenCalledTimes(1);
  });

  it('Paytef: al banco solo el importe (no cobra propina) y se guarda su enlace', async () => {
    const { service, adapter, attempts, updates } = makeService({ provider: 'PAYTEF' });
    await service.startAuthorization(QR);
    expect(adapter.authorize.mock.calls[0]![0]).toMatchObject({ amountCents: 4_500 });
    expect(attempts[0]).toMatchObject({ provider: 'PAYTEF', amountCents: 4_500, tipCents: null });
    expect(updates[0]).toEqual({ provider: 'PAYTEF', providerTxId: '2610170130A1', gatewayPaymentUrl: PAYTEF_URL });
  });

  it('fallo pasajero de la pasarela (sin respuesta, breaker abierto) → 409 que SÍ reintenta; el cobro ni se toca', async () => {
    const transient = [
      new GatewayTransientError('Paytef /save sin respuesta: fetch failed'),
      Object.assign(new Error('Breaker is open'), { code: 'EOPENBREAKER' }),
      Object.assign(new Error('Timed out after 5000ms'), { code: 'ETIMEDOUT' }),
    ];
    for (const cause of transient) {
      const { service, transition, attempts, updates, orphanQueue } = makeService({
        authorize: async () => {
          throw cause;
        },
      });
      const err = await service.startAuthorization(QR).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as Error).message).toBe(GATEWAY_ERROR_PUBLIC);
      expect((err as ConflictException).getResponse()).toMatchObject({ code: 'GATEWAY_RETRY' });
      // Sigue CREATED: ni AUTHORIZING ni FAILED, sin pedido ni intento.
      expect(transition).not.toHaveBeenCalled();
      expect(attempts).toHaveLength(0);
      expect(updates).toHaveLength(0);
      expect(orphanQueue.add).not.toHaveBeenCalled();
    }
  });

  it('fallo definitivo de la pasarela → FAILED (no llegó al banco) y 409 sin reintento; el detalle solo al log', async () => {
    const { service, transition, orphanQueue, logger } = makeService({
      authorize: async () => {
        throw new Error('Paytef /save failed: 422 sent: {"terminal":"T-0042"}');
      },
    });
    const err = await service.startAuthorization(QR).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as Error).message).toBe(GATEWAY_FAILED_PUBLIC);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: 'GATEWAY_FAILED' });
    expect(JSON.stringify((err as ConflictException).getResponse())).not.toMatch(/T-0042|sent:/);
    expect(String(logger.error.mock.calls[0]![0])).toContain('T-0042');
    expect(transition).toHaveBeenCalledTimes(1);
    expect(transition).toHaveBeenCalledWith(PAYMENT_ID, { type: 'CHECKOUT_FAILED', reason: 'gateway-authorize-error' });
    expect(orphanQueue.add).not.toHaveBeenCalled();
  });

  it('fallo definitivo y el cobro ya estaba FAILED (otra petición) → el mismo 409 sin reintento', async () => {
    const { service, transition } = makeService({
      authorize: async () => {
        throw new Error('REDSYS_SECRET_KEY no configurado');
      },
    });
    transition.mockRejectedValueOnce(new InvalidTransitionError('FAILED', 'CHECKOUT_FAILED'));
    const err = await service.startAuthorization(QR).catch((e: unknown) => e);
    expect((err as Error).message).toBe(GATEWAY_FAILED_PUBLIC);
  });

  it('fallo definitivo pero otro POST ya abrió el pago (AUTHORIZING) → ese sigue: «ya se está procesando», sin matarlo', async () => {
    const { service, transition } = makeService({
      authorize: async () => {
        throw new Error('REDSYS_SECRET_KEY no configurado');
      },
    });
    transition.mockRejectedValueOnce(new InvalidTransitionError('AUTHORIZING', 'CHECKOUT_FAILED'));
    const err = await service.startAuthorization(QR).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as Error).message).toMatch(/already in progress/);
  });

  it('la pasarela falla y además falla marcarlo FAILED → sale ese segundo error (el cobro sigue como estaba)', async () => {
    const { service, transition } = makeService({
      authorize: async () => {
        throw new Error('timeout');
      },
    });
    const deadlock = new Error('deadlock detected');
    transition.mockRejectedValueOnce(deadlock);
    await expect(service.startAuthorization(QR)).rejects.toBe(deadlock);
  });
});

describe('cancel — errores', () => {
  const owner = { userId: 'c0ffee00-1234-4abc-8def-0123456789ab', role: 'OWNER', tenantId: TENANT };

  it('cobro que no existe → 404 sin transición', async () => {
    const { service, transition } = makeService({ payment: null });
    await expect(service.cancel(PAYMENT_ID, owner)).rejects.toBeInstanceOf(NotFoundException);
    expect(transition).not.toHaveBeenCalled();
  });

  it('ya pagado (el FSM no deja) → 409; con el local del que cancela', async () => {
    const { service, transition } = makeService({ payment: { status: 'AUTHORIZED' } });
    transition.mockRejectedValueOnce(new InvalidTransitionError('AUTHORIZED', 'CANCELED'));
    await expect(service.cancel(PAYMENT_ID, owner)).rejects.toThrow(/AUTHORIZED/);
    expect(transition).toHaveBeenCalledWith(PAYMENT_ID, { type: 'CANCELED', reason: 'user-canceled' }, TENANT);
  });

  it('otro error (cobro de otro local, base caída) → sale tal cual', async () => {
    const { service, transition } = makeService();
    const notHere = new NotFoundException('Payment not found');
    transition.mockRejectedValueOnce(notHere);
    await expect(service.cancel(PAYMENT_ID, owner)).rejects.toBe(notHere);
  });
});

describe('confirmPosPayment — comprobaciones antes de confirmar', () => {
  const waiter = { userId: 'd4e5f6a7-b8c9-4d0e-9f1a-2b3c4d5e6f7a', role: 'WAITER', tenantId: TENANT };
  const pos = { captureMethod: 'POS_EXTERNAL', status: 'CREATED' };

  it('cobro que no existe → 404', async () => {
    const { service } = makeService({ payment: null });
    await expect(service.confirmPosPayment(PAYMENT_ID, waiter, { posReceiptRef: 'AB12CD' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('cobro con QR (no datáfono) o ya no pendiente → 409, sin tocar el cobro', async () => {
    const qr = makeService({ payment: { captureMethod: null } });
    await expect(qr.service.confirmPosPayment(PAYMENT_ID, waiter, { posReceiptRef: 'AB12CD' })).rejects.toThrow(
      /POS_EXTERNAL/,
    );
    const done = makeService({ payment: { ...pos, status: 'AUTHORIZED' } });
    await expect(done.service.confirmPosPayment(PAYMENT_ID, waiter, { posReceiptRef: 'AB12CD' })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(qr.transition).not.toHaveBeenCalled();
    expect(done.transition).not.toHaveBeenCalled();
  });

  it('la chica no confirma su propio cobro con datáfono → 403', async () => {
    const { service, transition } = makeService({ payment: pos });
    const self = { userId: OPERATOR, role: 'OPERATOR', tenantId: TENANT };
    await expect(service.confirmPosPayment(PAYMENT_ID, self, { posReceiptRef: 'AB12CD' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(transition).not.toHaveBeenCalled();
  });

  it('error inesperado al confirmar → sale tal cual', async () => {
    const { service, transition } = makeService({ payment: pos });
    const boom = new Error('could not serialize access');
    transition.mockRejectedValueOnce(boom);
    await expect(service.confirmPosPayment(PAYMENT_ID, waiter, { posReceiptRef: 'AB12CD' })).rejects.toBe(boom);
  });
});
