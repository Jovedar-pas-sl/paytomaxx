import { createHash } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import type { Redis } from 'ioredis';
import { ClsService } from 'nestjs-cls';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { Prisma } from '@nightpay/db';
import { deviceLabel, type StaffPasskeyView } from '@nightpay/contracts';
import { BRAND_NAME } from '../../common/brand';
import type { RequestContext } from '../../common/context/request-context';
import { PrismaService } from '../../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { AuditService } from '../audit/audit.service';
import { LockoutService } from './lockout.service';
import { currentStaffRelyingParty } from './staff-passkey-rp';
import type { StaffPasskeyCounter } from './step-up.service';
import { PASSWORD_INVALID_CODE, PASSWORD_LOCKED_CODE, REAUTH_LOCK_POLICY } from './totp-enrollment.service';
import { TotpService } from './totp.service';

/** Lo que tarda la persona en desbloquear su móvil. */
const CHALLENGE_TTL_S = 300;
/** Llaves por persona (un móvil o dos; no hace falta más). */
export const MAX_STAFF_PASSKEYS = 5;

export interface StaffActor {
  userId: string;
  sessionId?: string | null;
  tenantId?: string;
  email?: string;
}

/**
 * Las llaves de acceso del personal (WebAuthn): quien no tiene 2FA se
 * verifica con su móvil (Face ID, huella o el PIN del teléfono; lo decide su
 * móvil). Reutiliza lo de las llaves de los clientes (wallet-passkeys.service):
 * userVerification obligatoria, retos de 300 s de un solo uso (solo se gastan
 * con una firma buena) y solo la clave pública. A diferencia de las del
 * cliente:
 *  - darla de alta pide la contraseña otra vez (y el código, si tiene 2FA): una
 *    sesión robada sola no se da de alta su llave;
 *  - al verificarse se ofrecen solo SUS llaves (allowCredentials) y no se piden
 *    como «residentes»: así el selector del cliente en /s no las enseña.
 */
