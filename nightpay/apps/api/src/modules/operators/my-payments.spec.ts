import { describe, expect, it } from 'vitest';
import type { CobroRow } from '@nightpay/contracts';
import { myPaymentsPage, saldoAsMyPayment, type CardPaymentLike } from './my-payments';

const card = (id: string, at: string, status = 'AUTHORIZED'): CardPaymentLike => ({
  id,
  amountCents: 4000,
  currency: 'EUR',
  status,
  provider: 'REDSYS',
  createdAt: new Date(at),
  qrToken: `qr-${id}`,
  qrExpiresAt: new Date(at),
});
const saldo = (id: string, at: string, status = 'ACCEPTED') =>
  ({ kind: 'SALDO', id, amountCents: 12_000, currency: 'EUR', status, createdAt: at }) as CobroRow;

describe('«Mis cobros» de la app de antes (/operators/me/payments)', () => {
  it('el cobro del saldo, con un estado que la app de antes sabe pintar: pagado o, anulado, reembolsado', () => {
    expect(saldoAsMyPayment(saldo('s1', '2026-10-17T01:00:00.000Z'))).toEqual({
      kind: 'SALDO',
      id: 's1',
      amountCents: 12_000,
      currency: 'EUR',
      status: 'AUTHORIZED',
      provider: null,
      createdAt: new Date('2026-10-17T01:00:00.000Z'),
      qrToken: null,
      qrExpiresAt: null,
    });
    expect(saldoAsMyPayment(saldo('s2', '2026-10-17T01:00:00.000Z', 'REVERSED')).status).toBe('REFUNDED');
  });

  it('tarjeta y saldo juntos, más nuevos primero (a la misma hora, el id mayor) y como mucho `limit`', () => {
    const page = myPaymentsPage(
      [card('c1', '2026-10-17T01:00:00.000Z'), card('c9', '2026-10-17T03:00:00.000Z', 'CANCELED')],
      [saldo('s5', '2026-10-17T03:00:00.000Z'), saldo('s0', '2026-10-17T00:00:00.000Z')],
      3,
    );
    expect(page.map((r) => `${r.kind} ${r.id} ${r.status}`)).toEqual(['SALDO s5 AUTHORIZED', 'PAYMENT c9 CANCELED', 'PAYMENT c1 AUTHORIZED']);
    // El de tarjeta, tal cual (la app de antes cancela con su id).
    expect(page[2]).toEqual({ kind: 'PAYMENT', ...card('c1', '2026-10-17T01:00:00.000Z') });
  });
});
