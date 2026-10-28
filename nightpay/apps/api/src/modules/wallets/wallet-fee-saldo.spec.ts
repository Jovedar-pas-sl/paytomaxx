import { describe, expect, it } from 'vitest';
import { reversalCredits, serviceFeeSaldoCents, serviceFeeSpendCents, type SaldoCredit } from './wallet-fee-saldo';

/**
 * Lo que de un gasto del saldo sale de lo cargado CON «Comisión del servicio»
 * (ya la pagó el cliente: el local no paga el % antiguo) y lo que sale de lo
 * cargado SIN ella (el % antiguo, como siempre). Se gasta primero lo más
 * antiguo; lo ya gastado o devuelto es lo más antiguo.
 */

const at = (h: number) => new Date(Date.UTC(2026, 9, 26, h));
const plain = (h: number, cents: number): SaldoCredit => ({ at: at(h), cents, withServiceFee: false });
const fee = (h: number, cents: number): SaldoCredit => ({ at: at(h), cents, withServiceFee: true });

describe('de qué saldo sale un gasto (lo más antiguo primero)', () => {
  it('todo cargado sin comisión (antes de encenderla): nada sale del de la comisión', () => {
    expect(serviceFeeSpendCents([plain(20, 5_000)], 5_000, 3_300)).toBe(0);
  });

  it('todo cargado con comisión: todo sale de ahí (también con el interruptor ya apagado)', () => {
    expect(serviceFeeSpendCents([fee(21, 5_000)], 5_000, 3_300)).toBe(3_300);
  });

  it('20 € de antes y 50 € con comisión: un gasto de 30 € son 20 € sin y 10 € con', () => {
    const credits = [plain(20, 2_000), fee(22, 5_000)];
    expect(serviceFeeSpendCents(credits, 7_000, 3_000)).toBe(1_000);
    // Ya se gastaron 15 € (de los 20 € de antes): quedan 5 € sin y 50 € con.
    expect(serviceFeeSpendCents(credits, 5_500, 3_000)).toBe(2_500);
  });

  it('con, luego sin (apagada después): primero lo de la comisión, que es lo más antiguo', () => {
    const credits = [fee(20, 5_000), plain(23, 2_000)];
    expect(serviceFeeSpendCents(credits, 7_000, 6_000)).toBe(5_000);
  });

  it('saldo de antes de que se apuntaran las recargas (o sin ellas): sin comisión y lo más antiguo', () => {
    // 30 € que no salen en las recargas + 50 € con comisión.
    expect(serviceFeeSpendCents([fee(22, 5_000)], 8_000, 4_000)).toBe(1_000);
    expect(serviceFeeSpendCents([], 2_000, 1_000)).toBe(0);
  });

  it('el orden lo da la fecha, no cómo llegan; lo anulado (0 o menos) no cuenta', () => {
    const credits = [fee(22, 5_000), plain(20, 2_000), plain(21, 0)];
    expect(serviceFeeSpendCents(credits, 7_000, 3_000)).toBe(1_000);
  });

  it('nunca más que el gasto ni que lo que queda', () => {
    expect(serviceFeeSpendCents([fee(22, 5_000)], 5_000, 9_000)).toBe(5_000);
    expect(serviceFeeSpendCents([fee(22, 5_000)], 0, 1_000)).toBe(0);
    expect(serviceFeeSpendCents([fee(22, 5_000)], 5_000, 0)).toBe(0);
  });
});

describe('la parte del consumo (sin la propina) pagada con saldo de la comisión', () => {
  it('se reparte en proporción si el gasto lleva propina; entero si es todo de un lado', () => {
    // Gasto de 35 € (33 + 2 de propina), 17,50 € con comisión → la mitad de los 33 €.
    expect(serviceFeeSaldoCents({ amountCents: 3_300, tipCents: 200, feeSpendCents: 1_750 })).toBe(1_650);
    expect(serviceFeeSaldoCents({ amountCents: 3_300, tipCents: 200, feeSpendCents: 3_500 })).toBe(3_300);
    expect(serviceFeeSaldoCents({ amountCents: 3_300, tipCents: 0, feeSpendCents: 0 })).toBe(0);
  });
});

describe('un consumo anulado devuelve al saldo su reparto original', () => {
  it('vuelve lo que salió de cada lado: primero lo de sin comisión, luego lo de con ella', () => {
    // 33 € gastados: 20 € de antes de encenderla + 13 € con ella.
    expect(reversalCredits([{ at: at(23), amountCents: 3_300, tipCents: 0, serviceFeeSaldoCents: 1_300 }])).toEqual([
      plain(23, 2_000),
      fee(23, 1_300),
    ]);
  });

  it('la propina vuelve en la misma proporción que el importe', () => {
    // 33 € + 2 € de propina, la mitad del importe con comisión → 17,50 € con ella.
    expect(reversalCredits([{ at: at(23), amountCents: 3_300, tipCents: 200, serviceFeeSaldoCents: 1_650 }])).toEqual([
      plain(23, 1_750),
      fee(23, 1_750),
    ]);
  });

  it('todo de un lado, de antes de la comisión (sin el campo) o solo propina: sin repartir', () => {
    expect(reversalCredits([{ at: at(23), amountCents: 3_300, tipCents: 0, serviceFeeSaldoCents: 3_300 }])).toEqual([fee(23, 3_300)]);
    expect(reversalCredits([{ at: at(23), amountCents: 3_300, tipCents: 0, serviceFeeSaldoCents: null }])).toEqual([plain(23, 3_300)]);
    expect(reversalCredits([{ at: at(23), amountCents: 0, tipCents: 500, serviceFeeSaldoCents: 0 }])).toEqual([plain(23, 500)]);
  });

  it('anular después de otro gasto: volver a gastar sale como el reparto original', () => {
    // 20 € sin comisión y 50 € con ella; se gastan 33 € (20 + 13) y otros 33 € (con ella): quedan 4 €.
    const loads = [plain(20, 2_000), fee(21, 5_000)];
    expect(serviceFeeSpendCents(loads, 7_000, 3_300)).toBe(1_300);
    expect(serviceFeeSpendCents(loads, 3_700, 3_300)).toBe(3_300);
    // Se anula el primero: vuelven 20 € sin y 13 € con; en el saldo, 37 €.
    const credits = [...loads, ...reversalCredits([{ at: at(23), amountCents: 3_300, tipCents: 0, serviceFeeSaldoCents: 1_300 }])];
    expect(serviceFeeSpendCents(credits, 3_700, 3_300)).toBe(1_300);
  });
});
