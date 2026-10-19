import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import type { Redis } from 'ioredis';
import * as QRCode from 'qrcode';
import type { TotpSetupResponse, TotpStatusResponse } from '@nightpay/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { BRAND_NAME } from '../../common/brand';
import { AuditService } from '../audit/audit.service';
import { LockoutService, type LockPolicy } from './lockout.service';
import { buildOtpauthUrl } from './totp-code';
import { openTotpSecret } from './totp-crypto';
import { TotpService } from './totp.service';

/** El QR de activación vale 10 min. */
const PENDING_TTL_SEC = 10 * 60;
const QR_OPTIONS = { errorCorrectionLevel: 'M', margin: 1, width: 240 } as const;
/** Contraseña al activar la 2FA: 5 malas en 15 min → 15 min sin poder probar (por usuario). */
export const REAUTH_LOCK_POLICY: LockPolicy = { threshold: 5, windowSec: 15 * 60, lockSec: 15 * 60 };
/** 403 con la contraseña actual mal (nunca 401: el panel lo tomaría por sesión caducada). */
export const PASSWORD_INVALID_CODE = 'PASSWORD_INVALID';
export const PASSWORD_LOCKED_CODE = 'PASSWORD_LOCKED';

const MSG = {
  alreadyEnabled: 'La verificación en dos pasos ya está activada.',
  notEnabled: 'La verificación en dos pasos no está activada.',
  noPending: 'No hay ninguna activación en curso o ha caducado (10 min). Vuelve a empezar.',
  userGone: 'Usuario desactivado',
  badPassword: 'La contraseña no es correcta.',
} as const;

export interface ClientMeta {
  readonly ip?: string;
  readonly userAgent?: string;
}

interface EnrollingUser {
  readonly id: string;
  readonly email: string;
  readonly tenantId: string;
  readonly totpSecret: string | null;
  readonly passwordHash: string;
}

/** Activación pendiente en Redis: el secreto cifrado y la sesión (sid) que la empezó. */
interface PendingSecret {
  readonly sealed: string;
  readonly sid?: string;
}

/**
 * Activar / desactivar la 2FA desde la app (antes solo con `pnpm cli enroll-totp`).
 *
 * setup → con la contraseña actual, secreto nuevo pendiente en Redis (cifrado,
 *   10 min) + QR. Solo la misma sesión vuelve a ver el mismo secreto.
 * confirm → con la contraseña y un código de ese secreto se guarda (cifrado)
 *   en users.totpSecret. Así una sesión robada sola no activa su propia 2FA.
 * disable → con un código bueno del secreto actual se borra.
 * Los códigos pasan por el mismo límite de intentos y anti-reutilización.
 */
