import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@nightpay/db';
import { GATEWAY_ERROR_PUBLIC, PaymentsService } from './payments.service';
import { InvalidTransitionError, type PaymentEvent } from './payment.machine';
import type { CheckoutChoice } from './pay-redirect';

/**
 * Página de pago del cliente por el token del QR (GET/POST /pay/:token y
 * /pay/:token/checkout), con la base y la pasarela simuladas.
 */

const NOW = new Date('2026-10-17T01:30:00+02:00');
const TENANT = '5b0c8f7e-2d1a-4c3b-9e8f-0a1b2c3d4e5f';
const PAYMENT_ID = '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b';
const QR = 'c9d8e7f6-a5b4-4c3d-8e2f-1a0b9c8d7e6f';
const secondsAgo = (s: number) => new Date(NOW.getTime() - s * 1000);
const REDSYS_FORM = {
  action: 'https://sis.redsys.es/sis/realizarPago',
  method: 'POST',
  fields: { Ds_SignatureVersion: 'HMAC_SHA256_V1', Ds_MerchantParameters: 'eyJ9', Ds_Signature: 'c2lnbmF0dXJh' },
};
const PAYTEF_URL = 'https://pagos.paytef.es/checkout/9f3a77';

type Row = Record<string, unknown>;
interface Attempt {
  providerTxId: string;
  status: string;
  createdAt: Date;
  claimHash?: string | null;
  payMethod?: string | null;
}
interface Setup {
  payment?: Row | null;
  attempts?: Attempt[];
  /** Pasarela activa del local (null = ninguna). */
  provider?: string | null;
  /** Pausa y formas de cobro del local (por defecto, abierto y todo encendido). */
  venue?: Row;
  authorize?: (input: Row) => Promise<Row>;
}

function paymentRow(o: Row = {}): Row {
  return {
    id: PAYMENT_ID,
    tenantId: TENANT,
    status: 'CREATED',
    provider: null,
    providerTxId: null,
    amountCents: 4_500,
    tipCents: 0,
    currency: 'EUR',
    qrToken: QR,
    qrExpiresAt: new Date(NOW.getTime() + 4 * 60_000),
    updatedAt: secondsAgo(60),
    authorizedAt: null,
    walletId: null,
    serviceName: 'Copa en barra',
    tipGoesTo: null,
    venue: { name: 'Sala Bambú (Madrid)' },
    createdBy: { role: 'OPERATOR' },
    wallet: null,
    attempts: [],
    gatewayPaymentUrl: null,
    gatewayCheckoutForm: null,
    ...o,
  };
}

function makeService(setup: Setup = {}) {
  const state: { payment: Row | null; attempts: Attempt[] } = {
    payment: setup.payment === null ? null : paymentRow(setup.payment ?? {}),
    attempts: [...(setup.attempts ?? [])],
  };
  const written: Row[] = [];
  const locks: Prisma.Sql[] = [];
  const provider = setup.provider === undefined ? 'REDSYS' : setup.provider;
  const db = {
    payment: {
      findUnique: vi.fn(async ({ where }: { where: { qrToken?: string; id?: string } }) => {
        const p = state.payment;
        if (!p) return null;
        if (where.qrToken !== undefined && where.qrToken !== p.qrToken) return null;
        if (where.id !== undefined && where.id !== p.id) return null;
        return p;
      }),
      findFirst: vi.fn(async () => ({ id: PAYMENT_ID })),
      update: vi.fn(async ({ data }: { data: Row }) => {
        state.payment = { ...state.payment, ...data };
        return state.payment;
      }),
    },
    paymentAttempt: {
      findMany: vi.fn(async ({ take }: { take?: number }) => state.attempts.slice(0, take ?? state.attempts.length)),
      create: vi.fn(async ({ data }: { data: Row }) => {
        written.push(data);
        return data;
      }),
    },
    gatewayCredential: { findFirst: vi.fn(async () => (provider === null ? null : { provider })) },
    venue: { findUnique: vi.fn(async () => setup.venue ?? { pausedAt: null, business: null, paymentMethods: null }) },
    walletCashTopUp: { findFirst: vi.fn(async () => null) },
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      locks.push(Prisma.sql(strings, ...values));
      return [{ ok: 1 }];
    }),
  };
  const prisma = {
    asSystem: vi.fn(async (fn: (tx: typeof db) => unknown) => fn(db)),
    acrossVenues: vi.fn(async (fn: (tx: typeof db) => unknown) => fn(db)),
  };
  const authorize: (input: Row) => Promise<Row> =
    setup.authorize ?? (async () => ({ providerTxId: '2610170130A1', checkoutForm: REDSYS_FORM }));
  const adapter = { authorize: vi.fn(authorize) };
  const orphanQueue = { add: vi.fn(async () => ({})) };
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const service = new PaymentsService(
    prisma as never,
    { get: () => ({ traceId: 'trace-pago-1' }) } as never,
    { add: vi.fn() } as never,
    orphanQueue as never,
    { get: vi.fn(() => adapter) } as never,
    { emitPaymentUpdate: vi.fn(), emitPaymentCompleted: vi.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
  );
  Object.assign(service, { logger });
  // La transición real (SELECT … FOR UPDATE) tiene sus propias pruebas: aquí solo mueve el estado.
  const transition = vi.spyOn(service, 'transition').mockImplementation(async (_id: string, event: PaymentEvent) => {
    if (event.type === 'AUTHORIZING') state.payment = { ...state.payment, status: 'AUTHORIZING' };
  });
  return { service, db, state, written, locks, adapter, orphanQueue, logger, transition };
}

