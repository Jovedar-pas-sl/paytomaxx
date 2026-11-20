import { describe, expect, it } from 'vitest';
import { holderMismatchText, payoutHoldText, REVEAL_PAYOUT_SECONDS, revealLeft, twoFactorNeededText } from './payout-account-view';

const NOW = Date.parse('2026-11-19T22:00:00Z');

describe('payoutHoldText — las 48 h tras cambiar la cuenta', () => {
  it('aún no han pasado y no es en efectivo: desde cuándo se le puede pagar', () => {
    const text = payoutHoldText('2026-11-21T21:30:00Z', 'SEPA_IBAN', NOW, 'Europe/Madrid');
    expect(text).toMatch(/^Su cuenta de cobro cambió hace menos de 48 h/);
    expect(text).toContain('21');
    expect(text).toContain('22:30');
    expect(text).toMatch(/En efectivo, sí/);
  });
  it('en efectivo, ya pasadas o sin espera: nada', () => {
    expect(payoutHoldText('2026-11-21T21:30:00Z', 'MANUAL_CASH', NOW, 'Europe/Madrid')).toBeNull();
    expect(payoutHoldText('2026-11-19T21:00:00Z', 'SEPA_IBAN', NOW, 'Europe/Madrid')).toBeNull();
    expect(payoutHoldText(null, 'SEPA_IBAN', NOW, 'Europe/Madrid')).toBeNull();
  });
});

describe('holderMismatchText — el titular no se parece a su nombre (aviso, no bloquea)', () => {
  it('con el nombre que se ve', () => {
    expect(holderMismatchText('Marina')).toBe(
      'El titular no se parece al nombre de la compañera («Marina»). Comprueba que la cuenta es suya antes de pagarle.',
    );
    expect(holderMismatchText(null)).toMatch(/^El titular no se parece al nombre de la compañera\./);
  });
});

describe('revealLeft — la cuenta entera se tapa sola', () => {
  it('cuenta atrás en segundos, sin bajar de 0', () => {
    expect(REVEAL_PAYOUT_SECONDS).toBe(60);
    expect(revealLeft(NOW + 59_500, NOW)).toBe(60);
    expect(revealLeft(NOW + 1_000, NOW)).toBe(1);
    expect(revealLeft(NOW - 1_000, NOW)).toBe(0);
  });
});

describe('twoFactorNeededText — el dueño sin 2FA no cambia ni ve cuentas de cobro', () => {
  it('dice para qué hace falta y dónde se activa', () => {
    expect(twoFactorNeededText('change')).toBe(
      'Para cambiar una cuenta de cobro hace falta la verificación en dos pasos (2FA). Actívala en Ajustes → Seguridad y vuelve aquí.',
    );
    expect(twoFactorNeededText('reveal')).toBe(
      'Para ver la cuenta de cobro entera hace falta la verificación en dos pasos (2FA). Actívala en Ajustes → Seguridad y vuelve aquí.',
    );
  });
});
