import type { Role } from '@nightpay/contracts';
import { totpForbidden } from '../auth/totp-code';
import type { TotpService } from '../auth/totp.service';

/** El de la base (venues.refundApprovalThresholdCents, @default(10000)), si no llega. */
const DEFAULT_THRESHOLD_CENTS = 100_00;

/** El local puede pedir aprobación antes; el efectivo nunca supera 100 € sin ella. */
export function cashApprovalThreshold(thresholdCents: number | null | undefined): number {
  return Math.max(0, Math.min(DEFAULT_THRESHOLD_CENTS, thresholdCents ?? DEFAULT_THRESHOLD_CENTS));
}

/**
 * El encargado saca dinero del saldo sin el dueño: anular un consumo (vuelve
 * al saldo del cliente) o devolver el saldo en efectivo. Desde el umbral de
 * «Por aprobar» del local (el mismo de las devoluciones, incluido) pone su
 * código 2FA. No va a «Por aprobar»: el efectivo se da en el momento, con el
 * cliente delante, y el dueño no está para darlo. El dueño, como siempre.
 */
export function managerNeedsTwoFactor(
  role: Role,
  amountCents: number,
  thresholdCents: number | null | undefined,
): boolean {
  return role === 'MANAGER' && amountCents >= (thresholdCents ?? DEFAULT_THRESHOLD_CENTS);
}

/**
 * Si hace falta (managerNeedsTwoFactor), exige la 2FA activada y un código
 * bueno (TotpService.assertForUser: intentos y códigos usados en Redis).
 * `what` = lo que se hace, para el mensaje («Devolver 120,00 € en efectivo»).
 * Devuelve si se pidió el código.
 */
export async function assertManagerTwoFactor(
  totp: Pick<TotpService, 'assertForUser' | 'isEnabled'>,
  actor: { userId: string; role: Role },
  amountCents: number,
  thresholdCents: number | null | undefined,
  totpCode: string | undefined,
  what: string,
): Promise<boolean> {
  if (!managerNeedsTwoFactor(actor.role, amountCents, thresholdCents)) return false;
  const from = eur(thresholdCents ?? DEFAULT_THRESHOLD_CENTS);
  if (!totpCode) {
    if (!(await totp.isEnabled(actor.userId))) {
      throw totpForbidden(
        'notEnrolled',
        `${what}: desde ${from} hace falta la app de verificación (2FA) y no la tienes activada. Actívala en Ajustes o que lo haga el dueño.`,
      );
    }
    throw totpForbidden('required', `${what}: desde ${from} pon el código de tu app de verificación (2FA).`);
  }
  await totp.assertForUser(actor.userId, totpCode);
  return true;
}

export function eur(cents: number): string {
  return `${(cents / 100).toFixed(2).replace('.', ',')} €`;
}
