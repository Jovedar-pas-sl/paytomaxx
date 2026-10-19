// Qué pide cada acción de la consola (código 2FA y motivo), como el API
// (docs/SUPERADMIN.md), y qué decir cuando falla.

import { VENUE_PROFILE_STEP_UP_FIELDS } from '@nightpay/contracts';
import { ApiError, totpLockedUntil } from '../api-errors';

export type SaAction =
  | 'business.create'
  | 'business.createMoney'
  | 'business.update'
  | 'business.updateMoney'
  | 'business.pause'
  | 'business.resume'
  | 'business.assignVenues'
  | 'business.unassignVenue'
  | 'venue.create'
  | 'venue.createMoney'
  | 'venue.profile'
  | 'venue.profileMoney'
  | 'venue.rules'
  | 'venue.setIban'
  | 'venue.clearIban'
  | 'venue.pause'
  | 'venue.resume'
  | 'user.create'
  | 'user.resetPassword'
  | 'user.disable'
  | 'user.enable'
  | 'user.revokeSessions'
  | 'user.resetTotp'
  | 'user.superAdmin'
  | 'payout.reveal'
  | 'payout.update'
  | 'wallet.block'
  | 'wallet.unblock'
  | 'wallet.unlockPin'
  | 'wallet.relink';

export type ReasonRule = 'required' | 'optional' | 'none';

export interface StepUpRule {
  /** Pide el código 2FA del propio super-admin. */
  totp: boolean;
  reason: ReasonRule;
}

const rule = (totp: boolean, reason: ReasonRule): StepUpRule => ({ totp, reason });

/** Lo que pide el API en cada acción (tabla de docs/SUPERADMIN.md). */
export const SA_ACTION_RULES: Readonly<Record<SaAction, StepUpRule>> = {
  'business.create': rule(false, 'none'),
  // Alta o cambio con comisión por defecto propia (sus locales nuevos la heredan).
  'business.createMoney': rule(true, 'none'),
  'business.update': rule(false, 'none'),
  'business.updateMoney': rule(true, 'none'),
  'business.pause': rule(true, 'required'),
  'business.resume': rule(true, 'optional'),
  // Meter o sacar un local de un negocio en pausa le deja volver a cobrar.
  'business.assignVenues': rule(true, 'none'),
  'business.unassignVenue': rule(true, 'none'),
  'venue.create': rule(false, 'none'),
  // Alta con grupo del saldo o comisión propia.
  'venue.createMoney': rule(true, 'none'),
  'venue.profile': rule(false, 'none'),
  // Perfil tocando el grupo del saldo o el IVA.
  'venue.profileMoney': rule(true, 'none'),
  'venue.rules': rule(true, 'none'),
  'venue.setIban': rule(true, 'none'),
  'venue.clearIban': rule(true, 'required'),
  'venue.pause': rule(true, 'required'),
  'venue.resume': rule(true, 'optional'),
  'user.create': rule(true, 'none'),
  'user.resetPassword': rule(true, 'required'),
  'user.disable': rule(true, 'required'),
  'user.enable': rule(true, 'required'),
  'user.revokeSessions': rule(false, 'required'),
  'user.resetTotp': rule(true, 'required'),
  'user.superAdmin': rule(true, 'required'),
  'payout.reveal': rule(true, 'required'),
  'payout.update': rule(true, 'required'),
  'wallet.block': rule(false, 'required'),
  'wallet.unblock': rule(true, 'required'),
  'wallet.unlockPin': rule(true, 'required'),
  'wallet.relink': rule(true, 'required'),
};

export function needsTotp(action: SaAction): boolean {
  return SA_ACTION_RULES[action].totp;
}

/** El perfil del local pide 2FA solo si cambia el grupo del saldo o el IVA. */
export function profileNeedsTotp(changes: Readonly<Record<string, unknown>>): boolean {
  return VENUE_PROFILE_STEP_UP_FIELDS.some((field) => changes[field] !== undefined);
}

export const REASON_MIN = 3;
export const REASON_MAX = 500;

/** Por qué el motivo no vale; null si vale (o si no hace falta y está vacío). */
export function reasonProblem(reason: string, rule: ReasonRule): string | null {
  const text = reason.trim();
  if (rule === 'none') return null;
  if (!text) return rule === 'required' ? 'Pon el motivo: queda en el registro.' : null;
  if (text.length < REASON_MIN) return `El motivo, con al menos ${REASON_MIN} letras.`;
  if (text.length > REASON_MAX) return `El motivo, como mucho ${REASON_MAX} letras.`;
  return null;
}

/** Lo que se hace tras un fallo de una acción con 2FA. */
export interface SaFailure {
  message: string;
  /** 429 TOTP_LOCKED: no se puede probar otro código hasta este instante (epoch ms). */
  lockedUntil: number | null;
  /** El super-admin no tiene la 2FA activada: mandarle a Ajustes. */
  notEnrolled: boolean;
  /** Borrar el código puesto (malo, ya usado, o gastado por la acción que falló). */
  clearCode: boolean;
}

export const NOT_ENROLLED_MESSAGE =
  'Para esto necesitas la verificación en dos pasos (2FA). Actívala antes en Ajustes → Verificación en dos pasos.';
const REQUIRED_MESSAGE = 'Pon el código de 6 cifras de tu app de verificación.';
const CODE_HINT = 'cambia cada 30 s';
const CODE_HINT_SENTENCE = 'Si acabas de usar ese código, espera al siguiente (cambia cada 30 s).';

/** Error del API (o de la red) → qué enseñar y qué hacer con el código 2FA. */
export function describeSaFailure(err: unknown, now: number): SaFailure {
  const message = err instanceof Error && err.message ? err.message : 'No se pudo hacer. Vuelve a probar.';
  const base: SaFailure = { message, lockedUntil: null, notEnrolled: false, clearCode: true };
  if (!(err instanceof ApiError)) return base;

  const lockedUntil = totpLockedUntil(err, now);
  if (lockedUntil !== null) return { ...base, lockedUntil };

  switch (err.code) {
    case 'TOTP_NOT_ENROLLED':
      return { ...base, message: NOT_ENROLLED_MESSAGE, notEnrolled: true };
    case 'TOTP_REQUIRED':
      return { ...base, message: REQUIRED_MESSAGE };
    case 'TOTP_INVALID':
      return {
        ...base,
        message: message.includes(CODE_HINT) ? message : `${message.replace(/\.$/, '')}. ${CODE_HINT_SENTENCE}`,
      };
    default:
      // 423 VENUE_PAUSED, 409 (p. ej. el último super-admin)… el API ya lo explica.
      return base;
  }
}

/** El fallo es de la 2FA (el formulario sigue abierto para otro código). */
export function isTotpFailure(err: unknown): boolean {
  return err instanceof ApiError && typeof err.code === 'string' && err.code.startsWith('TOTP_');
}
