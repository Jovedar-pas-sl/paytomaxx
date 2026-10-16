import { describe, it, expect, vi } from 'vitest';
import { ForbiddenException, HttpException, HttpStatus } from '@nestjs/common';
import { TOTP_MESSAGES } from '../auth/totp-code';
import { STEP_UP_CODES, SuperAdminStepUpService, withStepUpCode } from './step-up.service';

const actor = { id: 'sa-1', email: 'jefe@x.es', ip: '1.2.3.4' };

function setup(opts: { enrolled?: boolean; assertError?: unknown } = {}) {
  const totp = {
    isEnabled: vi.fn().mockResolvedValue(opts.enrolled ?? true),
    assertForUser: opts.assertError ? vi.fn().mockRejectedValue(opts.assertError) : vi.fn().mockResolvedValue(undefined),
  };
  const audit = { write: vi.fn().mockResolvedValue(undefined) };
  const svc = new SuperAdminStepUpService(totp as never, audit as never);
  return { svc, totp, audit };
}

function bodyOf(err: unknown): Record<string, unknown> {
  return (err as HttpException).getResponse() as Record<string, unknown>;
}

describe('SuperAdminStepUpService — 2FA del super-admin en cada escritura delicada', () => {
  it('código bueno: pasa, con la API por usuario (assertForUser, Redis) y sin registrar fallo', async () => {
    const { svc, totp, audit } = setup();
    await expect(svc.verify(actor, '123456', 'venue.pause')).resolves.toBeUndefined();
    expect(totp.assertForUser).toHaveBeenCalledWith('sa-1', '123456');
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('sin código y con 2FA: 403 TOTP_REQUIRED; queda el intento en el registro', async () => {
    const { svc, totp, audit } = setup({ enrolled: true });
    const err = await svc.verify(actor, undefined, 'venue.rules').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(403);
    expect(bodyOf(err)).toMatchObject({ code: STEP_UP_CODES.required, message: TOTP_MESSAGES.required });
    expect(totp.assertForUser).not.toHaveBeenCalled();
    expect(audit.write).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ action: 'step_up.failed', extra: { attempted: 'venue.rules', code: 'TOTP_REQUIRED' } }),
    );
  });

  it('super-admin sin 2FA activada: 403 TOTP_NOT_ENROLLED (también con código)', async () => {
    const noCode = await setup({ enrolled: false }).svc.verify(actor, undefined, 'x').catch((e: unknown) => e);
    expect(bodyOf(noCode)).toMatchObject({ code: 'TOTP_NOT_ENROLLED' });
    const withCode = await setup({ assertError: new ForbiddenException(TOTP_MESSAGES.notEnrolled) })
      .svc.verify(actor, '123456', 'x')
      .catch((e: unknown) => e);
    expect((withCode as HttpException).getStatus()).toBe(403);
    expect(bodyOf(withCode)).toMatchObject({ code: 'TOTP_NOT_ENROLLED', message: TOTP_MESSAGES.notEnrolled });
  });

  it('código malo o ya usado: 403 TOTP_INVALID; demasiados: 429 TOTP_LOCKED', async () => {
    for (const msg of [TOTP_MESSAGES.invalid, TOTP_MESSAGES.reused]) {
      const err = await setup({ assertError: new ForbiddenException(msg) }).svc.verify(actor, '000000', 'x').catch((e: unknown) => e);
      expect(bodyOf(err)).toMatchObject({ code: 'TOTP_INVALID', message: msg });
    }
    const locked = new HttpException({ message: 'Demasiados códigos 2FA incorrectos. Espera 15 min' }, HttpStatus.TOO_MANY_REQUESTS);
    const err = await setup({ assertError: locked }).svc.verify(actor, '000000', 'x').catch((e: unknown) => e);
    expect((err as HttpException).getStatus()).toBe(429);
    expect(bodyOf(err)).toMatchObject({ code: 'TOTP_LOCKED' });
  });

  it('un error que ya trae su code (TotpService nuevo) sale tal cual', () => {
    const coded = new ForbiddenException({ message: 'x', code: 'TOTP_INVALID' });
    expect(withStepUpCode(coded)).toBe(coded);
    const other = new Error('base caída');
    expect(withStepUpCode(other)).toBe(other);
  });
});
