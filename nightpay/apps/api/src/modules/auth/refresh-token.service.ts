import { Inject, Injectable, Logger, Optional, UnauthorizedException } from '@nestjs/common';
import { stepUpKey } from './step-up-keys';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { deriveKey, openText, sealText } from './aes-gcm';
import { AccessRevocationService } from './access-revocation.service';

export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30d
/**
 * Vida máxima de una sesión (family), contada desde el login: refrescar no la
 * alarga más allá. Pasados 90 días hay que volver a entrar con la contraseña.
 */
export const REFRESH_FAMILY_MAX_SECONDS = 90 * 24 * 60 * 60;
/**
 * Margen para dos refrescos con el mismo token (dos pestañas a la vez, una
 * respuesta que se perdió): durante estos segundos el token ya usado devuelve
 * el MISMO par nuevo en vez de tomarse por robado.
 */
export const REFRESH_GRACE_SECONDS = 10;
/** Si el otro refresco aún no ha publicado el par nuevo, se le espera un poco. */
const GRACE_POLL_MS = 50;
const GRACE_POLL_ATTEMPTS = 4;
const GRACE_KEY_PURPOSE = 'nightpay:refresh-grace:v1';
const GRACE_AAD = 'refresh-grace';

/** Los ids de sesión (family) son UUID: nada de comodines en el SCAN. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MSG_INVALID = 'Sesión caducada: vuelve a iniciar sesión';
const MSG_REUSED = 'Sesión cerrada por seguridad: vuelve a iniciar sesión';

interface StoredRefresh {
  userId: string;
  tenantId: string;
  family: string;
  secretHash: string;
  issuedAt: number;
  lastUsedAt: number;
  /** Cuándo empezó la sesión (login). Falta en los anteriores: se toma issuedAt. */
  familyCreatedAt?: number;
  /** Huella de users.passwordHash al emitirlo (passwordFingerprint). Falta en los anteriores. */
  pwdFp?: string;
}

/** Rastro de un refresh ya usado (jti → family) para detectar si alguien lo reutiliza. */
interface UsedRefresh {
  userId: string;
  tenantId: string;
  family: string;
  secretHash: string;
  consumedAt: number;
}

interface ParsedToken {
  jti: string;
  secret: string;
}

export interface IssueOptions {
  /** Family a la que pertenece (rotación); sin ella, sesión nueva. */
  family?: string;
  /** passwordFingerprint del usuario al emitirlo. */
  pwdFp?: string;
  /** Inicio de la family (rotación): con él no se pasa de REFRESH_FAMILY_MAX_SECONDS. */
  familyCreatedAt?: number;
}

export interface RotatedRefresh {
  userId: string;
  tenantId: string;
  family: string;
  /** Huella con la que se emitió la sesión (undefined = token anterior a esta versión). */
  pwdFp?: string;
  token: string;
  ttlSeconds: number;
}

/** Un refresh ya usado volvió fuera del margen: señal de robo. La family ya está revocada. */
export class RefreshTokenReuseError extends UnauthorizedException {
  readonly userId: string;
  readonly tenantId: string;
  readonly family: string;

  constructor(session: { userId: string; tenantId: string; family: string }) {
    super(MSG_REUSED);
    this.userId = session.userId;
    this.tenantId = session.tenantId;
    this.family = session.family;
  }
}

