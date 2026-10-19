import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { PaymentsService } from './payments.service';

/**
 * Lo que ve quien paga después de pagar (resultado, justificante, «Pagado»)
 * y las consultas públicas por token. Seguridad: el enlace, el código y el
 * Face ID de un saldo solo se dan con la recarga que lo creó.
 */

const NOW = new Date('2026-10-17T01:30:00+02:00');
const TENANT = '5b0c8f7e-2d1a-4c3b-9e8f-0a1b2c3d4e5f';
const PAYMENT_ID = '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b';
const EARLIER_TOP_UP = '0d9e8f7a-6b5c-4d3e-9f2a-1b0c9d8e7f6a';
const WALLET_ID = '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d';
const QR = 'c9d8e7f6-a5b4-4c3d-8e2f-1a0b9c8d7e6f';
const AUTHORIZED_AT = new Date('2026-10-17T01:28:40+02:00');

type Row = Record<string, unknown>;
interface AttemptRow {
  providerTxId: string;
  status: string;
  payMethod?: string | null;
}
interface Setup {
  payment?: Row | null;
  /** Intentos del cobro, del más antiguo al más reciente. */
  attempts?: AttemptRow[];
  /** Primer cobro del saldo (null = ninguno). */
  firstTopUpId?: string | null;
  provider?: string | null;
}

function paymentRow(o: Row = {}): Row {
  return {
    id: PAYMENT_ID,
    tenantId: TENANT,
    status: 'AUTHORIZED',
    provider: 'REDSYS',
    providerTxId: 'ORD-2',
    amountCents: 4_500,
    tipCents: 500,
    currency: 'EUR',
    qrToken: QR,
    qrExpiresAt: new Date('2026-10-17T01:34:00+02:00'),
    updatedAt: AUTHORIZED_AT,
    authorizedAt: AUTHORIZED_AT,
    authCode: '012345',
    cardBrand: 'VISA',
    walletId: null,
    wallet: null,
    serviceName: null,
    tipGoesTo: null,
    venue: { name: 'Sala Bambú (Madrid)' },
    terminal: { label: 'Barra principal' },
    createdBy: { role: 'WAITER' },
    attempts: [],
    createdByUserId: '9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
    tokenizationData: { identifier: 'tok-redsys-77' },
    ...o,
  };
}

/** Recarga de saldo cobrada, con el saldo y la huella del navegador que pagó. */
const TOP_UP: Row = {
  walletId: WALLET_ID,
  wallet: { qrToken: 'wq-5f4e3d2c', shortCode: 'K7Q4M2', pinHash: '$argon2id$v=19$m=65536', _count: { passkeys: 1 } },
  attempts: [{ claimHash: 'huella-cliente' }],
};

function makeService(setup: Setup = {}) {
  const payment = setup.payment === null ? null : paymentRow(setup.payment ?? {});
  const attempts = setup.attempts ?? [];
  const db = {
    payment: {
      findUnique: vi.fn(async ({ where }: { where: { qrToken?: string; id?: string } }) => {
        if (!payment) return null;
        const hit = where.qrToken !== undefined ? where.qrToken === payment.qrToken : where.id === payment.id;
        return hit ? payment : null;
      }),
      findFirst: vi.fn(async ({ where }: { where: { walletId?: string; id?: string; providerTxId?: string } }) => {
        if (where.walletId !== undefined) {
          return setup.firstTopUpId === null ? null : { id: setup.firstTopUpId ?? PAYMENT_ID };
        }
        if (!payment) return null;
        if (where.id !== undefined) return where.id === payment.id ? payment : null;
        return where.providerTxId === payment.providerTxId ? payment : null;
      }),
    },
    paymentAttempt: {
      findFirst: vi.fn(async ({ where }: { where: { paymentId?: string; providerTxId?: string; status?: string } }) => {
        if (where.status) {
          const charged = attempts.find((a) => a.status === where.status);
          return charged ? { providerTxId: charged.providerTxId, payMethod: charged.payMethod ?? null } : null;
        }
        const hit = attempts.find((a) => a.providerTxId === where.providerTxId);
        if (!hit) return null;
        return where.paymentId === undefined ? { paymentId: PAYMENT_ID } : { status: hit.status };
      }),
    },
    gatewayCredential: {
      findFirst: vi.fn(async () => (setup.provider === null ? null : { provider: setup.provider ?? 'REDSYS' })),
    },
  };
  const prisma = {
    ...db,
    asSystem: vi.fn(async (fn: (tx: typeof db) => unknown) => fn(db)),
    acrossVenues: vi.fn(async (fn: (tx: typeof db) => unknown) => fn(db)),
  };
  const peanpe = { buildPaymentUrl: vi.fn(() => 'https://pasarela.peanpe.com/pago?id=LL-20261017-0042') };
  const service = new PaymentsService(
    prisma as never,
    { get: () => undefined } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    peanpe as never,
    {} as never,
  );
  Object.assign(service, { logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } });
  return { service, prisma, peanpe };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('«Pagado» de una recarga: el saldo solo se entrega con la recarga que lo creó', () => {
  it('primera recarga → enlace, huella, código, Face ID y PIN del saldo', async () => {
    const { service } = makeService({ payment: TOP_UP, firstTopUpId: PAYMENT_ID });
    await expect(service.getPayPage(QR)).resolves.toMatchObject({
      kind: 'paid',
      walletToken: 'wq-5f4e3d2c',
      walletClaimHash: 'huella-cliente',
      walletCode: 'K7Q-4M2',
      walletHasFaceId: true,
      walletHasPin: true,
    });
  });

  it('recarga de un saldo que ya existía → quien paga no se lleva enlace, código ni Face ID', async () => {
    const { service } = makeService({ payment: TOP_UP, firstTopUpId: EARLIER_TOP_UP });
    await expect(service.getPayPage(QR)).resolves.toMatchObject({
      kind: 'paid',
      walletToken: null,
      walletClaimHash: null,
      walletCode: null,
      walletHasFaceId: false,
      walletHasPin: false,
    });
  });

  it('recarga pendiente en un local con Redsys → sin propina', async () => {
    const { service } = makeService({
      payment: { ...TOP_UP, status: 'CREATED', provider: null, providerTxId: null, tipCents: 0, authorizedAt: null },
    });
    await expect(service.getPayPage(QR)).resolves.toMatchObject({ kind: 'choose', tipOptionsCents: [0], tipMaxCents: 0 });
  });
});

