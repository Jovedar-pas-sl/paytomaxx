import { describe, expect, it } from 'vitest';
import { stepUpActions } from '@nightpay/contracts';
import { proofFor, refundAutoSends, refundButtonText, REFUND_BUTTON_FROM_CENTS } from './refund-confirm';

const eur = (c: number) => `${(c / 100).toFixed(2).replace('.', ',')} €`;

describe('devolver desde 100 € (B10)', () => {
  it('por debajo de 100 € se manda sola al completar la verificación; desde 100 €, nunca', () => {
    expect(REFUND_BUTTON_FROM_CENTS).toBe(10000);
    expect(refundAutoSends(9999)).toBe(true);
    expect(refundAutoSends(10000)).toBe(false);
    expect(refundAutoSends(12000)).toBe(false);
    expect(refundAutoSends(Number.NaN)).toBe(false);
  });

  it('el botón dice el importe con «Devolver», nunca «Reembolsar»', () => {
    expect(refundButtonText({ asking: false, cents: 12000, valid: true }, eur)).toBe('Devolver 120,00 €');
    expect(refundButtonText({ asking: false, cents: Number.NaN, valid: false }, eur)).toBe('Devolver');
    expect(refundButtonText({ asking: true, cents: 12000, valid: true }, eur)).toBe('Pedir al dueño');
  });
});

describe('la prueba de la llave', () => {
  const action = stepUpActions.refund('p-1', 12000);
  const proof = { token: 't', action, expiresAt: '2026-11-10T10:02:00.000Z' };
  const now = Date.parse('2026-11-10T10:00:00.000Z');

  it('vale para su acción mientras no caduca', () => {
    expect(proofFor(proof, action, now)).toBe(proof);
    expect(proofFor(proof, action, Date.parse(proof.expiresAt))).toBeNull();
  });

  it('otro importe u otro cobro piden confirmar otra vez', () => {
    expect(proofFor(proof, stepUpActions.refund('p-1', 11000), now)).toBeNull();
    expect(proofFor(proof, stepUpActions.refund('p-2', 12000), now)).toBeNull();
    expect(proofFor(null, action, now)).toBeNull();
    expect(proofFor(proof, null, now)).toBeNull();
  });
});
