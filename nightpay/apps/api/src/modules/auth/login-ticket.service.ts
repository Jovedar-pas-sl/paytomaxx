import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { createHash, randomBytes } from 'node:crypto';
import { REDIS_CLIENT } from '../../common/redis/redis.module';

/** Lo que dura el paso del código tras la contraseña. */
export const LOGIN_TICKET_TTL_SECONDS = 5 * 60;
/** Activar la 2FA en el login (instalar la app, escanear): lo mismo que dura el QR pendiente. */
export const LOGIN_ENROLL_TICKET_TTL_SECONDS = 10 * 60;

/**
 * Para qué vale: `code` = poner el código 2FA (tiene la 2FA); `enroll` = solo
 * activarla (super-admin sin 2FA: es obligatoria). Uno no sirve para lo otro.
 */
export type LoginTicketPurpose = 'code' | 'enroll';

/** Lo que recuerda el ticket entre la contraseña y el código 2FA. */
export interface LoginTicket {
  userId: string;
  /** Huella de la contraseña con la que se entró (si cambia entretanto, no vale). */
  pwdFp: string;
  /** Sin él (tickets de antes): `code`. */
  purpose?: LoginTicketPurpose;
}

const TICKET_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Login en dos pasos (super-admin con 2FA): la contraseña buena da un ticket
 * de un solo uso y 5 minutos; con él y el código 2FA se abre la sesión. En
 * Redis solo va el hash del ticket (vale entre réplicas del API).
 */
@Injectable()
export class LoginTicketService {
  private readonly redis: Redis;

  constructor(@Inject(REDIS_CLIENT) redis: Redis) {
    this.redis = redis;
  }

  async create(ticket: LoginTicket, ttlSeconds: number = LOGIN_TICKET_TTL_SECONDS): Promise<string> {
    const raw = randomBytes(32).toString('base64url');
    await this.redis.set(this.key(raw), JSON.stringify(ticket), 'EX', ttlSeconds);
    return raw;
  }

  /** El ticket sin gastarlo (un código mal tecleado se puede repetir mientras dure). */
  async peek(raw: string): Promise<LoginTicket | null> {
    if (!TICKET_RE.test(raw)) return null;
    return parseTicket(await this.redis.get(this.key(raw)));
  }

  /** Lo gasta: true solo para la primera petición que llega (dos a la vez no abren dos sesiones). */
  async consume(raw: string): Promise<boolean> {
    if (!TICKET_RE.test(raw)) return false;
    return (await this.redis.del(this.key(raw))) === 1;
  }

  private key(raw: string): string {
    return `nightpay:login-ticket:${createHash('sha256').update(raw).digest('hex')}`;
  }
}

function parseTicket(value: string | null): LoginTicket | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<LoginTicket>;
    return typeof parsed.userId === 'string' && typeof parsed.pwdFp === 'string'
      ? { userId: parsed.userId, pwdFp: parsed.pwdFp, purpose: parsed.purpose === 'enroll' ? 'enroll' : 'code' }
      : null;
  } catch {
    return null;
  }
}
