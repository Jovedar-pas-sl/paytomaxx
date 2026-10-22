import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PAYOUT_PASSKEY_TTL_SECONDS } from '@nightpay/contracts';
import { REDIS_CLIENT } from '../../common/redis/redis.module';

/**
 * Salida de recepción de un saldo con Face ID: recepción enseña un QR, el
 * cliente lo abre en SU móvil y confirma con su llave (WalletPasskeysService,
 * reto atado a `payout:<saldo>:<requestKey>`). Aquí, en Redis, la petición y
 * si ya la confirmó: dura PAYOUT_PASSKEY_TTL_SECONDS y vale para esa salida
 * (saldo, importe, quien la pidió y su requestKey), no para otra.
 *
 *   np:rpo:tok:<token>             → la petición (JSON)
 *   np:rpo:req:<local>:<requestKey> → su token
 */

export interface PayoutPasskeyRequest {
  walletId: string;
  tenantId: string;
  userId: string;
  requestKey: string;
  amountCents: number;
  venueName: string;
  confirmed: boolean;
  expiresAt: string;
}

/** El token del QR: 144 bits, como el del saldo. */
const TOKEN_RE = /^[A-Za-z0-9_-]{24}$/;

/** El reto del Face ID vale solo para esta salida. */
export function payoutPasskeyScope(walletId: string, requestKey: string): string {
  return `payout:${walletId}:${requestKey}`;
}

export function isPayoutPasskeyToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

@Injectable()
export class ReceptionPayoutPasskeys {
  private readonly redis: Pick<Redis, 'get' | 'set' | 'pttl'>;

  constructor(@Inject(REDIS_CLIENT) redis: Redis) {
    this.redis = redis;
  }

  /** La petición de esta salida (la misma si se repite con lo mismo; si no, 409 en quien llama). */
  async open(input: Omit<PayoutPasskeyRequest, 'confirmed' | 'expiresAt'>, now: Date = new Date()): Promise<{ token: string; request: PayoutPasskeyRequest }> {
    const existing = await this.byRequestKey(input.tenantId, input.requestKey);
    if (existing && sameRequest(existing.request, input)) return existing;
    const token = randomBytes(18).toString('base64url');
    const request: PayoutPasskeyRequest = {
      ...input,
      confirmed: false,
      expiresAt: new Date(now.getTime() + PAYOUT_PASSKEY_TTL_SECONDS * 1000).toISOString(),
    };
    await this.redis.set(tokKey(token), JSON.stringify(request), 'EX', PAYOUT_PASSKEY_TTL_SECONDS);
    await this.redis.set(reqKey(input.tenantId, input.requestKey), token, 'EX', PAYOUT_PASSKEY_TTL_SECONDS);
    return { token, request };
  }

  /** La de esa requestKey en ese local (null: ninguna, o caducada). */
  async byRequestKey(tenantId: string, requestKey: string): Promise<{ token: string; request: PayoutPasskeyRequest } | null> {
    const token = await this.redis.get(reqKey(tenantId, requestKey));
    if (!token || !isPayoutPasskeyToken(token)) return null;
    const request = await this.byToken(token);
    return request ? { token, request } : null;
  }

  /** La del QR (null: no existe o caducó). */
  async byToken(token: string): Promise<PayoutPasskeyRequest | null> {
    if (!isPayoutPasskeyToken(token)) return null;
    const raw = await this.redis.get(tokKey(token));
    return raw ? parseRequest(raw) : null;
  }

  /** El cliente la confirmó con la llave de ese saldo: queda confirmada hasta que caduque. */
  async markConfirmed(token: string): Promise<PayoutPasskeyRequest | null> {
    const request = await this.byToken(token);
    if (!request) return null;
    const ttl = await this.redis.pttl(tokKey(token));
    if (ttl <= 0) return null;
    const next = { ...request, confirmed: true };
    await this.redis.set(tokKey(token), JSON.stringify(next), 'PX', ttl);
    return next;
  }
}

function sameRequest(a: PayoutPasskeyRequest, b: Omit<PayoutPasskeyRequest, 'confirmed' | 'expiresAt'>): boolean {
  return a.walletId === b.walletId && a.userId === b.userId && a.amountCents === b.amountCents && a.tenantId === b.tenantId;
}

function parseRequest(raw: string): PayoutPasskeyRequest | null {
  try {
    const v = JSON.parse(raw) as Partial<PayoutPasskeyRequest>;
    if (typeof v.walletId !== 'string' || typeof v.tenantId !== 'string' || typeof v.userId !== 'string') return null;
    if (typeof v.requestKey !== 'string' || !Number.isInteger(v.amountCents) || typeof v.expiresAt !== 'string') return null;
    return {
      walletId: v.walletId,
      tenantId: v.tenantId,
      userId: v.userId,
      requestKey: v.requestKey,
      amountCents: v.amountCents as number,
      venueName: typeof v.venueName === 'string' ? v.venueName : '',
      confirmed: v.confirmed === true,
      expiresAt: v.expiresAt,
    };
  } catch {
    return null;
  }
}

const tokKey = (token: string): string => `np:rpo:tok:${token}`;
const reqKey = (tenantId: string, requestKey: string): string => `np:rpo:req:${tenantId}:${requestKey}`;
