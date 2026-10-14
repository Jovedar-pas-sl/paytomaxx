import { describe, it, expect } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import * as speakeasy from 'speakeasy';
import { TotpService } from './totp.service';

describe('2FA para pagar a una chica (assertIfEnrolled)', () => {
  const totp = new TotpService();
  const { base32 } = totp.generateSecret('dueno@local.es');

  it('sin 2FA activada → pasa como antes (no bloquea a nadie)', () => {
    expect(() => totp.assertIfEnrolled(null, undefined)).not.toThrow();
  });

  it('con 2FA activada: sin código o con uno incorrecto → 403', () => {
    expect(() => totp.assertIfEnrolled(base32, undefined)).toThrow(ForbiddenException);
    expect(() => totp.assertIfEnrolled(base32, '000000')).toThrow(/incorrecto/);
  });

  it('con 2FA activada y el código de la app → pasa', () => {
    const code = speakeasy.totp({ secret: base32, encoding: 'base32' });
    expect(() => totp.assertIfEnrolled(base32, code)).not.toThrow();
  });
});
