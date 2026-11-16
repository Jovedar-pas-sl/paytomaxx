import { describe, it, expect, vi } from 'vitest';
import {
  bitcoinPartCents,
  cardRefundCapCents,
  cashPayoutCapCents,
  cashPayoutNote,
  cashPayoutRefusal,
  cashTopUpOverLimit,
  payoutAmounts,
  unspentCashCents,
  walletCash,
  type WalletCash,
} from './wallet-cash-limits';

/** El efectivo de un saldo: entra y sale como mucho lo que entró en efectivo, y nunca 1.000 € en 24 h. */

const cash = (o: Partial<WalletCash> = {}): WalletCash => ({ inCents: 0, inWindowCents: 0, outCents: 0, outWindowCents: 0, ...o });

describe('lo que entró en efectivo y sigue en el saldo', () => {
  it('lo gastado cuenta antes como dinero de la tarjeta; lo devuelto en efectivo ya salió', () => {
    // 500 con tarjeta, gasta 500, 500 en efectivo: queda el efectivo entero.
    expect(unspentCashCents(50_000, cash({ inCents: 50_000 }))).toBe(50_000);
    // 300 en efectivo y 200 con tarjeta, gasta 400: quedan 100, que cuentan como efectivo.
    expect(unspentCashCents(10_000, cash({ inCents: 30_000 }))).toBe(10_000);
    expect(unspentCashCents(30_000, cash({ inCents: 30_000, outCents: 20_000 }))).toBe(10_000);
    expect(unspentCashCents(30_000, cash())).toBe(0);
  });
});

describe('devolver en efectivo y a la tarjeta', () => {
  it('en efectivo, lo que entró en efectivo; a la tarjeta, el resto: entre los dos, todo el saldo', () => {
    const c = cash({ inCents: 10_000 });
    expect(cashPayoutCapCents(30_000, c)).toBe(10_000);
    expect(cardRefundCapCents(30_000, c)).toBe(20_000);
    expect(cashPayoutCapCents(30_000, c) + cardRefundCapCents(30_000, c)).toBe(30_000);
  });

  it('en efectivo, menos de 1.000 € en 24 h contando lo ya devuelto', () => {
    expect(cashPayoutCapCents(150_000, cash({ inCents: 150_000 }))).toBe(99_999);
    expect(cashPayoutCapCents(150_000, cash({ inCents: 200_000, outCents: 50_000, outWindowCents: 50_000 }))).toBe(49_999);
    expect(cashPayoutCapCents(150_000, cash({ inCents: 250_000, outCents: 99_999, outWindowCents: 99_999 }))).toBe(0);
  });

  it('el porqué cuando no sale nada en efectivo', () => {
    expect(cashPayoutRefusal(30_000, cash())).toMatch(/entró con tarjeta/);
    expect(cashPayoutRefusal(30_000, cash({ inCents: 200_000, outCents: 99_999, outWindowCents: 99_999 }))).toMatch(
      /ya se le devolvieron 999,99 €/,
    );
  });

  it('la salida de recepción dice antes por qué no sale todo en efectivo', () => {
    // Todo en efectivo, o nada que devolver: sin aviso.
    expect(cashPayoutNote(3_500, cash({ inCents: 5_000 }))).toBeNull();
    expect(cashPayoutNote(0, cash({ inCents: 5_000 }))).toBeNull();
    // 20 € en efectivo y 15 € con tarjeta: los 15 €, el dueño a la tarjeta.
    expect(cashPayoutNote(3_500, cash({ inCents: 2_000 }))).toMatch(/otros 15,00 € entraron con tarjeta/);
    // Todo con tarjeta: el mismo porqué que el botón del encargado.
    expect(cashPayoutNote(3_500, cash())).toBe(cashPayoutRefusal(3_500, cash()));
    // Lo que manda es el tope de 24 h.
    expect(cashPayoutNote(150_000, cash({ inCents: 200_000, outCents: 50_000, outWindowCents: 50_000 }))).toMatch(
      /como mucho 499,99 €.*devolvieron 500,00 €/,
    );
  });
});

