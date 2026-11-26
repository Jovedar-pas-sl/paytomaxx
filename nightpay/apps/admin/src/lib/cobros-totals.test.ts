import { describe, expect, it } from 'vitest';
import type { CobroRow } from '@nightpay/contracts';
import { cobroPaidCents, cobrosTotals, totalsText } from './cobros-totals';
import { formatEur } from './money';

// El total de la lista de Cobros (idea 17): dos cifras que NUNCA se suman. El
// saldo ya entró al recargarlo: sumarlo otra vez al gastarlo lo contaría dos veces.

const row = (over: Partial<CobroRow>): CobroRow =>
  ({ kind: 'PAYMENT', id: 'x', status: 'AUTHORIZED', amountCents: 0, tipCents: 0, currency: 'EUR', isTopUp: false, ...over }) as CobroRow;
/** El espacio duro del «€» no cuenta al comparar. */
const plain = (s: string) => s.replace(/\u00a0/g, ' ');

describe('el total de la lista de Cobros', () => {
  it('«Importe» es lo que pagó el cliente: importe, propina y comisión del servicio', () => {
    expect(cobroPaidCents(row({ amountCents: 4000, tipCents: 500, serviceFeeCents: 120 }))).toBe(4620);
    expect(cobroPaidCents(row({ amountCents: 2000 }))).toBe(2000);
  });

  it('una recarga con tarjeta de 40 € y dos cobros con saldo de 20 €: dos cifras, sin sumarlas', () => {
    const rows = [
      row({ id: 'a', isTopUp: true, amountCents: 4000 }),
      row({ id: 'b', kind: 'SALDO', status: 'ACCEPTED', amountCents: 2000 }),
      row({ id: 'c', kind: 'SALDO', status: 'ACCEPTED', amountCents: 2000 }),
    ];
    expect(cobrosTotals(rows)).toEqual({ count: 3, cardCents: 4000, bitcoinCents: 0, saldoCents: 4000 });
    expect(plain(totalsText(rows, false, formatEur))).toBe('3 cobros · 40,00 € con tarjeta o móvil · 40,00 € con saldo');
  });

  it('Cancelado, Sin pagar y Rechazado no suman; Devuelto en parte sí; el saldo anulado tampoco', () => {
    const rows = [
      row({ id: 'a', status: 'CANCELED', amountCents: 1000 }),
      row({ id: 'b', status: 'CREATED', amountCents: 1000 }),
      row({ id: 'c', status: 'FAILED', amountCents: 1000 }),
      row({ id: 'd', status: 'REFUNDED', amountCents: 1000 }),
      row({ id: 'e', status: 'PARTIALLY_REFUNDED', amountCents: 3000, tipCents: 200 }),
      row({ id: 'f', kind: 'SALDO', status: 'REVERSED', amountCents: 900 }),
    ];
    expect(cobrosTotals(rows)).toEqual({ count: 6, cardCents: 3200, bitcoinCents: 0, saldoCents: 0 });
    expect(plain(totalsText(rows, false, formatEur))).toBe('6 cobros · 32,00 € con tarjeta o móvil');
  });

  it('con el filtro Bitcoin, lo pagado con bitcoin nunca se llama «con tarjeta o móvil»', () => {
    const rows = [
      row({ id: 'a', method: 'BITCOIN', amountCents: 2500 }),
      row({ id: 'b', method: 'BITCOIN', status: 'PARTIALLY_REFUNDED', amountCents: 1000, tipCents: 100 }),
    ];
    expect(cobrosTotals(rows)).toEqual({ count: 2, cardCents: 0, bitcoinCents: 3600, saldoCents: 0 });
    const text = plain(totalsText(rows, false, formatEur));
    expect(text).toBe('2 cobros · 36,00 € con bitcoin');
    expect(text).not.toContain('tarjeta');
    // Mezclado con tarjeta y saldo: cada uno en su cifra, la misma suma.
    const mixed = [...rows, row({ id: 'c', method: 'CARD', amountCents: 1000 }), row({ id: 'd', kind: 'SALDO', status: 'ACCEPTED', amountCents: 500 })];
    expect(plain(totalsText(mixed, false, formatEur))).toBe('4 cobros · 10,00 € con tarjeta o móvil · 36,00 € con bitcoin · 5,00 € con saldo');
  });

  it('cada parte solo si no es 0; uno solo, en singular; con más páginas, «Los 50 últimos»', () => {
    expect(totalsText([], false, formatEur)).toBe('0 cobros');
    expect(plain(totalsText([row({ kind: 'SALDO', status: 'ACCEPTED', amountCents: 1500 })], false, formatEur))).toBe('1 cobro · 15,00 € con saldo');
    const fifty = Array.from({ length: 50 }, (_, i) => row({ id: String(i), amountCents: 100 }));
    expect(plain(totalsText(fifty, true, formatEur))).toBe('Los 50 últimos · 50,00 € con tarjeta o móvil');
  });
});
