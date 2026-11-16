import { describe, expect, it } from 'vitest';
import { cashRefundAlertText } from './bitcoin-cash-alert';

describe('aviso por Telegram de cada devolución en efectivo de un pago con bitcoin', () => {
  it('quién, cuánto, el motivo y el cobro; sin datos del cliente', () => {
    const text = cashRefundAlertText({
      venueName: 'Sala Aurora',
      amountCents: 4_500,
      reason: 'Cobro equivocado',
      target: { kind: 'payment', ref: 'C-0012' },
      doneBy: 'Ana',
      approvedBy: null,
    });
    expect(text).toBe(
      [
        '⚠️ Sala Aurora: Devolución en efectivo de un pago con bitcoin',
        '45,00 € de la caja · Cobro C-0012',
        'Motivo: Cobro equivocado',
        'La hizo Ana',
        'El bitcoin se queda en la cartera del local.',
      ].join('\n'),
    );
    expect(text).not.toMatch(/recibo|código/i);
  });

  it('de más de 100 €: también quién la aprobó; el bitcoin sin cobro, con su factura', () => {
    const text = cashRefundAlertText({
      venueName: 'Sala Aurora',
      amountCents: 12_000,
      reason: 'Cobrado dos veces',
      target: { kind: 'invoice', invoiceId: 'Kd8sY5DN6jLHfQ' },
      doneBy: 'Ana',
      approvedBy: 'Marta',
    });
    expect(text).toContain('120,00 € de la caja · Bitcoin sin cobro (factura Kd8sY5DN6jLHfQ)');
    expect(text).toContain('La hizo Ana · la aprobó Marta');
  });
});
