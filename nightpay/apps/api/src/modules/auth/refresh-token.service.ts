import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../common/redis/redis.module';

export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30d

interface StoredRefresh {
  userId: string;
  tenantId: string;
  family: string;
  secretHash: string;
  issuedAt: number;
  lastUsedAt: number;
}

/**
 * Refresh tokens opacos con rotacion + deteccion de reuso.
 *
 * Formato: `<jti>.<secret>` donde:
 *   - jti = UUID v4 (id de la sesion en Redis)
 *   - secret = 32 bytes hex (lo que el cliente debe presentar)
 *
 * Estado en Redis:
 *   nightpay:refresh:<jti> -> JSON StoredRefresh (TTL 30d)
 *   nightpay:refresh:family:<familyId>:<jti> -> '1' (TTL 30d)  // indice para revoke-all
 *   nightpay:refresh:user:<userId>:<jti> -> '1' (TTL 30d)      // indice para revoke-user
 *
 * Rotacion: en cada `refresh()` se borra el jti viejo y se emite uno nuevo en la
 * misma family. Si llega un refresh con un jti ya consumido (no existe en Redis
 * pero el cliente cree que es valido), se invalida la family entera — senal de robo.
 */
@Injectable()
export class RefreshTokenService {
  private readonly logger = new Logger(RefreshTokenService.name);
  private readonly redis: Redis;

  constructor(@Inject(REDIS_CLIENT) redis: Redis) {
    this.redis = redis;
  }

  /** Emite un refresh token nuevo y devuelve el string opaco al cliente. */
  async issue(userId: string, tenantId: string, family?: string): Promise<{ token: string; family: string; ttlSeconds: number }> {
    const jti = randomUUID();
    const secret = randomBytes(32).toString('hex');
    const familyId = family ?? randomUUID();
    const stored: StoredRefresh = {
      userId,
      tenantId,
      family: familyId,
      secretHash: hashSecret(secret),
      issuedAt: Date.now(),
      lastUsedAt: Date.now(),
    };

    const tx = this.redis.multi();
    tx.set(this.key(jti), JSON.stringify(stored), 'EX', REFRESH_TOKEN_TTL_SECONDS);
    tx.set(this.familyKey(familyId, jti), '1', 'EX', REFRESH_TOKEN_TTL_SECONDS);
    tx.set(this.userKey(userId, jti), '1', 'EX', REFRESH_TOKEN_TTL_SECONDS);
    await tx.exec();

    return {
      token: `${jti}.${secret}`,
      family: familyId,
      ttlSeconds: REFRESH_TOKEN_TTL_SECONDS,
    };
  }

  /**
   * Rota un refresh token: valida, borra el viejo y emite uno nuevo en la misma family.
   * Lanza UnauthorizedException si el token no existe, esta caducado, o tiene secret invalido.
   * Si detecta reuso (token consumido), revoca toda la family.
   */
  async rotate(rawToken: string): Promise<{ userId: string; tenantId: string; token: string; ttlSeconds: number }> {
    const parsed = parseToken(rawToken);
    if (!parsed) throw new UnauthorizedException('Invalid refresh token');

    const stored = await this.fetch(parsed.jti);
    if (!stored) {
      // Token no existe en Redis. Posibles causas: expiro, ya rotado (reuso!), o nunca existio.
      // No tenemos forma directa de saber a que family pertenecia, asi que solo logueamos.
      this.logger.warn(`Refresh token reuse or expired (jti=${parsed.jti})`);
      throw new UnauthorizedException('Invalid refresh token');
    }

    // Verifica secret en tiempo constante
    const expected = Buffer.from(stored.secretHash, 'hex');
    const candidate = Buffer.from(hashSecret(parsed.secret), 'hex');
    const ok = expected.length === candidate.length && timingSafeEqual(expected, candidate);
    if (!ok) {
      // Secret incorrecto pero jti existe — probablemente robo. Revocar family.
      this.logger.warn(`Refresh secret mismatch for jti=${parsed.jti} — revoking family ${stored.family}`);
      await this.revokeFamily(stored.family);
      throw new UnauthorizedException('Invalid refresh token');
    }

    // Consumirlo de forma atómica: si otro refresco ya lo consumió, este no vale.
    const claimed = await this.redis.del(this.key(parsed.jti));
    if (claimed !== 1) {
      this.logger.warn(`Refresh token ya consumido (jti=${parsed.jti})`);
      throw new UnauthorizedException('Invalid refresh token');
    }
    // Borrar índices del jti viejo
    await this.deleteJti(parsed.jti, stored);

    // Emitir nuevo en misma family
    const issued = await this.issue(stored.userId, stored.tenantId, stored.family);
    return {
      userId: stored.userId,
      tenantId: stored.tenantId,
      token: issued.token,
      ttlSeconds: issued.ttlSeconds,
    };
  }

