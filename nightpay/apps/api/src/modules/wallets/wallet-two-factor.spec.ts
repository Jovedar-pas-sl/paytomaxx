import { describe, it, expect, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { totpForbidden } from '../auth/totp-code';
import { assertManagerTwoFactor, managerNeedsTwoFactor } from './wallet-two-factor';

function totp(o: { enrolled?: boolean; valid?: boolean } = {}) {
  return {
    isEnabled: vi.fn().mockResolvedValue(o.enrolled ?? true),
    assertForUser: o.valid === false ? vi.fn().mockRejectedValue(totpForbidden('invalid')) : vi.fn().mockResolvedValue(undefined),
  };
}

const manager = { userId: 'man-1', role: 'MANAGER' as const };
const owner = { userId: 'own-1', role: 'OWNER' as const };

describe('¿pone el encargado su 2FA para sacar dinero del saldo?', () => {
  it('desde el umbral del local, incluido; el dueño nunca', () => {
    expect(managerNeedsTwoFactor('MANAGER', 9_999, 10_000)).toBe(false);
    expect(managerNeedsTwoFactor('MANAGER', 10_000, 10_000)).toBe(true);
    expect(managerNeedsTwoFactor('OWNER', 1_000_000, 0)).toBe(false);
    // Umbral 0: siempre.
    expect(managerNeedsTwoFactor('MANAGER', 1, 0)).toBe(true);
  });

  it('sin umbral leído, el de la base (100 €): no se abre por un dato que falta', () => {
    expect(managerNeedsTwoFactor('MANAGER', 9_999, undefined)).toBe(false);
    expect(managerNeedsTwoFactor('MANAGER', 10_000, null)).toBe(true);
  });
});

describe('assertManagerTwoFactor', () => {
  it('no hace falta: no mira la 2FA y dice que no se pidió', async () => {
    const t = totp();
    await expect(assertManagerTwoFactor(t, owner, 50_000, 10_000, undefined, 'Devolver')).resolves.toBe(false);
    await expect(assertManagerTwoFactor(t, manager, 5_000, 10_000, undefined, 'Devolver')).resolves.toBe(false);
    expect(t.isEnabled).not.toHaveBeenCalled();
    expect(t.assertForUser).not.toHaveBeenCalled();
  });

  it('sin código: TOTP_REQUIRED con qué y desde cuánto; sin la app activada, TOTP_NOT_ENROLLED', async () => {
    const err = await assertManagerTwoFactor(totp(), manager, 12_000, 10_000, undefined, 'Devolver 120,00 € en efectivo').catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toEqual({
      code: 'TOTP_REQUIRED',
      message: 'Devolver 120,00 € en efectivo: desde 100,00 € pon el código de tu app de verificación (2FA).',
    });
    const notEnrolled = await assertManagerTwoFactor(totp({ enrolled: false }), manager, 12_000, 10_000, undefined, 'Anular').catch(
      (e: unknown) => e,
    );
    expect((notEnrolled as ForbiddenException).getResponse()).toMatchObject({ code: 'TOTP_NOT_ENROLLED' });
  });

  it('con código: lo comprueba TotpService (intentos y códigos usados); uno malo no deja seguir', async () => {
    const ok = totp();
    await expect(assertManagerTwoFactor(ok, manager, 12_000, 10_000, '123456', 'Anular')).resolves.toBe(true);
    expect(ok.assertForUser).toHaveBeenCalledWith('man-1', '123456');
    await expect(assertManagerTwoFactor(totp({ valid: false }), manager, 12_000, 10_000, '000000', 'Anular')).rejects.toThrow(
      ForbiddenException,
    );
  });
});
