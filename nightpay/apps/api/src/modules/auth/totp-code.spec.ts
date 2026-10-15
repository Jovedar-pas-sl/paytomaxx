import { describe, expect, it } from 'vitest';
import * as speakeasy from 'speakeasy';
import { buildOtpauthUrl, matchTotpStep, totpLockedError, totpStepAt } from './totp-code';

const SECRET = 'JBSWY3DPEHPK3PXP';
const NOW = Date.parse('2026-10-15T22:00:10Z');
const STEP = totpStepAt(NOW);

function codeAt(step: number): string {
  return speakeasy.totp({ secret: SECRET, encoding: 'base32', counter: step });
}

describe('matchTotpStep', () => {
  it('devuelve el paso del código: el actual y ±1 (reloj del móvil)', () => {
    expect(matchTotpStep(SECRET, codeAt(STEP), NOW)).toBe(STEP);
    expect(matchTotpStep(SECRET, codeAt(STEP - 1), NOW)).toBe(STEP - 1);
    expect(matchTotpStep(SECRET, codeAt(STEP + 1), NOW)).toBe(STEP + 1);
  });

  it('fuera de la ventana o con basura → null', () => {
    expect(matchTotpStep(SECRET, codeAt(STEP - 3), NOW)).toBeNull();
    expect(matchTotpStep(SECRET, '12345', NOW)).toBeNull();
    expect(matchTotpStep(SECRET, 'abcdef', NOW)).toBeNull();
    expect(matchTotpStep(SECRET, undefined, NOW)).toBeNull();
    expect(matchTotpStep('', codeAt(STEP), NOW)).toBeNull();
  });
});

describe('buildOtpauthUrl', () => {
  it('lleva emisor (marca) y cuenta, codificados, para que la app los muestre bien', () => {
    const url = buildOtpauthUrl(SECRET, 'dueño@local.es', 'OxioPay');
    expect(url).toBe(
      `otpauth://totp/OxioPay:due%C3%B1o%40local.es?secret=${SECRET}&issuer=OxioPay&algorithm=SHA1&digits=6&period=30`,
    );
  });

  it('marca con espacios', () => {
    expect(buildOtpauthUrl(SECRET, 'a@b.es', 'Mi Marca')).toContain('otpauth://totp/Mi%20Marca:a%40b.es?');
    expect(buildOtpauthUrl(SECRET, 'a@b.es', 'Mi Marca')).toContain('issuer=Mi%20Marca');
  });
});

describe('totpLockedError', () => {
  it('429 con los minutos que quedan, en castellano', () => {
    const err = totpLockedError(14 * 60 + 5);
    expect(err.getStatus()).toBe(429);
    expect(JSON.stringify(err.getResponse())).toMatch(/Espera 15 min/);
  });
});
