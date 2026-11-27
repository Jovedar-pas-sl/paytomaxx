import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { ipPrefixKey } from '../../../common/http/client-ip';
import { REDIS_CLIENT } from '../../../common/redis/redis.module';

/**
 * Fallos de autenticación de la API de socios, en Redis y antes de la base.
 * Solo cuentan los de verdad: clave mal formada, del otro entorno o que no
 * existe (nunca una IP que no está en la lista: quien robe la clave bloquearía
 * la buena). Si Redis no responde, quien llama falla (503 try_later).
 *
 *  - por clave (sha256): 20 fallos en 10 min → 15 min sin mirar la base (401);
 *  - por IP (IPv6 por /48): 20 claves distintas en 10 min → 15 min de 429,
 *    salvo a una clave buena cuya lista tiene esa IP (el guard lo mira);
 *  - todos: más de 600 en un minuto → 60 s de 503 a lo que no se conoce.
 *  - `ok:<h>`: la clave funcionó hace menos de 24 h (pasa los bloqueos).
 */
export const PAUTH_LIMITS = Object.freeze({
  keyFails: 20,
  keyWindowS: 600,
  keyBlockS: 900,
  ipKeys: 20,
  ipWindowS: 600,
  ipBlockS: 900,
  /** Con la IP bloqueada, claves aún sin conocer que se buscan en la base (paso 5), por IP y bloqueo. */
  blockedIpLookups: 30,
  breakerFails: 601,
  breakerS: 60,
  okS: 86_400,
});

export interface PartnerAuthState {
  keyBlocked: boolean;
  /** Funcionó hace menos de 24 h. */
  known: boolean;
  breaker: boolean;
  ipBlocked: boolean;
}

/** La IP de los topes de fallos: IPv4 tal cual; IPv6, su /48. */
export function authIpKey(ip: string | null): string {
  return ip ? ipPrefixKey(ip, 48) : 'desconocida';
}

const K = {
  key: (h: string) => `np:pauth:key:${h}`,
  keyBlock: (h: string) => `np:pauth:keyblock:${h}`,
  ipSeen: (ip: string, h: string) => `np:pauth:ipseen:${ip}:${h}`,
  ip: (ip: string) => `np:pauth:ip:${ip}`,
  ipBlock: (ip: string) => `np:pauth:ipblock:${ip}`,
  ipBlockLookups: (ip: string) => `np:pauth:ipblocklookups:${ip}`,
  fail: (minute: number) => `np:pauth:fail:${minute}`,
  breaker: 'np:pauth:breaker',
  ok: (h: string) => `np:pauth:ok:${h}`,
  retired: (h: string) => `np:pk-retired:${h}`,
};

@Injectable()
export class PartnerAuthLimiter {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** Una lectura (MGET): bloqueos, cortacircuitos y si la clave se conoce. */
  async state(keyHash: string, ip: string | null): Promise<PartnerAuthState> {
    const ipKey = authIpKey(ip);
    const [keyBlock, ok, breaker, ipBlock] = await this.redis.mget(K.keyBlock(keyHash), K.ok(keyHash), K.breaker, K.ipBlock(ipKey));
    return { keyBlocked: keyBlock !== null, known: ok !== null, breaker: breaker !== null, ipBlocked: ipBlock !== null };
  }

  async recordFailure(keyHash: string, ip: string | null): Promise<void> {
    const ipKey = authIpKey(ip);
    if ((await this.count(K.key(keyHash), PAUTH_LIMITS.keyWindowS)) >= PAUTH_LIMITS.keyFails) {
      await this.redis.set(K.keyBlock(keyHash), '1', 'EX', PAUTH_LIMITS.keyBlockS);
    }
    // Solo las claves distintas: la misma repetida no bloquea la IP.
    if ((await this.redis.set(K.ipSeen(ipKey, keyHash), '1', 'EX', PAUTH_LIMITS.ipWindowS, 'NX')) === 'OK') {
      if ((await this.count(K.ip(ipKey), PAUTH_LIMITS.ipWindowS)) >= PAUTH_LIMITS.ipKeys) {
        await this.redis.set(K.ipBlock(ipKey), '1', 'EX', PAUTH_LIMITS.ipBlockS);
      }
    }
    if ((await this.count(K.fail(Math.floor(Date.now() / 60_000)), 120)) >= PAUTH_LIMITS.breakerFails) {
      await this.redis.set(K.breaker, '1', 'EX', PAUTH_LIMITS.breakerS);
    }
  }

  /**
   * Con la IP bloqueada, ¿se busca en la base esta clave aún sin conocer? Para
   * que pase una buena con esa IP en su lista (paso 5): pocas por IP y bloqueo.
   */
  async lookupFromBlockedIp(ip: string | null): Promise<boolean> {
    return (await this.count(K.ipBlockLookups(authIpKey(ip)), PAUTH_LIMITS.ipBlockS)) <= PAUTH_LIMITS.blockedIpLookups;
  }

  /** La clave funcionó: 24 h sin bloqueos ni cortacircuitos para ella. */
  async markGood(keyHash: string): Promise<void> {
    await this.redis.set(K.ok(keyHash), '1', 'EX', PAUTH_LIMITS.okS);
  }

  /** Cambiada por otra hace poco: `401 api_key_rotated` (no cuenta como fallo). */
  async isRetired(keyHash: string): Promise<boolean> {
    return (await this.redis.get(K.retired(keyHash))) !== null;
  }

  /** Al rotar: la clave que sale se reconoce durante su solape y 30 días más. */
  async retire(keyHash: string, ttlS: number): Promise<void> {
    await this.redis.set(K.retired(keyHash), '1', 'EX', Math.max(1, Math.ceil(ttlS)));
  }

  private async count(key: string, windowS: number): Promise<number> {
    const n = await this.redis.incr(key);
    if (n === 1) await this.redis.expire(key, windowS);
    return n;
  }
}
