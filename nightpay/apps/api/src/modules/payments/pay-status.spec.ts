import { describe, expect, it } from 'vitest';
import { RETRY_WAIT_MS } from '@nightpay/contracts';
import { payStatusView, type PayStatusInput } from './pay-status';

const NOW = new Date('2026-10-17T01:30:00+02:00');
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);
const QR_OPEN = new Date(NOW.getTime() + 10 * 60_000);

function input(o: Partial<PayStatusInput> = {}): PayStatusInput {
  return {
    status: 'AUTHORIZING',
    provider: 'REDSYS',
    amountCents: 3_300,
    serviceFeeCents: 330,
    tipCents: 200,
    qrExpiresAt: QR_OPEN,
    updatedAt: ago(30),
    venueName: 'Sala Aurora',
    attempts: [{ status: 'PENDING', createdAt: ago(30), claimHash: 'huella-a', amountCents: 3_830 }],
    viewerClaimHash: 'huella-a',
    now: NOW,
    ...o,
  };
}

describe('el estado del pago para la página «Comprobando el pago» (GET /pay/:token/status y /pay/result/status)', () => {
  it('esperando al banco: cuándo salió, cuándo podrá reintentar (2:30 después), el plazo del QR, el importe cobrado y el local', () => {
    expect(payStatusView(input())).toEqual({
      state: 'processing',
      attemptStartedAt: ago(30).toISOString(),
      retryAt: new Date(ago(30).getTime() + RETRY_WAIT_MS).toISOString(),
      qrExpiresAt: QR_OPEN.toISOString(),
      amountCents: 3_830,
      venueName: 'Sala Aurora',
      otherPayer: false,
      now: NOW.toISOString(),
    });
  });

  it('el importe: el del intento que fue al banco; sin él (cobros de antes), importe + comisión + propina', () => {
    expect(payStatusView(input({ attempts: [{ status: 'PENDING', createdAt: ago(5), claimHash: null, amountCents: null }] })).amountCents).toBe(3_830);
    expect(payStatusView(input({ attempts: [] })).amountCents).toBe(3_830);
  });

  it('pasados los 2:30 sin respuesta y con el QR vigente: puede volver a intentarlo (retryAt ya pasado)', () => {
    const late = payStatusView(input({ attempts: [{ status: 'PENDING', createdAt: ago(200), claimHash: 'huella-a', amountCents: 3_830 }] }));
    expect(late.state).toBe('processing');
    expect(Date.parse(late.retryAt!)).toBeLessThan(NOW.getTime());
  });

  it('sin reintento posible: el aviso del banco aprobado y sin procesar, el último intento permitido o el QR caducando antes', () => {
    const approved = payStatusView(input({ attempts: [{ status: 'APPROVED', createdAt: ago(10), claimHash: 'huella-a', amountCents: 3_830 }] }));
    expect(approved).toMatchObject({ state: 'processing', retryAt: null });
    const three = [0, 1, 2].map((i) => ({ status: i === 0 ? 'PENDING' : 'DENIED', createdAt: ago(30 + i * 40), claimHash: 'huella-a', amountCents: 3_830 }));
    expect(payStatusView(input({ attempts: three })).retryAt).toBeNull();
    // El QR caduca antes de que pasen los 2:30: no se le promete reintentar.
    expect(payStatusView(input({ qrExpiresAt: new Date(NOW.getTime() + 60_000) })).retryAt).toBeNull();
  });

  it('el último intento denegado: «denied» (la página del cobro le deja probar otra tarjeta)', () => {
    expect(payStatusView(input({ attempts: [{ status: 'DENIED', createdAt: ago(20), claimHash: 'huella-a', amountCents: 3_830 }] })).state).toBe('denied');
  });

  it('pagado, sin confirmación del banco (ORPHAN) y cerrado (caducado, fallido, cancelado o ya pagado con el saldo)', () => {
    expect(payStatusView(input({ status: 'AUTHORIZED' })).state).toBe('paid');
    expect(payStatusView(input({ status: 'PARTIALLY_REFUNDED' })).state).toBe('paid');
    expect(payStatusView(input({ status: 'ORPHAN' }))).toMatchObject({ state: 'unconfirmed', retryAt: null, attemptStartedAt: ago(30).toISOString() });
    for (const status of ['EXPIRED', 'FAILED', 'CANCELED'] as const) expect(payStatusView(input({ status })).state).toBe('closed');
    // Ya pagado con el saldo: la tarjeta queda CANCELED (closed) y, al recargar, la página dice «Ya está pagado con tu saldo».
    // QR caducado con un intento sin contestar: sin confirmar, nunca «no se te ha cobrado».
    expect(
      payStatusView(input({ qrExpiresAt: ago(1), attempts: [{ status: 'PENDING', createdAt: ago(400), claimHash: 'huella-a', amountCents: 3_830 }] })).state,
    ).toBe('unconfirmed');
  });

  it('aún sin ir al banco (CREATED): «open», sin tiempos (la página del cobro le deja pagar)', () => {
    expect(payStatusView(input({ status: 'CREATED', attempts: [] }))).toMatchObject({ state: 'open', attemptStartedAt: null, retryAt: null });
  });

  it('otro navegador en el mismo QR mientras el primero paga: otherPayer (la cookie no es la del intento pendiente)', () => {
    expect(payStatusView(input({ viewerClaimHash: 'huella-b' })).otherPayer).toBe(true);
    expect(payStatusView(input({ viewerClaimHash: null })).otherPayer).toBe(true);
    expect(payStatusView(input({ viewerClaimHash: 'huella-a' })).otherPayer).toBe(false);
    // Sin huella en el intento (cobros de antes) o sin intento pendiente: no se sabe, no se dice.
    expect(payStatusView(input({ attempts: [{ status: 'PENDING', createdAt: ago(5), claimHash: null, amountCents: 3_830 }], viewerClaimHash: null })).otherPayer).toBe(false);
    expect(payStatusView(input({ status: 'AUTHORIZED', viewerClaimHash: 'huella-b' })).otherPayer).toBe(false);
    // La vuelta del banco (/pay/result?op=) es la de quien pagó: nunca otherPayer.
    expect(payStatusView(input({ viewerClaimHash: undefined })).otherPayer).toBe(false);
  });

  it('otras pasarelas en AUTHORIZING: esperando, sin reintento (no hay pedidos que abrir)', () => {
    expect(payStatusView(input({ provider: 'PAYTEF', attempts: [] }))).toMatchObject({ state: 'processing', retryAt: null });
  });
});