describe('getResultView — el cliente vuelve del banco a /pay/result', () => {
  it('sin pedido → null sin consultar la base', async () => {
    const { service, prisma } = makeService();
    await expect(service.getResultView('')).resolves.toBeNull();
    expect(prisma.asSystem).not.toHaveBeenCalled();
  });

  it('pedido de un intento denegado de un cobro ya pagado → el cobro y el estado de ESE intento', async () => {
    const { service } = makeService({
      attempts: [
        { providerTxId: 'ORD-1', status: 'DENIED' },
        { providerTxId: 'ORD-2', status: 'APPROVED' },
      ],
    });
    await expect(service.getResultView('ORD-1')).resolves.toEqual({
      paymentId: PAYMENT_ID,
      status: 'AUTHORIZED',
      amountCents: 4_500,
      tipCents: 500,
      currency: 'EUR',
      authorizedAt: AUTHORIZED_AT,
      qrToken: QR,
      walletToken: null,
      walletClaimHash: null,
      walletCode: null,
      walletHasFaceId: false,
      walletHasPin: false,
      attemptStatus: 'DENIED',
    });
  });

  it('cobro anterior a los intentos → se encuentra por su pedido, sin estado de intento', async () => {
    const { service } = makeService({ payment: { providerTxId: 'ORD-ANTIGUO' } });
    await expect(service.getResultView('ORD-ANTIGUO')).resolves.toMatchObject({
      paymentId: PAYMENT_ID,
      status: 'AUTHORIZED',
      attemptStatus: null,
    });
  });

  it('pedido que no es de ningún cobro → null', async () => {
    const { service } = makeService();
    await expect(service.getResultView('ORD-DE-OTRO')).resolves.toBeNull();
  });

  it('recarga de un saldo que ya existía → sin enlace, huella ni código; la primera sí', async () => {
    const attempts = [{ providerTxId: 'ORD-2', status: 'APPROVED' }];
    const later = makeService({ payment: TOP_UP, attempts, firstTopUpId: EARLIER_TOP_UP });
    await expect(later.service.getResultView('ORD-2')).resolves.toMatchObject({
      walletToken: null,
      walletClaimHash: null,
      walletCode: null,
      walletHasFaceId: false,
      walletHasPin: false,
    });
    const first = makeService({ payment: TOP_UP, attempts, firstTopUpId: PAYMENT_ID });
    await expect(first.service.getResultView('ORD-2')).resolves.toMatchObject({
      walletToken: 'wq-5f4e3d2c',
      walletClaimHash: 'huella-cliente',
      walletCode: 'K7Q-4M2',
      walletHasFaceId: true,
      walletHasPin: true,
      attemptStatus: 'APPROVED',
    });
  });
});

