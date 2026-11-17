import type { CobroDetail } from '@nightpay/contracts';
import { describe, expect, it } from 'vitest';
import { cardHow, saldoHow } from './outcome-how';
import {
  RECEIPT_FOOTER,
  TOP_UP_FOOTER,
  howRows,
  paidTicket,
  payQrTicket,
  receiptFromDetail,
  testTicket,
  ticketDateTime,
  ticketMoney,
  ticketTime,
  topUpTicket,
} from './ticket';

// 16-nov-2026 15:20 UTC = 16:20 en Madrid (horario de invierno, UTC+1).
const AT = new Date('2026-11-16T15:20:00Z');
const m = (cents: number) => ticketMoney(cents);

function detail(over: Partial<CobroDetail> = {}): CobroDetail {
  return {
    audience: 'STAFF',
    kind: 'PAYMENT',
    id: 'p1',
    ref: 'C-0063',
    confirmationCode: 'DCE',
    status: 'AUTHORIZED',
    createdAt: '2026-11-16T15:19:00Z',
    paidAt: '2026-11-16T15:20:00Z',
    venueName: 'Luna Valencia',
    sections: [],
    lines: [
      { label: 'Gin tonic', qty: 2, unitCents: 1200, amountCents: 2400, category: 'VENUE_BAR', invitedName: null },
      { label: 'Copa con invitación', qty: 1, unitCents: 1500, amountCents: 1500, category: 'VENUE_BAR', invitedName: 'Lola' },
    ],
    service: '2× Gin tonic · Copa con invitación',
    isTopUp: false,
    amountCents: 3900,
    tipCents: 200,
    serviceFeeCents: 390,
    totalCents: 4490,
    chargedBy: { name: 'Carlos', role: 'WAITER' },
    method: { method: 'CARD', label: 'Tarjeta Visa ••4242', cardBrand: 'Visa', cardLast4: '4242', fichaNumber: null, via: 'QR', walletHint: null },
    undo: [],
    flags: [],
    ...over,
  } as CobroDetail;
}

