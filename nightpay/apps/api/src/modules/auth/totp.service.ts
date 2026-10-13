import { Injectable } from '@nestjs/common';
import * as speakeasy from 'speakeasy';
import { BRAND_NAME } from '../../common/brand';

/**
 * Servicio TOTP (RFC 6238) — usa speakeasy.
 * Cada User tiene `totpSecret` cifrado en base32 (placeholder en seed; real
 * lo seteariamos via flujo `setup-totp` en Sprint 7+).
 *
 * Verificacion con ventana ±1 step (30s antes/despues) — tolerancia clock skew.
 */
@Injectable()
export class TotpService {
  /**
   * Genera un secret nuevo + URL otpauth para QR scan en autenticador.
   * Caller debe persistir el secret en User.totpSecret tras el primer enrollment.
   */
  generateSecret(label: string, issuer = BRAND_NAME): { base32: string; otpauthUrl: string } {
    const s = speakeasy.generateSecret({
      name: `${issuer} (${label})`,
      issuer,
      length: 20,
    });
    return {
      base32: s.base32,
      otpauthUrl: s.otpauth_url ?? '',
    };
  }

  /**
   * Verifica un codigo TOTP de 6 digitos contra el secret del user.
   * Devuelve true si valida, false si no.
   */
  verify(secretBase32: string, code: string): boolean {
    if (!secretBase32 || !/^\d{6}$/.test(code)) return false;
    return speakeasy.totp.verify({
      secret: secretBase32,
      encoding: 'base32',
      token: code,
      window: 1,
    });
  }
}
