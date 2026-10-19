import { describe, it, expect, vi } from 'vitest';
import {
  cardRefundCapCents,
  cashPayoutCapCents,
  cashPayoutRefusal,
  cashTopUpOverLimit,
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
      outCents: 3_000,
      outWindowCents: 0,
    });
    const [strings, ...values] = $queryRaw.mock.calls[0]!;
    const sql = (strings as TemplateStringsArray).join('?');
    expect(sql).toMatch(/WITH RECURSIVE chain[\s\S]*"mergedIntoId" = c\.id/);
    expect(sql).toMatch(/FROM wallet_cash_topups[\s\S]*FROM wallet_payouts p[\s\S]*method = 'CASH' AND p\.status = 'DONE'/);
    expect(values[0]).toBe('w-1');
    expect(values).toContainEqual(new Date('2026-10-20T01:00:00Z'));
  });
});
