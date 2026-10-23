// Ajustes → Noche: el formulario (texto tal cual se teclea) → lo que se manda
// al API, con los mismos topes que el API. Sin React: se prueba solo
// (night-form.test.ts).

import {
  MAX_NFC_NO_PIN_CENTS,
  MAX_NFC_NO_PIN_NIGHT_CAP_CENTS,
  MAX_RECEPTION_PAYOUT_NIGHT_CAP_CENTS,
  MAX_RECEPTION_QUICK_AMOUNTS,
  nightSettingsProblem,
  parseEuroCents,
  type PinKeypadLayout,
  type ReceptionDefaultMethod,
  type UpdateNightSettingsDto,
  type VenueNightSettings,
} from '@nightpay/contracts';

export interface NightForm {
  noPinMaxEur: string;
  noPinNightCapEur: string;
  pinKeypad: PinKeypadLayout;
  quickAmountsEur: string;
  receptionDefaultMethod: ReceptionDefaultMethod;
  feedbackVibration: boolean;
  feedbackSound: boolean;
  /** Tope de efectivo devuelto por persona de recepción y noche (€). */
  payoutNightCapEur: string;
  /** Modo «sala»: las apps del personal en contraste alto. */
  highContrast: boolean;
}

/** «20», «12,50»: los euros como se teclean (sin decimales si son enteros). */
export function eurosText(cents: number): string {
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2).replace('.', ',');
}

export const quickAmountsText = (cents: readonly number[]): string => cents.map(eurosText).join(', ');

export function nightFormFrom(s: VenueNightSettings): NightForm {
  return {
    noPinMaxEur: eurosText(s.nfcNoPinMaxCents),
    noPinNightCapEur: eurosText(s.nfcNoPinNightCapCents),
    pinKeypad: s.pinKeypad,
    quickAmountsEur: quickAmountsText(s.receptionQuickAmountsCents),
    receptionDefaultMethod: s.receptionDefaultMethod,
    feedbackVibration: s.feedbackVibration,
    feedbackSound: s.feedbackSound,
    payoutNightCapEur: eurosText(s.receptionPayoutNightCapCents),
    highContrast: s.highContrast,
  };
}

/** Euros de 0 (incluido) hasta `maxCents`; null si no vale. */
function parseEurosUpTo(input: string, maxCents: number): number | null {
  if (/^\s*0+(?:[.,]0{1,2})?\s*€?\s*$/.test(input)) return 0;
  return parseEuroCents(input, maxCents);
}

/** «20, 50, 100» → [2000, 5000, 10000]: de 1 a 4 importes enteros de 1 a 999 €; null si algo no vale. */
export function parseQuickAmounts(input: string): number[] | null {
  const parts = input.split(/[,;\s€]+/).filter(Boolean);
  if (parts.length === 0 || parts.length > MAX_RECEPTION_QUICK_AMOUNTS) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n < 1) return null;
    out.push(n * 100);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/** Lo que cambia (solo lo distinto de lo guardado) o el motivo para no mandarlo. */
export function nightChange(
  form: NightForm,
  current: VenueNightSettings,
): { ok: true; change: UpdateNightSettingsDto } | { ok: false; problem: string } {
  const max = parseEurosUpTo(form.noPinMaxEur, MAX_NFC_NO_PIN_CENTS);
  if (max === null) return { ok: false, problem: `Sin PIN hasta: de 0 € (siempre con PIN) a ${MAX_NFC_NO_PIN_CENTS / 100} €.` };
  const cap = parseEurosUpTo(form.noPinNightCapEur, MAX_NFC_NO_PIN_NIGHT_CAP_CENTS);
  if (cap === null) return { ok: false, problem: `Tope sin PIN por noche: de 0 € a ${MAX_NFC_NO_PIN_NIGHT_CAP_CENTS / 100} €.` };
  const payoutCap = parseEurosUpTo(form.payoutNightCapEur, MAX_RECEPTION_PAYOUT_NIGHT_CAP_CENTS);
  if (payoutCap === null) {
    return { ok: false, problem: `Tope de salidas en efectivo por noche: de 0 € (siempre el encargado) a ${MAX_RECEPTION_PAYOUT_NIGHT_CAP_CENTS / 100} €.` };
  }
  const quick = parseQuickAmounts(form.quickAmountsEur);
  if (!quick) {
    return { ok: false, problem: `Importes rápidos: de 1 a ${MAX_RECEPTION_QUICK_AMOUNTS} importes en euros enteros (p. ej. 20, 50, 100).` };
  }
  const next: VenueNightSettings = {
    nfcNoPinMaxCents: max,
    nfcNoPinNightCapCents: cap,
    pinKeypad: form.pinKeypad,
    receptionQuickAmountsCents: quick,
    receptionDefaultMethod: form.receptionDefaultMethod,
    feedbackVibration: form.feedbackVibration,
    feedbackSound: form.feedbackSound,
    receptionPayoutNightCapCents: payoutCap,
    highContrast: form.highContrast,
  };
  const problem = nightSettingsProblem(next);
  if (problem) return { ok: false, problem };
  const change: UpdateNightSettingsDto = {};
  if (max !== current.nfcNoPinMaxCents) change.nfcNoPinMaxCents = max;
  if (cap !== current.nfcNoPinNightCapCents) change.nfcNoPinNightCapCents = cap;
  if (next.pinKeypad !== current.pinKeypad) change.pinKeypad = next.pinKeypad;
  if (quick.join(',') !== current.receptionQuickAmountsCents.join(',')) change.receptionQuickAmountsCents = quick;
  if (next.receptionDefaultMethod !== current.receptionDefaultMethod) change.receptionDefaultMethod = next.receptionDefaultMethod;
  if (next.feedbackVibration !== current.feedbackVibration) change.feedbackVibration = next.feedbackVibration;
  if (next.feedbackSound !== current.feedbackSound) change.feedbackSound = next.feedbackSound;
  if (payoutCap !== current.receptionPayoutNightCapCents) change.receptionPayoutNightCapCents = payoutCap;
  if (next.highContrast !== current.highContrast) change.highContrast = next.highContrast;
  return { ok: true, change };
}

/** La línea de ayuda del NFC sin PIN, con lo guardado («Hasta 20 € por cobro y 100 € por noche»). */
export function noPinSummary(s: Pick<VenueNightSettings, 'nfcNoPinMaxCents' | 'nfcNoPinNightCapCents'>): string {
  if (s.nfcNoPinMaxCents <= 0 || s.nfcNoPinNightCapCents <= 0) return 'Ahora: siempre con PIN.';
  return `Ahora: sin PIN hasta ${eurosText(s.nfcNoPinMaxCents)} € por cobro y ${eurosText(s.nfcNoPinNightCapCents)} € por noche.`;
}