describe('getReceipt — justificante del cliente', () => {
  it('sin pagar o token desconocido → null', async () => {
    const pending = makeService({ payment: { status: 'AUTHORIZING', authorizedAt: null } });
    await expect(pending.service.getReceipt(QR)).resolves.toBeNull();
    const unknown = makeService({ payment: null });
    await expect(unknown.service.getReceipt(QR)).resolves.toBeNull();
  });

  it('pagado con Apple/Google Pay → método «wallet» y el pedido del intento cobrado', async () => {
    const { service } = makeService({
      attempts: [
        { providerTxId: 'ORD-1', status: 'DENIED', payMethod: 'card' },
        { providerTxId: 'ORD-2', status: 'APPROVED', payMethod: 'wallet' },
      ],
    });
    await expect(service.getReceipt(QR)).resolves.toEqual({
      paymentId: PAYMENT_ID,
      amountCents: 4_500,
      tipCents: 500,
      currency: 'EUR',
      authorizedAt: AUTHORIZED_AT,
      authCode: '012345',
      cardBrand: 'VISA',
      payMethod: 'wallet',
      order: 'ORD-2',
    });
  });

  it('cobro devuelto sigue teniendo justificante; método raro → null y el pedido del cobro', async () => {
    const refunded = makeService({ payment: { status: 'REFUNDED' } });
    await expect(refunded.service.getReceipt(QR)).resolves.toMatchObject({ payMethod: null, order: 'ORD-2' });
    const odd = makeService({ attempts: [{ providerTxId: 'ORD-9', status: 'APPROVED', payMethod: 'apple_pay' }] });
    await expect(odd.service.getReceipt(QR)).resolves.toMatchObject({ payMethod: null, order: 'ORD-9' });
  });
});

describe('getByToken — consulta pública por el QR', () => {
  it('token desconocido → 404', async () => {
    const { service } = makeService({ payment: null });
    await expect(service.getByToken(QR)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('solo importe, estado, local, datáfono y caducidad (nada del personal ni de la tarjeta)', async () => {
    const { service } = makeService({ payment: { status: 'CREATED' } });
    await expect(service.getByToken(QR)).resolves.toEqual({
      id: PAYMENT_ID,
      amountCents: 4_500,
      currency: 'EUR',
      status: 'CREATED',
      venueName: 'Sala Bambú (Madrid)',
      terminalLabel: 'Barra principal',
      qrExpiresAt: '2026-10-16T23:34:00.000Z',
    });
  });
});

describe('getPeanpeRedirectUrl — formulario de Peanpe', () => {
  const peanpeCall = { identificadorLlamada: 'LL-20261017-0042' };

  it('token desconocido → 404; otra pasarela o llamada sin inicializar → 409', async () => {
    await expect(makeService({ payment: null }).service.getPeanpeRedirectUrl(QR)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const redsys = makeService({ payment: { provider: 'REDSYS', peanpeCall } });
    await expect(redsys.service.getPeanpeRedirectUrl(QR)).rejects.toThrow(/REDSYS/);
    const noCall = makeService({ payment: { provider: 'PEANPE', peanpeCall: null } });
    await expect(noCall.service.getPeanpeRedirectUrl(QR)).rejects.toBeInstanceOf(ConflictException);
    expect(noCall.peanpe.buildPaymentUrl).not.toHaveBeenCalled();
  });

  it('URL con la llamada, el importe y el concepto «<marca> <8 primeros del cobro>»', async () => {
    const { service, peanpe } = makeService({ payment: { provider: 'PEANPE', status: 'AUTHORIZING', peanpeCall } });
    await expect(service.getPeanpeRedirectUrl(QR)).resolves.toEqual({
      provider: 'PEANPE',
      url: 'https://pasarela.peanpe.com/pago?id=LL-20261017-0042',
    });
    expect(peanpe.buildPaymentUrl).toHaveBeenCalledWith({
      identificadorLlamada: 'LL-20261017-0042',
      amountCents: 4_500,
      concepto: expect.stringMatching(/ 7f1c2a9e$/),
      debug: true,
    });
  });

  it('en producción, sin modo depuración', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { service, peanpe } = makeService({ payment: { provider: 'PEANPE', peanpeCall } });
    await service.getPeanpeRedirectUrl(QR);
    expect(peanpe.buildPaymentUrl).toHaveBeenCalledWith(expect.objectContaining({ debug: false }));
  });
});

describe('findById — detalle para el personal', () => {
  it('cobro que no existe (o de otro local, filtrado por el middleware) → 404', async () => {
    const { service } = makeService({ payment: null });
    await expect(service.findById(PAYMENT_ID)).rejects.toBeInstanceOf(NotFoundException);
  });
});
