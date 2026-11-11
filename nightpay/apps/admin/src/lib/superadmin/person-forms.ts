// Formularios de personas y cuentas de cobro de la consola: lo tecleado → lo
// que se manda al API, con el error en llano.

import type { CreateStaffUserDto, PayoutMethod, Role } from '@nightpay/contracts';
import { parsePercentToBps } from '../commission';
import { payoutAddressError, type PayoutValue } from '../payout-address';
import type { FormResult } from './forms';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ─── Persona nueva ──────────────────────────────────────────────────

export interface NewPersonForm {
  venueId: string;
  role: Role | '';
  email: string;
  displayName: string;
  /** Solo chicas: su % propio del servicio (vacío = el del local). */
  commissionPct: string;
}

export const EMPTY_PERSON_FORM: NewPersonForm = { venueId: '', role: '', email: '', displayName: '', commissionPct: '' };

export type NewPersonDto = Omit<CreateStaffUserDto, 'totpCode'>;

export function newPersonPayload(form: NewPersonForm): FormResult<NewPersonDto> {
  if (!form.venueId) return { ok: false, error: 'Elige el local.' };
  if (!form.role) return { ok: false, error: 'Elige qué es: dueño, encargado, camarero o compañera.' };
  const email = form.email.trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) return { ok: false, error: 'El email no es válido.' };
  const displayName = form.displayName.trim();
  if (displayName.length > 80) return { ok: false, error: 'El nombre, como mucho 80 letras.' };
  const isChica = form.role === 'OPERATOR';
  if (isChica && !displayName) return { ok: false, error: 'Pon el nombre con el que se verá a la compañera.' };
  let commissionBps: number | undefined;
  if (isChica && form.commissionPct.trim()) {
    const bps = parsePercentToBps(form.commissionPct);
    if (bps === null) return { ok: false, error: 'Su comisión: un porcentaje de 0 a 100 (por ejemplo 90).' };
    commissionBps = bps;
  }
  return {
    ok: true,
    value: {
      venueId: form.venueId,
      role: form.role,
      email,
      ...(displayName ? { displayName } : {}),
      ...(commissionBps !== undefined ? { commissionBps } : {}),
    },
  };
}

// ─── Cuenta de cobro de una chica ───────────────────────────────────

export interface PayoutUpdateDto {
  payoutMethod: PayoutMethod | null;
  payoutAddress: string | null;
  payoutLabel: string | null;
  payoutMetadata: PayoutValue['metadata'];
}

/**
 * Valor del formulario de cobro (PayoutMethodForm, ya limpio) → cuerpo del
 * PUT. Sin método = quitar la cuenta. El API pide método y cuenta juntos:
 * «efectivo» no tiene cuenta que guardar.
 */
export function payoutUpdatePayload(value: PayoutValue | null): FormResult<PayoutUpdateDto> {
  if (!value || value.method === null) {
    return { ok: true, value: { payoutMethod: null, payoutAddress: null, payoutLabel: null, payoutMetadata: null } };
  }
  if (value.method === 'MANUAL_CASH') {
    return {
      ok: false,
      error: 'En efectivo no hay cuenta que guardar. Para quitarle la cuenta elige «— No configurado —».',
    };
  }
  const address = value.address ?? '';
  const problem = payoutAddressError(value.method, address);
  if (problem) return { ok: false, error: problem };
  return {
    ok: true,
    value: {
      payoutMethod: value.method,
      payoutAddress: address,
      payoutLabel: value.label,
      payoutMetadata: value.metadata,
    },
  };
}

/** Cuánto queda (s) de una cuenta enseñada entera; 0 = se vuelve a tapar. */
export const REVEAL_SECONDS = 30;

export function revealSecondsLeft(until: number, now: number): number {
  return Math.max(0, Math.ceil((until - now) / 1000));
}