  /** Revoca un refresh token concreto (logout). No falla si ya estaba revocado. */
  async revoke(rawToken: string): Promise<void> {
    const parsed = parseToken(rawToken);
    if (!parsed) return;
    const stored = await this.fetch(parsed.jti);
    if (!stored) return;
    await this.deleteJti(parsed.jti, stored);
  }

  /** Revoca todos los refresh tokens activos de un usuario (kill-switch para device theft). */
  async revokeAllForUser(userId: string): Promise<number> {
    const pattern = `nightpay:refresh:user:${userId}:*`;
    const keys = await this.scanKeys(pattern);
    let count = 0;
    for (const k of keys) {
      const jti = k.split(':').pop();
      if (!jti) continue;
      const stored = await this.fetch(jti);
      if (stored) {
        await this.deleteJti(jti, stored);
        count += 1;
      } else {
        await this.redis.del(k);
      }
    }
    if (count > 0) this.logger.log(`Revoked ${count} refresh tokens for user ${userId}`);
    return count;
  }

  /** Revoca toda una family (deteccion de reuso). */
  private async revokeFamily(familyId: string): Promise<void> {
    const pattern = `nightpay:refresh:family:${familyId}:*`;
    const keys = await this.scanKeys(pattern);
    for (const k of keys) {
      const jti = k.split(':').pop();
      if (!jti) continue;
      const stored = await this.fetch(jti);
      if (stored) await this.deleteJti(jti, stored);
      else await this.redis.del(k);
    }
  }

  private async fetch(jti: string): Promise<StoredRefresh | null> {
    const raw = await this.redis.get(this.key(jti));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StoredRefresh;
    } catch {
      return null;
    }
  }

  private async deleteJti(jti: string, stored: StoredRefresh): Promise<void> {
    await this.redis.del(
      this.key(jti),
      this.familyKey(stored.family, jti),
      this.userKey(stored.userId, jti),
    );
  }

  private async scanKeys(pattern: string): Promise<string[]> {
    const found: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = next;
      found.push(...batch);
    } while (cursor !== '0');
    return found;
  }

  private key(jti: string): string {
    return `nightpay:refresh:${jti}`;
  }
  private familyKey(family: string, jti: string): string {
    return `nightpay:refresh:family:${family}:${jti}`;
  }
  private userKey(userId: string, jti: string): string {
    return `nightpay:refresh:user:${userId}:${jti}`;
  }
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function parseToken(raw: string): { jti: string; secret: string } | null {
  const dot = raw.indexOf('.');
  if (dot < 1 || dot === raw.length - 1) return null;
  const jti = raw.slice(0, dot);
  const secret = raw.slice(dot + 1);
  // jti es UUID v4 — 36 chars con dashes
  if (jti.length !== 36 || !/^[0-9a-f-]+$/i.test(jti)) return null;
  if (secret.length < 16) return null;
  return { jti, secret };
}
