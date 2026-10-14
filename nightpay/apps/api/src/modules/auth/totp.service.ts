import { ForbiddenException, Injectable } from '@nestjs/common';
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
  /**
   * 2FA "si la tiene activada": quien activó la app de verificación tiene que
   * poner el código; quien no, sigue como antes (no se bloquea a nadie hasta
   * que la active con `pnpm cli enroll-totp`).
   */
  assertIfEnrolled(secretBase32: string | null | undefined, code: string | undefined): void {
    if (!secretBase32) return;
    if (!code) throw new ForbiddenException('Pon el código de tu app de verificación (2FA)');
    if (!this.verify(secretBase32, code)) throw new ForbiddenException('Código 2FA incorrecto o caducado');
  }

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