describe('ticket impreso', () => {
  it('fecha y hora de Madrid, no las del aparato; importes siempre con céntimos', () => {
    expect(ticketDateTime(AT)).toBe('16/11/2026 16:20');
    expect(ticketTime(new Date('2026-11-17T00:27:00Z'))).toBe('01:27');
    expect(m(2400)).toMatch(/^24,00\s€$/);
  });

  it('cómo se pagó, dicho como en un ticket y sin quién cobró', () => {
    const rows = howRows(cardHow({ payMethod: 'wallet', code: 'K7Q4', who: 'Carlos', at: AT }));
    expect(rows).toEqual([
      { label: 'Pago', value: 'Apple Pay o Google Pay' },
      { label: 'Código', value: 'K7Q4' },
    ]);
    const ficha = howRows(saldoHow({ fichaNumber: '925977', newBalanceCents: 0, who: 'Ana', at: AT }));
    expect(ficha[0]).toEqual({ label: 'Pago', value: 'Ficha nº 925977' });
    expect(ficha).toContainEqual({ label: 'Saldo restante', value: expect.stringMatching(/^0\s€$/) });
    expect(ficha.map((r) => r.value).join(' ')).not.toContain('Ana');
  });

  it('PAGADO: lo comprado, subtotal, propina, comisión, total y pago', () => {
    const t = paidTicket({
      venue: 'Luna Valencia',
      number: 'C-0063',
      lines: [{ label: 'Gin tonic', qty: 2, unitCents: 1200, amountCents: 2400 }],
      amountCents: 2400,
      tipCents: 200,
      serviceFeeCents: 240,
      totalCents: 2840,
      how: cardHow({ code: 'DCE', at: AT }),
      at: AT,
    });
    expect(t.title).toBe('Ticket');
    expect(t.lines).toHaveLength(1);
    expect(t.amounts).toEqual([
      { label: 'Subtotal', value: m(2400) },
      { label: 'Propina', value: m(200) },
      { label: 'Comisión del servicio', value: m(240) },
    ]);
    expect(t.totalCents).toBe(2840);
    expect(t.payment).toEqual([
      { label: 'Pago', value: 'Tarjeta' },
      { label: 'Código', value: 'DCE' },
    ]);
    expect(t.footer).toBe(RECEIPT_FOOTER);
  });

  it('sin la cuenta (TPV), una línea con el importe; sin propina ni comisión, solo el total', () => {
    const t = paidTicket({ totalCents: 2450, at: AT });
    expect(t.lines).toEqual([{ label: 'Consumición', qty: 1, amountCents: 2450 }]);
    expect(t.amounts).toEqual([]);
  });

  it('desde el detalle de Cobros: líneas, tarjeta, autorización, código y el pie', () => {
    const t = receiptFromDetail(detail({ bank: { authCode: '123456', secure3ds: true, cardCountry: '724', provider: 'REDSYS', bankOrder: 'x' } }));
    expect(t.venue).toBe('Luna Valencia');
    expect(t.number).toBe('C-0063');
    expect(t.lines.map((l) => l.label)).toEqual(['Gin tonic', 'Copa con invitación']);
    // A quién se invitó no sale en el papel del cliente.
    expect(JSON.stringify(t)).not.toContain('Lola');
    expect(JSON.stringify(t)).not.toContain('Carlos');
    expect(t.totalCents).toBe(4490);
    expect(t.payment).toEqual([
      { label: 'Tarjeta', value: 'Visa •••• 4242' },
      { label: 'Autorización', value: '123456' },
      { label: 'Código', value: 'DCE' },
    ]);
  });

  it('desde el detalle: con ficha, el saldo que queda y lo devuelto', () => {
    const t = receiptFromDetail(
      detail({
        kind: 'SALDO',
        tipCents: 0,
        serviceFeeCents: 0,
        totalCents: 3900,
        method: { method: 'SALDO', label: 'Saldo K7Q-•••', cardBrand: null, cardLast4: null, fichaNumber: '925977', via: 'NFC sin PIN', walletHint: 'K7Q-•••' },
        balance: { beforeCents: 5000, afterCents: 1100 },
        undo: [{ kind: 'VOID', at: '2026-11-16T15:30:00Z', amountCents: 1500 } as CobroDetail['undo'][number]],
      }),
    );
    expect(t.amounts).toEqual([]);
    expect(t.payment).toEqual([
      { label: 'Pago', value: 'Ficha nº 925977' },
      { label: 'Código', value: 'DCE' },
      { label: 'Saldo restante', value: m(1100) },
      { label: 'Devuelto al saldo', value: m(1500) },
    ]);
  });

  it('en PAGADO, el saldo que queda lo pone la pantalla si el detalle no lo trae', () => {
    const saldo = detail({ kind: 'SALDO', tipCents: 0, serviceFeeCents: 0, totalCents: 3900, bank: null });
    expect(receiptFromDetail(saldo).payment.map((r) => r.label)).not.toContain('Saldo restante');
    expect(receiptFromDetail(saldo, { balanceAfterCents: 2600 }).payment).toContainEqual({ label: 'Saldo restante', value: m(2600) });
    // Si el detalle lo trae, manda el detalle.
    const conSaldo = detail({ kind: 'SALDO', balance: { beforeCents: 5000, afterCents: 1100 } });
    expect(receiptFromDetail(conSaldo, { balanceAfterCents: 9999 }).payment).toContainEqual({ label: 'Saldo restante', value: m(1100) });
    expect(receiptFromDetail(saldo, { balanceAfterCents: null }).payment.map((r) => r.label)).not.toContain('Saldo restante');
  });

  it('desde el detalle: una recarga es «Carga de saldo» con su saldo nuevo', () => {
    const t = receiptFromDetail(detail({ isTopUp: true, lines: [], amountCents: 5000, tipCents: 0, serviceFeeCents: 0, totalCents: 5000, balance: { beforeCents: 0, afterCents: 5000 } }));
    expect(t.title).toBe('Carga de saldo');
    expect(t.lines).toEqual([{ label: 'Carga de saldo', qty: 1, amountCents: 5000 }]);
    expect(t.payment).toContainEqual({ label: 'Saldo ahora', value: m(5000) });
    expect(t.footer).toBe(TOP_UP_FOOTER);
  });

  it('el QR en papel lleva el enlace del cobro y hasta cuándo vale', () => {
    const t = payQrTicket({ amountCents: 2000, qrUrl: 'https://api.example/pay/abc', expiresAt: new Date('2026-11-16T15:25:00Z'), at: AT });
    expect(t.qrUrl).toBe('https://api.example/pay/abc');
    expect(t.qrNote).toBe('Vale hasta las 16:25');
    expect(t.totalCents).toBe(2000);
    expect(payQrTicket({ amountCents: 2000, qrUrl: 'x', expiresAt: null, at: AT }).qrNote).toBeNull();
  });

  it('carga en recepción: forma de pago, ficha, código, saldo y la comisión si la hubo', () => {
    const t = topUpTicket({ amountCents: 5000, method: 'cash', ficha: '0522', code: 'K7Q-4M2', balanceCents: 7000, at: AT });
    expect(t.totalCents).toBe(5000);
    expect(t.payment).toEqual([
      { label: 'Pago', value: 'Efectivo' },
      { label: 'Ficha', value: 'nº 0522' },
      { label: 'Código del saldo', value: 'K7Q-4M2' },
      { label: 'Saldo ahora', value: m(7000) },
    ]);
    const conComision = topUpTicket({ amountCents: 5000, feeCents: 600, method: 'card', balanceCents: null, at: AT });
    expect(conComision.totalCents).toBe(5600);
    expect(conComision.amounts).toContainEqual({ label: 'Comisión del servicio', value: m(600) });
  });

  it('la prueba de impresión no es un cobro y su QR es la propia app', () => {
    const t = testTicket(AT, 'https://operator.example');
    expect(t.payment).toEqual([{ label: 'Pago', value: 'Esto no es un cobro' }]);
    expect(t.qrUrl).toBe('https://operator.example');
  });
});
