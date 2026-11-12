import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@nightpay/db';
import * as bcrypt from 'bcryptjs';
import {
  CURRENT_PASSWORD_WRONG_CODE,
  DISPLAY_NAME_TAKEN_CODE,
  DISPLAY_NAME_TAKEN_MESSAGE,
  EMAIL_TAKEN_CODE,
  type ChangePasswordDto,
  type MyProfile,
  type UpdateEmailDto,
  type UpdatePhoneDto,
  type UpdateProfileDto,
} from '@nightpay/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { passwordFingerprint, RefreshTokenService } from '../auth/refresh-token.service';
import { maskEmail, maskPhone } from './audit-mask';
import { checkProfilePhoto } from './profile-image';

const BCRYPT_ROUNDS = 10;

/** Quién llama: lo del token. `sid` es su sesión (para no cerrarla al cerrar las demás). */
export interface ProfileActor {
  userId: string;
  tenantId: string;
  role: string;
  sid?: string;
}

const SELF_SELECT = {
  id: true,
  tenantId: true,
  email: true,
  phone: true,
  role: true,
  displayName: true,
  passwordHash: true,
  deletedAt: true,
  photo: { select: { contentHash: true } },
} satisfies Prisma.UserSelect;

type SelfRow = Prisma.UserGetPayload<{ select: typeof SELF_SELECT }>;

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/**
 * «Mi perfil» del personal: cada persona cambia solo lo suyo (la persona sale
 * siempre del token, nunca de la petición), y todo queda en el registro. No toca
 * datos legales ni de cobro (alta, IBAN). Las fotos van en `user_photos` (FORCE
 * RLS): solo dentro de una transacción con el local del dueño de la foto.
 */
