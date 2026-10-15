import { ForbiddenException, HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import * as speakeasy from 'speakeasy';
import { BRAND_NAME } from '../../common/brand';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TOTP_LOCK_POLICY, TotpAttemptsService } from './totp-attempts.service';
import { buildOtpauthUrl, matchTotpStep, TOTP_MESSAGES, totpLockedError } from './totp-code';
import { openTotpSecret, sealTotpSecret, type OpenedTotpSecret } from './totp-crypto';
import { TotpMemoryGuard } from './totp-memory-guard';

/**
 * 2FA con app de verificación (TOTP, RFC 6238).
 *
 * - users.totpSecret va cifrado (ver totp-crypto); los antiguos en claro se
 *   aceptan y se re-cifran en el siguiente código correcto.
 * - 5 códigos malos en 15 min bloquean 15 min; un código (paso de 30 s) solo
 *   vale una vez y nunca uno anterior al último aceptado.
 *
 * Dos APIs:
 * - Por usuario, en Redis (assertForUser / assertIfEnrolledForUser): la buena,
 *   vale con varias réplicas.
 * - Síncrona antigua (assertIfEnrolled / verify): la siguen usando refunds y el
 *   pago a operadoras; hace lo mismo pero con el límite en memoria del proceso.
 */
@Injectable()
export class TotpService {
  private readonly logger = new Logger(TotpService.name);
  private readonly prisma: PrismaService;
  private readonly attempts: TotpAttemptsService;
  private readonly memoryGuard = new TotpMemoryGuard(TOTP_LOCK_POLICY);

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(TotpAttemptsService) attempts: TotpAttemptsService,
  ) {
    this.prisma = prisma;
    this.attempts = attempts;
  }

  /** Secreto nuevo + URL otpauth para el QR. Se guarda con sealSecret(). */
  generateSecret(label: string, issuer = BRAND_NAME): { base32: string; otpauthUrl: string } {
    const { base32 } = speakeasy.generateSecret({ length: 20 });
    return { base32, otpauthUrl: buildOtpauthUrl(base32, label, issuer) };
  }

  /** Lo que se guarda en users.totpSecret: el secreto cifrado con ENCRYPTION_KEK. */
  sealSecret(secretBase32: string): string {
    return sealTotpSecret(secretBase32, process.env.ENCRYPTION_KEK);
  }

  // ── API síncrona antigua ────────────────────────────────────────────

  /**
   * 2FA "si la tiene activada": quien activó la app de verificación tiene que
   * poner el código; quien no, sigue como antes. `storedSecret` es lo que hay
   * en users.totpSecret (cifrado o antiguo en claro).
   */
  assertIfEnrolled(storedSecret: string | null | undefined, code: string | undefined): void {
    if (!storedSecret) return;
    if (!code) throw new ForbiddenException(TOTP_MESSAGES.required);
    const error = this.checkInMemory(storedSecret, code);
    if (error) throw error;
  }

  /** true si el código vale (y lo da por usado). */
  verify(storedSecret: string, code: string): boolean {
    if (!storedSecret) return false;
    return this.checkInMemory(storedSecret, code) === null;
  }

  // ── API por usuario (Redis) ─────────────────────────────────────────

  async isEnabled(userId: string): Promise<boolean> {
    return (await this.loadStoredSecret(userId)) !== null;
  }

  /** Como assertIfEnrolled, pero buscando al usuario y con el límite en Redis. */
  async assertIfEnrolledForUser(userId: string, code: string | undefined): Promise<void> {
    const stored = await this.loadStoredSecret(userId);
    if (stored) await this.checkStoredForUser(userId, stored, code);
  }

  /** Exige la 2FA activada y un código bueno (p. ej. reembolsos de 100 € o más). */
  async assertForUser(userId: string, code: string | undefined): Promise<void> {
    const stored = await this.loadStoredSecret(userId);
    if (!stored) throw new ForbiddenException(TOTP_MESSAGES.notEnrolled);
    await this.checkStoredForUser(userId, stored, code);
  }

  /** Código contra lo guardado en users.totpSecret; re-cifra si estaba en claro. */
  async checkStoredForUser(userId: string, stored: string, code: string | undefined): Promise<void> {
    const opened = this.tryOpen(stored);
    if (!opened) throw new ForbiddenException(TOTP_MESSAGES.unreadable);
    await this.checkCodeForUser(userId, opened.secret, code);
    if (opened.legacy) await this.reencrypt(stored, opened.secret, userId);
  }

  /** Código contra un secreto en claro (p. ej. el pendiente de activar). */
  async checkCodeForUser(userId: string, secretBase32: string, code: string | undefined): Promise<void> {
    if (!code) throw new ForbiddenException(TOTP_MESSAGES.required);
    await this.attempts.assertNotLocked(userId);
    const step = matchTotpStep(secretBase32, code);
    if (step === null) return this.failForUser(userId, TOTP_MESSAGES.invalid);
    if (!(await this.attempts.claimStep(userId, step))) return this.failForUser(userId, TOTP_MESSAGES.reused);
    await this.attempts.clearFailures(userId);
  }

  /** Al desactivar la 2FA: el próximo secreto empieza sin pasos usados. */
  async forgetUsedCodes(userId: string): Promise<void> {
    await this.attempts.forgetSteps(userId);
  }

  // ── internos ────────────────────────────────────────────────────────

  /** null si vale; si no, el error a lanzar. */
  private checkInMemory(stored: string, code: string): HttpException | null {
    const opened = this.tryOpen(stored);
    if (!opened) return new ForbiddenException(TOTP_MESSAGES.unreadable);
    const key = guardKey(opened.secret);
    const lockedFor = this.memoryGuard.lockedFor(key);
    if (lockedFor > 0) return totpLockedError(lockedFor);

    const step = matchTotpStep(opened.secret, code);
    if (step === null) return this.memoryFailure(key, TOTP_MESSAGES.invalid);
    if (!this.memoryGuard.claimStep(key, step)) return this.memoryFailure(key, TOTP_MESSAGES.reused);
    this.memoryGuard.clearFailures(key);
    if (opened.legacy) void this.reencrypt(stored, opened.secret);
    return null;
  }

  private memoryFailure(key: string, message: string): HttpException {
    const locked = this.memoryGuard.recordFailure(key);
    return locked ? totpLockedError(TOTP_LOCK_POLICY.lockSec) : new ForbiddenException(message);
  }

  private async failForUser(userId: string, message: string): Promise<never> {
    const locked = await this.attempts.recordFailure(userId);
    throw locked ? totpLockedError(TOTP_LOCK_POLICY.lockSec) : new ForbiddenException(message);
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
  private async reencrypt(stored: string, secretBase32: string, userId?: string): Promise<void> {
    try {
      const sealed = this.sealSecret(secretBase32);
      const where = userId ? { id: userId, totpSecret: stored } : { totpSecret: stored };
      const { count } = await this.prisma.acrossVenues((tx) =>
        tx.user.updateMany({ where, data: { totpSecret: sealed } }),
      );
      if (count > 0) this.logger.log(`Secreto 2FA antiguo guardado ya cifrado (${count})`);
    } catch (err) {
      this.logger.error(`No se pudo cifrar un secreto 2FA antiguo: ${(err as Error).message}`);
    }
  }
}

/** Huella del secreto para el límite en memoria (no se guarda el secreto). */
function guardKey(secretBase32: string): string {
  return createHash('sha256').update(`totp-guard:${secretBase32}`).digest('hex').slice(0, 32);
}
