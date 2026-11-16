import { formatMoney } from '@nightpay/contracts';
import { describe, expect, it } from 'vitest';
import { cardHow, saldoHow } from './outcome-how';
import { RECEIPT_FOOTER, howRows, paidTicket, payQrTicket, testTicket, ticketDateTime, ticketTime, topUpTicket } from './ticket';

const eur = (cents: number) => formatMoney(cents, { compact: true });

// 16-nov-2026 15:20 UTC = 16:20 en Madrid (horario de invierno, UTC+1).
const AT = new Date('2026-11-16T15:20:00Z');

describe('ticket impreso', () => {
  it('fecha y hora de Madrid, no las del aparato', () => {
    expect(ticketDateTime(AT)).toBe('16/11/2026 16:20');
    expect(ticketTime(new Date('2026-11-17T00:27:00Z'))).toBe('01:27');
  });

  it('el ticket del cliente no lleva quién cobró ni la hora repetida', () => {
    const how = cardHow({ payMethod: 'wallet', code: 'K7Q4', who: 'Carlos', at: AT });
    expect(howRows(how)).toEqual([{ label: 'Código del cobro', value: 'K7Q4' }]);
    const sinNombre = cardHow({ code: 'K7Q4', at: AT });
    expect(howRows(sinNombre).map((r) => r.label)).not.toContain('Hora');
  });

  it('comprobante de pago con tarjeta: título, cómo, desglose y pie', () => {
    const t = paidTicket({
      venue: 'Sala Uno',
      amountCents: 3630,
      how: cardHow({ code: 'K7Q4', who: 'Carlos', at: AT }),
      breakdown: '33 € + 3,30 € de comisión del servicio',
      reference: 'C-0023',
      at: AT,
    });
    expect(t).toMatchObject({
      title: 'Comprobante de pago',
      venue: 'Sala Uno',
      amountCents: 3630,
      how: 'Con tarjeta',
      notes: ['33 € + 3,30 € de comisión del servicio'],
      reference: 'C-0023',
      footer: RECEIPT_FOOTER,
    });
    expect(t.rows).toEqual([{ label: 'Código del cobro', value: 'K7Q4' }]);
    expect(t.footer.join(' ')).toContain('No es una factura');
  });

  it('comprobante con la ficha: lo que le queda y el número de la ficha', () => {
    const how = saldoHow({ fichaNumber: '1013', newBalanceCents: 2600, who: 'Ana', at: AT });
    const t = paidTicket({ amountCents: 1500, how, at: AT });
    expect(t.how).toBe('Con ficha nº 1013');
    expect(t.rows).toEqual([{ label: 'Le quedan', value: eur(2600) }]);
    expect(t.venue).toBeNull();
    expect(t.notes).toEqual([]);
  });

  it('el QR en papel lleva el enlace del cobro y hasta cuándo vale', () => {
    const t = payQrTicket({
      amountCents: 2000,
      qrUrl: 'https://api.example/pay/abc',
      expiresAt: new Date('2026-11-16T15:25:00Z'),
      at: AT,
    });
    expect(t.qrUrl).toBe('https://api.example/pay/abc');
    expect(t.qrNote).toBe('Vale hasta las 16:25');
    expect(t.title).toBe('Escanea para pagar');
    expect(payQrTicket({ amountCents: 2000, qrUrl: 'x', expiresAt: null, at: AT }).qrNote).toBeNull();
  });

  it('carga de saldo: forma de pago, ficha, código, saldo y la comisión si la hubo', () => {
    const t = topUpTicket({ amountCents: 5000, method: 'cash', ficha: '0522', code: 'K7Q-4M2', balanceCents: 7000, at: AT });
    expect(t.title).toBe('Carga de saldo');
    expect(t.how).toBe('En efectivo');
    expect(t.rows).toEqual([
      { label: 'Ficha', value: 'nº 0522' },
      { label: 'Código del saldo', value: 'K7Q-4M2' },
      { label: 'Saldo ahora', value: eur(7000) },
    ]);
    const conComision = topUpTicket({ amountCents: 5000, feeCents: 600, method: 'card', balanceCents: null, at: AT });
    expect(conComision.how).toBe('Con tarjeta');
    expect(conComision.rows).toEqual([
      { label: 'Comisión del servicio', value: eur(600) },
      { label: 'Pagado', value: eur(5600) },
    ]);
  });

  it('pagado con bitcoin desde su móvil: el papel dice «Con bitcoin», nunca «Con tarjeta»', () => {
    // La carga con el QR que el cliente pagó con bitcoin (lo dice el sondeo del QR).
    const carga = topUpTicket({ amountCents: 5000, feeCents: 600, method: 'bitcoin', ficha: '0522', balanceCents: 5000, at: AT });
    expect(carga.how).toBe('Con bitcoin');
    expect(carga.rows).toEqual([
      { label: 'Comisión del servicio', value: eur(600) },
      { label: 'Pagado', value: eur(5600) },
      { label: 'Ficha', value: 'nº 0522' },
      { label: 'Saldo ahora', value: eur(5000) },
    ]);
    // Y el comprobante de un cobro: lo que diga la tarjeta de «cómo se pagó».
    const cobro = paidTicket({ amountCents: 2000, how: cardHow({ payMethod: 'bitcoin', code: 'K7Q4', who: 'Carlos', at: AT }), at: AT });
    expect(cobro.how).toBe('Con bitcoin');
    expect(cobro.rows).toEqual([{ label: 'Código del cobro', value: 'K7Q4' }]);
  });

  it('la prueba de impresión no es un cobro y su QR es la propia app', () => {
    const t = testTicket(AT, 'https://operator.example');
    expect(t.amountCents).toBe(0);
    expect(t.how).toBe('Esto no es un cobro');
    expect(t.qrUrl).toBe('https://operator.example');
  });
});
