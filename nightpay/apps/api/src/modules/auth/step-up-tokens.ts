import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { STEP_UP_ACTION_TTL_SECONDS, type StepUpProof } from '@nightpay/contracts';
import { REDIS_CLIENT } from '../../common/redis/redis.module';

/**
 * Pruebas para actuar sin 2FA (con la llave de acceso): una por acción, de un
 * solo uso, 2 minutos, atada a la persona, a su sesión y a la acción
 * («refund:<cobro>:<importe>»). Aquí solo su sha256: el token va al navegador
 * y vuelve una vez en la cabecera X-Step-Up-Token. La gasta TotpService al
 * pedir la 2FA de esa acción.
 */
export interface StoredProof {
  userId: string;
  sessionId: string | null;
  action: string;
}

const proofKey = (token: string): string => `np:stepup:act:${createHash('sha256').update(token).digest('hex')}`;

@Injectable()
export class StepUpTokens {
  private readonly redis: Redis;

  constructor(@Inject(REDIS_CLIENT) redis: Redis) {
    this.redis = redis;
  }

  async mint(proof: StoredProof, nowMs: number = Date.now()): Promise<StepUpProof> {
    const token = randomBytes(32).toString('base64url');
    await this.redis.set(proofKey(token), JSON.stringify(proof), 'EX', STEP_UP_ACTION_TTL_SECONDS);
    return { token, action: proof.action, expiresAt: new Date(nowMs + STEP_UP_ACTION_TTL_SECONDS * 1000).toISOString() };
  }

  /**
   * La gasta si es de esta persona, de esta sesión y de esta acción. Otra
   * acción u otra persona no la gasta (sigue valiendo para la suya). Dos a la
   * vez: solo una borra la clave (DEL devuelve 1) y pasa.
   */
  async consume(expected: StoredProof, token: string): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
    const key = proofKey(token);
    const raw = await this.redis.get(key);
    if (!raw) return false;
    let stored: Partial<StoredProof>;
    try {
      stored = JSON.parse(raw) as Partial<StoredProof>;
    } catch {
      return false;
    }
    if (stored.userId !== expected.userId || stored.action !== expected.action) return false;
    if ((stored.sessionId ?? null) !== (expected.sessionId ?? null)) return false;
    return (await this.redis.del(key)) === 1;
  }
}
