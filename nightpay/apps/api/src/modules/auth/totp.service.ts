import { ForbiddenException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import * as speakeasy from 'speakeasy';
import { ClsService } from 'nestjs-cls';
import { PASSKEY_REQUIRED_CODE } from '@nightpay/contracts';
import { BRAND_NAME } from '../../common/brand';
import type { RequestContext } from '../../common/context/request-context';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TOTP_LOCK_POLICY, TotpAttemptsService } from './totp-attempts.service';
import { buildOtpauthUrl, matchTotpStep, totpForbidden, totpLockedError, type TotpErrorKind } from './totp-code';
import { openTotpSecret, sealTotpSecret, type OpenedTotpSecret } from './totp-crypto';
import { StepUpTokens } from './step-up-tokens';

/** 403 PASSKEY_REQUIRED: quien no tiene 2FA y sí llave confirma con ella esta acción. */
export const PASSKEY_REQUIRED_MESSAGE = 'Confirma con tu llave de acceso (Face ID o el PIN de tu móvil) y repítelo.';

/**
 * 2FA con app de verificación (TOTP, RFC 6238).
 *
 * - users.totpSecret va cifrado (ver totp-crypto); los antiguos en claro se
 *   aceptan y se re-cifran en el siguiente código correcto.
 * - 5 códigos malos en 15 min bloquean 15 min; un código (paso de 30 s) solo
 *   vale una vez y nunca uno anterior al último aceptado.
 * - El límite y los códigos usados van por usuario en Redis: valen igual con
 *   varias réplicas del API (un código usado en una no vale en otra).
 * - Los errores llevan el código que entiende el panel (ver TOTP_ERROR_CODES).
 */