@Injectable()
export class ProfileService {
  private readonly logger = new Logger(ProfileService.name);
  private readonly prisma: PrismaService;
  private readonly audit: AuditService;
  private readonly sessions: RefreshTokenService;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(AuditService) audit: AuditService,
    @Inject(RefreshTokenService) sessions: RefreshTokenService,
  ) {
    this.prisma = prisma;
    this.audit = audit;
    this.sessions = sessions;
  }

  async getMine(actor: ProfileActor): Promise<MyProfile> {
    const me = await this.loadSelf(actor.userId);
    const venue = await this.prisma.asSystem((tx) => tx.venue.findUnique({ where: { id: actor.tenantId }, select: { name: true } }));
    return this.view(me, venue?.name ?? '');
  }

  async updateName(actor: ProfileActor, dto: UpdateProfileDto): Promise<MyProfile> {
    const me = await this.loadSelf(actor.userId);
    if (me.displayName !== dto.displayName) {
      await this.assertNameFree(me, dto.displayName);
      await this.prisma.asSystem((tx) => tx.user.update({ where: { id: me.id }, data: { displayName: dto.displayName } }));
      await this.log(actor, me, 'profile.name.updated', { field: 'displayName', before: me.displayName, after: dto.displayName });
    }
    return this.getMine(actor);
  }

  async updatePhone(actor: ProfileActor, dto: UpdatePhoneDto): Promise<MyProfile> {
    const me = await this.loadSelf(actor.userId);
    if ((me.phone ?? null) !== dto.phone) {
      await this.prisma.asSystem((tx) => tx.user.update({ where: { id: me.id }, data: { phone: dto.phone } }));
      await this.log(actor, me, 'profile.phone.updated', { field: 'phone', before: maskPhone(me.phone), after: maskPhone(dto.phone) });
    }
    return this.getMine(actor);
  }

  /**
   * El correo con el que entra. Pide la contraseña actual, no puede ser el de
   * otra cuenta (sin mirar mayúsculas) y deja el de antes y el nuevo en el
   * registro. La sesión de este móvil sigue; las demás se cierran.
   */
  async updateEmail(actor: ProfileActor, dto: UpdateEmailDto): Promise<MyProfile> {
    const me = await this.loadSelf(actor.userId);
    await this.assertCurrentPassword(me, dto.currentPassword);
    if (me.email.toLowerCase() === dto.email) return this.getMine(actor);
    const taken = await this.prisma.asSystem((tx) =>
      tx.user.findFirst({ where: { email: { equals: dto.email, mode: 'insensitive' }, id: { not: me.id } }, select: { id: true } }),
    );
    if (taken) throw this.emailTaken();
    // Primero el registro, luego el cambio y al final las sesiones: si algo falla, queda rastro.
    await this.log(actor, me, 'profile.email.changed', { field: 'email', before: maskEmail(me.email), after: maskEmail(dto.email) });
    try {
      await this.prisma.asSystem((tx) => tx.user.update({ where: { id: me.id }, data: { email: dto.email } }));
    } catch (err) {
      await this.log(actor, me, 'profile.email.change_failed', { field: 'email' });
      if (isUniqueViolation(err)) throw this.emailTaken();
      throw err;
    }
    await this.closeOtherSessions(actor, me.id, 'cambio de correo');
    return this.getMine(actor);
  }

  /** Contraseña nueva con la actual. Las demás sesiones de la persona se cierran; la de este móvil sigue. */
  async changePassword(actor: ProfileActor, dto: ChangePasswordDto): Promise<{ changed: true; otherSessionsClosed: number }> {
    const me = await this.loadSelf(actor.userId);
    await this.assertCurrentPassword(me, dto.currentPassword);
    const passwordHash = await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS);
    // Primero el registro, luego el cambio y al final las sesiones: si algo falla, queda rastro.
    await this.log(actor, me, 'profile.password.changed', { field: 'password' });
    try {
      await this.prisma.asSystem((tx) => tx.user.update({ where: { id: me.id }, data: { passwordHash, invitedAt: null, inviteToken: null } }));
    } catch (err) {
      await this.log(actor, me, 'profile.password.change_failed', { field: 'password' });
      throw err;
    }
    const closed = await this.closeOtherSessions(actor, me.id, 'cambio de contraseña', passwordFingerprint(passwordHash));
    return { changed: true, otherSessionsClosed: closed };
  }

  /** Guarda (o cambia) la foto de quien llama: WebP o JPEG ya comprobado. */
  async setPhoto(actor: ProfileActor, base64: string): Promise<MyProfile> {
    const checked = checkProfilePhoto(Buffer.from(base64, 'base64'));
    if (!checked.ok) throw new BadRequestException(checked.message);
    const { data, contentType, contentHash, width, height } = checked.image;
    const me = await this.loadSelf(actor.userId);
    await this.prisma.withTenant(me.tenantId, (tx) =>
      tx.userPhoto.upsert({
        where: { userId: me.id },
        create: { userId: me.id, tenantId: me.tenantId, contentType, data, contentHash, width, height },
        update: { contentType, data, contentHash, width, height },
      }),
    );
    await this.log(actor, me, 'profile.photo.set', { contentHash, contentType, bytes: data.length, width, height });
    return this.getMine(actor);
  }

  async removeOwnPhoto(actor: ProfileActor): Promise<MyProfile> {
    const me = await this.loadSelf(actor.userId);
    const { count } = await this.prisma.withTenant(me.tenantId, (tx) => tx.userPhoto.deleteMany({ where: { userId: me.id, tenantId: me.tenantId } }));
    if (count > 0) await this.log(actor, me, 'profile.photo.removed', {});
    return this.getMine(actor);
  }

  /** El dueño o el encargado quitan la foto de alguien de SU local (por si sube algo que no toca). */
  async removePhotoOf(actor: ProfileActor, targetUserId: string): Promise<{ removed: boolean }> {
    const target = await this.prisma.withTenant(actor.tenantId, (tx) =>
      tx.user.findFirst({ where: { id: targetUserId, tenantId: actor.tenantId }, select: { id: true, tenantId: true } }),
    );
    if (!target) throw new NotFoundException('Esa persona no está en este local');
    const { count } = await this.prisma.withTenant(actor.tenantId, (tx) =>
      tx.userPhoto.deleteMany({ where: { userId: target.id, tenantId: actor.tenantId } }),
    );
    if (count > 0) {
      await this.audit.log({
        action: 'profile.photo.removed_by_staff',
        tenantId: actor.tenantId,
        actorId: actor.userId,
        targetType: 'User',
        targetId: target.id,
        payload: { actorRole: actor.role },
      });
    }
    return { removed: count > 0 };
  }

  /**
   * Los bytes de la foto para servirla: solo al personal del MISMO local (el
   * RLS lo impone también), y la huella de la dirección tiene que ser la de la
   * foto de ahora (una vieja → null).
   */
  async photoFor(viewerTenantId: string, userId: string, contentHash: string): Promise<{ data: Buffer; contentHash: string; contentType: string } | null> {
    const row = await this.prisma.withTenant(viewerTenantId, (tx) =>
      tx.userPhoto.findFirst({
        where: { userId, tenantId: viewerTenantId, contentHash },
        select: { data: true, contentHash: true, contentType: true },
      }),
    );
    return row ? { data: Buffer.from(row.data), contentHash: row.contentHash.trim(), contentType: row.contentType } : null;
  }

  /** Las huellas de las fotos de un grupo de personas del local (para las listas del panel). */
  async photoHashes(tenantId: string, userIds: readonly string[]): Promise<Map<string, string>> {
    if (userIds.length === 0) return new Map();
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.userPhoto.findMany({ where: { tenantId, userId: { in: [...userIds] } }, select: { userId: true, contentHash: true } }),
    );
    return new Map(rows.map((r) => [r.userId, r.contentHash.trim()]));
  }

  /**
   * Cierra las demás sesiones. El cambio ya está hecho: si Redis falla se prueba
   * con cerrarlas todas (también esta) y, si tampoco, se registra el fallo y se
   * contesta OK. Nunca se traga el error sin dejar rastro.
   */
  private async closeOtherSessions(actor: ProfileActor, userId: string, why: string, newPwdFp?: string): Promise<number> {
    try {
      return await this.sessions.revokeOthersForUser(userId, actor.sid, newPwdFp);
    } catch (err) {
      this.logger.error(`No se pudieron cerrar las demás sesiones tras el ${why} (user=${userId}): ${(err as Error).message}. Pruebo a cerrarlas todas.`);
    }
    try {
      return await this.sessions.revokeAllForUser(userId);
    } catch (err) {
      this.logger.error(`No se pudo cerrar ninguna sesión tras el ${why} (user=${userId}, tenant=${actor.tenantId}): ${(err as Error).message}. El cambio SÍ se hizo; las sesiones abiertas siguen vivas.`);
      return 0;
    }
  }

  /** Nadie más del personal activo del local usa ese nombre (sin mirar mayúsculas). */
  private async assertNameFree(me: SelfRow, name: string): Promise<void> {
    const clash = await this.prisma.asSystem((tx) =>
      tx.user.findFirst({
        where: { tenantId: me.tenantId, deletedAt: null, id: { not: me.id }, displayName: { equals: name, mode: 'insensitive' } },
        select: { id: true },
      }),
    );
    if (clash) throw new ConflictException({ message: DISPLAY_NAME_TAKEN_MESSAGE, code: DISPLAY_NAME_TAKEN_CODE });
  }

  private async loadSelf(userId: string): Promise<SelfRow> {
    const me = await this.prisma.asSystem((tx) => tx.user.findUnique({ where: { id: userId }, select: SELF_SELECT }));
    if (!me || me.deletedAt) throw new NotFoundException('Tu cuenta no está activa');
    return me;
  }

  private async assertCurrentPassword(me: SelfRow, plain: string): Promise<void> {
    if (await bcrypt.compare(plain, me.passwordHash)) return;
    await this.audit.log({
      action: 'profile.password.check_failed',
      tenantId: me.tenantId,
      actorId: me.id,
      targetType: 'User',
      targetId: me.id,
      payload: {},
    });
    throw new ForbiddenException({ message: 'La contraseña actual no es correcta', code: CURRENT_PASSWORD_WRONG_CODE });
  }

  private emailTaken(): ConflictException {
    return new ConflictException({ message: 'Ese correo ya lo usa otra cuenta', code: EMAIL_TAKEN_CODE });
  }

  private view(me: SelfRow, venueName: string): MyProfile {
    const hash = me.photo?.contentHash.trim() ?? null;
    return {
      userId: me.id,
      displayName: me.displayName?.trim() || null,
      email: me.email,
      phone: me.phone ?? null,
      role: me.role,
      venueName,
      hasPhoto: hash !== null,
      photoHash: hash,
    };
  }

  private async log(actor: ProfileActor, me: SelfRow, action: string, payload: Record<string, unknown>): Promise<void> {
    await this.audit.log({
      action,
      tenantId: me.tenantId,
      actorId: actor.userId,
      targetType: 'User',
      targetId: me.id,
      payload,
    });
  }
}
