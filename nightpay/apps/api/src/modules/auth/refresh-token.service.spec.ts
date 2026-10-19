import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { Logger, UnauthorizedException } from '@nestjs/common';
import {
  passwordFingerprint,
  REFRESH_FAMILY_MAX_SECONDS,
  REFRESH_GRACE_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  RefreshTokenReuseError,
  RefreshTokenService,
} from './refresh-token.service';
import { createFakeRedis, type FakeRedis } from './testing/fake-redis';

function makeService() {
  const redisMock = createFakeRedis();
  const svc = new RefreshTokenService(redisMock as never);
  return { svc, redisMock };
}

function jtiOf(token: string): string {
  return token.split('.')[0]!;
}

function familyKeys(redis: FakeRedis, family: string): string[] {
  return redis.keys().filter((k) => k.startsWith(`nightpay:refresh:family:${family}:`));
}

describe('RefreshTokenService', () => {
  let svc: RefreshTokenService;
  let redisMock: FakeRedis;

  beforeEach(() => {
    const made = makeService();
    svc = made.svc;
    redisMock = made.redisMock;
  });

  describe('passwordFingerprint', () => {
    it('16 hex estables; cambia si cambia el hash', () => {
      const a = passwordFingerprint('$2a$10$hashA');
      expect(a).toMatch(/^[0-9a-f]{16}$/);
      expect(passwordFingerprint('$2a$10$hashA')).toBe(a);
      expect(passwordFingerprint('$2a$10$hashB')).not.toBe(a);
    });
  });

  describe('issue', () => {
    it('returns a token in <jti>.<secret> format', async () => {
      const result = await svc.issue('user-1', 'tenant-1');
      expect(result.token).toMatch(/^[0-9a-f-]{36}\.[0-9a-f]{64}$/);
      expect(result.ttlSeconds).toBe(REFRESH_TOKEN_TTL_SECONDS);
      expect(result.family).toBeTruthy();
    });

    it('persists three index keys (main, family, user) and the password fingerprint', async () => {
      const { token, family } = await svc.issue('user-1', 'tenant-1', { pwdFp: 'abcdef0123456789' });
      const jti = jtiOf(token);
      expect(redisMock.has(`nightpay:refresh:${jti}`)).toBe(true);
      expect(redisMock.has(`nightpay:refresh:family:${family}:${jti}`)).toBe(true);
      expect(redisMock.has(`nightpay:refresh:user:user-1:${jti}`)).toBe(true);
      const stored = JSON.parse((await redisMock.get(`nightpay:refresh:${jti}`))!) as { pwdFp?: string };
      expect(stored.pwdFp).toBe('abcdef0123456789');
    });
  });

  describe('rotate', () => {
    it('issues a new token in the same family + invalidates the old jti', async () => {
      const issued = await svc.issue('user-1', 'tenant-1', { pwdFp: 'fp1' });
      const oldJti = jtiOf(issued.token);

      const rotated = await svc.rotate(issued.token);

      expect(rotated.token).not.toBe(issued.token);
      expect(rotated).toMatchObject({ userId: 'user-1', tenantId: 'tenant-1', family: issued.family, pwdFp: 'fp1' });
      expect(redisMock.has(`nightpay:refresh:${oldJti}`)).toBe(false);
      expect(redisMock.has(`nightpay:refresh:${jtiOf(rotated.token)}`)).toBe(true);
      // El nuevo hereda la huella de la contraseña.
      const stored = JSON.parse((await redisMock.get(`nightpay:refresh:${jtiOf(rotated.token)}`))!) as {
        pwdFp?: string;
      };
      expect(stored.pwdFp).toBe('fp1');
    });

    it('reuso de un token ya rotado (pasado el margen) → revoca TODA la family, también el nuevo', async () => {
      vi.useFakeTimers();
      try {
        const issued = await svc.issue('user-1', 'tenant-1');
        const rotated = await svc.rotate(issued.token);
        vi.advanceTimersByTime((REFRESH_GRACE_SECONDS + 1) * 1000);

        const err = await svc.rotate(issued.token).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(RefreshTokenReuseError);
        expect(err).toBeInstanceOf(UnauthorizedException);
        expect((err as RefreshTokenReuseError).userId).toBe('user-1');

        expect(familyKeys(redisMock, issued.family)).toHaveLength(0);
        await expect(svc.rotate(rotated.token)).rejects.toThrow(UnauthorizedException);
      } finally {
        vi.useRealTimers();
      }
    });

    it('dos refrescos a la vez con el mismo token → los dos reciben el MISMO par nuevo', async () => {
      const issued = await svc.issue('user-1', 'tenant-1');
      const [a, b] = await Promise.all([svc.rotate(issued.token), svc.rotate(issued.token)]);
      expect(a.token).toBe(b.token);
      expect(familyKeys(redisMock, issued.family)).toHaveLength(1);
      // Y el par nuevo sigue funcionando.
      await expect(svc.rotate(a.token)).resolves.toMatchObject({ family: issued.family });
    });

    it('repetido dentro del margen (p. ej. respuesta perdida) → mismo par nuevo, sin revocar', async () => {
      const issued = await svc.issue('user-1', 'tenant-1');
      const first = await svc.rotate(issued.token);
      const again = await svc.rotate(issued.token);
      expect(again.token).toBe(first.token);
      expect(familyKeys(redisMock, issued.family)).toHaveLength(1);
    });

    it('dentro del margen pero el par nuevo ya se rotó otra vez → 401 sin revocar', async () => {
      const issued = await svc.issue('user-1', 'tenant-1');
      const first = await svc.rotate(issued.token);
      const second = await svc.rotate(first.token);
      await expect(svc.rotate(issued.token)).rejects.toThrow(UnauthorizedException);
      expect(redisMock.has(`nightpay:refresh:${jtiOf(second.token)}`)).toBe(true);
    });

    it('jti ya usado pero secreto falso → 401 sin revocar nada (no basta con conocer el jti)', async () => {
      vi.useFakeTimers();
      try {
        const issued = await svc.issue('user-1', 'tenant-1');
        const rotated = await svc.rotate(issued.token);
        vi.advanceTimersByTime((REFRESH_GRACE_SECONDS + 1) * 1000);
        await expect(svc.rotate(`${jtiOf(issued.token)}.${'0'.repeat(64)}`)).rejects.toThrow(UnauthorizedException);
        expect(redisMock.has(`nightpay:refresh:${jtiOf(rotated.token)}`)).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('jti vivo con un secreto falso → solo 401: la sesión de su dueño sigue', async () => {
      const issued = await svc.issue('user-1', 'tenant-1');
      const jti = jtiOf(issued.token);

      await expect(svc.rotate(`${jti}.${'0'.repeat(64)}`)).rejects.toThrow(UnauthorizedException);

      expect(familyKeys(redisMock, issued.family)).toHaveLength(1);
      expect(redisMock.has(`nightpay:refresh:${jti}`)).toBe(true);
      await expect(svc.rotate(issued.token)).resolves.toMatchObject({ family: issued.family });
    });

    it('los logs no llevan el jti entero', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const issued = await svc.issue('user-1', 'tenant-1');
      const jti = jtiOf(issued.token);
      await expect(svc.rotate(`${jti}.${'0'.repeat(64)}`)).rejects.toThrow(UnauthorizedException);
      const rotated = await svc.rotate(issued.token);
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + (REFRESH_GRACE_SECONDS + 1) * 1000);
      await expect(svc.rotate(issued.token)).rejects.toThrow(RefreshTokenReuseError);
      const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain(jti.slice(0, 8));
      expect(logged).not.toContain(jti);
      expect(logged).not.toContain(rotated.family);
      warn.mockRestore();
    });

    it('rejects malformed tokens', async () => {
      await expect(svc.rotate('not-a-token')).rejects.toThrow(UnauthorizedException);
      await expect(svc.rotate('aaa.bbb')).rejects.toThrow(UnauthorizedException);
      await expect(svc.rotate('')).rejects.toThrow(UnauthorizedException);
    });

    it('el rastro de tokens usados caduca con la vida del token', async () => {
      const issued = await svc.issue('user-1', 'tenant-1');
      await svc.rotate(issued.token);
      const ttl = await redisMock.ttl(`nightpay:refresh:used:${jtiOf(issued.token)}`);
      expect(ttl).toBe(REFRESH_TOKEN_TTL_SECONDS);
    });
  });

  describe('vida máxima de la sesión (90 días desde el login)', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    it('refrescar no la alarga: cerca de los 90 días el token nuevo caduca con la sesión', async () => {
      vi.useFakeTimers();
      const t0 = new Date('2026-10-01T10:00:00Z').getTime();
      vi.setSystemTime(t0);
      let token = (await svc.issue('user-1', 'tenant-1')).token;
      for (let day = 1; day <= 88; day++) {
        vi.setSystemTime(t0 + day * DAY_MS);
        token = (await svc.rotate(token)).token;
      }
      // Día 88: al token nuevo le quedan 2 días (no 30).
      expect(await redisMock.ttl(`nightpay:refresh:${jtiOf(token)}`)).toBe(2 * 24 * 60 * 60);

      vi.setSystemTime(t0 + REFRESH_FAMILY_MAX_SECONDS * 1000 - 1000);
      const last = await svc.rotate(token);
      expect(last.ttlSeconds).toBe(1);
      expect(await redisMock.ttl(`nightpay:refresh:${jtiOf(last.token)}`)).toBe(1);
    });

    it('una sesión de más de 90 días → 401 y la family entera fuera', async () => {
      const old = Date.now() - REFRESH_FAMILY_MAX_SECONDS * 1000 - 1000;
      const issued = await svc.issue('user-1', 'tenant-1', { familyCreatedAt: old });
      const sibling = await svc.issue('user-1', 'tenant-1', { family: issued.family, familyCreatedAt: old });
      await expect(svc.rotate(issued.token)).rejects.toThrow(UnauthorizedException);
      expect(familyKeys(redisMock, issued.family)).toHaveLength(0);
      expect(redisMock.has(`nightpay:refresh:${jtiOf(sibling.token)}`)).toBe(false);
    });

    it('token de antes de esta versión (sin inicio de sesión): cuenta desde su emisión', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-01T10:00:00Z'));
      const issued = await svc.issue('user-1', 'tenant-1');
      const key = `nightpay:refresh:${jtiOf(issued.token)}`;
      const { familyCreatedAt: _start, ...legacy } = JSON.parse((await redisMock.get(key))!) as Record<string, unknown>;
      await redisMock.set(key, JSON.stringify(legacy), 'KEEPTTL');
      const rotated = await svc.rotate(issued.token);
      const stored = JSON.parse((await redisMock.get(`nightpay:refresh:${jtiOf(rotated.token)}`))!) as {
        familyCreatedAt?: number;
      };
      expect(stored.familyCreatedAt).toBe(new Date('2026-10-01T10:00:00Z').getTime());
    });
  });

  describe('stampFingerprint (tokens de antes de esta versión)', () => {
    it('apunta la huella sin tocar la caducidad', async () => {
      const issued = await svc.issue('user-1', 'tenant-1');
      const key = `nightpay:refresh:${jtiOf(issued.token)}`;
      await svc.stampFingerprint(issued.token, 'fp-now');
      expect((JSON.parse((await redisMock.get(key))!) as { pwdFp?: string }).pwdFp).toBe('fp-now');
      expect(await redisMock.ttl(key)).toBe(REFRESH_TOKEN_TTL_SECONDS);
    });

    it('nunca resucita un token ya borrado', async () => {
      const issued = await svc.issue('user-1', 'tenant-1');
      await svc.revoke(issued.token);
      await svc.stampFingerprint(issued.token, 'fp-now');
      expect(redisMock.has(`nightpay:refresh:${jtiOf(issued.token)}`)).toBe(false);
    });
  });

  describe('revoke', () => {
    it('removes a refresh token, returns its owner and is idempotent', async () => {
      const issued = await svc.issue('user-1', 'tenant-1');
      const jti = jtiOf(issued.token);

      await expect(svc.revoke(issued.token)).resolves.toEqual({ userId: 'user-1', tenantId: 'tenant-1' });
      expect(redisMock.has(`nightpay:refresh:${jti}`)).toBe(false);

      // Idempotente — no lanza
      await expect(svc.revoke(issued.token)).resolves.toBeNull();
    });

    it('con el secreto falso no revoca nada (el jti sale en logs)', async () => {
      const issued = await svc.issue('user-1', 'tenant-1');
      await expect(svc.revoke(`${jtiOf(issued.token)}.${'0'.repeat(64)}`)).resolves.toBeNull();
      expect(redisMock.has(`nightpay:refresh:${jtiOf(issued.token)}`)).toBe(true);
    });

    it('con un token ya rotado (la app no guardó el nuevo) cierra la sesión entera', async () => {
      const issued = await svc.issue('user-1', 'tenant-1');
      const rotated = await svc.rotate(issued.token);
      await expect(svc.revoke(issued.token)).resolves.toEqual({ userId: 'user-1', tenantId: 'tenant-1' });
      await expect(svc.rotate(rotated.token)).rejects.toThrow(UnauthorizedException);
    });

    it('silently ignores malformed tokens', async () => {
      await expect(svc.revoke('garbage')).resolves.toBeNull();
    });
  });

  describe('revokeAllForUser', () => {
    it('deletes every active refresh token for that user', async () => {
      await svc.issue('user-1', 'tenant-1');
      await svc.issue('user-1', 'tenant-1');
      await svc.issue('user-2', 'tenant-1'); // distinto user — debe sobrevivir

      const removed = await svc.revokeAllForUser('user-1');

      expect(removed).toBe(2);
      expect(redisMock.keys().filter((k) => k.startsWith('nightpay:refresh:user:user-1:'))).toHaveLength(0);
      expect(redisMock.keys().filter((k) => k.startsWith('nightpay:refresh:user:user-2:'))).toHaveLength(1);
    });

    it('returns 0 when user has no active sessions', async () => {
      const removed = await svc.revokeAllForUser('ghost-user');
      expect(removed).toBe(0);
    });
  });

  afterEach(() => vi.useRealTimers());
});
