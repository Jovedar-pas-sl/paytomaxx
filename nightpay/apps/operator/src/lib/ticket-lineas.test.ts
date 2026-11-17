import { describe, expect, it } from 'vitest';
import { EMPTY_CUENTA, PROPINAS, addAmount, addItem, ticketLinesOf, type CartaItem } from './cuenta';
import { paidTargetOf } from './paid-detail';

const COPA: CartaItem = { id: 'c-copa', name: 'Copa', priceCents: 1000, category: 'VENUE_BAR' };
const HORA: CartaItem = { id: 'c-1h', name: 'Servicio', priceCents: 12_000, category: 'CHICA_SERVICE', durationMin: 60 };

describe('el ticket impreso de un cobro', () => {
  it('la cuenta, línea a línea: cantidad, precio de una e importe', () => {
    let cuenta = addItem(addItem(EMPTY_CUENTA, COPA), COPA);
    cuenta = addItem(cuenta, HORA);
    cuenta = addAmount(cuenta, 'VENUE_FOOD', 750);
    cuenta = addAmount(cuenta, PROPINAS, 200);
    expect(ticketLinesOf(cuenta)).toEqual([
      { label: 'Copa', qty: 2, unitCents: 1000, amountCents: 2000 },
      { label: 'Servicio · 1 h', qty: 1, unitCents: 12_000, amountCents: 12_000 },
      { label: 'Otro importe', qty: 1, amountCents: 750 },
      { label: 'Propina', qty: 1, amountCents: 200 },
    ]);
    expect(ticketLinesOf(EMPTY_CUENTA)).toEqual([]);
  });

  it('qué detalle se pide al pagarse: con tarjeta, el pago; con el saldo, el cobro del saldo', () => {
    const card = { id: 'pay-1' };
    const saldo = { chargeId: 'ch-1' };
    expect(paidTargetOf(false, null, card, saldo)).toBeNull();
    expect(paidTargetOf(true, 'card', card, saldo)).toEqual({ kind: 'PAYMENT', id: 'pay-1' });
    expect(paidTargetOf(true, 'nfc_nopin', card, saldo)).toEqual({ kind: 'SALDO', id: 'ch-1' });
    expect(paidTargetOf(true, 'pin', null, saldo)).toEqual({ kind: 'SALDO', id: 'ch-1' });
    // Sin el cobro que toca, ninguno (el ticket sale con lo de la pantalla).
    expect(paidTargetOf(true, 'card', null, saldo)).toBeNull();
    expect(paidTargetOf(true, 'passkey', card, null)).toBeNull();
  });
});
