import { describe, expect, it } from 'vitest';
import { ApiError } from './api-errors';
import { stepUpErrorText, verifiedLeftText } from './step-up';

describe('verificarse para ver lo delicado', () => {
  it('cada error de la llave, en llano; cancelar en el móvil no dice nada', () => {
    expect(stepUpErrorText(new ApiError('x', 403, 'PASSKEY_NOT_SET'))).toMatch(/Ajustes → Seguridad/);
    expect(stepUpErrorText(new ApiError('x', 403, 'TOTP_REQUIRED'))).toBe('Tienes la verificación en dos pasos: usa su código.');
    expect(stepUpErrorText(new ApiError('x', 403, 'PASSWORD_INVALID'))).toBe('La contraseña no es correcta.');
    expect(stepUpErrorText(Object.assign(new Error('cancelado'), { name: 'NotAllowedError' }))).toBeNull();
    expect(stepUpErrorText(new ApiError('Código 2FA incorrecto o caducado', 403, 'TOTP_INVALID'))).toBe('Código 2FA incorrecto o caducado');
  });

  it('lo que le queda a la verificación (los 5 minutos)', () => {
    const now = Date.parse('2026-11-08T00:20:00.000Z');
    expect(verifiedLeftText('2026-11-08T00:24:30.000Z', now)).toBe('Verificado: te quedan 5 min.');
    expect(verifiedLeftText('2026-11-08T00:20:30.000Z', now)).toBe('Verificado: te queda 1 min.');
    expect(verifiedLeftText('2026-11-08T00:19:00.000Z', now)).toBeNull();
    expect(verifiedLeftText(null, now)).toBeNull();
  });
});
