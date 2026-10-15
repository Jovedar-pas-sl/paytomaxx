import { describe, it, expect } from 'vitest';
import {
  CHECKOUT_REPLAY_MS,
  MAX_PAYMENT_ATTEMPTS,
  RETRY_WAIT_MS,
  choosePayPage,
  freshPendingOrder,
  confirmationCode,
  decideRedsysRetry,
  retryOutcome,
  settledPayView,
  type PayablePayment,
} from './pay-redirect';
import { resolveRevenueCategory } from './commission';

const NOW = new Date('2026-10-13T08:00:00Z');
const FUTURE = new Date(NOW.getTime() + 3 * 60_000);
const PAST = new Date(NOW.getTime() - 60_000);
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe('decideRedsysRetry — el cliente vuelve a escanear un QR en curso', () => {
  it('intento pendiente reciente → esperar (puede estar pagando ahora mismo)', () => {
    expect(
      decideRedsysRetry({
        attempts: [{ status: 'PENDING', createdAt: ago(10_000) }],
        now: NOW,
        qrExpiresAt: FUTURE,
        paymentUpdatedAt: ago(10_000),
      }),
    ).toBe('wait');
  });

  it('intento aprobado cuyo aviso aún no se procesó → esperar, nunca reintentar', () => {
    expect(
      decideRedsysRetry({
        attempts: [{ status: 'APPROVED', createdAt: ago(5 * 60_000) }],
        now: NOW,
        qrExpiresAt: FUTURE,
        paymentUpdatedAt: ago(5 * 60_000),
      }),
    ).toBe('wait');
  });

  it('intento denegado → nuevo intento al momento', () => {
    expect(
      decideRedsysRetry({
        attempts: [{ status: 'DENIED', createdAt: ago(5_000) }],
        now: NOW,
        qrExpiresAt: FUTURE,
        paymentUpdatedAt: ago(5_000),
      }),
    ).toBe('retry');
  });

  it('pendiente sin aviso pasado el tiempo de espera (abandonado) → nuevo intento', () => {
    expect(
      decideRedsysRetry({
        attempts: [{ status: 'PENDING', createdAt: ago(RETRY_WAIT_MS + 1_000) }],
        now: NOW,
        qrExpiresAt: FUTURE,
        paymentUpdatedAt: ago(RETRY_WAIT_MS + 1_000),
      }),
    ).toBe('retry');
  });

  it('QR caducado → no abre más intentos', () => {
    expect(
      decideRedsysRetry({
        attempts: [{ status: 'DENIED', createdAt: ago(5_000) }],
        now: NOW,
        qrExpiresAt: PAST,
        paymentUpdatedAt: ago(5_000),
      }),
    ).toBe('expired');
  });

  it(`máximo ${MAX_PAYMENT_ATTEMPTS} intentos por QR`, () => {
    const attempts = Array.from({ length: MAX_PAYMENT_ATTEMPTS }, (_, i) => ({
      status: 'DENIED',
      createdAt: ago(5_000 + i * 1_000),
    }));
    expect(
      decideRedsysRetry({ attempts, now: NOW, qrExpiresAt: FUTURE, paymentUpdatedAt: ago(5_000) }),
    ).toBe('max-attempts');
  });

  it('pago anterior a Fase 0 sin intentos registrados: cuenta como pendiente desde updatedAt', () => {
    expect(
      decideRedsysRetry({ attempts: [], now: NOW, qrExpiresAt: FUTURE, paymentUpdatedAt: ago(5_000) }),
    ).toBe('wait');
    expect(
      decideRedsysRetry({
        attempts: [],
        now: NOW,
        qrExpiresAt: FUTURE,
        paymentUpdatedAt: ago(RETRY_WAIT_MS + 1_000),
      }),
    ).toBe('retry');
  });
});

