import { ForbiddenException, HttpException, Inject, Injectable } from '@nestjs/common';
import { TOTP_MESSAGES } from '../auth/totp-code';
import { TotpService } from '../auth/totp.service';
import { SuperAdminAuditService } from './superadmin-audit.service';
import type { SuperAdminActor } from './superadmin.guard';

/** Códigos de error 2FA (los mismos que pone TotpService en fix/f2-api-pendientes). */
export const STEP_UP_CODES = {
  required: 'TOTP_REQUIRED',
  invalid: 'TOTP_INVALID',
  notEnrolled: 'TOTP_NOT_ENROLLED',
  unreadable: 'TOTP_UNREADABLE',
  locked: 'TOTP_LOCKED',
} as const;

/**
 * Error 2FA con su `code`. Si ya lo trae (TotpService nuevo), tal cual; si no
 * (TotpService de la base, solo con el texto), se le pone por el texto o el
 * estado: 429 → TOTP_LOCKED; "Activa antes…" → TOTP_NOT_ENROLLED; etc.
 */
export function withStepUpCode(err: unknown): unknown {
  if (!(err instanceof HttpException)) return err;
  const body = err.getResponse();
  if (body && typeof body === 'object' && 'code' in body) return err;
  const message = typeof body === 'string' ? body : ((body as { message?: unknown }).message as string | undefined) ?? err.message;
  const status = err.getStatus();
  const code =
    status === 429
      ? STEP_UP_CODES.locked
      : message === TOTP_MESSAGES.notEnrolled
        ? STEP_UP_CODES.notEnrolled
        : message === TOTP_MESSAGES.required
          ? STEP_UP_CODES.required
          : message === TOTP_MESSAGES.unreadable
            ? STEP_UP_CODES.unreadable
            : STEP_UP_CODES.invalid;
  const rest = typeof body === 'object' && body !== null ? body : {};
  return new HttpException({ ...rest, message, code }, status);
}

/**
 * Step-up de la consola: las escrituras que mueven dinero o identidades piden
 * el código 2FA del propio super-admin, aunque tenga la sesión abierta. Sin
 * 2FA activada no se puede (403 TOTP_NOT_ENROLLED). Usa la API por usuario
 * (Redis: intentos y códigos usados valen con varias réplicas). Un intento
 * fallido queda en el registro.
 */
@Injectable()
export class SuperAdminStepUpService {
  private readonly totp: TotpService;
  private readonly audit: SuperAdminAuditService;

  constructor(@Inject(TotpService) totp: TotpService, @Inject(SuperAdminAuditService) audit: SuperAdminAuditService) {
    this.totp = totp;
    this.audit = audit;
  }

  async verify(actor: SuperAdminActor, totpCode: string | undefined, action: string): Promise<void> {
    try {
      if (!totpCode) {
        // Sin código: antes que nada, ¿tiene 2FA? (el panel enseña "actívala" o "pon el código").
        const enrolled = await this.totp.isEnabled(actor.id);
        throw new ForbiddenException({
          message: enrolled ? TOTP_MESSAGES.required : TOTP_MESSAGES.notEnrolled,
          code: enrolled ? STEP_UP_CODES.required : STEP_UP_CODES.notEnrolled,
        });
      }
      await this.totp.assertForUser(actor.id, totpCode);
    } catch (err) {
      const coded = withStepUpCode(err);
      await this.audit.write(actor, {
        action: 'step_up.failed',
        targetType: 'User',
        targetId: actor.id,
        extra: { attempted: action, code: codeOf(coded) },
      });
      throw coded;
    }
  }
}

function codeOf(err: unknown): string | null {
  if (!(err instanceof HttpException)) return null;
  const body = err.getResponse();
  return body && typeof body === 'object' && 'code' in body ? String((body as { code: unknown }).code) : null;
}
