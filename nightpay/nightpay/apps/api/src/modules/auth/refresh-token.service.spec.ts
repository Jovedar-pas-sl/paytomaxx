import { describe, it, expect, beforeEach } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { RefreshTokenService } from './refresh-token.service';

/**
 * In-memory Redis mock — solo los metodos que RefreshTokenService usa.
 * Suficiente para verificar la logica de rotacion / reuso / revocacion.
 */
function createRedisMock() {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();

  const set = (key: string, value: string, _ex?: string, ttl?: number) => {
    store.set(key, value);
    if (ttl !== undefined) ttls.set(key, ttl);
    return Promise.resolve('OK');
  };

  const get = (key: string) => Promise.resolve(store.get(key) ?? null);

  const del = (...keys: string[]) => {
    let n = 0;
    for (const k of keys) {
      if (store.delete(k)) n += 1;
      ttls.delete(k);
    }
    return Promise.resolve(n);
  };

  const scan = (_cursor: string, _matchTok: 'MATCH', pattern: string, _countTok: 'COUNT', _count: number) => {
    const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    const matched = Array.from(store.keys()).filter((k) => re.test(k));
    return Promise.resolve(['0', matched] as [string, string[]]);
  };

  const multi = () => {
    const ops: Array<() => Promise<unknown>> = [];
    const chain = {
      set: (k: string, v: string, ex?: string, ttl?: number) => {
        ops.push(() => set(k, v, ex, ttl));
        return chain;
      },
      exec: async () => {
        for (const op of ops) await op();
        return [];
      },
    };
    return chain;
  };

  return { set, get, del, scan, multi, _store: store };
}

function makeService() {
  const redisMock = createRedisMock();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = new RefreshTokenService(redisMock as any);
  return { svc, redisMock };
}

describe('RefreshTokenService', () => {
  let svc: RefreshTokenService;
  let redisMock: ReturnType<typeof createRedisMock>;

  beforeEach(() => {
    const made = makeService();
    svc = made.svc;
    redisMock = made.redisMock;
  });

  describe('issue', () => {
    it('returns a token in <jti>.<secret> format', async () => {
      const result = await svc.issue('user-1', 'tenant-1');
      expect(result.token).toMatch(/^[0-9a-f-]{36}\.[0-9a-f]{64}$/);
      expect(result.ttlSeconds).toBeGreaterThan(0);
      expect(result.family).toBeTruthy();
    });

    it('persists three index keys (main, family, user)', async () => {
      const { token, family } = await svc.issue('user-1', 'tenant-1');
      const jti = token.split('.')[0]!;
      expect(redisMock._store.has(`nightpay:refresh:${jti}`)).toBe(true);
      expect(redisMock._store.has(`nightpay:refresh:family:${family}:${jti}`)).toBe(true);
      expect(redisMock._store.has(`nightpay:refresh:user:user-1:${jti}`)).toBe(true);
    });
  });

  describe('rotate', () => {
    it('issues a new token in the same family + invalidates the old jti', async () => {
      const issued = await svc.issue('user-1', 'tenant-1');
      const oldJti = issued.token.split('.')[0]!;

      const rotated = await svc.rotate(issued.token);

      expect(rotated.token).not.toBe(issued.token);
      expect(rotated.userId).toBe('user-1');
      expect(rotated.tenantId).toBe('tenant-1');
      // Vieja entrada borrada
      expect(redisMock._store.has(`nightpay:refresh:${oldJti}`)).toBe(false);
      // Nueva entrada existe
      const newJti = rotated.token.split('.')[0]!;
      expect(redisMock._store.has(`nightpay:refresh:${newJti}`)).toBe(true);
    });

    it('rejects an already-rotated token (reuse detection)', async () => {
      const issued = await svc.issue('user-1', 'tenant-1');
      await svc.rotate(issued.token);
      // Reusar el viejo token — ya no existe en Redis
      await expect(svc.rotate(issued.token)).rejects.toThrow(UnauthorizedException);
    });

    it('rejects + revokes family when secret is tampered', async () => {
      const issued = await svc.issue('user-1', 'tenant-1');
      const [jti] = issued.token.split('.');
      const tamperedToken = `${jti}.${'0'.repeat(64)}`;

      // Antes del intento: la family tiene 1 entrada en su index
      expect(
        Array.from(redisMock._store.keys()).filter((k) =>
          k.startsWith(`nightpay:refresh:family:${issued.family}:`),
        ),
      ).toHaveLength(1);

      await expect(svc.rotate(tamperedToken)).rejects.toThrow(UnauthorizedException);

      // Tras el intento: la family entera debe estar borrada
      expect(
        Array.from(redisMock._store.keys()).filter((k) =>
          k.startsWith(`nightpay:refresh:family:${issued.family}:`),
        ),
      ).toHaveLength(0);
      expect(redisMock._store.has(`nightpay:refresh:${jti}`)).toBe(false);
    });

    it('rejects malformed tokens', async () => {
      await expect(svc.rotate('not-a-token')).rejects.toThrow(UnauthorizedException);
      await expect(svc.rotate('aaa.bbb')).rejects.toThrow(UnauthorizedException);
      await expect(svc.rotate('')).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('revoke', () => {
    it('removes a refresh token and is idempotent', async () => {
      const issued = await svc.issue('user-1', 'tenant-1');
      const jti = issued.token.split('.')[0]!;

      await svc.revoke(issued.token);
      expect(redisMock._store.has(`nightpay:refresh:${jti}`)).toBe(false);

      // Idempotente — no lanza
      await expect(svc.revoke(issued.token)).resolves.toBeUndefined();
    });

    it('silently ignores malformed tokens', async () => {
      await expect(svc.revoke('garbage')).resolves.toBeUndefined();
    });
  });

  describe('revokeAllForUser', () => {
    it('deletes every active refresh token for that user', async () => {
      await svc.issue('user-1', 'tenant-1');
      await svc.issue('user-1', 'tenant-1');
      await svc.issue('user-2', 'tenant-1'); // distinto user — debe sobrevivir

      const removed = await svc.revokeAllForUser('user-1');

      expect(removed).toBe(2);
      const remainingUser1 = Array.from(redisMock._store.keys()).filter((k) =>
        k.startsWith('nightpay:refresh:user:user-1:'),
      );
      expect(remainingUser1).toHaveLength(0);
      const remainingUser2 = Array.from(redisMock._store.keys()).filter((k) =>
        k.startsWith('nightpay:refresh:user:user-2:'),
      );
      expect(remainingUser2).toHaveLength(1);
    });

    it('returns 0 when user has no active sessions', async () => {
      const removed = await svc.revokeAllForUser('ghost-user');
      expect(removed).toBe(0);
    });
  });
});
