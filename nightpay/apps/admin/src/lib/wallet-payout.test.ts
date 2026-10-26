import { describe, expect, it } from 'vitest';
import { ApiError } from '@nightpay/api-client';
import { isPayoutAmountChanged, payoutDoneText, payoutPlan, type WalletPayoutPreview } from './wallet-payout';

// Intl pone un espacio duro antes de «€».
const eur = (s: string | null) => (s ?? '').replace(/\u00a0/g, ' ');

/** 80 € de saldo: 30 € entraron en efectivo y 50 € con tarjeta (el ejemplo de la revisión). */
const mixed: WalletPayoutPreview = {
  balanceCents: 8_000,
  cashOutCents: 3_000,
  cardRefundCents: 5_000,
  cashLaterCents: 0,
  pendingCardCents: null,
};

describe('«Devolver saldo»: lo que se dice antes de confirmar es lo que hará el API, no el saldo entero', () => {
  it('en efectivo, con parte de tarjeta: solo los 30 € y por qué quedan los otros 50 €', () => {
    const plan = payoutPlan(mixed, 'CASH');
    expect(plan.amountCents).toBe(3_000);
    expect(plan.blocked).toBeNull();
    expect(eur(plan.instruction)).toBe('Confirma y dale 30,00 € en efectivo al cliente.');
    expect(eur(plan.remainder)).toBe(
      'El saldo no se cierra: quedan 50,00 €. Los 50,00 € que entraron con tarjeta van a su tarjeta: los devuelve el dueño en el banco («A su tarjeta»).',
    );
    expect(plan.leftCents).toBe(5_000);
    expect(eur(plan.instruction)).not.toContain('80,00');
  });

  it('a la tarjeta, con parte en efectivo: solo los 50 € en BBVA; los 30 € del efectivo, en efectivo', () => {
    const plan = payoutPlan(mixed, 'CARD');
    expect(plan.amountCents).toBe(5_000);
    expect(eur(plan.instruction)).toMatch(/^1\. En el portal de BBVA, devuelve 50,00 € a las recargas de saldo del cliente/);
    expect(eur(plan.remainder)).toBe(
      'El saldo no se cierra: quedan 30,00 € que entraron en efectivo. Se devuelven en efectivo («Efectivo»), no a la tarjeta.',
    );
    expect(plan.leftCents).toBe(3_000);
  });

  it('todo de un camino: el importe entero y el saldo queda cerrado', () => {
    const cash = payoutPlan({ ...mixed, cashOutCents: 8_000, cardRefundCents: 0 }, 'CASH');
    expect(eur(cash.instruction)).toBe('Confirma y dale 80,00 € en efectivo al cliente. El saldo queda cerrado.');
    expect(cash.remainder).toBeNull();
    expect(cash.leftCents).toBe(0);
    const card = payoutPlan({ ...mixed, cashOutCents: 0, cardRefundCents: 8_000 }, 'CARD');
    expect(eur(card.instruction)).toMatch(/devuelve 80,00 €.*El saldo queda cerrado\.$/);
    expect(card.remainder).toBeNull();
  });

  it('el tope de 1.000 € en 24 h: lo que hoy no sale en efectivo se devuelve mañana (no a la tarjeta)', () => {
    const big: WalletPayoutPreview = { balanceCents: 150_000, cashOutCents: 99_999, cardRefundCents: 0, cashLaterCents: 50_001, pendingCardCents: null };
    const plan = payoutPlan(big, 'CASH');
    expect(plan.amountCents).toBe(99_999);
    expect(eur(plan.remainder)).toBe(
      'El saldo no se cierra: quedan 500,01 €. Otros 500,01 € en efectivo no pueden salir hoy (lo devuelto en efectivo no llega a 1.000 € en 24 h): se le devuelven mañana.',
    );
    // Con las dos cosas: las dos razones.
    const both = payoutPlan({ ...big, balanceCents: 170_000, cardRefundCents: 20_000 }, 'CASH');
    expect(eur(both.remainder)).toContain('Los 200,00 € que entraron con tarjeta van a su tarjeta');
    expect(eur(both.remainder)).toContain('Otros 500,01 € en efectivo no pueden salir hoy');
  });

  it('nada por este camino: no hay botón con importe y se dice por qué', () => {
    const allCard = payoutPlan({ ...mixed, cashOutCents: 0, cardRefundCents: 8_000 }, 'CASH');
    expect(allCard.amountCents).toBe(0);
    expect(allCard.instruction).toBeNull();
    expect(eur(allCard.blocked)).toBe(
      'Este saldo entró con tarjeta: en efectivo no se devuelve nada. Lo devuelve el dueño en el banco («A su tarjeta»).',
    );
    const allCash = payoutPlan({ ...mixed, cashOutCents: 8_000, cardRefundCents: 0 }, 'CARD');
    expect(eur(allCash.blocked)).toBe('Este saldo entró en efectivo: se devuelve en efectivo («Efectivo»), no a la tarjeta.');
    const limit = payoutPlan({ balanceCents: 40_000, cashOutCents: 0, cardRefundCents: 0, cashLaterCents: 40_000, pendingCardCents: null }, 'CASH');
    expect(eur(limit.blocked)).toBe(
      'Hoy no se puede devolver más en efectivo a este saldo (lo devuelto en efectivo no llega a 1.000 € en 24 h): los 400,00 € se le devuelven mañana.',
    );
    const empty = payoutPlan({ balanceCents: 0, cashOutCents: 0, cardRefundCents: 0, cashLaterCents: 0, pendingCardCents: null }, 'CASH');
    expect(empty.blocked).toBe('Este saldo no tiene nada que devolver.');
  });

  it('una devolución a la tarjeta a medias: en efectivo, nada hasta terminarla; «A su tarjeta» la termina', () => {
    const halfDone: WalletPayoutPreview = { balanceCents: 3_000, cashOutCents: 0, cardRefundCents: 5_000, cashLaterCents: 0, pendingCardCents: 5_000 };
    expect(eur(payoutPlan(halfDone, 'CASH').blocked)).toBe(
      'Hay una devolución a la tarjeta de 50,00 € a medias: que el dueño vuelva a pulsar «A su tarjeta» para terminarla. Hasta entonces, en efectivo no se devuelve nada.',
    );
    const card = payoutPlan(halfDone, 'CARD');
    expect(card.amountCents).toBe(5_000);
    expect(eur(card.instruction)).toBe(
      'Una devolución a la tarjeta de 50,00 € se quedó a medias. Si ya la hiciste en el portal de BBVA, pon la referencia y confirma para terminar de apuntarla.',
    );
    expect(eur(card.remainder)).toBe('El saldo no se cierra: después quedan 30,00 €.');
    expect(card.leftCents).toBe(3_000);
  });
});

