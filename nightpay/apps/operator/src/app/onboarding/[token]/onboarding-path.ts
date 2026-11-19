import { BirthDateSchema, LegalNameSchema, holderMatchesName, type SelfOnboardingSubmitDto } from '@nightpay/contracts';
import type { SavedPayout } from '../../../lib/payout-address';
import { EMPTY_PAYOUT, payoutDto, payoutProblem, type PayoutDto, type PayoutValues } from './onboarding-payout';

/**
 * Alta con tres caminos (19-nov-2026): su nombre legal y su fecha de
 * nacimiento, y cómo cobra: su IBAN (a su nombre), la OxioCard, abrir una
 * cuenta de pago básica (la guía) u otra forma. Lógica pura
 * (onboarding-path.test.ts).
 */

export type PayoutPath = 'IBAN' | 'OXIOCARD' | 'BASICA' | 'OTRA' | 'NADA';

export interface IdentityValues {
  legalName: string;
  birthDate: string;
}

/** Lo que falta o no vale. Lo ya guardado se puede dejar en blanco (no se cambia). */
export function identityProblems(
  v: IdentityValues,
  saved: { legalNameMasked?: string | null; hasBirthDate?: boolean },
): Partial<Record<keyof IdentityValues, string>> {
  const problems: Partial<Record<keyof IdentityValues, string>> = {};
  const name = v.legalName.trim();
  if (name) {
    const parsed = LegalNameSchema.safeParse(name);
    if (!parsed.success) problems.legalName = parsed.error.issues[0]?.message;
  } else if (!saved.legalNameMasked) {
    problems.legalName = 'Pon tu nombre y apellidos como en tu documento';
  }
  if (v.birthDate) {
    const parsed = BirthDateSchema.safeParse(v.birthDate);
    if (!parsed.success) problems.birthDate = parsed.error.issues[0]?.message;
  } else if (!saved.hasBirthDate) {
    problems.birthDate = 'Pon tu fecha de nacimiento';
  }
  return problems;
}

export function identityDto(v: IdentityValues): Pick<SelfOnboardingSubmitDto, 'legalName' | 'birthDate'> {
  const name = v.legalName.trim();
  return { ...(name ? { legalName: name } : {}), ...(v.birthDate ? { birthDate: v.birthDate } : {}) };
}

/** Los caminos que se ofrecen: su cuenta solo si el enlace deja ponerla; la OxioCard, encendida y sin pedir. */
export function payoutPaths(p: { canSetPayout: boolean; oxiocardEnabled?: boolean; oxiocardStatus?: string }): PayoutPath[] {
  const oxiocard = p.oxiocardEnabled === true && (p.oxiocardStatus ?? 'NO_SOLICITADA') === 'NO_SOLICITADA';
  return [
    ...(p.canSetPayout ? (['IBAN'] as const) : []),
    ...(oxiocard ? (['OXIOCARD'] as const) : []),
    'BASICA',
    ...(p.canSetPayout ? (['OTRA'] as const) : []),
    'NADA',
  ];
}

/** Al elegir camino: su IBAN, con el método ya puesto; los demás, en blanco. */
export function pathPayout(path: PayoutPath): PayoutValues {
  return path === 'IBAN' ? { ...EMPTY_PAYOUT, method: 'SEPA_IBAN' } : EMPTY_PAYOUT;
}

/** Lo primero que impide guardar (solo su cuenta o «otra forma» llevan datos). */
export function pathProblem(path: PayoutPath, payout: PayoutValues, saved: SavedPayout): string | null {
  return path === 'IBAN' || path === 'OTRA' ? payoutProblem(payout, saved) : null;
}

/** Lo que se manda: la cuenta, la petición de la OxioCard o nada. */
export function pathDto(path: PayoutPath, payout: PayoutValues): PayoutDto | { oxiocard: true } | Record<string, never> {
  if (path === 'OXIOCARD') return { oxiocard: true };
  if ((path === 'IBAN' || path === 'OTRA') && payout.method) return payoutDto(payout);
  return {};
}

/** El titular no coincide con el nombre legal que acaba de poner: se le avisa (no la bloquea). */
export function holderWarning(legalName: string, holder: string): string | null {
  if (!legalName.trim() || !holder.trim() || holderMatchesName(holder, legalName)) return null;
  return 'El titular no coincide con tu nombre legal: la cuenta tiene que ser tuya. Si lo es, el dueño tendrá que confirmarlo antes de pagarte.';
}
