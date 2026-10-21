import { describe, expect, it } from 'vitest';
import { cobroOutcome, type CobroSignals } from './cobro-state';

const base: CobroSignals = { card: { status: 'CREATED' }, saldo: { status: 'PENDING', newBalanceCents: null }, localFail: null, canceledByMe: false };
const at = (o: Partial<CobroSignals>): CobroSignals => ({ ...base, ...o });

describe('el cobro único mientras espera: gana el primero', () => {
  it('esperando el NFC o el QR', () => {
    expect(cobroOutcome(base)).toEqual({ kind: 'waiting' });
    expect(cobroOutcome(at({ card: { status: 'AUTHORIZING' } }))).toEqual({ kind: 'waiting' });
  });

  it('pagado con el saldo: cómo y lo que le queda (aunque la tarjeta ya diga cancelada)', () => {
    expect(
      cobroOutcome(at({ card: { status: 'CANCELED' }, saldo: { status: 'ACCEPTED', paidWith: 'pin', newBalanceCents: 3000, tipCents: 500 } })),
    ).toEqual({ kind: 'paid', method: 'pin', newBalanceCents: 3000, tipCents: 500 });
    expect(cobroOutcome(at({ saldo: { status: 'ACCEPTED', newBalanceCents: 0 } }))).toMatchObject({ kind: 'paid', method: 'nfc_nopin' });
  });

  it('pagado con la tarjeta (con su propina); el saldo, cancelado', () => {
    expect(cobroOutcome(at({ card: { status: 'AUTHORIZED', tipCents: 200 }, saldo: { status: 'CANCELED', newBalanceCents: null } }))).toEqual({
      kind: 'paid',
      method: 'card',
      newBalanceCents: null,
      tipCents: 200,
    });
  });

  it('la tarjeta cancelada con el saldo aún pendiente aquí: se espera a la próxima consulta (lo pagó el saldo)', () => {
    expect(cobroOutcome(at({ card: { status: 'CANCELED' } }))).toEqual({ kind: 'waiting' });
    expect(cobroOutcome(at({ card: { status: 'CANCELED' }, saldo: { status: 'CANCELED', newBalanceCents: null } }))).toEqual({ kind: 'canceled' });
  });

  it('el NFC no pagó: NO PAGADO con la razón; el QR sigue valiendo', () => {
    const reason = { title: 'Saldo insuficiente', sentence: 'Tiene 30 €.' };
    expect(cobroOutcome(at({ localFail: reason }))).toEqual({ kind: 'failed', reason, qrStillOpen: true });
    expect(cobroOutcome(at({ localFail: reason, card: { status: 'EXPIRED' }, saldo: { status: 'EXPIRED', newBalanceCents: null } }))).toMatchObject({
      qrStillOpen: false,
    });
  });

  it('tarjeta rechazada, caducado y cancelado', () => {
    expect(cobroOutcome(at({ card: { status: 'FAILED' } }))).toMatchObject({ kind: 'failed', reason: { title: 'Tarjeta rechazada' } });
    expect(cobroOutcome(at({ card: { status: 'EXPIRED' } }))).toEqual({ kind: 'expired' });
    expect(cobroOutcome(at({ card: null, saldo: { status: 'EXPIRED', newBalanceCents: null } }))).toEqual({ kind: 'expired' });
    expect(cobroOutcome(at({ card: null, saldo: { status: 'CANCELED', newBalanceCents: null } }))).toEqual({ kind: 'canceled' });
    expect(cobroOutcome(at({ canceledByMe: true }))).toEqual({ kind: 'canceled' });
    expect(cobroOutcome(at({ card: { status: 'CREATED' }, saldo: null }))).toEqual({ kind: 'waiting' });
  });
});