describe('saldo cargado con bitcoin: ni a la tarjeta ni en efectivo («habla con el encargado»)', () => {
  it('lo que entró con bitcoin no sale «A la tarjeta»: el bitcoin no pasó por el banco', () => {
    // 50 € con tarjeta + 30 € con bitcoin, nada gastado.
    const c = cash({ bitcoinInCents: 3_000 });
    expect(bitcoinPartCents(8_000, c)).toBe(3_000);
    expect(cardRefundCapCents(8_000, c)).toBe(5_000);
    expect(payoutAmounts(8_000, c)).toEqual({ cashOutCents: 0, cardRefundCents: 5_000, cashLaterCents: 0, bitcoinCents: 3_000 });
    // Lo gastado cuenta antes como dinero de la tarjeta: con 20 € gastados quedan 30 € de tarjeta y los 30 € de bitcoin.
    expect(cardRefundCapCents(6_000, c)).toBe(3_000);
    // Gastado casi todo: lo que queda es bitcoin, no tarjeta.
    expect(cardRefundCapCents(2_000, c)).toBe(0);
    expect(bitcoinPartCents(2_000, c)).toBe(2_000);
  });

  it('los textos dicen «entró con bitcoin» y qué hacer; nunca «entró con tarjeta» por el bitcoin', () => {
    const solo = cash({ bitcoinInCents: 3_000 });
    const refusal = cashPayoutRefusal(3_000, solo);
    expect(refusal).toBe('Este saldo entró con bitcoin: no se devuelve en efectivo ni a la tarjeta. Para devolverlo, habla con el encargado: la devolución de bitcoin aún no está en la app.');
    expect(cashPayoutNote(3_000, solo)).toBe(refusal);
    const mixto = cashPayoutRefusal(8_000, cash({ bitcoinInCents: 3_000 }));
    expect(mixto).toContain('50,00 € entraron con tarjeta (los devuelve el dueño «A la tarjeta»)');
    expect(mixto).toContain('30,00 € con bitcoin');
    expect(mixto).toContain('habla con el encargado');
    // 20 € en efectivo y 15 € con bitcoin: los 15 €, con el encargado.
    expect(cashPayoutNote(3_500, cash({ inCents: 2_000, bitcoinInCents: 1_500 }))).toBe(
      'Los otros 15,00 € entraron con bitcoin: no se devuelven en efectivo ni a la tarjeta. Para devolverlos, habla con el encargado: la devolución de bitcoin aún no está en la app.',
    );
  });
});

describe('recargar en efectivo: el total de 24 h no llega a 1.000 €', () => {
  it('cabe, no cabe y cuánto cabe aún', () => {
    expect(cashTopUpOverLimit(99_999, cash())).toBeNull();
    expect(cashTopUpOverLimit(1, cash({ inWindowCents: 99_998 }))).toBeNull();
    expect(cashTopUpOverLimit(1, cash({ inWindowCents: 99_999 }))).toMatch(/ya lleva 999,99 €.*no puede llegar a 1.000 €/);
    expect(cashTopUpOverLimit(60_000, cash({ inWindowCents: 50_000 }))).toMatch(/como mucho 499,99 € más/);
  });
});

describe('la lectura: el saldo y los sumados a él, en una consulta', () => {
  it('suma recargas (con sus anulaciones) y lo devuelto en efectivo, de toda la cadena, con la ventana de 24 h', async () => {
    const now = new Date('2026-10-21T01:00:00Z');
    const $queryRaw = vi.fn(async (_s: TemplateStringsArray, ..._v: unknown[]) => [
      { inCents: 12_000n, inWindowCents: 5_000n, outCents: 3_000n, outWindowCents: 0n },
    ]);
    await expect(walletCash({ $queryRaw } as never, 'w-1', now)).resolves.toEqual({
      inCents: 12_000,
      inWindowCents: 5_000,
      // Sin la columna (lectura de antes): lo pagado es el saldo.
      inWindowPaidCents: 5_000,
      outCents: 3_000,
      outWindowCents: 0,
      // Sin la columna, nada entró con bitcoin.
      bitcoinInCents: 0,
    });
    const [strings, ...values] = $queryRaw.mock.calls[0]!;
    const sql = (strings as TemplateStringsArray).join('?');
    expect(sql).toMatch(/WITH RECURSIVE chain[\s\S]*"mergedIntoId" = c\.id/);
    expect(sql).toMatch(/FROM wallet_cash_topups[\s\S]*FROM wallet_payouts p[\s\S]*method = 'CASH' AND p\.status = 'DONE'/);
    expect(values[0]).toBe('w-1');
    expect(values).toContainEqual(new Date('2026-10-20T01:00:00Z'));
  });
});

describe('tope legal del efectivo con la «Comisión del servicio»', () => {
  it('cuenta lo que pagó el cliente (saldo + comisión), no solo el saldo', () => {
    // 800 € de saldo + 96 € de comisión ya pagados: 100 € + 12 € más llegan a 1.008 €.
    expect(cashTopUpOverLimit(11_200, { inWindowCents: 80_000, inWindowPaidCents: 89_600 })).toMatch(/89[6.,]+00 €/);
    expect(cashTopUpOverLimit(10_300, { inWindowCents: 80_000, inWindowPaidCents: 89_600 })).toBeNull();
    // Sin el campo, el saldo (como antes).
    expect(cashTopUpOverLimit(11_200, { inWindowCents: 80_000 })).toBeNull();
  });
});
