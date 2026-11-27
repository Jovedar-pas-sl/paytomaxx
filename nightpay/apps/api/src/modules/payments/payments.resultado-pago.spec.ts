import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { PaymentsService, payerWalletFields } from './payments.service';
import { selfTopUpKey } from '../wallets/wallet-topup-rules';

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
  claimHash?: string | null;
}
interface Setup {
  payment?: Row | null;
  /** Intentos del cobro, del más antiguo al más reciente. */
  attempts?: AttemptRow[];
  /** Primer cobro del saldo (null = ninguno). */
  firstTopUpId?: string | null;
  /** Primera recarga en efectivo del saldo (antes o después del primer cobro). */
  firstCashAt?: Date | null;
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
    serviceFeeCents: 0,
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
          return setup.firstTopUpId === null ? null : { id: setup.firstTopUpId ?? PAYMENT_ID, createdAt: NOW };
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
          return charged ? { providerTxId: charged.providerTxId, payMethod: charged.payMethod ?? null, claimHash: charged.claimHash ?? null } : null;
        }
        const hit = attempts.find((a) => a.providerTxId === where.providerTxId);
        if (!hit) return null;
        return where.paymentId === undefined ? { paymentId: PAYMENT_ID } : { status: hit.status };
      }),
    },
    // La compañera del servicio de un cobro hecho por otra persona (cobro por el encargado): aquí, ninguna.
    $queryRaw: vi.fn(async () => []),
    gatewayCredential: {
      findFirst: vi.fn(async () => (setup.provider === null ? null : { provider: setup.provider ?? 'REDSYS' })),
    },
    walletCashTopUp: {
      findFirst: vi.fn(async () =>
        setup.firstCashAt ? { takenByUserId: null, terminalId: 'term-recepcion', createdAt: setup.firstCashAt } : null,
      ),
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

  it('primera recarga con tarjeta de un saldo abierto en EFECTIVO → quien la paga no se lleva el saldo', async () => {
    // Pagos #1: antes solo se miraban los cobros; un amigo que pagara 10 € se quedaba con el enlace y el Face ID.
    const { service } = makeService({ payment: TOP_UP, firstTopUpId: PAYMENT_ID, firstCashAt: new Date(NOW.getTime() - 3_600_000) });
    await expect(service.getPayPage(QR)).resolves.toMatchObject({ kind: 'paid', walletToken: null, walletCode: null, walletClaimHash: null });
    // El efectivo después de la tarjeta no cambia nada: la tarjeta sí fue la primera.
    const after = makeService({ payment: TOP_UP, firstTopUpId: PAYMENT_ID, firstCashAt: new Date(NOW.getTime() + 60_000) });
    await expect(after.service.getPayPage(QR)).resolves.toMatchObject({ kind: 'paid', walletToken: 'wq-5f4e3d2c' });
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

describe('idea 62: el «Pagado» dice a quién se pagó, qué y cómo, sin dígitos de la tarjeta', () => {
  // Visa (Ds_Card_Brand 1) con Apple Pay o Google Pay.
  const PAID: Row = { serviceName: '2× Gin tonic · Nachos', cardBrand: '1', cardLast4: '4242', attempts: [{ claimHash: 'huella-cliente', payMethod: 'wallet' }] };

  it('/pay/:token ya pagado → el local, lo pedido, la marca y la forma de pago', async () => {
    const { service, prisma } = makeService({ payment: PAID });
    const view = await service.getPayPage(QR);
    expect(view).toMatchObject({
      kind: 'paid',
      venueName: 'Sala Bambú (Madrid)',
      concept: '2× Gin tonic · Nachos',
      cardBrand: '1',
      payMethod: 'wallet',
    });
    // Ni se piden ni salen los dígitos de la tarjeta (eso es de la parte B, solo para quien pagó).
    expect(view).not.toHaveProperty('cardLast4');
    expect(JSON.stringify(view)).not.toContain('4242');
    expect(JSON.stringify(prisma.payment.findUnique.mock.calls[0]![0])).not.toContain('cardLast4');
  });

  it('/pay/result (la vuelta del banco) → lo mismo', async () => {
    const attempts = [{ providerTxId: 'ORD-2', status: 'APPROVED' }];
    const { service, prisma } = makeService({ payment: PAID, attempts });
    const view = await service.getResultView('ORD-2');
    expect(view).toMatchObject({
      venueName: 'Sala Bambú (Madrid)',
      concept: '2× Gin tonic · Nachos',
      cardBrand: '1',
      payMethod: 'wallet',
    });
    expect(view).not.toHaveProperty('cardLast4');
    expect(JSON.stringify(view)).not.toContain('4242');
    expect(JSON.stringify(prisma.payment.findFirst.mock.calls.map((c) => c[0]))).not.toContain('cardLast4');
  });

  it('sin concepto, sin marca o sin intento aprobado (un cobro de antes): esos datos, vacíos', async () => {
    const { service } = makeService({ payment: { cardBrand: null }, attempts: [{ providerTxId: 'ORD-2', status: 'APPROVED' }] });
    await expect(service.getPayPage(QR)).resolves.toMatchObject({ kind: 'paid', venueName: 'Sala Bambú (Madrid)', concept: null, cardBrand: null, payMethod: null });
    await expect(service.getResultView('ORD-2')).resolves.toMatchObject({ concept: null, cardBrand: null, payMethod: null });
  });

  it('el justificante: a quién se pagó y lo pedido; los 4 últimos dígitos y la huella del intento APROBADO (parte B: el controlador solo los enseña a quien pagó)', async () => {
    const { service } = makeService({
      payment: PAID,
      attempts: [
        { providerTxId: 'ORD-1', status: 'DENIED', payMethod: 'card', claimHash: 'huella-de-otro' },
        { providerTxId: 'ORD-2', status: 'APPROVED', payMethod: 'wallet', claimHash: 'huella-cliente' },
      ],
    });
    const receipt = await service.getReceipt(QR);
    expect(receipt).toMatchObject({ venueName: 'Sala Bambú (Madrid)', concept: '2× Gin tonic · Nachos', cardBrand: '1', payMethod: 'wallet' });
    expect(receipt).toMatchObject({ cardLast4: '4242', approvedClaimHash: 'huella-cliente' });
  });
});

describe('«Recargar» desde /w: tras pagar, solo la vuelta al saldo (al navegador que la empezó)', () => {
  const RETURN_KEY = selfTopUpKey('r'.repeat(43));
  const RETURN_HASH = RETURN_KEY.slice('wtopup:'.length);
  const SELF: Row = { ...TOP_UP, idempotencyKey: RETURN_KEY, createdByUserId: null, createdBy: null, tipCents: 0 };

  it('/pay pagado → sin enlace, código ni Face ID; vuelta al saldo con la huella de su cookie de vuelta', async () => {
    // Aunque fuese la primera recarga del saldo: una de /w nunca entrega el código.
    const { service } = makeService({ payment: SELF, firstTopUpId: PAYMENT_ID });
    await expect(service.getPayPage(QR)).resolves.toMatchObject({
      kind: 'paid',
      walletToken: null,
      walletClaimHash: RETURN_HASH,
      walletCode: null,
      walletHasFaceId: false,
      walletHasPin: false,
      walletReturnToken: 'wq-5f4e3d2c',
    });
  });

  it('/pay/result → lo mismo (y no la huella del intento)', async () => {
    const attempts = [{ providerTxId: 'ORD-2', status: 'APPROVED' }];
    const { service } = makeService({ payment: SELF, attempts, firstTopUpId: EARLIER_TOP_UP });
    await expect(service.getResultView('ORD-2')).resolves.toMatchObject({
      walletToken: null,
      walletClaimHash: RETURN_HASH,
      walletReturnToken: 'wq-5f4e3d2c',
      attemptStatus: 'APPROVED',
    });
  });

  it('pendiente → página de pago sin propina (la recarga no la lleva)', async () => {
    const { service } = makeService({
      payment: { ...SELF, status: 'CREATED', provider: null, providerTxId: null, authorizedAt: null },
    });
    await expect(service.getPayPage(QR)).resolves.toMatchObject({ kind: 'choose', tipOptionsCents: [0], tipMaxCents: 0 });
  });

  it('payerWalletFields: cobro sin saldo o recarga normal → sin vuelta', () => {
    const wallet = TOP_UP.wallet as Parameters<typeof payerWalletFields>[0]['wallet'];
    expect(payerWalletFields({ wallet: null, firstTopUp: false, idempotencyKey: RETURN_KEY, approvedClaimHash: 'h' })).toEqual({
      walletToken: null,
      walletClaimHash: null,
      walletCode: null,
      walletHasFaceId: false,
      walletHasPin: false,
    });
    expect(
      payerWalletFields({ wallet, firstTopUp: true, idempotencyKey: 'op-1234-abcd', approvedClaimHash: 'h' }),
    ).not.toHaveProperty('walletReturnToken');
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
      serviceFeeCents: 0,
      currency: 'EUR',
      authorizedAt: AUTHORIZED_AT,
      qrToken: QR,
      walletToken: null,
      walletClaimHash: null,
      walletCode: null,
      walletHasFaceId: false,
      walletHasPin: false,
      attemptStatus: 'DENIED',
      approvedClaimHash: null,
      // Idea 62: a quién se pagó, qué y cómo (aquí, un cobro sin concepto ni intento aprobado con su forma).
      venueName: 'Sala Bambú (Madrid)',
      concept: null,
      cardBrand: 'VISA',
      payMethod: null,
    });
  });

  it('el intento se busca con su pasarela (índice único pasarela + pedido): sin ella se recorre la tabla entera', async () => {
    const { service, prisma } = makeService({ attempts: [{ providerTxId: 'ORD-2', status: 'APPROVED' }] });
    await expect(service.getResultView('ORD-2')).resolves.toMatchObject({ paymentId: PAYMENT_ID, attemptStatus: 'APPROVED' });
    // Solo Redsys (Ds_Order) y Cecabank/Wipay (Num_operacion) vuelven a /pay/result?op=.
    expect(prisma.paymentAttempt.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { provider: { in: ['REDSYS', 'WIPAY'] }, providerTxId: 'ORD-2' } }),
    );
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
      serviceFeeCents: 0,
      topUp: false,
      currency: 'EUR',
      authorizedAt: AUTHORIZED_AT,
      authCode: '012345',
      cardBrand: 'VISA',
      payMethod: 'wallet',
      order: 'ORD-2',
      // Idea 62: a quién se pagó y lo pedido (este cobro no lleva concepto).
      venueName: 'Sala Bambú (Madrid)',
      concept: null,
      // Parte B: sin dígitos guardados (lo normal con Redsys) y la huella del intento aprobado (este, sin ella).
      cardLast4: null,
      approvedClaimHash: null,
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
      amountCents: 4_500,
      serviceFeeCents: 0,
      currency: 'EUR',
      status: 'CREATED',
      venueName: 'Sala Bambú (Madrid)',
      terminalLabel: 'Barra principal',
      qrExpiresAt: '2026-10-16T23:34:00.000Z',
      // Cobro de antes de las referencias: sin referencia.
      ref: null,
    });
  });

  it('con su referencia corta (C-0042): la misma que ve la chica en el PAGADO', async () => {
    const { service } = makeService({ payment: { status: 'AUTHORIZED', ref: 42 } as never });
    await expect(service.getByToken(QR)).resolves.toMatchObject({ ref: 'C-0042' });
  });

  it('pagado: con la propina que dejó el cliente (el PAGADO del personal sin tiempo real la necesita)', async () => {
    const paid = makeService({ payment: { status: 'AUTHORIZED' } });
    await expect(paid.service.getByToken(QR)).resolves.toMatchObject({ status: 'AUTHORIZED', tipCents: 500 });
    // Sin pagar aún, la propina no se dice (puede cambiar hasta pagar).
    const pending = makeService({ payment: { status: 'AUTHORIZING' } });
    await expect(pending.service.getByToken(QR)).resolves.not.toHaveProperty('tipCents');
  });

  it('pagado: cómo pagó, solo si el banco lo dio, y NUNCA las cifras de la tarjeta (ruta pública por el QR)', async () => {
    const card = makeService({ payment: { status: 'AUTHORIZED', cardLast4: '4021' }, attempts: [{ providerTxId: 'ORD-2', status: 'APPROVED', payMethod: 'wallet' }] });
    const shown = await card.service.getByToken(QR);
    expect(shown).toMatchObject({ payMethod: 'wallet' });
    expect(shown).not.toHaveProperty('cardLast4');
    expect(JSON.stringify(shown)).not.toContain('4021');
    // Sin método (cobro de antes, datáfono): no se dice nada.
    const none = makeService({ payment: { status: 'AUTHORIZED' } });
    expect(await none.service.getByToken(QR)).not.toHaveProperty('payMethod');
  });

  it.each(['CREATED', 'AUTHORIZING', 'ORPHAN', 'FAILED'])('sin pagar (%s): nada de la tarjeta', async (status) => {
    const { service } = makeService({ payment: { status, cardLast4: '4021' }, attempts: [{ providerTxId: 'ORD-2', status: 'APPROVED', payMethod: 'card' }] });
    const view = await service.getByToken(QR);
    expect(view).not.toHaveProperty('cardLast4');
    expect(view).not.toHaveProperty('payMethod');
  });

  // El código de confirmación del «Pagado» son los 3 últimos caracteres del id
  // (confirmation-code.ts): con el id, una página falsa lo enseñaría sin pagar.
  it.each(['CREATED', 'AWAITING_CAPTURE', 'AUTHORIZING', 'ORPHAN', 'FAILED', 'EXPIRED', 'CANCELED'])(
    'sin pagar (%s): ni el id ni nada de lo que salga el código',
    async (status) => {
      const { service } = makeService({ payment: { status } });
      const view = await service.getByToken(QR);
      expect(view).not.toHaveProperty('id');
      const text = JSON.stringify(view).toLowerCase();
      expect(text).not.toContain(PAYMENT_ID);
      expect(text).not.toContain(PAYMENT_ID.replace(/-/g, '').slice(-3));
    },
  );

  it('esperando al banco o sin su respuesta: cuándo salió el intento (la espera del personal cuenta desde ahí)', async () => {
    const sentAt = new Date('2026-10-17T01:29:10+02:00');
    const waiting = makeService({ payment: { status: 'AUTHORIZING', attempts: [{ createdAt: sentAt }] } });
    await expect(waiting.service.getByToken(QR)).resolves.toMatchObject({ status: 'AUTHORIZING', attemptStartedAt: sentAt.toISOString() });
    const orphan = makeService({ payment: { status: 'ORPHAN', attempts: [{ createdAt: sentAt }] } });
    await expect(orphan.service.getByToken(QR)).resolves.toMatchObject({ status: 'ORPHAN', attemptStartedAt: sentAt.toISOString() });
    // Un cobro de antes de los intentos (Fase 0): desde que cambió de estado.
    const legacy = makeService({ payment: { status: 'AUTHORIZING', attempts: [] } });
    await expect(legacy.service.getByToken(QR)).resolves.toMatchObject({ attemptStartedAt: AUTHORIZED_AT.toISOString() });
    // En los demás estados, nada.
    for (const status of ['CREATED', 'AUTHORIZED', 'FAILED', 'EXPIRED']) {
      const other = makeService({ payment: { status, attempts: [{ createdAt: sentAt }] } });
      await expect(other.service.getByToken(QR)).resolves.not.toHaveProperty('attemptStartedAt');
    }
  });

  it.each(['AUTHORIZED', 'PARTIALLY_REFUNDED', 'REFUNDED'])(
    'pagado (%s): con el id, como antes (las apps del personal lo comparan en el sondeo)',
    async (status) => {
      const { service } = makeService({ payment: { status } });
      await expect(service.getByToken(QR)).resolves.toMatchObject({ id: PAYMENT_ID, status });
    },
  );
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
