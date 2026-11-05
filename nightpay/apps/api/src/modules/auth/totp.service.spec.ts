import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpException } from '@nestjs/common';
import { totpStepAt } from './totp-code';
import { openTotpSecret, sealTotpSecret } from './totp-crypto';
import { createFakeRedis } from './testing/fake-redis';
import { makeTotpKit, totpCodeAt } from './testing/totp-kit';

const KEK = 'test_kek_0123456789abcdef0123456789abcdef_v1';
const NOW = new Date('2026-10-15T22:00:10Z');
const STEP = totpStepAt(NOW.getTime());
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

/** Estado HTTP y cuerpo con el que falla la promesa (null si no falla). */
async function failureOf(promise: Promise<unknown>): Promise<{ status: number; body: Record<string, unknown> } | null> {
  try {
    await promise;
    return null;
  } catch (e) {
    if (!(e instanceof HttpException)) throw e;
    return { status: e.getStatus(), body: e.getResponse() as Record<string, unknown> };
  }
}

const codeAt = (secret: string, step = STEP) => totpCodeAt(secret, step);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  process.env.ENCRYPTION_KEK = KEK;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('generateSecret', () => {
  it('secreto base32 + URL otpauth con la marca como emisor', () => {
    const { totp } = makeTotpKit();
    const { base32, otpauthUrl } = totp.generateSecret('dueno@local.es', 'OxioPay');
    expect(base32).toMatch(/^[A-Z2-7]{32}$/);
    expect(otpauthUrl).toMatch(/^otpauth:\/\/totp\/OxioPay:dueno%40local\.es\?secret=[A-Z2-7]+&issuer=OxioPay/);
  });
});

describe('API por usuario (Redis): assertIfEnrolledForUser / assertForUser', () => {
  it('sin 2FA: assertIfEnrolledForUser deja pasar; assertForUser exige activarla (TOTP_NOT_ENROLLED)', async () => {
    const { totp } = makeTotpKit({ users: { u1: null } });
    await expect(totp.assertIfEnrolledForUser('u1', undefined)).resolves.toBeUndefined();
    expect(await failureOf(totp.assertForUser('u1', '123456'))).toEqual({
      status: 403,
      body: expect.objectContaining({ code: 'TOTP_NOT_ENROLLED', message: expect.stringMatching(/Activa antes/) }),
    });
    expect(await totp.isEnabled('u1')).toBe(false);
  });

  it('con 2FA: sin código → 403 TOTP_REQUIRED; con el de la app pasa', async () => {
    const { totp } = makeTotpKit({ users: { u1: sealTotpSecret(SECRET, KEK) } });
    expect(await totp.isEnabled('u1')).toBe(true);
    expect(await failureOf(totp.assertIfEnrolledForUser('u1', undefined))).toEqual({
      status: 403,
      body: expect.objectContaining({ code: 'TOTP_REQUIRED', message: expect.stringMatching(/Pon el código/) }),
    });
    await expect(totp.assertIfEnrolledForUser('u1', codeAt(SECRET))).resolves.toBeUndefined();
  });

  it('código malo → 403 TOTP_INVALID; repetido o anterior → TOTP_INVALID con la pista de los 30 s', async () => {
    const { totp } = makeTotpKit({ users: { u1: sealTotpSecret(SECRET, KEK) } });
    expect(await failureOf(totp.assertForUser('u1', '000000'))).toEqual({
      status: 403,
      body: expect.objectContaining({ code: 'TOTP_INVALID', message: expect.stringMatching(/incorrecto/) }),
    });
    await totp.assertForUser('u1', codeAt(SECRET));
    for (const code of [codeAt(SECRET), codeAt(SECRET, STEP - 1)]) {
      const reused = await failureOf(totp.assertForUser('u1', code));
      expect(reused?.status).toBe(403);
      expect(reused?.body).toMatchObject({ code: 'TOTP_INVALID' });
      expect(String(reused?.body.message)).toMatch(/ya se ha usado.*[Ee]spera al siguiente \(cambia cada 30 s\)/);
    }
    await expect(totp.assertForUser('u1', codeAt(SECRET, STEP + 1))).resolves.toBeUndefined();
  });

  it('repetir un código bueno (entrar y aprobar en los mismos 30 s) no bloquea, por muchas veces que sea', async () => {
    const { totp } = makeTotpKit({ users: { u1: sealTotpSecret(SECRET, KEK) } });
    await totp.assertForUser('u1', codeAt(SECRET));
    for (let i = 0; i < 8; i += 1) {
      expect((await failureOf(totp.assertForUser('u1', codeAt(SECRET))))?.status).toBe(403);
    }
    await expect(totp.assertForUser('u1', codeAt(SECRET, STEP + 1))).resolves.toBeUndefined();
  });

  it('5 códigos malos → 429 (TOTP_LOCKED) aunque luego llegue el bueno; a los 15 min vuelve a dejar', async () => {
    const { totp } = makeTotpKit({ users: { u1: sealTotpSecret(SECRET, KEK) } });
    for (let i = 0; i < 4; i++) expect((await failureOf(totp.assertForUser('u1', '000000')))?.status).toBe(403);
    const locked = await failureOf(totp.assertForUser('u1', '000000'));
    expect(locked).toEqual({
      status: 429,
      body: expect.objectContaining({ code: 'TOTP_LOCKED', message: expect.stringMatching(/Demasiados.*15 min/) }),
    });
    expect((await failureOf(totp.assertForUser('u1', codeAt(SECRET))))?.status).toBe(429);

    vi.advanceTimersByTime(15 * 60 * 1000);
    await expect(totp.assertForUser('u1', codeAt(SECRET, totpStepAt(Date.now())))).resolves.toBeUndefined();
  });

  it('secreto cifrado con otra clave → 403 claro (TOTP_UNREADABLE), no 500', async () => {
    const { totp } = makeTotpKit({ users: { u1: sealTotpSecret(SECRET, `${KEK}-otra`) } });
    expect(await failureOf(totp.assertForUser('u1', codeAt(SECRET)))).toEqual({
      status: 403,
      body: expect.objectContaining({ code: 'TOTP_UNREADABLE', message: expect.stringMatching(/No se puede comprobar/) }),
    });
  });

  it('secreto antiguo en claro: vale y se guarda cifrado tras acertar', async () => {
    const { totp, updates } = makeTotpKit({ users: { u1: SECRET } });
    await totp.assertForUser('u1', codeAt(SECRET));
    expect(updates).toHaveLength(1);
    expect(updates[0]!.where).toEqual({ id: 'u1', totpSecret: SECRET });
    expect(openTotpSecret(String(updates[0]!.data.totpSecret), KEK)).toEqual({ secret: SECRET, legacy: false });
  });
});

