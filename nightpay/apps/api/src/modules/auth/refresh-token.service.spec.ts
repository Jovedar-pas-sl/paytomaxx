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
import { AccessRevocationService } from './access-revocation.service';

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

  describe('local elegido por el super-admin en la sesión', () => {
    it('se guarda por family, se borra con null y al cerrar la sesión', async () => {
      const issued = await svc.issue('user-1', 'tenant-1');
      await svc.setActiveVenue(issued.family, 'venue-9');
      expect(await svc.activeVenue(issued.family)).toBe('venue-9');
      expect(await redisMock.ttl(`nightpay:refresh:venue:${issued.family}`)).toBe(REFRESH_FAMILY_MAX_SECONDS);
      await svc.setActiveVenue(issued.family, null);
      expect(await svc.activeVenue(issued.family)).toBeNull();

      await svc.setActiveVenue(issued.family, 'venue-9');
      await svc.revokeFamily(issued.family);
      expect(await svc.activeVenue(issued.family)).toBeNull();
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

  describe('lo que recuerda la sesión (local elegido, 2FA) no sobrevive a cerrarla', () => {
    async function remembering(): Promise<{ token: string; family: string }> {
      const issued = await svc.issue('user-1', 'tenant-1');
      await svc.setActiveVenue(issued.family, 'venue-9');
      await svc.markTwoFactor(issued.family);
      return issued;
    }

    it('revoke (logout) borra el local elegido y la marca de 2FA', async () => {
      const issued = await remembering();
      await svc.revoke(issued.token);
      expect(await svc.activeVenue(issued.family)).toBeNull();
      expect(await svc.hasTwoFactor(issued.family)).toBe(false);
    });

    it('revokeAllForUser (revocar sesiones, reset de contraseña) también', async () => {
      const a = await remembering();
      const b = await remembering();
      await svc.revokeAllForUser('user-1');
      for (const s of [a, b]) {
        expect(await svc.activeVenue(s.family)).toBeNull();
        expect(await svc.hasTwoFactor(s.family)).toBe(false);
      }
    });
  });

  describe('liveSession', () => {
    it('viva mientras le quede un refresh sin usar; tras rotar, sigue; tras el logout, no', async () => {
      const issued = await svc.issue('user-1', 'tenant-1');
      await expect(svc.liveSession(issued.family)).resolves.toEqual({ userId: 'user-1' });
      const rotated = await svc.rotate(issued.token);
      await expect(svc.liveSession(issued.family)).resolves.toEqual({ userId: 'user-1' });
      await svc.revoke(rotated.token);
      await expect(svc.liveSession(issued.family)).resolves.toBeNull();
    });

    it('revocada, de más de 90 días, inventada o con comodines → null', async () => {
      const revoked = await svc.issue('user-1', 'tenant-1');
      await svc.revokeAllForUser('user-1');
      await expect(svc.liveSession(revoked.family)).resolves.toBeNull();

      const old = await svc.issue('user-2', 'tenant-1', { familyCreatedAt: Date.now() - REFRESH_FAMILY_MAX_SECONDS * 1000 - 1 });
      await expect(svc.liveSession(old.family)).resolves.toBeNull();

      await svc.issue('user-3', 'tenant-1');
      await expect(svc.liveSession('00000000-0000-4000-8000-000000000000')).resolves.toBeNull();
      await expect(svc.liveSession('*')).resolves.toBeNull();
    });
  });

  afterEach(() => vi.useRealTimers());
});

describe('RefreshTokenService — cerrar sesiones corta también los tokens de acceso ya emitidos', () => {
  function withRevocations() {
    const redis = createFakeRedis();
    const revocations = new AccessRevocationService(redis as never);
    const svc = new RefreshTokenService(redis as never, revocations);
    const access = (userId: string, sid: string) => ({ sub: userId, sid, iat: Math.floor(Date.now() / 1000) - 60 });
    return { svc, revocations, access, redis };
  }

  it('logout (revoke): la sesión que se cierra, y solo esa', async () => {
    const { svc, revocations, access } = withRevocations();
    const a = await svc.issue('user-1', 'tenant-1');
    const b = await svc.issue('user-1', 'tenant-1');
    await svc.revoke(a.token);
    await expect(revocations.isRevoked(access('user-1', a.family))).resolves.toBe(true);
    await expect(revocations.isRevoked(access('user-1', b.family))).resolves.toBe(false);
  });

  it('logout con un refresh ya rotado (la app no guardó el nuevo) → la sesión entera', async () => {
    const { svc, revocations, access } = withRevocations();
    const issued = await svc.issue('user-1', 'tenant-1');
    await svc.rotate(issued.token);
    await svc.revoke(issued.token);
    await expect(revocations.isRevoked(access('user-1', issued.family))).resolves.toBe(true);
  });

  it('revokeFamily (reuso del refresh, contraseña cambiada, 2FA quitada, 90 días)', async () => {
    const { svc, revocations, access } = withRevocations();
    const issued = await svc.issue('user-1', 'tenant-1');
    await svc.revokeFamily(issued.family);
    await expect(revocations.isRevoked(access('user-1', issued.family))).resolves.toBe(true);
  });

  it('revokeAllForUser (móvil perdido, baja, reset de contraseña o de 2FA): todas sus sesiones, y no las de otros', async () => {
    const { svc, revocations, access } = withRevocations();
    const a = await svc.issue('user-1', 'tenant-1');
    const b = await svc.issue('user-1', 'tenant-1');
    const other = await svc.issue('user-2', 'tenant-1');
    await expect(svc.revokeAllForUser('user-1')).resolves.toBe(2);
    await expect(revocations.isRevoked(access('user-1', a.family))).resolves.toBe(true);
    // Uno emitido en este mismo segundo, antes de revocar: lo corta la marca de su sesión.
    await expect(
      revocations.isRevoked({ sub: 'user-1', sid: b.family, iat: Math.floor(Date.now() / 1000) }),
    ).resolves.toBe(true);
    await expect(revocations.isRevoked(access('user-1', b.family))).resolves.toBe(true);
    // También un token suyo de una sesión que ya no tenía refresh (o sin sid).
    await expect(revocations.isRevoked({ sub: 'user-1', iat: Math.floor(Date.now() / 1000) - 60 })).resolves.toBe(true);
    await expect(revocations.isRevoked(access('user-2', other.family))).resolves.toBe(false);
  });

  it('sin el servicio inyectado (pruebas antiguas) marca igual en el mismo Redis', async () => {
    const redis = createFakeRedis();
    const svc = new RefreshTokenService(redis as never);
    const issued = await svc.issue('user-1', 'tenant-1');
    await svc.revoke(issued.token);
    const revocations = new AccessRevocationService(redis as never);
    await expect(revocations.isRevoked({ sub: 'user-1', sid: issued.family, iat: 1 })).resolves.toBe(true);
  });
});
