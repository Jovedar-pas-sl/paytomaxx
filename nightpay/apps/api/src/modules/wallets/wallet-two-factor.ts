import type { Role } from '@nightpay/contracts';
import { totpForbidden } from '../auth/totp-code';
import type { TotpService } from '../auth/totp.service';

/** El de la base (venues.refundApprovalThresholdCents, @default(10000)), si no llega. */
const DEFAULT_THRESHOLD_CENTS = 100_00;

/**
 * El local puede pedir aprobación antes; el efectivo nunca pasa de 100 € sin
 * ella. «Más de 100 €» es más de 100,00 € (100,00 € justos, sin 2FA): lo mismo
 * en la salida de recepción y en la 2FA del encargado.
 */
export function cashApprovalThreshold(thresholdCents: number | null | undefined): number {
  return Math.max(0, Math.min(DEFAULT_THRESHOLD_CENTS, thresholdCents ?? DEFAULT_THRESHOLD_CENTS));
}

/**
 * El encargado saca dinero del saldo sin el dueño: anular un consumo (vuelve
 * al saldo del cliente) o devolver el saldo en efectivo. Por encima del
 * umbral de «Por aprobar» del local (más de ese importe, como la salida de
 * recepción) pone su código 2FA. No va a «Por aprobar»: el efectivo se da en
 * el momento, con el cliente delante, y el dueño no está para darlo. El
 * dueño, como siempre. Umbral 0: siempre.
 */
export function managerNeedsTwoFactor(
  role: Role,
  amountCents: number,
  thresholdCents: number | null | undefined,
): boolean {
  return role === 'MANAGER' && amountCents > (thresholdCents ?? DEFAULT_THRESHOLD_CENTS);
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
  await assertTwoFactorCode(totp, actor.userId, totpCode, `${what}: con más de ${eur(thresholdCents ?? DEFAULT_THRESHOLD_CENTS)}`);
  return true;
}

/**
 * El código 2FA de esta persona, haga falta por lo que haga falta (`why`:
 * «Devolver 120,00 € en efectivo: con más de 100,00 €»). Sin código, el 403
 * que pide ponerlo (o activarla); con él, TotpService lo comprueba.
 */
export async function assertTwoFactorCode(
  totp: Pick<TotpService, 'assertForUser' | 'isEnabled'>,
  userId: string,
  totpCode: string | undefined,
  why: string,
): Promise<void> {
  if (!totpCode) {
    if (!(await totp.isEnabled(userId))) {
      throw totpForbidden(
        'notEnrolled',
        `${why} hace falta la app de verificación (2FA) y no la tienes activada. Actívala en Ajustes o que lo haga el dueño.`,
      );
    }
    throw totpForbidden('required', `${why} pon el código de tu app de verificación (2FA).`);
  }
  await totp.assertForUser(userId, totpCode);
}

export function eur(cents: number): string {
  return `${(cents / 100).toFixed(2).replace('.', ',')} €`;
}