describe('qué ve el cliente al escanear (Fase 1B)', () => {
  const payable = (o: Partial<PayablePayment>): PayablePayment => ({
    id: 'pay-1',
    status: 'CREATED',
    amountCents: 10_000,
    tipCents: 0,
    currency: 'EUR',
    qrExpiresAt: FUTURE,
    authorizedAt: null,
    allowTip: true,
    walletToken: null,
    walletClaimHash: null,
    ...o,
  });

  it('cobro nuevo → página de pago con propinas; no abre nada en el banco', () => {
    const p = payable({});
    expect(settledPayView(p, NOW)).toBeNull();
    // 100 €: 10 % y 15 %; «Otra» hasta 100 €.
    expect(choosePayPage(p)).toMatchObject({
      kind: 'choose',
      amountCents: 10_000,
      tipOptionsCents: [0, 1_000, 1_500],
      tipMaxCents: 10_000,
    });
  });

  it('recarga de wallet u otra pasarela → sin propina', () => {
    expect(choosePayPage(payable({ allowTip: false }))).toMatchObject({ tipOptionsCents: [0], tipMaxCents: 0 });
  });

  it('cabecera de confianza: local, concepto y si la propina va al personal', () => {
    expect(choosePayPage(payable({ venueName: 'Luna', concept: 'Copa', tipToStaff: true }))).toMatchObject({
      venueName: 'Luna',
      concept: 'Copa',
      tipToStaff: true,
    });
    expect(choosePayPage(payable({}))).toMatchObject({ venueName: null, concept: null, tipToStaff: false });
  });

  it('pedido pendiente recién abierto → se reutiliza (doble toque); viejo o resuelto → no', () => {
    const order = (status: string, msAgo: number) => [{ providerTxId: 'ORD1', status, createdAt: ago(msAgo) }];
    expect(freshPendingOrder(order('PENDING', 5_000), NOW)).toBe('ORD1');
    expect(freshPendingOrder(order('PENDING', CHECKOUT_REPLAY_MS + 1), NOW)).toBeNull();
    expect(freshPendingOrder(order('DENIED', 5_000), NOW)).toBeNull();
    expect(freshPendingOrder([], NOW)).toBeNull();
  });

  it('pagado → "Pagado" con la propina cobrada', () => {
    expect(settledPayView(payable({ status: 'AUTHORIZED', tipCents: 500 }), NOW)).toMatchObject({
      kind: 'paid',
      amountCents: 10_000,
      tipCents: 500,
    });
  });

  it('QR caducado sin empezar → cerrado; con intento en curso decide el reintento', () => {
    expect(settledPayView(payable({ qrExpiresAt: PAST }), NOW)).toEqual({ kind: 'closed', reason: 'expired' });
    expect(settledPayView(payable({ status: 'AUTHORIZING', qrExpiresAt: PAST }), NOW)).toBeNull();
  });

  it('cancelado o sin confirmar → cerrado', () => {
    expect(settledPayView(payable({ status: 'CANCELED' }), NOW)).toEqual({ kind: 'closed', reason: 'canceled' });
    expect(settledPayView(payable({ status: 'ORPHAN' }), NOW)).toEqual({ kind: 'closed', reason: 'unconfirmed' });
  });

  it('sin intento nuevo: esperar, caducado o demasiados intentos', () => {
    expect(retryOutcome('wait')).toEqual({ kind: 'processing' });
    expect(retryOutcome('expired')).toEqual({ kind: 'closed', reason: 'expired' });
    expect(retryOutcome('max-attempts')).toEqual({ kind: 'closed', reason: 'too-many-attempts' });
  });
});

describe('confirmationCode', () => {
  it('3 caracteres en mayúsculas, estables para un mismo pago', () => {
    const id = '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b';
    expect(confirmationCode(id)).toBe('A6B');
    expect(confirmationCode(id)).toBe(confirmationCode(id));
  });
});

describe('resolveRevenueCategory — quién puede cobrar qué', () => {
  it('la chica solo cobra sus servicios', () => {
    expect(resolveRevenueCategory({ isWalletTopUp: false, creatorRole: 'OPERATOR', requested: undefined })).toBe(
      'CHICA_SERVICE',
    );
    expect(
      resolveRevenueCategory({ isWalletTopUp: false, creatorRole: 'OPERATOR', requested: 'CHICA_SERVICE' }),
    ).toBe('CHICA_SERVICE');
  });

  it('la chica no puede cobrar barra ni habitación (→ null, el servicio responde 400)', () => {
    expect(resolveRevenueCategory({ isWalletTopUp: false, creatorRole: 'OPERATOR', requested: 'VENUE_BAR' })).toBeNull();
    expect(resolveRevenueCategory({ isWalletTopUp: false, creatorRole: 'OPERATOR', requested: 'VENUE_ROOM' })).toBeNull();
  });

  it('la recarga de wallet siempre es EXTRA, la pida quien la pida', () => {
    expect(
      resolveRevenueCategory({ isWalletTopUp: true, creatorRole: 'OPERATOR', requested: 'CHICA_SERVICE' }),
    ).toBe('EXTRA');
  });

  it('el camarero cobra las categorías del local', () => {
    expect(resolveRevenueCategory({ isWalletTopUp: false, creatorRole: 'WAITER', requested: 'VENUE_BAR' })).toBe(
      'VENUE_BAR',
    );
  });
});

describe('reutilizar el pedido abierto: solo el del mismo navegador', () => {
  it('otro navegador con el mismo QR no se queda con el pedido del cliente', async () => {
    const { freshPendingOrder } = await import('./pay-redirect');
    const now = new Date('2026-10-14T22:00:03Z');
    const attempts = [
      { providerTxId: 'ORD1', status: 'PENDING', createdAt: new Date('2026-10-14T22:00:00Z'), claimHash: 'cliente' },
    ];
    expect(freshPendingOrder(attempts, now, 'cliente')).toBe('ORD1');
    expect(freshPendingOrder(attempts, now, 'chica')).toBeNull();
    expect(freshPendingOrder(attempts, now, null)).toBeNull();
    expect(freshPendingOrder(attempts, now)).toBe('ORD1');
  });
});