@Injectable()
export class StaffPasskeysService implements StaffPasskeyCounter {
  private readonly logger = new Logger(StaffPasskeysService.name);
  private readonly prisma: PrismaService;
  private readonly redis: Redis;
  private readonly totp: Pick<TotpService, 'assertForUser' | 'isEnabled'>;
  private readonly lockout: Pick<LockoutService, 'reserveAttempt' | 'clear'>;
  private readonly audit: AuditService | null;
  private readonly cls: Pick<ClsService<{ ctx: RequestContext }>, 'get'> | null;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(REDIS_CLIENT) redis: Redis,
    @Inject(TotpService) totp: TotpService,
    @Inject(LockoutService) lockout: LockoutService,
    @Optional() @Inject(AuditService) audit?: AuditService,
    @Optional() @Inject(ClsService) cls?: ClsService<{ ctx: RequestContext }>,
  ) {
    this.prisma = prisma;
    this.redis = redis;
    this.totp = totp;
    this.lockout = lockout;
    this.audit = audit ?? null;
    this.cls = cls ?? null;
  }

  async count(userId: string): Promise<number> {
    return this.prisma.staffPasskey.count({ where: { userId } });
  }

  async list(userId: string): Promise<StaffPasskeyView[]> {
    const rows = await this.prisma.staffPasskey.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, createdAt: true, lastUsedAt: true },
    });
    return rows.map(viewOf);
  }

  /**
   * Dar de alta una llave, paso 1: con la contraseña (5 malas en 15 min
   * bloquean 15 min, la misma cuenta que al activar la 2FA) y, si tiene 2FA,
   * su código. Devuelve las opciones para el móvil.
   */
  async registrationOptions(
    actor: StaffActor,
    password: string,
    totpCode: string | undefined,
    origin: string | undefined,
  ): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const user = await this.loadUser(actor.userId);
    await this.assertPassword(user, password);
    if (await this.totp.isEnabled(user.id)) await this.totp.assertForUser(user.id, totpCode);
    const existing = await this.prisma.staffPasskey.findMany({ where: { userId: user.id }, select: { credentialId: true, transports: true } });
    if (existing.length >= MAX_STAFF_PASSKEYS) {
      throw new ConflictException({ message: `Ya tienes ${MAX_STAFF_PASSKEYS} llaves: quita una antes de añadir otra.`, code: 'PASSKEY_LIMIT' });
    }
    const options = await generateRegistrationOptions({
      rpName: BRAND_NAME,
      rpID: currentStaffRelyingParty(origin).rpID,
      userName: user.email,
      userDisplayName: user.displayName?.trim() || user.email,
      userID: new TextEncoder().encode(`staff:${user.id}`),
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({ id: c.credentialId, transports: c.transports as never })),
      authenticatorSelection: { residentKey: 'discouraged', requireResidentKey: false, userVerification: 'required' },
      preferredAuthenticatorType: 'localDevice',
    });
    await this.redis.set(regKey(user.id, options.challenge), actor.sessionId ?? '-', 'EX', CHALLENGE_TTL_S);
    return options;
  }

  /** Paso 2: comprueba lo que firmó el móvil y guarda la clave pública. */
  async register(actor: StaffActor, response: unknown, name: string | undefined, origin: string | undefined): Promise<StaffPasskeyView> {
    const r = response as RegistrationResponseJSON | undefined;
    const challenge = challengeOf(r?.response?.clientDataJSON);
    const slot = challenge ? regKey(actor.userId, challenge) : null;
    const pendingSession = slot ? await this.redis.get(slot) : null;
    if (!slot || pendingSession === null || pendingSession !== (actor.sessionId ?? '-')) {
      throw new ConflictException({ message: 'Ha tardado demasiado: vuelve a empezar.', code: 'PASSKEY_TIMEOUT' });
    }
    const rp = currentStaffRelyingParty(origin);
    let info: Awaited<ReturnType<typeof verifyRegistrationResponse>>['registrationInfo'];
    try {
      const v = await verifyRegistrationResponse({
        response: r!,
        expectedChallenge: challenge!,
        expectedOrigin: rp.origins,
        expectedRPID: rp.rpIDs,
        requireUserVerification: true,
      });
      info = v.verified ? v.registrationInfo : undefined;
    } catch (err) {
      this.logger.warn(`Llave del personal rechazada (${actor.userId}): ${(err as Error).message}`);
    }
    if (!info) throw new ForbiddenException({ message: 'No se ha podido dar de alta la llave.', code: 'PASSKEY_FAILED' });
    if ((await this.redis.del(slot)) !== 1) throw new ConflictException({ message: 'Este alta ya se usó.', code: 'PASSKEY_USED' });
    const c = info.credential;
    const label = (name?.trim() || this.deviceName()).slice(0, 80);
    try {
      const row = await this.prisma.staffPasskey.create({
        data: {
          userId: actor.userId,
          credentialId: c.id,
          publicKey: Buffer.from(c.publicKey),
          counter: BigInt(c.counter),
          transports: c.transports ?? [],
          name: label,
        },
        select: { id: true, name: true, createdAt: true, lastUsedAt: true },
      });
      await this.log(actor, 'auth.passkey.added', { passkeyId: row.id, name: label });
      return viewOf(row);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException({ message: 'Esta llave ya está dada de alta.', code: 'PASSKEY_EXISTS' });
      }
      throw err;
    }
  }

  /** Quitar una de sus llaves (otra persona: 404). */
  async remove(actor: StaffActor, passkeyId: string): Promise<void> {
    const { count } = await this.prisma.staffPasskey.deleteMany({ where: { id: passkeyId, userId: actor.userId } });
    if (count === 0) throw new NotFoundException('Llave no encontrada');
    await this.log(actor, 'auth.passkey.removed', { passkeyId });
  }

  /** El dueño quita las llaves de alguien de su local (un móvil perdido). Devuelve cuántas. */
  async removeAllOf(owner: StaffActor & { tenantId: string }, userId: string): Promise<number> {
    const person = await this.prisma.asSystem((tx) =>
      tx.user.findFirst({ where: { id: userId, tenantId: owner.tenantId, deletedAt: null }, select: { id: true } }),
    );
    if (!person) throw new NotFoundException('No es del personal de este local');
    const { count } = await this.prisma.staffPasskey.deleteMany({ where: { userId } });
    await this.log(owner, 'auth.passkey.removed_by_owner', { userId, count });
    return count;
  }

  /** Reto para verificarse: solo SUS llaves; `purpose` lo ata a ver o a una acción. */
  async authenticationOptions(actor: StaffActor, purpose: string, origin: string | undefined): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const keys = await this.prisma.staffPasskey.findMany({ where: { userId: actor.userId }, select: { credentialId: true, transports: true } });
    if (keys.length === 0) {
      throw new ForbiddenException({ message: 'No tienes ninguna llave de acceso: dala de alta en tu menú.', code: 'PASSKEY_NOT_SET' });
    }
    const options = await generateAuthenticationOptions({
      rpID: currentStaffRelyingParty(origin).rpID,
      userVerification: 'required',
      allowCredentials: keys.map((k) => ({ id: k.credentialId, transports: k.transports as never })),
    });
    await this.redis.set(authKey(actor.userId, options.challenge), slotValue(actor, purpose), 'EX', CHALLENGE_TTL_S);
    return options;
  }

  /** Comprueba que desbloqueó su móvil con una de SUS llaves, para este `purpose` y en esta sesión. */
  async verify(actor: StaffActor, purpose: string, response: unknown, origin: string | undefined): Promise<void> {
    const r = response as AuthenticationResponseJSON | undefined;
    if (!r || typeof r !== 'object' || typeof r.id !== 'string') {
      throw new ForbiddenException({ message: 'Confirma con Face ID, huella o el PIN de tu móvil.', code: 'PASSKEY_REQUIRED' });
    }
    const key = await this.prisma.staffPasskey.findUnique({
      where: { credentialId: r.id },
      select: { id: true, userId: true, credentialId: true, publicKey: true, counter: true, transports: true },
    });
    if (!key || key.userId !== actor.userId) {
      throw new ForbiddenException({ message: 'Esa llave no es tuya.', code: 'PASSKEY_UNKNOWN' });
    }
    const challenge = challengeOf(r.response?.clientDataJSON);
    const slot = challenge ? authKey(actor.userId, challenge) : null;
    if (!slot || (await this.redis.get(slot)) !== slotValue(actor, purpose)) {
      throw new ConflictException({ message: 'Ha tardado demasiado: vuelve a intentarlo.', code: 'PASSKEY_TIMEOUT' });
    }
    const rp = currentStaffRelyingParty(origin);
    let newCounter: number | null = null;
    try {
      const v = await verifyAuthenticationResponse({
        response: r,
        expectedChallenge: challenge!,
        expectedOrigin: rp.origins,
        expectedRPID: rp.rpIDs,
        credential: { id: key.credentialId, publicKey: new Uint8Array(key.publicKey), counter: Number(key.counter), transports: key.transports as never },
        requireUserVerification: true,
      });
      if (v.verified) newCounter = v.authenticationInfo.newCounter;
    } catch (err) {
      this.logger.warn(`Verificación con llave rechazada (${actor.userId}): ${(err as Error).message}`);
    }
    if (newCounter === null) throw new ForbiddenException({ message: 'No se ha podido comprobar tu llave.', code: 'PASSKEY_FAILED' });
    // El reto se gasta solo con una firma buena; la misma firma dos veces, no.
    if ((await this.redis.del(slot)) !== 1) throw new ConflictException({ message: 'Esta confirmación ya se usó.', code: 'PASSKEY_USED' });
    await this.prisma.staffPasskey.update({ where: { id: key.id }, data: { counter: BigInt(newCounter), lastUsedAt: new Date() } });
  }

  // ── internos ──────────────────────────────────────────────────────────

  /** El móvil de la petición («iPhone · iOS 18»), para el nombre de la llave. */
  private deviceName(): string {
    const d = this.cls?.get('ctx')?.device;
    if (!d) return 'Mi móvil';
    const label = deviceLabel({ model: d.model, os: d.os, osVersion: d.osVersion, browser: null, inApp: null });
    return label === 'Dispositivo sin identificar' ? 'Mi móvil' : label;
  }

  private async loadUser(userId: string) {
    const user = await this.prisma.acrossVenues((tx) =>
      tx.user.findUnique({ where: { id: userId }, select: { id: true, email: true, displayName: true, passwordHash: true, tenantId: true, deletedAt: true } }),
    );
    if (!user || user.deletedAt) throw new UnauthorizedException('Usuario desactivado');
    return user;
  }

  private async assertPassword(user: { id: string; passwordHash: string; email: string; tenantId: string }, password: string): Promise<void> {
    const key = `reauth:${user.id}`;
    const attempt = await this.lockout.reserveAttempt([{ key, policy: REAUTH_LOCK_POLICY }]);
    if (!attempt.allowed) {
      const minutes = Math.max(1, Math.ceil(attempt.ttlSeconds / 60));
      throw new HttpException(
        { message: `Demasiadas contraseñas incorrectas. Espera ${minutes} min y vuelve a probar.`, code: PASSWORD_LOCKED_CODE },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (!(await bcrypt.compare(password, user.passwordHash))) {
      await this.log({ userId: user.id, tenantId: user.tenantId, email: user.email }, 'auth.passkey.password_failed', {});
      throw new ForbiddenException({ message: 'La contraseña no es correcta.', code: PASSWORD_INVALID_CODE });
    }
    await this.lockout.clear(key);
  }

  private async log(actor: StaffActor, action: string, payload: Record<string, unknown>): Promise<void> {
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

function viewOf(row: { id: string; name: string; createdAt: Date; lastUsedAt: Date | null }): StaffPasskeyView {
  return { id: row.id, label: row.name, createdAt: row.createdAt.toISOString(), lastUsedAt: row.lastUsedAt?.toISOString() ?? null };
}

/** El reto vale para esta persona, esta sesión y este propósito (ver, o una acción). */
function slotValue(actor: StaffActor, purpose: string): string {
  return createHash('sha256').update(`${actor.sessionId ?? '-'}|${purpose}`).digest('hex');
}

const regKey = (userId: string, challenge: string): string => `np:spk:reg:${userId}:${challenge}`;
const authKey = (userId: string, challenge: string): string => `np:spk:auth:${userId}:${challenge}`;

/** El reto que firmó el móvil (va dentro de clientDataJSON). */
function challengeOf(clientDataJSON: unknown): string | null {
  if (typeof clientDataJSON !== 'string') return null;
  try {
    const data = JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf8')) as { challenge?: unknown };
    return typeof data.challenge === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(data.challenge) ? data.challenge : null;
  } catch {
    return null;
  }
}
