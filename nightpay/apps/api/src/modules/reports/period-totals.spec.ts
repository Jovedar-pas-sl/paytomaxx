import { describe, it, expect } from 'vitest';
import { chargedCents, invoicedCents, netCents, totalsFromRow, type PeriodTotals } from './period-totals';

/**
 * Noche de ejemplo: un servicio de 100 € con 5 € de propina, una barra de
 * 30 €, una recarga de saldo de 200 €; se devuelven 52,50 € del servicio
 * (la mitad: 50 € de importe y 2,50 € de propina); el cliente del saldo gasta
 * 120 € y se le devuelven 80 € en efectivo.
 */
const NIGHT: PeriodTotals = {
  paymentCount: 3,
  grossCents: 33_000,
  tipCents: 500,
  refundCount: 1,
  refundedCents: 5250,
  refundedTipCents: 250,
  walletCashPayoutCount: 1,
  walletCashPayoutCents: 8000,
  walletCashTopUpCount: 0,
  walletCashTopUpCents: 0,
  walletCardPayoutCount: 0,
  walletCardPayoutCents: 0,
};

describe('totales de un periodo (mismas reglas en métricas, Z e IVA)', () => {
  it('cobrado = importe + propinas', () => {
    expect(chargedCents(NIGHT)).toBe(33_500);
  });

  it('neto = cobrado − devoluciones − saldo devuelto en efectivo (recarga 200, devuelve 80 → cuenta 120)', () => {
    expect(netCents(NIGHT)).toBe(33_500 - 5250 - 8000);
  });

  it('el saldo devuelto a la tarjeta ya está en las devoluciones: no se resta dos veces', () => {
    const card: PeriodTotals = {
      ...NIGHT,
      refundCount: 2,
      refundedCents: 5250 + 8000,
      walletCashPayoutCount: 0,
      walletCashPayoutCents: 0,
      walletCardPayoutCount: 1,
      walletCardPayoutCents: 8000,
    };
    expect(netCents(card)).toBe(netCents(NIGHT));
    expect(invoicedCents(card)).toBe(invoicedCents(NIGHT));
  });

  it('facturado (base del IVA + IVA): sin propinas ni la parte de propina de lo devuelto', () => {
    // 330 € − 50 € devueltos de importe − 80 € de saldo devuelto.
    expect(invoicedCents(NIGHT)).toBe(33_000 - 5000 - 8000);
  });

  it('fila del SQL (sumas en bigint, o sin fila) → céntimos', () => {
    expect(
      totalsFromRow({
        paymentCount: 3,
        grossCents: 33_000n,
        tipCents: 500n,
        refundCount: 1,
        refundedCents: 5250n,
        refundedTipCents: 250n,
        walletCashPayoutCount: 1,
        walletCashPayoutCents: 8000n,
        walletCashTopUpCount: 0,
        walletCashTopUpCents: 0n,
        walletCardPayoutCount: 0,
        walletCardPayoutCents: 0n,
      }),
    ).toEqual(NIGHT);
    expect(netCents(totalsFromRow(undefined))).toBe(0);
  });

  it('una recarga en efectivo de 50 € cuenta como cobrada y facturada, igual que la de tarjeta', () => {
    const cash: PeriodTotals = { ...NIGHT, walletCashTopUpCount: 1, walletCashTopUpCents: 5000 };
    expect(chargedCents(cash)).toBe(33_500 + 5000);
    expect(netCents(cash)).toBe(33_500 + 5000 - 5250 - 8000);
    // Sin la propina de lo devuelto, como sin ella: la recarga en efectivo suma entera.
    expect(invoicedCents(cash)).toBe(invoicedCents(NIGHT) + 5000);
  });

  it('recarga en efectivo y se devuelve entera en efectivo («Me voy»): neto y facturado 0', () => {
    const t: PeriodTotals = {
      ...NIGHT,
      paymentCount: 0,
      grossCents: 0,
      tipCents: 0,
      refundCount: 0,
      refundedCents: 0,
      refundedTipCents: 0,
      walletCashTopUpCount: 1,
      walletCashTopUpCents: 8000,
    };
    expect(netCents(t)).toBe(0);
    expect(invoicedCents(t)).toBe(0);
  });
});
