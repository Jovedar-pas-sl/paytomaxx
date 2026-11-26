import { HttpException } from '@nestjs/common';
import { PASSKEY_REQUIRED_CODE, type Role } from '@nightpay/contracts';
import { totpForbidden } from '../auth/totp-code';
import type { TotpService } from '../auth/totp.service';
import { eur } from '../../common/money/eur';

/**
 * Lo que se usa de la 2FA. La llave de acceso (passkeyProofFor,
 * missingSecondFactor) es opcional: sin ella, como antes (solo la 2FA).
 */
export type TwoFactorDeps = Pick<TotpService, 'assertForUser' | 'isEnabled'> &
  Partial<Pick<TotpService, 'passkeyProofFor' | 'missingSecondFactor'>>;

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
 * El encargado devuelve el saldo en efectivo sin el dueño. Por encima del
 * umbral de «Por aprobar» del local (más de ese importe, como la salida de
 * recepción) pone su código 2FA. No va a «Por aprobar»: el efectivo se da en
 * el momento, con el cliente delante, y el dueño no está para darlo. El
 * dueño, como siempre. Umbral 0: siempre. Anular un cobro con saldo pide el
 * código a los dos, siempre (WalletsService.reverseConsumption).
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
  totp: TwoFactorDeps,
  actor: { userId: string; role: Role },
  amountCents: number,
  thresholdCents: number | null | undefined,
  totpCode: string | undefined,
  what: string,
  action?: string,
): Promise<boolean> {
  if (!managerNeedsTwoFactor(actor.role, amountCents, thresholdCents)) return false;
  await assertTwoFactorCode(totp, actor.userId, totpCode, `${what}: con más de ${eur(thresholdCents ?? DEFAULT_THRESHOLD_CENTS)}`, action);
  return true;
}

/**
 * El código 2FA de esta persona, haga falta por lo que haga falta (`why`:
 * «Devolver 120,00 € en efectivo: con más de 100,00 €»). Sin código, el 403
 * que pide ponerlo (o activarla); con él, TotpService lo comprueba. Con
 * `action` (stepUpActions), quien no tiene 2FA puede hacerlo con la prueba de
 * su llave de acceso para esa acción (si tiene llave y no la trae, 403
 * PASSKEY_REQUIRED con la acción).
 */
export async function assertTwoFactorCode(
  totp: TwoFactorDeps,
  userId: string,
  totpCode: string | undefined,
  why: string,
  action?: string,
): Promise<void> {
  if (!totpCode) {
    if (!(await totp.isEnabled(userId))) {
      if (await passkeyInstead(totp, userId, action, why)) return;
      throw totpForbidden(
        'notEnrolled',
        `${why} hace falta la app de verificación (2FA) y no la tienes activada. Actívala en Ajustes o que lo haga el dueño.`,
      );
    }
    throw totpForbidden('required', `${why} pon el código de tu app de verificación (2FA).`);
  }
  await totp.assertForUser(userId, totpCode, action);
}

/**
 * Sin 2FA: la prueba de su llave para esta acción vale (true, y se gasta);
 * con llave y sin la prueba, 403 PASSKEY_REQUIRED; sin llave (o sin acción),
 * false: quien llama da su error de siempre.
 */
export async function passkeyInstead(totp: TwoFactorDeps, userId: string, action: string | undefined, why: string): Promise<boolean> {
  if (!action) return false;
  if (await totp.passkeyProofFor?.(userId, action)) return true;
  const err = await totp.missingSecondFactor?.(userId, action, `${why} confirma con tu llave de acceso (Face ID o huella) y repítelo.`);
  if (err && codeOf(err) === PASSKEY_REQUIRED_CODE) throw err;
  return false;
}

function codeOf(err: HttpException): string | null {
  const body = err.getResponse();
  return body && typeof body === 'object' && 'code' in body ? String((body as { code: unknown }).code) : null;
}
