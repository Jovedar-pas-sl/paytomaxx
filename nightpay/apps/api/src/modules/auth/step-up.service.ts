import { ForbiddenException, Inject, Injectable, Optional } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { STEP_UP_REQUIRED_CODE, STEP_UP_TTL_SECONDS, type StepUpMethod, type StepUpStatus } from '@nightpay/contracts';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { AuditService } from '../audit/audit.service';
import { stepUpKey } from './step-up-keys';
import { TotpService } from './totp.service';

/**
 * La verificación del momento para ver lo delicado de un cobro (el móvil, la
 * IP, la tarjeta más allá de los últimos 4 y el historial completo):
 *  - quien tiene 2FA, con su código (TotpService: intentos y códigos usados);
 *  - quien no, con su llave de acceso (fase 2, staff-passkeys).
 * Vale 5 minutos fijos (mirar no la alarga) y solo en la sesión que la hizo:
 * Redis `np:stepup:<sid>`. Cerrar la sesión la borra (RefreshTokenService).
 * Para actuar no vale: cada acción pide su propia prueba.
 */

export { stepUpKey };

export interface StepUpActor {
  userId: string;
  /** El `sid` del token: sin él (tokens de antes) no se puede verificar. */
  sessionId?: string | null;
  tenantId?: string;
  email?: string;
}

export interface StepUpGrant {
  userId: string;
  method: StepUpMethod;
  /** Hasta cuándo vale (epoch ms). */
  until: number;
}

/** Lo guardado, si es de esta persona, está bien formado y no ha caducado. */
export function parseStepUpGrant(raw: string | null, userId: string, nowMs: number): StepUpGrant | null {
  if (!raw) return null;
  try {
    const g = JSON.parse(raw) as Partial<StepUpGrant> | null;
    if (!g || g.userId !== userId || (g.method !== 'totp' && g.method !== 'passkey')) return null;
    if (typeof g.until !== 'number' || g.until <= nowMs) return null;
    return { userId: g.userId, method: g.method, until: g.until };
  } catch {
    return null;
  }
}

/** Con qué tiene que verificarse: la 2FA si la tiene; si no, su llave; sin ninguna, null. */
export function stepUpMethodFor(totpEnabled: boolean, passkeys: number): StepUpMethod | null {
  if (totpEnabled) return 'totp';
  return passkeys > 0 ? 'passkey' : null;
}

/** Cuántas llaves de acceso tiene la persona (fase 2; sin ellas, 0). */
export const STAFF_PASSKEY_COUNTER = Symbol('STAFF_PASSKEY_COUNTER');
export interface StaffPasskeyCounter {
  count(userId: string): Promise<number>;
}

const NO_SESSION_MESSAGE = 'Tu sesión es de antes de esta función: sal y vuelve a entrar para verificarte.';

@Injectable()
export class StepUpService {
  private readonly redis: Redis;
  private readonly totp: Pick<TotpService, 'assertForUser' | 'isEnabled'>;
  private readonly audit: AuditService | null;
  private readonly passkeys: StaffPasskeyCounter | null;

  constructor(
    @Inject(REDIS_CLIENT) redis: Redis,
    @Inject(TotpService) totp: TotpService,
    @Optional() @Inject(AuditService) audit?: AuditService,
    @Optional() @Inject(STAFF_PASSKEY_COUNTER) passkeys?: StaffPasskeyCounter,
  ) {
    this.redis = redis;
    this.totp = totp;
    this.audit = audit ?? null;
    this.passkeys = passkeys ?? null;
  }

  /** La verificación vigente de esta sesión (null: sin verificar, caducada o sin sesión). */
  async current(actor: StepUpActor, nowMs: number = Date.now()): Promise<StepUpGrant | null> {
    if (!actor.sessionId) return null;
    return parseStepUpGrant(await this.redis.get(stepUpKey(actor.sessionId)), actor.userId, nowMs);
  }

  async status(actor: StepUpActor, nowMs: number = Date.now()): Promise<StepUpStatus> {
    const [grant, totpEnabled, passkeys] = await Promise.all([
      this.current(actor, nowMs),
      this.totp.isEnabled(actor.userId),
      this.passkeyCount(actor.userId),
    ]);
    return {
      verifiedUntil: grant ? new Date(grant.until).toISOString() : null,
      verifiedWith: grant?.method ?? null,
      method: stepUpMethodFor(totpEnabled, passkeys),
      totpEnabled,
      passkeys,
    };
  }

  /**
   * Con el código de su 2FA: 5 minutos para ver lo delicado. Sin 2FA, 403
   * TOTP_NOT_ENROLLED; código malo o usado, 403; demasiados, 429 (TotpService).
   */
  async verifyWithTotp(actor: StepUpActor, code: string, nowMs: number = Date.now()): Promise<StepUpStatus> {
    const sessionId = requireSession(actor);
    try {
      await this.totp.assertForUser(actor.userId, code);
    } catch (err) {
      await this.log(actor, 'auth.step_up.failed', { method: 'totp' });
      throw err;
    }
    await this.grant(actor.userId, sessionId, 'totp', nowMs);
    await this.log(actor, 'auth.step_up.ok', { method: 'totp' });
    return this.status(actor, nowMs);
  }

  /** Apunta la verificación de esta sesión (5 minutos desde ahora). */
  async grant(userId: string, sessionId: string, method: StepUpMethod, nowMs: number = Date.now()): Promise<StepUpGrant> {
    const grant: StepUpGrant = { userId, method, until: nowMs + STEP_UP_TTL_SECONDS * 1000 };
    await this.redis.set(stepUpKey(sessionId), JSON.stringify(grant), 'EX', STEP_UP_TTL_SECONDS);
    return grant;
  }

  /** Lo delicado pedido aparte sin la verificación vigente: 403 STEP_UP_REQUIRED. */
  async assertVerified(actor: StepUpActor, nowMs: number = Date.now()): Promise<StepUpGrant> {
    const grant = await this.current(actor, nowMs);
    if (grant) return grant;
    const status = await this.status(actor, nowMs);
    throw new ForbiddenException({
      message: 'Para ver esto, verifícate antes (vale 5 minutos).',
      code: STEP_UP_REQUIRED_CODE,
      method: status.method,
    });
  }

  private async passkeyCount(userId: string): Promise<number> {
    return this.passkeys ? this.passkeys.count(userId) : 0;
  }

  private async log(actor: StepUpActor, action: string, payload: Record<string, unknown>): Promise<void> {
    await this.audit?.log({
      action,
      actorId: actor.userId,
      ...(actor.email ? { actorEmail: actor.email } : {}),
      ...(actor.tenantId ? { tenantId: actor.tenantId } : {}),
      targetType: 'User',
      targetId: actor.userId,
      payload,
    });
  }
}

function requireSession(actor: StepUpActor): string {
  if (!actor.sessionId) throw new ForbiddenException({ message: NO_SESSION_MESSAGE, code: STEP_UP_REQUIRED_CODE });
  return actor.sessionId;
}