const choice = (o: Partial<CheckoutChoice> = {}): CheckoutChoice => ({
  tipCents: 0,
  method: 'card',
  language: 'es',
  claimHash: 'huella-cliente',
  ...o,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getPayPage — lo que ve el cliente al escanear el QR', () => {
  it('cobro ya pagado → «Pagado» con la propina cobrada, sin mirar los intentos', async () => {
    const { service, db } = makeService({
      payment: { status: 'AUTHORIZED', provider: 'REDSYS', tipCents: 500, authorizedAt: secondsAgo(40) },
    });
    await expect(service.getPayPage(QR)).resolves.toMatchObject({
      kind: 'paid',
      paymentId: PAYMENT_ID,
      amountCents: 4_500,
      tipCents: 500,
      authorizedAt: secondsAgo(40),
    });
    expect(db.paymentAttempt.findMany).not.toHaveBeenCalled();
  });

  it('cobro nuevo en un local con Redsys → página de pago con propinas y cabecera del local', async () => {
    const { service } = makeService({ provider: 'REDSYS' });
    await expect(service.getPayPage(QR)).resolves.toEqual({
      kind: 'choose',
      amountCents: 4_500,
      currency: 'EUR',
      // 45 €: 10 % y 15 % en euros enteros; «Otra» hasta el importe.
      tipOptionsCents: [0, 500, 700],
      tipMaxCents: 4_500,
      tipCents: 0,
      qrExpiresAt: new Date(NOW.getTime() + 4 * 60_000),
      venueName: 'Sala Bambú (Madrid)',
      concept: 'Copa en barra',
      tipToStaff: true,
      // Sin ajustes del local: las propinas sugeridas de siempre.
      tipPresets: { flatCents: [200, 500], percents: [10, 15] },
    });
    // Local con otra pasarela (Paytef): solo «Sin propina».
    const paytef = makeService({ provider: 'PAYTEF' });
    await expect(paytef.service.getPayPage(QR)).resolves.toMatchObject({ tipOptionsCents: [0], tipMaxCents: 0 });
  });

  it('propinas del local (Ajustes): apagadas → solo «Sin propina» y no se acepta otra; sugeridas propias → esas', async () => {
    const off = makeService({ provider: 'REDSYS', payment: { venue: { name: 'Sala Bambú (Madrid)', paymentMethods: { tips: false } } } });
    await expect(off.service.getPayPage(QR)).resolves.toMatchObject({ kind: 'choose', tipOptionsCents: [0], tipMaxCents: 0 });
    const own = makeService({
      provider: 'REDSYS',
      payment: { venue: { name: 'Sala Bambú (Madrid)', paymentMethods: { tipPercents: [5, 20] } } },
    });
    // 45 €: 5 % → 2 € (redondeado a euros), 20 % → 9 €.
    await expect(own.service.getPayPage(QR)).resolves.toMatchObject({ tipOptionsCents: [0, 200, 900] });
  });

  it('pago en curso con otra pasarela → reenvía a lo guardado (enlace o formulario); sin nada → 409', async () => {
    const link = makeService({ payment: { status: 'AUTHORIZING', provider: 'PAYTEF', gatewayPaymentUrl: PAYTEF_URL } });
    await expect(link.service.getPayPage(QR)).resolves.toEqual({ kind: 'redirect', url: PAYTEF_URL, status: 'AUTHORIZING' });
    const form = makeService({ payment: { status: 'AUTHORIZING', provider: 'WIPAY', gatewayCheckoutForm: REDSYS_FORM } });
    await expect(form.service.getPayPage(QR)).resolves.toMatchObject({ kind: 'form', action: REDSYS_FORM.action });
    const empty = makeService({ payment: { status: 'AUTHORIZING', provider: 'PAYTEF' } });
    await expect(empty.service.getPayPage(QR)).rejects.toBeInstanceOf(ConflictException);
  });

  it('Redsys, intento denegado hace 1 min → puede volver a elegir (tarjeta en vez de Apple Pay)', async () => {
    const { service } = makeService({
      payment: { status: 'AUTHORIZING', provider: 'REDSYS', providerTxId: 'ORD-1' },
      attempts: [{ providerTxId: 'ORD-1', status: 'DENIED', createdAt: secondsAgo(60) }],
    });
    await expect(service.getPayPage(QR)).resolves.toMatchObject({ kind: 'choose', amountCents: 4_500 });
  });

  it('Redsys, intento pendiente de hace 30 s → esperar al aviso del banco', async () => {
    const { service } = makeService({
      payment: { status: 'AUTHORIZING', provider: 'REDSYS', providerTxId: 'ORD-1' },
      attempts: [{ providerTxId: 'ORD-1', status: 'PENDING', createdAt: secondsAgo(30) }],
    });
    await expect(service.getPayPage(QR)).resolves.toEqual({ kind: 'processing' });
  });

  it('Redsys, intento sin respuesta del banco con el QR ya caducado → «sin confirmar» (puede que sí cobrara)', async () => {
    const { service } = makeService({
      payment: { status: 'AUTHORIZING', provider: 'REDSYS', qrExpiresAt: secondsAgo(10) },
      attempts: [{ providerTxId: 'ORD-1', status: 'PENDING', createdAt: secondsAgo(200) }],
    });
    await expect(service.getPayPage(QR)).resolves.toEqual({ kind: 'closed', reason: 'unconfirmed' });
  });

  it('Redsys, intento denegado con el QR ya caducado → caducado (ahí sí: no se cobró nada)', async () => {
    const { service } = makeService({
      payment: { status: 'AUTHORIZING', provider: 'REDSYS', qrExpiresAt: secondsAgo(10) },
      attempts: [{ providerTxId: 'ORD-1', status: 'DENIED', createdAt: secondsAgo(200) }],
    });
    await expect(service.getPayPage(QR)).resolves.toEqual({ kind: 'closed', reason: 'expired' });
  });

  it('token desconocido → 404', async () => {
    const { service } = makeService({ payment: null });
    await expect(service.getPayPage(QR)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('startCheckout — el cliente pulsa «Pagar»', () => {
  it('cobro ya pagado → «Pagado», sin ir al banco', async () => {
    const { service, adapter } = makeService({ payment: { status: 'AUTHORIZED', provider: 'REDSYS' } });
    await expect(service.startCheckout(QR, choice({ tipCents: 500 }))).resolves.toMatchObject({ kind: 'paid' });
    expect(adapter.authorize).not.toHaveBeenCalled();
  });

  it('propina no válida (más que el importe, con decimales, negativa o sin Redsys) → 400 sin abrir nada', async () => {
    const redsys = makeService();
    for (const tipCents of [4_501, 250.5, -100]) {
      await expect(redsys.service.startCheckout(QR, choice({ tipCents }))).rejects.toBeInstanceOf(BadRequestException);
    }
    const paytef = makeService({ provider: 'PAYTEF' });
    await expect(paytef.service.startCheckout(QR, choice({ tipCents: 500 }))).rejects.toBeInstanceOf(BadRequestException);
    expect(redsys.adapter.authorize).not.toHaveBeenCalled();
    expect(paytef.adapter.authorize).not.toHaveBeenCalled();
    expect(redsys.written).toHaveLength(0);
  });

  it('primer pago con Redsys: pedido por importe + propina, intento del navegador apuntado', async () => {
    const { service, adapter, written, state, orphanQueue, transition } = makeService();
    await expect(service.startCheckout(QR, choice({ tipCents: 500 }))).resolves.toEqual({ kind: 'checkout', order: '2610170130A1' });
    expect(transition).toHaveBeenCalledWith(PAYMENT_ID, { type: 'AUTHORIZING' });
    expect(adapter.authorize).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, amountCents: 5_000, payMethod: 'card', language: 'es' }),
    );
    expect(written).toEqual([
      {
        paymentId: PAYMENT_ID,
        tenantId: TENANT,
        provider: 'REDSYS',
        providerTxId: '2610170130A1',
        amountCents: 5_000,
        tipCents: 500,
        payMethod: 'card',
        claimHash: 'huella-cliente',
      },
    ]);
    expect(state.payment).toMatchObject({ provider: 'REDSYS', providerTxId: '2610170130A1', gatewayCheckoutForm: REDSYS_FORM });
    // Si el aviso del banco no llega, la conciliación lo pregunta a los 2 min.
    expect(orphanQueue.add).toHaveBeenCalledWith(
      'orphan-reconcile',
      { paymentId: PAYMENT_ID, tenantId: TENANT },
      expect.objectContaining({ jobId: `orphan-${PAYMENT_ID}`, delay: 120_000, attempts: 5 }),
    );
  });

  it('primer pago con Paytef: al banco solo el importe y se redirige a su enlace', async () => {
    const { service, adapter, written } = makeService({
      provider: 'PAYTEF',
      authorize: async () => ({ providerTxId: 'PTF-88121', paymentLinkUrl: PAYTEF_URL }),
    });
    await expect(service.startCheckout(QR, choice())).resolves.toEqual({ kind: 'redirect', url: PAYTEF_URL, status: 'AUTHORIZING' });
    expect(adapter.authorize.mock.calls[0]![0]).toMatchObject({ amountCents: 4_500 });
    expect(adapter.authorize.mock.calls[0]![0]).not.toHaveProperty('payMethod');
    expect(written[0]).toMatchObject({ provider: 'PAYTEF', amountCents: 4_500, tipCents: null });
  });

  it('doble toque: el otro POST ya abrió el pedido → mismo formulario; otro navegador → 409', async () => {
    // El otro POST ya movió el cobro a AUTHORIZING y abrió el pedido hace 5 s.
    const tapped = () => {
      const s = makeService({
        attempts: [{ providerTxId: '2610170130A1', status: 'PENDING', createdAt: secondsAgo(5), claimHash: 'huella-cliente' }],
      });
      s.transition.mockRejectedValueOnce(new InvalidTransitionError('AUTHORIZING', 'AUTHORIZING'));
      return s;
    };
    const same = tapped();
    await expect(same.service.startCheckout(QR, choice())).resolves.toEqual({ kind: 'checkout', order: '2610170130A1' });
    expect(same.adapter.authorize).not.toHaveBeenCalled();
    // Otro navegador con el mismo QR no se queda con el pedido del cliente.
    const other = tapped();
    await expect(other.service.startCheckout(QR, choice({ claimHash: 'huella-otro' }))).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('startCheckout — el local se pausó o apagó el QR con tarjeta después de crear el cobro', () => {
  it('local en pausa → 423 sin ir al banco', async () => {
    const { service, adapter, written } = makeService({ venue: { pausedAt: NOW, business: null, paymentMethods: null } });
    await expect(service.startCheckout(QR, choice())).rejects.toMatchObject({ status: 423 });
    expect(adapter.authorize).not.toHaveBeenCalled();
    expect(written).toHaveLength(0);
  });

  it('negocio en pausa o «QR con tarjeta» apagado → no se cobra (tampoco al reintentar)', async () => {
    const business = makeService({ venue: { pausedAt: null, business: { status: 'PAUSED' }, paymentMethods: null } });
    await expect(business.service.startCheckout(QR, choice())).rejects.toMatchObject({ status: 423 });
    const cardOff = makeService({ venue: { pausedAt: null, business: null, paymentMethods: { card: false } } });
    await expect(cardOff.service.startCheckout(QR, choice())).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'PAYMENT_METHOD_DISABLED', method: 'card' }),
    });
    const retry = makeService({
      payment: { status: 'AUTHORIZING', provider: 'REDSYS', providerTxId: 'ORD-1' },
      attempts: [{ providerTxId: 'ORD-1', status: 'DENIED', createdAt: secondsAgo(60) }],
      venue: { pausedAt: NOW, business: null, paymentMethods: null },
    });
    await expect(retry.service.startCheckout(QR, choice())).rejects.toMatchObject({ status: 423 });
    for (const s of [business, cardOff, retry]) expect(s.adapter.authorize).not.toHaveBeenCalled();
  });

  it('recarga de saldo con «Saldo» apagado → 409; ya pagado → «Pagado» igualmente', async () => {
    const topUp = makeService({ payment: { walletId: 'w-1' }, venue: { pausedAt: null, business: null, paymentMethods: { wallet: false } } });
    await expect(topUp.service.startCheckout(QR, choice())).rejects.toMatchObject({
      response: expect.objectContaining({ method: 'wallet' }),
    });
    const paid = makeService({ payment: { status: 'AUTHORIZED', provider: 'REDSYS' }, venue: { pausedAt: NOW } });
    await expect(paid.service.startCheckout(QR, choice())).resolves.toMatchObject({ kind: 'paid' });
  });
});

describe('startCheckout — reintento con Redsys (pago en AUTHORIZING)', () => {
  const inProgress = { status: 'AUTHORIZING', provider: 'REDSYS', providerTxId: 'ORD-1' };

  it('tras una denegación: pedido NUEVO abierto bajo el candado del cobro', async () => {
    const { service, db, locks, written } = makeService({
      payment: inProgress,
      attempts: [{ providerTxId: 'ORD-1', status: 'DENIED', createdAt: secondsAgo(60) }],
      authorize: async () => ({ providerTxId: 'ORD-2', checkoutForm: REDSYS_FORM }),
    });
    await expect(service.startCheckout(QR, choice({ method: 'wallet' }))).resolves.toEqual({ kind: 'checkout', order: 'ORD-2' });
    expect(locks[0]!.text).toContain('pg_advisory_xact_lock');
    expect(locks[0]!.values).toEqual([PAYMENT_ID]);
    expect(db.$queryRaw.mock.invocationCallOrder[0]!).toBeLessThan(db.paymentAttempt.create.mock.invocationCallOrder[0]!);
    expect(written).toEqual([expect.objectContaining({ providerTxId: 'ORD-2', amountCents: 4_500, payMethod: 'wallet' })]);
  });

  it('doble toque durante el reintento → reutiliza el pedido recién abierto', async () => {
    const { service, adapter } = makeService({
      payment: inProgress,
      attempts: [
        { providerTxId: 'ORD-2', status: 'PENDING', createdAt: secondsAgo(3), claimHash: 'huella-cliente' },
        { providerTxId: 'ORD-1', status: 'DENIED', createdAt: secondsAgo(60) },
      ],
    });
    await expect(service.startCheckout(QR, choice())).resolves.toEqual({ kind: 'checkout', order: 'ORD-2' });
    expect(adapter.authorize).not.toHaveBeenCalled();
  });

  it('pendiente de hace 40 s → esperar; tres denegados → cerrado por demasiados intentos', async () => {
    const waiting = makeService({
      payment: inProgress,
      attempts: [{ providerTxId: 'ORD-1', status: 'PENDING', createdAt: secondsAgo(40), claimHash: 'huella-cliente' }],
    });
    await expect(waiting.service.startCheckout(QR, choice())).resolves.toEqual({ kind: 'processing' });

    const denied = (n: number) => ({ providerTxId: `ORD-${n}`, status: 'DENIED', createdAt: secondsAgo(20 * n) });
    const tooMany = makeService({ payment: inProgress, attempts: [denied(3), denied(2), denied(1)] });
    await expect(tooMany.service.startCheckout(QR, choice())).resolves.toEqual({ kind: 'closed', reason: 'too-many-attempts' });
    expect(waiting.adapter.authorize).not.toHaveBeenCalled();
    expect(tooMany.adapter.authorize).not.toHaveBeenCalled();
  });

  it('«Pagar con tarjeta» tras tocar Apple Pay (intento pendiente de hace 10 s) → pedido NUEVO con tarjeta', async () => {
    const { service, adapter, written } = makeService({
      payment: inProgress,
      attempts: [
        { providerTxId: 'ORD-1', status: 'PENDING', createdAt: secondsAgo(10), claimHash: 'huella-cliente', payMethod: 'wallet' },
      ],
      authorize: async () => ({ providerTxId: 'ORD-2', checkoutForm: REDSYS_FORM }),
    });
    await expect(service.startCheckout(QR, choice({ method: 'card' }))).resolves.toEqual({ kind: 'checkout', order: 'ORD-2' });
    expect(adapter.authorize).toHaveBeenCalledWith(expect.objectContaining({ payMethod: 'card' }));
    expect(written).toEqual([expect.objectContaining({ providerTxId: 'ORD-2', payMethod: 'card' })]);
  });

  it('el mismo botón otra vez (doble toque de Apple Pay) → el mismo pedido; pasado el replay → esperar', async () => {
    const pending = (s: number) => [
      { providerTxId: 'ORD-1', status: 'PENDING', createdAt: secondsAgo(s), claimHash: 'huella-cliente', payMethod: 'wallet' },
    ];
    const replay = makeService({ payment: inProgress, attempts: pending(5) });
    await expect(replay.service.startCheckout(QR, choice({ method: 'wallet' }))).resolves.toEqual({ kind: 'checkout', order: 'ORD-1' });
    const waiting = makeService({ payment: inProgress, attempts: pending(60) });
    await expect(waiting.service.startCheckout(QR, choice({ method: 'wallet' }))).resolves.toEqual({ kind: 'processing' });
    expect(replay.adapter.authorize).not.toHaveBeenCalled();
    expect(waiting.adapter.authorize).not.toHaveBeenCalled();
  });

  it('la pasarela falla al reintentar → 409 genérico; lo enviado al banco solo va al log', async () => {
    const { service, logger, written } = makeService({
      payment: inProgress,
      attempts: [{ providerTxId: 'ORD-1', status: 'DENIED', createdAt: secondsAgo(60) }],
      authorize: async () => {
        throw new Error('Redsys SIS0051 Ds_MerchantParameters=eyJEU19BTU9VTlQiOiI0NTAwIn0= Ds_Order=ORD-2');
      },
    });
    const err = await service.startCheckout(QR, choice()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as Error).message).toBe(GATEWAY_ERROR_PUBLIC);
    expect((err as Error).message).not.toMatch(/SIS0051|Ds_Merchant/);
    expect(String(logger.error.mock.calls[0]![0])).toContain('SIS0051');
    expect(written).toHaveLength(0);
  });

  it('pago en curso con otra pasarela → su enlace guardado, sin candado ni intento nuevo', async () => {
    const { service, locks } = makeService({
      payment: { status: 'AUTHORIZING', provider: 'PAYTEF', gatewayPaymentUrl: PAYTEF_URL },
    });
    await expect(service.startCheckout(QR, choice())).resolves.toEqual({ kind: 'redirect', url: PAYTEF_URL, status: 'AUTHORIZING' });
    expect(locks).toHaveLength(0);
  });
});

describe('getCheckoutForm — formulario hacia el banco del pedido recién abierto', () => {
  const opened = { status: 'AUTHORIZING', provider: 'REDSYS', providerTxId: 'ORD-2', gatewayCheckoutForm: REDSYS_FORM };
  const fresh = [{ providerTxId: 'ORD-2', status: 'PENDING', createdAt: secondsAgo(5) }];

  it('último pedido, pendiente y recién abierto → el formulario', async () => {
    const { service } = makeService({ payment: opened, attempts: fresh });
    await expect(service.getCheckoutForm(QR, 'ORD-2')).resolves.toEqual({
      kind: 'form',
      action: REDSYS_FORM.action,
      method: 'POST',
      fields: REDSYS_FORM.fields,
      status: 'AUTHORIZING',
    });
  });

  it('vuelve atrás desde el banco pasado el margen → null (vuelve a la página del cobro)', async () => {
    const stale = [{ providerTxId: 'ORD-2', status: 'PENDING', createdAt: secondsAgo(31) }];
    const { service } = makeService({ payment: opened, attempts: stale });
    await expect(service.getCheckoutForm(QR, 'ORD-2')).resolves.toBeNull();
  });

  it('pedido que no es el último, ya pagado, token desconocido o pasarela con enlace → null', async () => {
    const old = makeService({ payment: opened, attempts: fresh });
    await expect(old.service.getCheckoutForm(QR, 'ORD-1')).resolves.toBeNull();
    const paid = makeService({ payment: { ...opened, status: 'AUTHORIZED' }, attempts: fresh });
    await expect(paid.service.getCheckoutForm(QR, 'ORD-2')).resolves.toBeNull();
    const unknown = makeService({ payment: null });
    await expect(unknown.service.getCheckoutForm(QR, 'ORD-2')).resolves.toBeNull();
    const link = makeService({ payment: { ...opened, gatewayCheckoutForm: null, gatewayPaymentUrl: PAYTEF_URL }, attempts: fresh });
    await expect(link.service.getCheckoutForm(QR, 'ORD-2')).resolves.toBeNull();
  });
});