@Injectable()
export class TotpEnrollmentService {
  private readonly logger = new Logger(TotpEnrollmentService.name);
  private readonly prisma: PrismaService;
  private readonly redis: Redis;
  private readonly totp: TotpService;
  private readonly audit: AuditService;
  private readonly lockout: LockoutService;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(REDIS_CLIENT) redis: Redis,
    @Inject(TotpService) totp: TotpService,
    @Inject(AuditService) audit: AuditService,
    @Inject(LockoutService) lockout: LockoutService,
  ) {
    this.prisma = prisma;
    this.redis = redis;
    this.totp = totp;
    this.audit = audit;
    this.lockout = lockout;
  }

  async status(userId: string): Promise<TotpStatusResponse> {
    const user = await this.loadUser(userId);
    return { enabled: Boolean(user.totpSecret) };
  }

  /**
   * Repetido antes de 10 min desde la MISMA sesión devuelve el mismo secreto
   * (recargar no invalida el QR ya escaneado); otra sesión, o un token sin
   * sid, recibe uno nuevo (el anterior deja de valer).
   */
  async setup(userId: string, password: string, sessionId?: string): Promise<TotpSetupResponse> {
    const user = await this.loadUser(userId);
    if (user.totpSecret) throw new ConflictException(MSG.alreadyEnabled);
    await this.assertPassword(user, password);

    const secret = (await this.readPending(userId, sessionId)) ?? (await this.createPending(userId, sessionId));
    const otpauthUrl = buildOtpauthUrl(secret, user.email, BRAND_NAME);
    const qrPngDataUrl = await QRCode.toDataURL(otpauthUrl, QR_OPTIONS);
    return { otpauthUrl, secret, qrPngDataUrl };
  }

  async confirm(userId: string, code: string, password: string, meta: ClientMeta = {}): Promise<{ enabled: true }> {
    const user = await this.loadUser(userId);
    if (user.totpSecret) throw new ConflictException(MSG.alreadyEnabled);
    const pending = parsePending(await this.redis.get(pendingKey(userId)));
    if (!pending) throw new ConflictException(MSG.noPending);
    await this.assertPassword(user, password);

    const { sealed } = pending;
    await this.totp.checkStoredForUser(userId, sealed, code);
    const saved = await this.prisma.acrossVenues((tx) =>
      tx.user.updateMany({ where: { id: userId, totpSecret: null }, data: { totpSecret: sealed } }),
    );
    if (saved.count === 0) throw new ConflictException(MSG.alreadyEnabled);
    await this.redis.del(pendingKey(userId));

    await this.audit.log({ action: 'auth.totp.enabled', ...auditActor(user), ...meta });
    this.logger.log(`2FA activada: ${user.email}`);
    return { enabled: true };
  }

  async disable(userId: string, code: string, meta: ClientMeta = {}): Promise<{ enabled: false }> {
    const user = await this.loadUser(userId);
    if (!user.totpSecret) throw new ConflictException(MSG.notEnabled);

    await this.totp.checkStoredForUser(userId, user.totpSecret, code);
    await this.prisma.acrossVenues((tx) =>
      tx.user.updateMany({ where: { id: userId }, data: { totpSecret: null } }),
    );
    await this.totp.forgetUsedCodes(userId);

    await this.audit.log({ action: 'auth.totp.disabled', ...auditActor(user), ...meta });
    this.logger.log(`2FA desactivada: ${user.email}`);
    return { enabled: false };
  }

  /** El super-admin puede tener otro local activo: se busca sin filtro de local. */
  private async loadUser(userId: string): Promise<EnrollingUser> {
    const user = await this.prisma.acrossVenues((tx) =>
      tx.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, tenantId: true, totpSecret: true, passwordHash: true, deletedAt: true },
      }),
    );
    if (!user || user.deletedAt) throw new UnauthorizedException(MSG.userGone);
    return {
      id: user.id,
      email: user.email,
      tenantId: user.tenantId,
      totpSecret: user.totpSecret || null,
      passwordHash: user.passwordHash,
    };
  }

  /**
   * La contraseña actual (bcrypt). El intento se cuenta antes de compararla
   * (atómico): 5 malas en 15 min bloquean 15 min. Mal → 403; bloqueado → 429.
   */
  private async assertPassword(user: EnrollingUser, password: string): Promise<void> {
    const key = reauthKey(user.id);
    const attempt = await this.lockout.reserveAttempt([{ key, policy: REAUTH_LOCK_POLICY }]);
    if (!attempt.allowed) throw passwordLockedError(attempt.ttlSeconds);
    if (!(await bcrypt.compare(password, user.passwordHash))) {
      await this.audit.log({ action: 'auth.totp.password_failed', ...auditActor(user) });
      throw new ForbiddenException({ message: MSG.badPassword, code: PASSWORD_INVALID_CODE });
    }
    await this.lockout.clear(key);
  }

  /** Secreto pendiente en claro de ESTA sesión, o null (no hay, es de otra sesión o no se lee). */
  private async readPending(userId: string, sessionId: string | undefined): Promise<string | null> {
    const pending = parsePending(await this.redis.get(pendingKey(userId)));
    if (!pending || !sessionId || pending.sid !== sessionId) return null;
    try {
      return openTotpSecret(pending.sealed, process.env.ENCRYPTION_KEK).secret;
    } catch (err) {
      this.logger.warn(`Activación 2FA pendiente ilegible, se genera otra: ${(err as Error).message}`);
      return null;
    }
  }

  private async createPending(userId: string, sessionId: string | undefined): Promise<string> {
    const secret = this.totp.newSecret();
    const pending: PendingSecret = { sealed: this.totp.sealSecret(secret), ...(sessionId ? { sid: sessionId } : {}) };
    await this.redis.set(pendingKey(userId), JSON.stringify(pending), 'EX', PENDING_TTL_SEC);
    return secret;
  }
}

/** JSON { sealed, sid }; lo guardado antes de esta versión es el secreto cifrado tal cual (sin sesión). */
function parsePending(raw: string | null): PendingSecret | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PendingSecret> | null;
    if (parsed && typeof parsed.sealed === 'string') {
      return { sealed: parsed.sealed, ...(typeof parsed.sid === 'string' ? { sid: parsed.sid } : {}) };
    }
  } catch {
    // Formato anterior: abajo.
  }
  return { sealed: raw };
}

function passwordLockedError(ttlSeconds: number): HttpException {
  const minutes = Math.max(1, Math.ceil(ttlSeconds / 60));
  return new HttpException(
    {
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      error: 'Too Many Requests',
      message: `Demasiadas contraseñas incorrectas. Espera ${minutes} min y vuelve a probar.`,
      code: PASSWORD_LOCKED_CODE,
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

function reauthKey(userId: string): string {
  return `reauth:${userId}`;
}

function pendingKey(userId: string): string {
  return `nightpay:totp:pending:${userId}`;
}

function auditActor(user: EnrollingUser) {
  return { actorId: user.id, actorEmail: user.email, tenantId: user.tenantId };
}
