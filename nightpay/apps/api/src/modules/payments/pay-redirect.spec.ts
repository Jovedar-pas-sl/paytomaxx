import { describe, it, expect } from 'vitest';
import { MAX_PAYMENT_ATTEMPTS, RETRY_WAIT_MS, confirmationCode, decideRedsysRetry } from './pay-redirect';
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