describe('varias réplicas del API (dos TotpService con el mismo Redis)', () => {
  const users = { u1: sealTotpSecret(SECRET, KEK) };

  it('un código usado en una réplica no vale en la otra', async () => {
    const redis = createFakeRedis();
    const a = makeTotpKit({ redis, users }).totp;
    const b = makeTotpKit({ redis, users }).totp;
    await a.assertIfEnrolledForUser('u1', codeAt(SECRET));
    const reused = await failureOf(b.assertIfEnrolledForUser('u1', codeAt(SECRET)));
    expect(reused).toEqual({ status: 403, body: expect.objectContaining({ code: 'TOTP_INVALID' }) });
    expect(String(reused?.body.message)).toMatch(/ya se ha usado/);
  });

  it('los fallos se suman entre réplicas: 5 repartidos bloquean en las dos', async () => {
    const redis = createFakeRedis();
    const a = makeTotpKit({ redis, users }).totp;
    const b = makeTotpKit({ redis, users }).totp;
    for (let i = 0; i < 4; i++) await failureOf((i % 2 === 0 ? a : b).assertForUser('u1', '000000'));
    expect((await failureOf(b.assertForUser('u1', '000000')))?.status).toBe(429);
    expect((await failureOf(a.assertForUser('u1', codeAt(SECRET))))?.status).toBe(429);
  });

  it('sin Redis compartido (lo de antes, en memoria) el mismo código pasaría dos veces', async () => {
    const a = makeTotpKit({ users }).totp;
    const b = makeTotpKit({ users }).totp;
    await a.assertForUser('u1', codeAt(SECRET));
    await expect(b.assertForUser('u1', codeAt(SECRET))).resolves.toBeUndefined();
  });
});