/** Huella corta de users.passwordHash: si cambia la contraseña, cambia la huella. */
export function passwordFingerprint(passwordHash: string): string {
  return createHash('sha256').update(passwordHash).digest('hex').slice(0, 16);
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
 *   nightpay:refresh:used:<jti> -> JSON UsedRefresh (TTL 30d)  // rastro tras rotarlo
 *   nightpay:refresh:grace:<jti> -> par nuevo cifrado con el secreto viejo (TTL 10 s)
 *
 * Rotacion: cada `refresh()` marca el jti como usado (atómico), emite uno nuevo
 * en la misma family y borra el viejo. La family vive como mucho 90 días desde
 * el login (REFRESH_FAMILY_MAX_SECONDS). Un jti con un secreto que no es el
 * suyo solo da 401: sin el secreto no se cierra la sesión de nadie. Si vuelve
 * un jti usado:
 *   - dentro del margen (10 s) → el mismo par nuevo (dos pestañas, reintentos);
 *   - después → se revoca la family entera (alguien tenía una copia: robo).
 * La huella de la contraseña viaja con la sesión: AuthService la compara al
 * refrescar y, si la contraseña cambió, revoca la family.
 *
 * Cerrar una sesión (revoke, revokeFamily, revokeAllForUser) corta también,
 * al momento, los tokens de acceso que ya emitió (AccessRevocationService):
 * antes seguían valiendo hasta caducar (1 h).
 */
@Injectable()
export class RefreshTokenService {
  private readonly logger = new Logger(RefreshTokenService.name);
  private readonly redis: Redis;
  private readonly revocations: AccessRevocationService;

  constructor(
    @Inject(REDIS_CLIENT) redis: Redis,
    // En la app lo inyecta AuthModule (el mismo que escucha el tiempo real);
    // sin él (pruebas que construyen el servicio a mano), uno sobre el mismo Redis.
    @Optional() @Inject(AccessRevocationService) revocations?: AccessRevocationService,
  ) {
    this.redis = redis;
    this.revocations = revocations ?? new AccessRevocationService(redis);
  }

  /** Emite un refresh token nuevo y devuelve el string opaco al cliente. */
  async issue(
    userId: string,
    tenantId: string,
    opts: IssueOptions = {},
  ): Promise<{ token: string; family: string; ttlSeconds: number }> {
    const jti = randomUUID();
    const secret = randomBytes(32).toString('hex');
    const familyId = opts.family ?? randomUUID();
    const now = Date.now();
    const familyCreatedAt = opts.familyCreatedAt ?? now;
    const ttlSeconds = ttlWithinFamily(familyCreatedAt, now);
    const stored: StoredRefresh = {
      userId,
      tenantId,
      family: familyId,
      secretHash: hashSecret(secret),
      issuedAt: now,
      lastUsedAt: now,
      familyCreatedAt,
      ...(opts.pwdFp ? { pwdFp: opts.pwdFp } : {}),
    };

    await this.redis
      .multi()
      .set(this.key(jti), JSON.stringify(stored), 'EX', ttlSeconds)
      .set(this.familyKey(familyId, jti), '1', 'EX', ttlSeconds)
      .set(this.userKey(userId, jti), '1', 'EX', ttlSeconds)
      .exec();

    return { token: `${jti}.${secret}`, family: familyId, ttlSeconds };
  }

  /**
   * Rota un refresh token: valida, lo marca como usado, emite uno nuevo en la
   * misma family y borra el viejo. Lanza UnauthorizedException si no vale;
   * RefreshTokenReuseError (y revoca la family) si es un reuso.
   */
  async rotate(rawToken: string): Promise<RotatedRefresh> {
    const parsed = parseToken(rawToken);
    if (!parsed) throw invalidRefresh();

    const stored = await this.fetch(parsed.jti);
    if (!stored) return this.rotateUsed(parsed);

    if (!secretMatches(stored.secretHash, parsed.secret)) {
      // Sin el secreto no se prueba nada: 401 y la sesión de su dueño sigue
      // (si no, con un jti visto en un log se cerraría la sesión de cualquiera).
      this.logger.warn(`Refresh con un secreto que no es el suyo (jti=${shortId(parsed.jti)})`);
      throw invalidRefresh();
    }

    const familyCreatedAt = familyStartOf(stored);
    if (familyExpired(familyCreatedAt)) {
      // 90 días desde el login: se cierra la sesión entera y hay que volver a entrar.
      await this.revokeFamily(stored.family);
      throw invalidRefresh();
    }

    // Solo una petición consigue marcarlo; la otra va por el margen.
    if (!(await this.markUsed(parsed.jti, stored))) return this.rotateUsed(parsed);

    const issued = await this.issue(stored.userId, stored.tenantId, {
      family: stored.family,
      pwdFp: stored.pwdFp,
      familyCreatedAt,
    });
    await this.retire(parsed, stored, issued.token);
    await this.assertNotRevokedMeanwhile(stored);
    return {
      userId: stored.userId,
      tenantId: stored.tenantId,
      family: stored.family,
      pwdFp: stored.pwdFp,
      token: issued.token,
      ttlSeconds: issued.ttlSeconds,
    };
  }

  /**
   * Revoca un refresh token (logout). Exige el token entero (jti + secreto).
   * Con uno ya rotado (la app no guardó el nuevo) cierra la sesión entera.
   * Devuelve de quién era, o null si no valía (un token que no vale no es un error).
   */
  async revoke(rawToken: string): Promise<{ userId: string; tenantId: string } | null> {
    const parsed = parseToken(rawToken);
    if (!parsed) return null;

    const stored = await this.fetch(parsed.jti);
    if (stored) {
      if (!secretMatches(stored.secretHash, parsed.secret)) return null;
      await this.deleteJti(parsed.jti, stored);
      await this.forgetFamily(stored.family);
      // Logout: el token de acceso de esta sesión deja de valer ya (no en 1 h).
      await this.revocations.revokeSession(stored.family);
      return { userId: stored.userId, tenantId: stored.tenantId };
    }

    const used = await this.fetchUsed(parsed.jti);
    if (!used || !secretMatches(used.secretHash, parsed.secret)) return null;
    await this.revokeFamily(used.family);
    return { userId: used.userId, tenantId: used.tenantId };
  }

  /** Tokens de antes de esta versión: se les apunta la huella de la contraseña actual. */
  async stampFingerprint(rawToken: string, pwdFp: string): Promise<void> {
    const parsed = parseToken(rawToken);
    const stored = parsed ? await this.fetch(parsed.jti) : null;
    if (!parsed || !stored || stored.pwdFp) return;
    // XX: solo si sigue vivo (nunca resucitar uno usado o revocado); KEEPTTL: misma caducidad.
    await this.redis.set(this.key(parsed.jti), JSON.stringify({ ...stored, pwdFp }), 'KEEPTTL', 'XX');
  }

  /**
   * Revoca todas las sesiones de un usuario (kill-switch para device theft,
   * baja, reset de contraseña o de 2FA): sus refresh tokens y, al momento,
   * los tokens de acceso que ya tenía (la marca de la persona va primero:
   * corta todo lo emitido hasta ahora aunque falle algo después).
   */
  async revokeAllForUser(userId: string): Promise<number> {
    await this.revocations.revokeUser(userId);
    const pattern = `nightpay:refresh:user:${userId}:*`;
    const keys = await this.scanKeys(pattern);
    const families = new Set<string>();
    let count = 0;
    for (const k of keys) {
      const jti = k.split(':').pop();
      if (!jti) continue;
      const stored = await this.fetch(jti);
      if (stored) {
        await this.deleteJti(jti, stored);
        await this.forgetFamily(stored.family);
        families.add(stored.family);
        count += 1;
      } else {
        await this.redis.del(k);
      }
    }
    // Y cada sesión: también un token emitido en este mismo segundo, antes de revocar.
    for (const family of families) await this.revocations.revokeSession(family);
    if (count > 0) this.logger.log(`Revoked ${count} refresh tokens for user ${userId}`);
    return count;
  }

  /** Revoca toda una family (reuso detectado, contraseña cambiada) y, al momento, sus tokens de acceso. */
  async revokeFamily(familyId: string): Promise<void> {
    await this.revocations.revokeSession(familyId);
    const pattern = `nightpay:refresh:family:${familyId}:*`;
    const keys = await this.scanKeys(pattern);
    for (const k of keys) {
      const jti = k.split(':').pop();
      if (!jti) continue;
      const stored = await this.fetch(jti);
      if (stored) await this.deleteJti(jti, stored);
      else await this.redis.del(k);
    }
    await this.forgetFamily(familyId);
  }

  /**
   * ¿Sigue viva la sesión? Le queda un refresh sin usar (no se cerró, no se
   * revocó) y no ha pasado de los 90 días desde el login. Devuelve de quién
   * es, o null. Con ella el cambio de local no sobrevive a un logout.
   */
  async liveSession(familyId: string): Promise<{ userId: string } | null> {
    if (!UUID_RE.test(familyId)) return null;
    const keys = await this.scanKeys(`nightpay:refresh:family:${familyId}:*`);
    for (const k of keys) {
      const jti = k.split(':').pop();
      const stored = jti ? await this.fetch(jti) : null;
      if (stored && stored.family === familyId && !familyExpired(familyStartOf(stored))) {
        return { userId: stored.userId };
      }
    }
    return null;
  }

  /** La sesión se abrió con la 2FA (login en dos pasos del super-admin). */
  async markTwoFactor(familyId: string): Promise<void> {
    await this.redis.set(this.twoFactorKey(familyId), '1', 'EX', REFRESH_FAMILY_MAX_SECONDS);
  }

  /** ¿Se abrió esta sesión con la 2FA? Las de antes (o sin ella), no. */
  async hasTwoFactor(familyId: string): Promise<boolean> {
    return (await this.redis.get(this.twoFactorKey(familyId))) === '1';
  }

  /**
   * Super-admin: el local que eligió (con 2FA) en esta sesión. Al refrescar,
   * el access token sale ya para ese local. null = vuelve al suyo.
   */
  async setActiveVenue(familyId: string, venueId: string | null): Promise<void> {
    if (venueId === null) {
      await this.redis.del(this.venueKey(familyId));
      return;
    }
    await this.redis.set(this.venueKey(familyId), venueId, 'EX', REFRESH_FAMILY_MAX_SECONDS);
  }

  async activeVenue(familyId: string): Promise<string | null> {
    return this.redis.get(this.venueKey(familyId));
  }

  /**
   * Carrera con una revocación (revokeAllForUser / revokeFamily): si borró
   * los refresh de la persona después de que este refresco leyera el suyo y
   * antes de que emitiera el nuevo, el nuevo se libraba (30 días, y la marca
   * de los tokens de acceso solo dura 65 min). Se mira DESPUÉS de emitir: las
   * revocaciones ponen su marca antes de buscar los refresh, así que o la
   * marca ya está y se ve aquí, o su búsqueda llega después y encuentra el
   * nuevo. Cuenta la marca de la sesión y la de la persona contra el inicio
   * de la sesión (login): una sesión empezada antes de «revocar todas» no
   * sigue; quien entró después de revocar no se ve afectado. Redis sin
   * respuesta → 503 (como el resto; el par nuevo ya se puede repetir en el margen).
   */
  private async assertNotRevokedMeanwhile(stored: StoredRefresh): Promise<void> {
    const revoked = await this.revocations.isRevoked({
      sub: stored.userId,
      sid: stored.family,
      iat: Math.floor(familyStartOf(stored) / 1000),
    });
    if (!revoked) return;
    this.logger.warn(`Refresco de una sesión revocada mientras tanto (family=${shortId(stored.family)}): se cierra`);
    await this.revokeFamily(stored.family);
    throw invalidRefresh();
  }

  /** Marca atómica de "usado": devuelve false si otra petición lo marcó antes. */
  private async markUsed(jti: string, stored: StoredRefresh): Promise<boolean> {
    const used: UsedRefresh = {
      userId: stored.userId,
      tenantId: stored.tenantId,
      family: stored.family,
      secretHash: stored.secretHash,
      consumedAt: Date.now(),
    };
    const ok = await this.redis.set(this.usedKey(jti), JSON.stringify(used), 'EX', REFRESH_TOKEN_TTL_SECONDS, 'NX');
    return ok === 'OK';
  }

  /** Borra el token usado y deja el par nuevo, cifrado con el secreto viejo, durante el margen. */
  private async retire(parsed: ParsedToken, stored: StoredRefresh, nextToken: string): Promise<void> {
    await this.redis
      .multi()
      .set(this.graceKey(parsed.jti), sealForGrace(nextToken, parsed.secret), 'EX', REFRESH_GRACE_SECONDS)
      .del(this.key(parsed.jti), this.familyKey(stored.family, parsed.jti), this.userKey(stored.userId, parsed.jti))
      .exec();
  }

  /** Token ya usado: en el margen, el mismo par nuevo; fuera, reuso → revoca la family. */
  private async rotateUsed(parsed: ParsedToken): Promise<RotatedRefresh> {
    const used = await this.fetchUsed(parsed.jti);
    if (!used || !secretMatches(used.secretHash, parsed.secret)) {
      this.logger.warn(`Refresh token desconocido o caducado (jti=${shortId(parsed.jti)})`);
      throw invalidRefresh();
    }

    const replay = await this.replayWithinGrace(parsed, used);
    if (replay) return replay;
    // En el margen sin par que devolver (a medias o ya rotado otra vez): no es un robo.
    if (withinGrace(used)) throw invalidRefresh();

    this.logger.warn(`Reuso de un refresh ya usado (jti=${shortId(parsed.jti)}): se cierra su sesión`);
    await this.revokeFamily(used.family);
    throw new RefreshTokenReuseError(used);
  }

  private async replayWithinGrace(parsed: ParsedToken, used: UsedRefresh): Promise<RotatedRefresh | null> {
    const sealed = await this.waitForGrace(parsed.jti, used);
    const next = sealed ? openGrace(sealed, parsed.secret) : null;
    const nextParsed = next ? parseToken(next) : null;
    const nextStored = nextParsed ? await this.fetch(nextParsed.jti) : null;
    if (!next || !nextStored || nextStored.family !== used.family) return null;
    return {
      userId: nextStored.userId,
      tenantId: nextStored.tenantId,
      family: nextStored.family,
      pwdFp: nextStored.pwdFp,
      token: next,
      ttlSeconds: ttlWithinFamily(familyStartOf(nextStored), Date.now()),
    };
  }

  /** Si el otro refresco va a la vez, el par nuevo tarda unos ms en aparecer. */
  private async waitForGrace(jti: string, used: UsedRefresh): Promise<string | null> {
    for (let attempt = 0; attempt <= GRACE_POLL_ATTEMPTS; attempt++) {
      const sealed = await this.redis.get(this.graceKey(jti));
      if (sealed || !withinGrace(used)) return sealed;
      if (attempt < GRACE_POLL_ATTEMPTS) await sleep(GRACE_POLL_MS);
    }
    return null;
  }

  private async fetch(jti: string): Promise<StoredRefresh | null> {
    return parseJson<StoredRefresh>(await this.redis.get(this.key(jti)));
  }

  private async fetchUsed(jti: string): Promise<UsedRefresh | null> {
    return parseJson<UsedRefresh>(await this.redis.get(this.usedKey(jti)));
  }

  private async deleteJti(jti: string, stored: StoredRefresh): Promise<void> {
    await this.redis.del(
      this.key(jti),
      this.familyKey(stored.family, jti),
      this.userKey(stored.userId, jti),
    );
  }

  /** Lo que la sesión recordaba (local elegido, entró con 2FA): una sesión cerrada no lo deja atrás. */
  private async forgetFamily(familyId: string): Promise<void> {
    // También la verificación del momento de esa sesión (step-up.service): se borra al salir.
    await this.redis.del(this.venueKey(familyId), this.twoFactorKey(familyId), stepUpKey(familyId));
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
  private usedKey(jti: string): string {
    return `nightpay:refresh:used:${jti}`;
  }
  private graceKey(jti: string): string {
    return `nightpay:refresh:grace:${jti}`;
  }
  private venueKey(family: string): string {
    return `nightpay:refresh:venue:${family}`;
  }
  private twoFactorKey(family: string): string {
    return `nightpay:refresh:2fa:${family}`;
  }
}

/** Inicio de la sesión; los tokens de antes no lo traen: desde su emisión. */
function familyStartOf(stored: StoredRefresh): number {
  return stored.familyCreatedAt ?? stored.issuedAt;
}

function familyExpired(familyCreatedAt: number, now = Date.now()): boolean {
  return now - familyCreatedAt >= REFRESH_FAMILY_MAX_SECONDS * 1000;
}

/** 30 días, o lo que le quede a la sesión si es menos (como poco 1 s). */
function ttlWithinFamily(familyCreatedAt: number, now: number): number {
  const left = Math.floor((familyCreatedAt + REFRESH_FAMILY_MAX_SECONDS * 1000 - now) / 1000);
  return Math.max(1, Math.min(REFRESH_TOKEN_TTL_SECONDS, left));
}

/** Para los logs: el principio del jti basta para seguirlo y no sirve para nada más. */
function shortId(id: string): string {
  return `${id.slice(0, 8)}…`;
}

function invalidRefresh(): UnauthorizedException {
  return new UnauthorizedException(MSG_INVALID);
}

function withinGrace(used: UsedRefresh): boolean {
  return Date.now() - used.consumedAt < REFRESH_GRACE_SECONDS * 1000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Compara en tiempo constante el secreto presentado con el hash guardado. */
function secretMatches(expectedHashHex: string, secret: string): boolean {
  const expected = Buffer.from(expectedHashHex, 'hex');
  const candidate = Buffer.from(hashSecret(secret), 'hex');
  return expected.length === candidate.length && timingSafeEqual(expected, candidate);
}

function sealForGrace(nextToken: string, oldSecret: string): string {
  return sealText(deriveKey(oldSecret, GRACE_KEY_PURPOSE), nextToken, GRACE_AAD);
}

/** null si no se puede abrir (el secreto ya se comprobó contra el hash: sería un dato corrupto). */
function openGrace(sealed: string, oldSecret: string): string | null {
  try {
    return openText(deriveKey(oldSecret, GRACE_KEY_PURPOSE), sealed, GRACE_AAD);
  } catch {
    return null;
  }
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function parseToken(raw: string): ParsedToken | null {
  const dot = raw.indexOf('.');
  if (dot < 1 || dot === raw.length - 1) return null;
  const jti = raw.slice(0, dot);
  const secret = raw.slice(dot + 1);
  // jti es UUID v4 — 36 chars con dashes
  if (jti.length !== 36 || !/^[0-9a-f-]+$/i.test(jti)) return null;
  if (secret.length < 16) return null;
  return { jti, secret };
}
