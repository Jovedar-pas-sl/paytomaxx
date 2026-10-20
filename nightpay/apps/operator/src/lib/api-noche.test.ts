import { describe, expect, it } from 'vitest';
import { nfcPayResultOf } from './api-noche';

/** Cobrar con el NFC solo: pagado, «que ponga su PIN» (el mismo cobro sigue libre) o el error de siempre. */

const paid = { id: 'req-1', status: 'ACCEPTED', amountCents: 1_500, serviceName: null, expiresAt: '2026-10-17T00:00:00Z', newBalanceCents: 3_500 };

describe('NFC sin PIN en la app del personal', () => {
  it('pagado: directo a PAGADO con lo que le queda', () => {
    expect(nfcPayResultOf(200, JSON.stringify(paid))).toEqual({ kind: 'paid', charge: paid });
  });

  it('409 PIN_REQUIRED: a teclear su PIN, con el porqué', () => {
    const body = JSON.stringify({ message: 'Este cobro pasa del máximo sin PIN: que ponga su PIN.', code: 'PIN_REQUIRED', reason: 'over_max' });
    expect(nfcPayResultOf(409, body)).toEqual({ kind: 'pin', message: 'Este cobro pasa del máximo sin PIN: que ponga su PIN.' });
  });

  it('otro 409 (copia, ya pagado…) o un 5xx: el error de siempre', () => {
    expect(() => nfcPayResultOf(409, JSON.stringify({ message: 'Esta ficha no es la original (¿copiada?): avisa al encargado' }))).toThrow(
      /no es la original/,
    );
    expect(() => nfcPayResultOf(503, '')).toThrow(/servidor/i);
  });
});