@Injectable()
export class TotpService {
  private readonly logger = new Logger(TotpService.name);
  private readonly prisma: PrismaService;
  private readonly attempts: TotpAttemptsService;
  /** Pruebas de la llave de acceso para actuar sin 2FA (cabecera X-Step-Up-Token). */
  private readonly tokens: Pick<StepUpTokens, 'consume'> | null;
  private readonly cls: Pick<ClsService<{ ctx: RequestContext }>, 'get' | 'set'> | null;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(TotpAttemptsService) attempts: TotpAttemptsService,
    @Optional() @Inject(StepUpTokens) tokens?: StepUpTokens,
    @Optional() @Inject(ClsService) cls?: ClsService<{ ctx: RequestContext }>,
  ) {
    this.prisma = prisma;
    this.attempts = attempts;
    this.tokens = tokens ?? null;
    this.cls = cls ?? null;
  }

  /** Secreto nuevo + URL otpauth para el QR. Se guarda con sealSecret(). */
  generateSecret(label: string, issuer = BRAND_NAME): { base32: string; otpauthUrl: string } {
    const base32 = this.newSecret();
    return { base32, otpauthUrl: buildOtpauthUrl(base32, label, issuer) };
  }

  /** Secreto base32 nuevo (160 bits, lo recomendado por RFC 4226). */
  newSecret(): string {
    return speakeasy.generateSecret({ length: 20 }).base32;
  }

  /** Lo que se guarda en users.totpSecret: el secreto cifrado con ENCRYPTION_KEK. */
  sealSecret(secretBase32: string): string {
    return sealTotpSecret(secretBase32, process.env.ENCRYPTION_KEK);
  }

  async isEnabled(userId: string): Promise<boolean> {
    return (await this.loadStoredSecret(userId)) !== null;
  }

  /**
   * 2FA "si la tiene activada": quien activó la app de verificación tiene que
   * poner el código; quien no, sigue como antes (p. ej. pagar a una operadora).
   */
  async assertIfEnrolledForUser(userId: string, code: string | undefined): Promise<void> {
    const stored = await this.loadStoredSecret(userId);
    if (stored) await this.checkStoredForUser(userId, stored, code);
  }

  /**
   * Exige la 2FA activada y un código bueno. Con `action` (la acción que lo
   * pide, stepUpActions de @nightpay/contracts): quien no tiene 2FA puede
   * hacerla con la prueba de su llave de acceso para ESA acción (de un solo
   * uso, en la cabecera X-Step-Up-Token); si tiene llave y no la trae, 403
   * PASSKEY_REQUIRED con `stepUpAction`. Sin `action` (login, cambio de local,
   * desactivar la 2FA, el super-admin), solo la 2FA, como siempre.
   */
  async assertForUser(userId: string, code: string | undefined, action?: string): Promise<void> {
    const stored = await this.loadStoredSecret(userId);
    if (!stored) {
      if (action && (await this.passkeyProofFor(userId, action))) return;
      throw await this.missingSecondFactor(userId, action);
    }
    await this.checkStoredForUser(userId, stored, code);
  }

  /**
   * Sin 2FA: ¿trae la prueba de su llave para esta acción, de esta sesión? La
   * gasta (una vez). Si la misma petición lo vuelve a preguntar para la misma
   * acción (un reintento dentro), vale sin gastar otra.
   */
  async passkeyProofFor(userId: string, action: string): Promise<boolean> {
    const ctx = this.cls?.get('ctx');
    if (!this.tokens || !ctx?.stepUpToken) return false;
    if (ctx.stepUpSpentFor === action) return true;
    const ok = await this.tokens.consume({ userId, sessionId: ctx.sessionId ?? null, action }, ctx.stepUpToken);
    if (ok) this.cls?.set('ctx', { ...ctx, stepUpSpentFor: action });
    return ok;
  }

  /**
   * El 403 de quien no tiene 2FA: con una llave de acceso y una acción, que
   * confirme con ella (PASSKEY_REQUIRED, `stepUpAction`); si no, que active la
   * 2FA (TOTP_NOT_ENROLLED). `message`: el texto a medida de quien llama.
   */
  async missingSecondFactor(userId: string, action?: string, message?: string): Promise<ForbiddenException> {
    if (action && (await this.passkeyCount(userId)) > 0) {
      return new ForbiddenException({ message: message ?? PASSKEY_REQUIRED_MESSAGE, code: PASSKEY_REQUIRED_CODE, stepUpAction: action });
    }
    return totpForbidden('notEnrolled', message);
  }

  /**
   * Código contra lo guardado en users.totpSecret (o el pendiente de activar);
   * re-cifra si estaba en claro.
   */
  async checkStoredForUser(userId: string, stored: string, code: string | undefined): Promise<void> {
    const opened = this.tryOpen(stored);
    if (!opened) throw totpForbidden('unreadable');
    await this.checkCodeForUser(userId, opened.secret, code);
    if (opened.legacy) await this.reencrypt(userId, stored, opened.secret);
  }

  /** Código contra un secreto en claro. */
  async checkCodeForUser(userId: string, secretBase32: string, code: string | undefined): Promise<void> {
    if (!code) throw totpForbidden('required');
    await this.attempts.assertNotLocked(userId);
    const step = matchTotpStep(secretBase32, code);
    if (step === null) return this.failForUser(userId, 'invalid');
    // Un código ya usado no vale, pero es bueno: no es probar a ciegas. Repetirlo
    // (entrar y aprobar algo en los mismos 30 s) no acerca al bloqueo.
    if (!(await this.attempts.claimStep(userId, step))) throw totpForbidden('reused');
    await this.attempts.clearFailures(userId);
  }

  /** Al desactivar la 2FA: el próximo secreto empieza sin pasos usados. */
  async forgetUsedCodes(userId: string): Promise<void> {
    await this.attempts.forgetSteps(userId);
  }

  // ── internos ────────────────────────────────────────────────────────

  private async failForUser(userId: string, kind: TotpErrorKind): Promise<never> {
    const locked = await this.attempts.recordFailure(userId);
    throw locked ? totpLockedError(TOTP_LOCK_POLICY.lockSec) : totpForbidden(kind);
  }

  private tryOpen(stored: string): OpenedTotpSecret | null {
    try {
      return openTotpSecret(stored, process.env.ENCRYPTION_KEK);
    } catch (err) {
      this.logger.error(`No se puede leer un secreto 2FA guardado: ${(err as Error).message}`);
      return null;
    }
  }

  private async passkeyCount(userId: string): Promise<number> {
    try {
      return await this.prisma.staffPasskey.count({ where: { userId } });
    } catch (err) {
      this.logger.warn(`No se pudieron contar las llaves de acceso: ${(err as Error).message}`);
      return 0;
    }
  }

  private async loadStoredSecret(userId: string): Promise<string | null> {
    const user = await this.prisma.acrossVenues((tx) =>
      tx.user.findUnique({ where: { id: userId }, select: { totpSecret: true } }),
    );
    return user?.totpSecret || null;
  }

  /**
   * Secreto antiguo en claro → se guarda cifrado, solo si nadie lo ha cambiado
   * entretanto. Nunca lanza: si falla, se queda en claro y se reintenta la
   * próxima vez.
   */
  private async reencrypt(userId: string, stored: string, secretBase32: string): Promise<void> {
    try {
      const sealed = this.sealSecret(secretBase32);
      const { count } = await this.prisma.acrossVenues((tx) =>
        tx.user.updateMany({ where: { id: userId, totpSecret: stored }, data: { totpSecret: sealed } }),
      );
      if (count > 0) this.logger.log(`Secreto 2FA antiguo guardado ya cifrado (${count})`);
    } catch (err) {
      this.logger.error(`No se pudo cifrar un secreto 2FA antiguo: ${(err as Error).message}`);
    }
  }
}
