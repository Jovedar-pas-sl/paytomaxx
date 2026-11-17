import { describe, expect, it } from 'vitest';
import { NOT_STARTED, ReservationsService, continuable } from './reservations.service';
import { RESERVATION_VIEW_INCLUDE, reservationView, type ReservationRow } from './reservation-views';
import { reservationPaymentCancelable } from '../payments/payments.service';

/**
 * El pago a medias de un reservado y la página del grupo («Seguir pagando»).
 * Con bitcoin, el cobro pasa a AUTHORIZING al abrir la factura y vuelve a
 * AWAITING_CAPTURE si se cierra sin pagarse («Pagar de otra forma» o caducada).
 */
describe('reservados: el pago a medias con bitcoin', () => {
  it('sin empezar: CREATED y también AWAITING_CAPTURE (su factura de bitcoin se cerró sin pagarse)', () => {
    expect([...NOT_STARTED]).toEqual(['CREATED', 'AWAITING_CAPTURE']);
    expect(continuable({ status: 'CREATED', provider: null })).toBe(true);
    expect(continuable({ status: 'AWAITING_CAPTURE', provider: 'BTCPAY' })).toBe(true);
  });

  it('con la factura de bitcoin abierta se puede volver a ella («Seguir pagando»: su página con el QR)', () => {
    expect(continuable({ status: 'AUTHORIZING', provider: 'BTCPAY' })).toBe(true);
  });

  it('en el banco con tarjeta, no: se espera a que conteste', () => {
    expect(continuable({ status: 'AUTHORIZING', provider: 'REDSYS' })).toBe(false);
    expect(continuable({ status: 'AUTHORIZING', provider: null })).toBe(false);
  });

  it('al anular la reserva o elegir otro pago se cancela el sin empezar o con la factura abierta; con la tarjeta en el banco, no', () => {
    expect(reservationPaymentCancelable({ status: 'CREATED', provider: null })).toBe(true);
    expect(reservationPaymentCancelable({ status: 'AWAITING_CAPTURE', provider: 'BTCPAY' })).toBe(true);
    expect(reservationPaymentCancelable({ status: 'AUTHORIZING', provider: 'BTCPAY' })).toBe(true);
    expect(reservationPaymentCancelable({ status: 'AUTHORIZING', provider: 'REDSYS' })).toBe(false);
    expect(reservationPaymentCancelable({ status: 'AUTHORIZED', provider: 'BTCPAY' })).toBe(false);
    expect(reservationPaymentCancelable({ status: 'CANCELED', provider: 'BTCPAY' })).toBe(false);
  });
});

describe('la página del grupo: «Seguir pagando» solo mientras la reserva se pueda pagar', () => {
  /** La reserva (con su local) y su pago a medias, como los leen groupView y openPaymentOf. */
  function groupOf(r: { status: string; paidCents: number }, open: { status: string; provider: string | null } | null) {
    const row = {
      id: '8c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f',
      ref: 'R-0042',
      status: r.status,
      nightDate: new Date('2026-12-21T00:00:00Z'),
      previousNightDate: null,
      dateChangedAt: null,
      packageName: 'Mesa consumo',
      kind: 'CREDIT',
      priceCents: 50000,
      creditCents: 40000,
      depositCents: 15000,
      paidCents: r.paidCents,
      entries: 2,
      items: [],
      customerName: 'Laura Gómez',
      customerPhone: '600112233',
      notes: null,
      tableLabel: null,
      source: 'WEB',
      soldByUserId: null,
      arrivedAt: null,
      noShowAuto: false,
      canceledAt: null,
      cancelReason: null,
      createdAt: new Date('2026-11-16T12:00:00Z'),
      guests: [],
      spends: [],
      wallet: null,
      promoter: null,
      payments: [],
      venue: { name: 'Sala Aurora', reservationsOpenMinute: 23 * 60 },
    };
    const tx = {
      reservation: { findUnique: async () => row },
      reservationPayment: {
        findMany: async () => (open ? [{ paymentId: 'p1', kind: 'DEPOSIT', payment: { status: open.status, qrToken: 'qr-1', provider: open.provider } }] : []),
      },
    };
    const prisma = { asSystem: async (fn: (t: typeof tx) => unknown) => fn(tx) };
    return new ReservationsService(prisma as never, {} as never, {} as never, {} as never).groupView('M'.repeat(32), new Date('2026-11-17T12:00:00Z'));
  }
  const bitcoinOpen = { status: 'AUTHORIZING', provider: 'BTCPAY' };

  it('sin pagar o con la señal pagada: vuelve al pago a medias (también con la factura de bitcoin abierta)', async () => {
    expect((await groupOf({ status: 'PENDING', paidCents: 0 }, bitcoinOpen))?.openPayUrl).toBe('/pay/qr-1');
    expect((await groupOf({ status: 'DEPOSIT_PAID', paidCents: 15000 }, { status: 'CREATED', provider: null }))?.openPayUrl).toBe('/pay/qr-1');
  });

  it('anulada (por el local o el cliente) o ya pagada: nunca, aunque quede un pago a medias', async () => {
    for (const r of [
      { status: 'CANCELED', paidCents: 0 },
      { status: 'CANCELED', paidCents: 15000 },
      { status: 'CLIENT_CANCELED', paidCents: 15000 },
      { status: 'PAID', paidCents: 50000 },
    ]) {
      const view = await groupOf(r, bitcoinOpen);
      expect(view?.openPayUrl).toBeNull();
      expect(view?.payable).toEqual([]);
    }
  });
});

describe('la vista de la reserva dice lo pagado con bitcoin (solo se devuelve en euros)', () => {
  const row = (payments?: Array<{ amountCents: number }>): ReservationRow => ({
    id: '8c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f',
    ref: 'R-0042',
    status: 'PAID',
    nightDate: new Date('2026-11-21T00:00:00Z'),
    previousNightDate: null,
    dateChangedAt: null,
    packageName: 'Mesa consumo',
    kind: 'CREDIT',
    priceCents: 50000,
    creditCents: 40000,
    depositCents: 15000,
    paidCents: 50000,
    entries: 4,
    items: [],
    customerName: 'Laura Gómez',
    customerPhone: '600112233',
    notes: null,
    tableLabel: null,
    source: 'WEB',
    soldByUserId: null,
    arrivedAt: null,
    noShowAuto: false,
    canceledAt: null,
    cancelReason: null,
    createdAt: new Date('2026-11-16T12:00:00Z'),
    guests: [],
    spends: [],
    wallet: { balanceCents: 50000, status: 'ACTIVE', qrToken: 'w-tok' },
    promoter: null,
    ...(payments ? { payments } : {}),
  });

  it('la señal con tarjeta y el resto con bitcoin: 350 € con bitcoin', () => {
    expect(reservationView(row([{ amountCents: 35000 }])).paidWithBitcoinCents).toBe(35000);
  });

  it('sin pagos con bitcoin (o sin el dato): 0', () => {
    expect(reservationView(row([])).paidWithBitcoinCents).toBe(0);
    expect(reservationView(row()).paidWithBitcoinCents).toBe(0);
  });

  it('se lee con la vista: solo los pagos ya pagados con bitcoin', () => {
    expect(RESERVATION_VIEW_INCLUDE.payments).toEqual({ where: { paidAt: { not: null }, payment: { provider: 'BTCPAY' } }, select: { amountCents: true } });
  });
});
