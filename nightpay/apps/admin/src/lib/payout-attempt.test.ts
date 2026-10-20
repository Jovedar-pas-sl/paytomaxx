import { describe, expect, it } from 'vitest';
import { ApiError } from './api-errors';
import { KEY_REUSED_CODE, PAYOUT_CHANGED_CODE, payoutAttempt, payoutFailure, payoutWhat } from './payout-attempt';

const base = { operatorId: 'op-1', totalCents: 30_000, rail: 'CASH', txId: '', receipt: '' };

describe('la clave de «Marcar pagado»', () => {
  it('lo mismo otra vez (sin respuesta, doble clic): la misma clave', () => {
    const first = payoutAttempt(null, payoutWhat(base));
    expect(payoutAttempt(first, payoutWhat(base))).toBe(first);
  });

  it('otra cifra, otro método u otra referencia: clave nueva', () => {
    const first = payoutAttempt(null, payoutWhat(base));
    expect(payoutAttempt(first, payoutWhat({ ...base, totalCents: 31_000 })).key).not.toBe(first.key);
    expect(payoutAttempt(first, payoutWhat({ ...base, rail: 'SEPA' })).key).not.toBe(first.key);
    expect(payoutAttempt(first, payoutWhat({ ...base, txId: 'REF-123' })).key).not.toBe(first.key);
  });
});

describe('cuando falla «Marcar pagado»', () => {
  it('la cifra cambió en el servidor: cerrar y mirar la nueva', () => {
    const err = new ApiError('El saldo de la chica ha cambiado desde que se pidió (ahora 310,00 €)', 409, PAYOUT_CHANGED_CODE);
    expect(payoutFailure(err)).toEqual({
      kind: 'changed',
      text: 'El saldo de la chica ha cambiado desde que se pidió (ahora 310,00 €). Cierra y vuelve a abrirlo con la cifra nueva.',
    });
  });

  it('la clave del intento ya se usó con otros datos: cerrar y abrir otro intento (sin hablar de cabeceras)', () => {
    const err = new ApiError('Esa Idempotency-Key ya se usó para otro pago', 409, KEY_REUSED_CODE);
    const failure = payoutFailure(err);
    expect(failure).toMatchObject({ kind: 'changed', text: expect.stringMatching(/Cierra y vuelve a abrirlo/) });
    expect(failure.text).not.toMatch(/Idempotency/);
  });

  it('sin respuesta o con un 5xx: no se sabe si se apuntó', () => {
    expect(payoutFailure(new ApiError('sin red', 0))).toMatchObject({ kind: 'unknown' });
    expect(payoutFailure(new ApiError('Bad gateway', 502))).toMatchObject({ kind: 'unknown' });
    expect(payoutFailure(new Error('raro'))).toMatchObject({ kind: 'unknown', text: expect.stringMatching(/No sabemos/) });
  });

  it('otro error del API: no se apuntó, se corrige y se vuelve a probar', () => {
    expect(payoutFailure(new ApiError('Código 2FA incorrecto', 403, 'TOTP_INVALID'))).toEqual({
      kind: 'retry',
      text: 'Código 2FA incorrecto',
    });
  });
});
