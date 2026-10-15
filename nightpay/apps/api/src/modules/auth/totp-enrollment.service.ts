import { ConflictException, Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import * as QRCode from 'qrcode';
import type { TotpSetupResponse, TotpStatusResponse } from '@nightpay/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { BRAND_NAME } from '../../common/brand';
import { AuditService } from '../audit/audit.service';
import { buildOtpauthUrl } from './totp-code';
import { openTotpSecret } from './totp-crypto';
import { TotpService } from './totp.service';

/** El QR de activación vale 10 min. */
const PENDING_TTL_SEC = 10 * 60;
const QR_OPTIONS = { errorCorrectionLevel: 'M', margin: 1, width: 240 } as const;

const MSG = {
  alreadyEnabled: 'La verificación en dos pasos ya está activada.',
  notEnabled: 'La verificación en dos pasos no está activada.',
  noPending: 'No hay ninguna activación en curso o ha caducado (10 min). Vuelve a empezar.',
  userGone: 'Usuario desactivado',
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
}

/**
 * Activar / desactivar la 2FA desde la app (antes solo con `pnpm cli enroll-totp`).
 *
 * setup → secreto nuevo pendiente en Redis (cifrado, 10 min) + QR.
 * confirm → con un código de ese secreto se guarda (cifrado) en users.totpSecret.
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

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(REDIS_CLIENT) redis: Redis,
    @Inject(TotpService) totp: TotpService,
    @Inject(AuditService) audit: AuditService,
  ) {
    this.prisma = prisma;
    this.redis = redis;
    this.totp = totp;
    this.audit = audit;
  }

  async status(userId: string): Promise<TotpStatusResponse> {
    const user = await this.loadUser(userId);
    return { enabled: Boolean(user.totpSecret) };
  }

  /** Repetido antes de 10 min devuelve el mismo secreto (recargar no invalida el QR ya escaneado). */
  async setup(userId: string): Promise<TotpSetupResponse> {
    const user = await this.loadUser(userId);
    if (user.totpSecret) throw new ConflictException(MSG.alreadyEnabled);

    const secret = (await this.readPending(userId)) ?? (await this.createPending(userId));
    const otpauthUrl = buildOtpauthUrl(secret, user.email, BRAND_NAME);
    const qrPngDataUrl = await QRCode.toDataURL(otpauthUrl, QR_OPTIONS);
    return { otpauthUrl, secret, qrPngDataUrl };
  }

  async confirm(userId: string, code: string, meta: ClientMeta = {}): Promise<{ enabled: true }> {
    const user = await this.loadUser(userId);
    if (user.totpSecret) throw new ConflictException(MSG.alreadyEnabled);
    const sealed = await this.redis.get(pendingKey(userId));
    if (!sealed) throw new ConflictException(MSG.noPending);

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
        select: { id: true, email: true, tenantId: true, totpSecret: true, deletedAt: true },
      }),
    );
    if (!user || user.deletedAt) throw new UnauthorizedException(MSG.userGone);
    return { id: user.id, email: user.email, tenantId: user.tenantId, totpSecret: user.totpSecret || null };
  }

  /** Secreto pendiente en claro, o null si no hay (o no se puede leer). */
  private async readPending(userId: string): Promise<string | null> {
    const sealed = await this.redis.get(pendingKey(userId));
    if (!sealed) return null;
    try {
      return openTotpSecret(sealed, process.env.ENCRYPTION_KEK).secret;
    } catch (err) {
      this.logger.warn(`Activación 2FA pendiente ilegible, se genera otra: ${(err as Error).message}`);
      return null;
    }
  }

  private async createPending(userId: string): Promise<string> {
    const secret = this.totp.newSecret();
    await this.redis.set(pendingKey(userId), this.totp.sealSecret(secret), 'EX', PENDING_TTL_SEC);
    return secret;
  }
}

function pendingKey(userId: string): string {
  return `nightpay:totp:pending:${userId}`;
}

function auditActor(user: EnrollingUser) {
  return { actorId: user.id, actorEmail: user.email, tenantId: user.tenantId };
}
