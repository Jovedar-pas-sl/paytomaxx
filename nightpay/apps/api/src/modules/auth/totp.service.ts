import { Inject, Injectable, Logger } from '@nestjs/common';
import * as speakeasy from 'speakeasy';
import { BRAND_NAME } from '../../common/brand';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TOTP_LOCK_POLICY, TotpAttemptsService } from './totp-attempts.service';
import { buildOtpauthUrl, matchTotpStep, totpForbidden, totpLockedError, type TotpErrorKind } from './totp-code';
import { openTotpSecret, sealTotpSecret, type OpenedTotpSecret } from './totp-crypto';

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

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(TotpAttemptsService) attempts: TotpAttemptsService,
  ) {
    this.prisma = prisma;
    this.attempts = attempts;
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

  /** Exige la 2FA activada y un código bueno. */
  async assertForUser(userId: string, code: string | undefined): Promise<void> {
    const stored = await this.loadStoredSecret(userId);
    if (!stored) throw totpForbidden('notEnrolled');
    await this.checkStoredForUser(userId, stored, code);
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
    if (!(await this.attempts.claimStep(userId, step))) return this.failForUser(userId, 'reused');
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