describe('lo que se dice al apuntarlo', () => {
  it('en efectivo solo una parte: lo que se da y lo que queda (con el porqué)', () => {
    const plan = payoutPlan(mixed, 'CASH');
    expect(eur(payoutDoneText({ refundedCents: 3_000, method: 'CASH', remainingCents: 5_000 }, plan))).toBe(
      'Apuntado: dale 30,00 € en efectivo al cliente. El saldo no se cierra: quedan 50,00 €. Los 50,00 € que entraron con tarjeta van a su tarjeta: los devuelve el dueño en el banco («A su tarjeta»).',
    );
    // Sin plan (no debería pasar): al menos lo que queda.
    expect(eur(payoutDoneText({ refundedCents: 4_000, method: 'CASH', remainingCents: 6_000 }))).toBe(
      'Apuntado: dale 40,00 € en efectivo al cliente. El saldo no se cierra: quedan 60,00 €.',
    );
  });

  it('todo: saldo cerrado', () => {
    expect(eur(payoutDoneText({ refundedCents: 4_000, method: 'CASH' }))).toBe('Apuntado: dale 40,00 € en efectivo al cliente. Saldo cerrado.');
    expect(eur(payoutDoneText({ refundedCents: 4_000, method: 'CARD', remainingCents: 0 }))).toBe('Apuntado: 40,00 € devueltos a la tarjeta. Saldo cerrado.');
  });

  it('a la tarjeta con efectivo en el saldo: el API no dice lo que queda; el plan sí (no «Saldo cerrado»)', () => {
    expect(eur(payoutDoneText({ refundedCents: 5_000, method: 'CARD' }, payoutPlan(mixed, 'CARD')))).toBe(
      'Apuntado: 50,00 € devueltos a la tarjeta. El saldo no se cierra: quedan 30,00 € que entraron en efectivo. Se devuelven en efectivo («Efectivo»), no a la tarjeta.',
    );
  });
});

describe('el saldo se movió entre ver la cifra y confirmar', () => {
  it('409 PAYOUT_AMOUNT_CHANGED: se vuelve a pedir la cifra (otros errores, no)', () => {
    expect(isPayoutAmountChanged(new ApiError('cambió', 409, 'PAYOUT_AMOUNT_CHANGED'))).toBe(true);
    expect(isPayoutAmountChanged(new ApiError('2FA', 403, 'TOTP_REQUIRED'))).toBe(false);
    expect(isPayoutAmountChanged(new Error('red'))).toBe(false);
    expect(isPayoutAmountChanged(null)).toBe(false);
  });
});
