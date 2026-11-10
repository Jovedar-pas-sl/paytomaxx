import { afterEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { STEP_UP_REQUIRED_CODE } from '@nightpay/contracts';
import { createFakeRedis } from './testing/fake-redis';
import { parseStepUpGrant, stepUpKey, stepUpMethodFor, StepUpService } from './step-up.service';
import { totpForbidden } from './totp-code';

const USER = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d06';
const SID = '11111111-1111-4111-8111-111111111111';
const OTHER_SID = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-11-08T00:20:00.000Z');
const MIN = 60_000;

function setup(o: { totpEnabled?: boolean; passkeys?: number } = {}) {
  const redis = createFakeRedis();
  const enabled = o.totpEnabled ?? true;
  const totp = {
    isEnabled: vi.fn(async () => enabled),
    assertForUser: vi.fn(async (_u: string, code: string | undefined) => {
      if (!enabled) throw totpForbidden('notEnrolled');
      if (code !== '123456') throw totpForbidden('invalid');
    }),
  };
  const audit = { log: vi.fn(async () => undefined) };
  const counter = { count: vi.fn(async () => o.passkeys ?? 0) };
  const svc = new StepUpService(redis as never, totp as never, audit as never, counter);
  return { svc, redis, totp, audit };
}

const me = { userId: USER, sessionId: SID, tenantId: 'a1a1a1a1-0000-4000-8000-000000000001' };

afterEach(() => {
  vi.useRealTimers();
});

describe('la verificación del momento para ver lo delicado', () => {
  it('con el código de su 2FA: 5 minutos en esta sesión, y queda en el registro', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const { svc, redis, audit } = setup();
    const status = await svc.verifyWithTotp(me, '123456', NOW);
    expect(status).toEqual({
      verifiedUntil: '2026-11-08T00:25:00.000Z',
      verifiedWith: 'totp',
      method: 'totp',
      totpEnabled: true,
      passkeys: 0,
    });
    expect(redis.has(stepUpKey(SID))).toBe(true);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.step_up.ok', actorId: USER }));
  });

  it('caduca a los 5 minutos (mirar no la alarga)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const { svc } = setup();
    await svc.verifyWithTotp(me, '123456', NOW);
    expect(await svc.current(me, NOW + 4 * MIN)).not.toBeNull();
    expect(await svc.current(me, NOW + 5 * MIN)).toBeNull();
    vi.setSystemTime(NOW + 6 * MIN);
    expect((await svc.status(me)).verifiedUntil).toBeNull();
  });

  it('solo en la sesión que la hizo (otra sesión, u otra persona, sin verificar)', async () => {
    const { svc } = setup();
    await svc.verifyWithTotp(me, '123456', NOW);
    expect(await svc.current({ ...me, sessionId: OTHER_SID }, NOW)).toBeNull();
    expect(await svc.current({ ...me, userId: 'otra-persona' }, NOW)).toBeNull();
  });

  it('código malo: 403 y sin verificación (el fallo queda en el registro)', async () => {
    const { svc, audit } = setup();
    await expect(svc.verifyWithTotp(me, '000000', NOW)).rejects.toBeInstanceOf(ForbiddenException);
    expect(await svc.current(me, NOW)).toBeNull();
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.step_up.failed' }));
  });

  it('sin 2FA no se verifica con el código (TOTP_NOT_ENROLLED); sin sesión (token de antes), 403', async () => {
    await expect(setup({ totpEnabled: false }).svc.verifyWithTotp(me, '123456', NOW)).rejects.toMatchObject({
      response: { code: 'TOTP_NOT_ENROLLED' },
    });
    await expect(setup().svc.verifyWithTotp({ ...me, sessionId: null }, '123456', NOW)).rejects.toMatchObject({
      response: { code: STEP_UP_REQUIRED_CODE },
    });
  });

  it('lo delicado pedido aparte sin verificar: 403 STEP_UP_REQUIRED con lo que tiene que usar', async () => {
    const { svc } = setup({ totpEnabled: false, passkeys: 1 });
    await expect(svc.assertVerified(me, NOW)).rejects.toMatchObject({ response: { code: STEP_UP_REQUIRED_CODE, method: 'passkey' } });
  });

  it('con qué se verifica cada uno: la 2FA si la tiene; si no, su llave; sin ninguna, nada', () => {
    expect(stepUpMethodFor(true, 2)).toBe('totp');
    expect(stepUpMethodFor(false, 1)).toBe('passkey');
    expect(stepUpMethodFor(false, 0)).toBeNull();
  });

  it('lo guardado se lee solo si es de esa persona, está bien y no ha caducado', () => {
    const ok = JSON.stringify({ userId: USER, method: 'totp', until: NOW + MIN });
    expect(parseStepUpGrant(ok, USER, NOW)).toEqual({ userId: USER, method: 'totp', until: NOW + MIN });
    expect(parseStepUpGrant(ok, 'otro', NOW)).toBeNull();
    expect(parseStepUpGrant(ok, USER, NOW + MIN)).toBeNull();
    expect(parseStepUpGrant('no-es-json', USER, NOW)).toBeNull();
    expect(parseStepUpGrant(JSON.stringify({ userId: USER, method: 'sms', until: NOW + MIN }), USER, NOW)).toBeNull();
  });
});
