import { describe, it, expect } from 'vitest';
import { clientRefundState, refundCards } from './wallet-refund-view';

const active = { status: 'ACTIVE', balanceCents: 15_000, closeRequested: false };

describe('«Me voy» en la página del saldo: cuánto, cómo y en qué paso', () => {
  it('sin pedirlo → nada que enseñar', () => {
    expect(clientRefundState(active, [])).toBeNull();
  });

  it('pedido: lo que queda de saldo, a sus tarjetas o en efectivo (aún no se sabe)', () => {
    expect(clientRefundState({ ...active, closeRequested: true }, [])).toEqual({
      stage: 'requested',
      amountCents: 15_000,
      methods: [],
    });
  });

  it('el dueño la está apuntando a la tarjeta → aprobado', () => {
    const out = clientRefundState(
      { status: 'ACTIVE', balanceCents: 0, closeRequested: true },
      [{ amountCents: 15_000, method: 'CARD', status: 'PENDING' }],
    );
    expect(out).toMatchObject({ stage: 'approved', amountCents: 15_000, methods: ['CARD'] });
  });

  it('devuelto: lo hecho y cómo (tarjeta y el resto en efectivo)', () => {
    const out = clientRefundState(
      { status: 'REFUNDED', balanceCents: 0, closeRequested: true },
      [
        { amountCents: 10_000, method: 'CARD', status: 'DONE' },
        { amountCents: 5_000, method: 'CASH', status: 'DONE' },
      ],
    );
    expect(out).toEqual({ stage: 'done', amountCents: 15_000, methods: ['CARD', 'CASH'] });
  });

  it('gastado entero (sin devolución) → nada', () => {
    expect(clientRefundState({ status: 'DEPLETED', balanceCents: 0, closeRequested: false }, [])).toBeNull();
  });

  it('solo últimas 4 cifras bien formadas, sin repetir', () => {
    expect(refundCards(['4242', '4242', null, '12', 'abcd', '1111'])).toEqual(['4242', '1111']);
  });
});
