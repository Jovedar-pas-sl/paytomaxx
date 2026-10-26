import { Inject, Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../common/redis/redis.module';

/**
 * Vida del token de acceso (JWT): 1 h. El refresco (automático en las apps)
 * lo renueva; al cerrar una sesión, este servicio lo corta antes.
 */
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
/**
 * Lo que dura una marca de revocación: más que cualquier token de acceso
 * emitido antes de ella (1 h), con margen para relojes desajustados. Pasado
 * ese tiempo ningún token afectado sigue vivo y la marca se va sola.
 */
export const ACCESS_REVOCATION_TTL_SECONDS = ACCESS_TOKEN_TTL_SECONDS + 5 * 60;
/** Lo más que espera cada petición a Redis para saber si su sesión sigue viva. */
export const ACCESS_CHECK_TIMEOUT_MS = 500;
/** Marcas que recuerda cada nodo para el límite global (al pasar, se empieza de cero). */
const MAX_KNOWN_MARKS = 10_000;

/** 401: la sesión de este token se cerró (logout, revocada, baja, contraseña nueva). */
export const SESSION_REVOKED_CODE = 'SESSION_REVOKED';
/** 503: no se pudo comprobar la sesión (Redis no responde). No cierra la sesión: se reintenta. */
export const SESSION_CHECK_UNAVAILABLE_CODE = 'SESSION_CHECK_UNAVAILABLE';
const MSG_SESSION_REVOKED = 'Sesión cerrada: vuelve a iniciar sesión';
const MSG_CHECK_UNAVAILABLE = 'No se puede comprobar la sesión ahora mismo: vuelve a probar en unos segundos.';

export type AccessRevocation = { kind: 'session'; sid: string } | { kind: 'user'; userId: string };
type RevocationListener = (revocation: AccessRevocation) => void;

/** Lo que hace falta del token de acceso: quién (`sub`), su sesión (`sid`) y cuándo se emitió (`iat`, s). */
export interface AccessTokenRef {
  sub: string;
  sid?: string;
  iat?: number;
}

/**
 * Corta al momento los tokens de acceso ya emitidos (antes valían hasta
 * caducar: 1 h). Dos marcas en Redis, con TTL ACCESS_REVOCATION_TTL_SECONDS:
 *   nightpay:access:revoked-sid:<sid>         → la sesión (family del refresh)
 *                                               se cerró (logout, reuso,
 *                                               contraseña cambiada…);
 *   nightpay:access:revoked-before:<userId>   → los tokens de esa persona
 *                                               emitidos antes de este segundo
 *                                               ya no valen (revocar todas sus
 *                                               sesiones, baja, reset).
 * Cada petición con sesión (AuthGuard, tiempo real) hace un MGET de esas dos
 * claves: sin consultas a la base ni SCAN. Sin caché a propósito: la
 * revocación se ve en todos los nodos en la petición siguiente.
 *
 * Tokens de antes de este cambio: ya llevan `sid` e `iat` (AuthService los
 * pone desde hace tiempo), así que valen hasta caducar y una revocación
 * posterior también los corta. Uno sin `sid` (más antiguo) lo corta la marca
 * de la persona.
 *
 * Si Redis no responde: 503 (fail-closed). Sin la comprobación, un token de
 * un móvil perdido volvería a entrar justo cuando no se puede mirar; y sin
 * Redis tampoco funcionan el login, el refresco, los topes ni las colas de
 * cobros, así que dejar pasar no salvaría el servicio. El 503 no cierra
 * ninguna sesión (las apps solo echan con un 401 del refresco): al volver
 * Redis, todo sigue.
 */
@Injectable()
export class AccessRevocationService {
  private readonly logger = new Logger(AccessRevocationService.name);
  private readonly redis: Redis;
  private readonly listeners = new Set<RevocationListener>();
  /**
   * Las marcas que este nodo ya ha visto (las que puso o las que encontró en
   * Redis al comprobar una petición): sid → hasta cuándo; persona → corte (s)
   * y hasta cuándo. SOLO para el límite global (isKnownRevoked): el acceso lo
   * decide siempre Redis (isRevoked).
   */
  private readonly knownSids = new Map<string, number>();
  private readonly knownCutoffs = new Map<string, { cutoff: number; until: number }>();

  constructor(@Inject(REDIS_CLIENT) redis: Redis) {
    this.redis = redis;
  }

  /** La sesión (family del refresh) se cerró: sus tokens de acceso dejan de valer. */
  async revokeSession(sid: string): Promise<void> {
    await this.redis.set(sidKey(sid), '1', 'EX', ACCESS_REVOCATION_TTL_SECONDS);
    this.rememberSid(sid);
    this.notify({ kind: 'session', sid });
  }

  /**
   * Todas las sesiones de una persona: sus tokens emitidos ANTES de este
   * segundo dejan de valer (`iat` va en segundos). Los de este mismo segundo
   * los corta la marca de su sesión: RefreshTokenService.revokeAllForUser
   * marca cada una. Así un login justo después (en el mismo segundo) vale.
   */
  async revokeUser(userId: string, nowMs: number = Date.now()): Promise<void> {
    const cutoff = Math.floor(nowMs / 1000);
    await this.redis.set(userKey(userId), String(cutoff), 'EX', ACCESS_REVOCATION_TTL_SECONDS);
    this.rememberCutoff(userId, cutoff);
    this.notify({ kind: 'user', userId });
  }

  /** ¿Se cerró la sesión de este token? Redis sin respuesta → 503 (ver arriba). */
  async isRevoked(token: AccessTokenRef): Promise<boolean> {
    const keys = token.sid ? [userKey(token.sub), sidKey(token.sid)] : [userKey(token.sub)];
    let values: Array<string | null>;
    try {
      values = await withTimeout(this.redis.mget(...keys), ACCESS_CHECK_TIMEOUT_MS);
    } catch (err) {
      this.logger.error(`No se pudo comprobar la sesión en Redis (se responde 503): ${(err as Error).message}`);
      throw new ServiceUnavailableException({ message: MSG_CHECK_UNAVAILABLE, code: SESSION_CHECK_UNAVAILABLE_CODE });
    }
    const [cutoff, sidMark] = values;
    if (sidMark && token.sid) this.rememberSid(token.sid);
    if (sidMark) return true;
    if (cutoff === null || cutoff === undefined) return false;
    const cutoffSeconds = Number(cutoff);
    // Un valor raro o un token sin fecha de emisión: no se da por bueno.
    if (!Number.isFinite(cutoffSeconds) || typeof token.iat !== 'number') return true;
    this.rememberCutoff(token.sub, cutoffSeconds);
    return token.iat < cutoffSeconds;
  }

  /**
   * ¿Sabe ya ESTE nodo que la sesión de este token se cerró? Sin Redis ni
   * esperas: lo usa el límite global para no contar en el cupo del local las
   * peticiones de un token revocado. Puede decir «no» de uno revocado en otro
   * nodo hasta que aquí llegue su primera petición; nunca decide un acceso.
   */
  isKnownRevoked(token: AccessTokenRef, nowMs: number = Date.now()): boolean {
    const sidUntil = token.sid ? this.knownSids.get(token.sid) : undefined;
    if (sidUntil !== undefined && sidUntil > nowMs) return true;
    const known = this.knownCutoffs.get(token.sub);
    if (!known || known.until <= nowMs) return false;
    return typeof token.iat !== 'number' || token.iat < known.cutoff;
  }

  /** 401 SESSION_REVOKED si la sesión de este token se cerró. */
  async assertActive(token: AccessTokenRef): Promise<void> {
    if (await this.isRevoked(token)) {
      throw new UnauthorizedException({ message: MSG_SESSION_REVOKED, code: SESSION_REVOKED_CODE });
    }
  }

  /** Para el tiempo real: cerrar las conexiones de lo revocado. Devuelve cómo dejar de escuchar. */
  onRevoked(listener: RevocationListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private rememberSid(sid: string): void {
    if (this.knownSids.size >= MAX_KNOWN_MARKS) this.knownSids.clear();
    this.knownSids.set(sid, Date.now() + ACCESS_REVOCATION_TTL_SECONDS * 1000);
  }

  private rememberCutoff(userId: string, cutoff: number): void {
    if (this.knownCutoffs.size >= MAX_KNOWN_MARKS) this.knownCutoffs.clear();
    this.knownCutoffs.set(userId, { cutoff, until: Date.now() + ACCESS_REVOCATION_TTL_SECONDS * 1000 });
  }

  private notify(revocation: AccessRevocation): void {
    for (const listener of this.listeners) {
      try {
        listener(revocation);
      } catch (err) {
        // La marca ya está en Redis: la conexión se corta en su siguiente subscribe.
        this.logger.error(`Aviso de sesión revocada fallido: ${(err as Error).message}`);
      }
    }
  }
}

function sidKey(sid: string): string {
  return `nightpay:access:revoked-sid:${sid}`;
}

function userKey(userId: string): string {
  return `nightpay:access:revoked-before:${userId}`;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Redis no contestó en ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
