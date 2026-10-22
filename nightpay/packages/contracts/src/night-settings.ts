import { z } from 'zod';
import { MAX_CASH_TOP_UP_CENTS } from './reception';

/**
 * Ajustes de la noche del local («Noche fácil», panel → Ajustes → Noche): el
 * NFC sin PIN, el teclado del PIN, la recepción y los avisos al cobrar. Se
 * guardan en `venues.nightSettings` como JSON (migración 20261023200000) y lo
 * que falte vale lo de fábrica: un local sin ajustes funciona sin tocar nada.
 *
 * NFC = tarjeta, ficha o pulsera: da igual el formato, se trata igual.
 */

export const PIN_KEYPAD_LAYOUTS = ['fixed', 'shuffled'] as const;
export type PinKeypadLayout = (typeof PIN_KEYPAD_LAYOUTS)[number];

export const RECEPTION_METHODS = ['cash', 'card'] as const;
export type ReceptionDefaultMethod = (typeof RECEPTION_METHODS)[number];

export interface VenueNightSettings {
  /** Un cobro con el NFC hasta esto (incluido) va sin PIN. 0 = siempre con PIN. */
  nfcNoPinMaxCents: number;
  /** Lo más que se gasta sin PIN en una noche (de 08:00 a 08:00 de Madrid); al pasarlo, PIN una vez. */
  nfcNoPinNightCapCents: number;
  /** Teclado del PIN: fijo (más fácil a oscuras) o con las cifras cambiando de sitio. */
  pinKeypad: PinKeypadLayout;
  /** Los botones de importe rápido de la recepción. */
  receptionQuickAmountsCents: number[];
  /** El botón grande de la recepción. */
  receptionDefaultMethod: ReceptionDefaultMethod;
  /** Vibrar al cobrar (pagado o no). */
  feedbackVibration: boolean;
  /** Sonar al cobrar (pagado o no). */
  feedbackSound: boolean;
  /**
   * Lo que cada persona de recepción devuelve en efectivo en una noche (de
   * 08:00 a 08:00 de Madrid) con el NFC del cliente. Al pasarlo, cada salida
   * la confirma el encargado con su 2FA, sale en Incidencias y avisa por
   * Telegram. 0 = siempre el encargado.
   */
  receptionPayoutNightCapCents: number;
}

/** Topes de lo que se puede guardar (el API y el panel usan los mismos). */
export const MAX_NFC_NO_PIN_CENTS = 50_00;
export const MAX_NFC_NO_PIN_NIGHT_CAP_CENTS = 500_00;
export const MAX_RECEPTION_QUICK_AMOUNTS = 4;
export const MAX_RECEPTION_PAYOUT_NIGHT_CAP_CENTS = 5_000_00;
const MIN_QUICK_AMOUNT_CENTS = 100;

export const DEFAULT_RECEPTION_QUICK_AMOUNTS_CENTS: readonly number[] = [20_00, 50_00, 100_00];

export const DEFAULT_NIGHT_SETTINGS: Readonly<VenueNightSettings> = Object.freeze({
  nfcNoPinMaxCents: 20_00,
  nfcNoPinNightCapCents: 100_00,
  pinKeypad: 'fixed',
  receptionQuickAmountsCents: [...DEFAULT_RECEPTION_QUICK_AMOUNTS_CENTS],
  receptionDefaultMethod: 'cash',
  feedbackVibration: true,
  feedbackSound: true,
  receptionPayoutNightCapCents: 300_00,
});

const cents = (max: number) => z.number().int().min(0).max(max);

export const UpdateNightSettingsSchema = z
  .object({
    nfcNoPinMaxCents: cents(MAX_NFC_NO_PIN_CENTS).optional(),
    nfcNoPinNightCapCents: cents(MAX_NFC_NO_PIN_NIGHT_CAP_CENTS).optional(),
    pinKeypad: z.enum(PIN_KEYPAD_LAYOUTS).optional(),
    receptionQuickAmountsCents: z
      .array(z.number().int().min(MIN_QUICK_AMOUNT_CENTS).max(MAX_CASH_TOP_UP_CENTS))
      .min(1, 'Deja al menos un importe rápido')
      .max(MAX_RECEPTION_QUICK_AMOUNTS, `Como mucho ${MAX_RECEPTION_QUICK_AMOUNTS} importes rápidos`)
      .optional(),
    receptionDefaultMethod: z.enum(RECEPTION_METHODS).optional(),
    feedbackVibration: z.boolean().optional(),
    feedbackSound: z.boolean().optional(),
    receptionPayoutNightCapCents: cents(MAX_RECEPTION_PAYOUT_NIGHT_CAP_CENTS).optional(),
  })
  .strict()
  .refine((d) => Object.values(d).some((v) => v !== undefined), { message: 'No hay nada que cambiar' });
export type UpdateNightSettingsDto = z.infer<typeof UpdateNightSettingsSchema>;

function intIn(v: unknown, min: number, max: number): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null;
}

function quickAmounts(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null;
  const ok = v.filter((x): x is number => intIn(x, MIN_QUICK_AMOUNT_CENTS, MAX_CASH_TOP_UP_CENTS) !== null);
  const out = [...new Set(ok)].sort((a, b) => a - b).slice(0, MAX_RECEPTION_QUICK_AMOUNTS);
  return out.length > 0 ? out : null;
}

function oneOf<T extends string>(v: unknown, options: readonly T[], fallback: T): T {
  return typeof v === 'string' && (options as readonly string[]).includes(v) ? (v as T) : fallback;
}

/** Lo guardado (JSON o null) con lo de fábrica donde falte. Un valor raro no rompe nada. */
export function nightSettingsOf(raw: unknown): VenueNightSettings {
  const s = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_NIGHT_SETTINGS;
  const flag = (key: 'feedbackVibration' | 'feedbackSound'): boolean =>
    typeof s[key] === 'boolean' ? (s[key] as boolean) : d[key];
  return {
    nfcNoPinMaxCents: intIn(s.nfcNoPinMaxCents, 0, MAX_NFC_NO_PIN_CENTS) ?? d.nfcNoPinMaxCents,
    nfcNoPinNightCapCents: intIn(s.nfcNoPinNightCapCents, 0, MAX_NFC_NO_PIN_NIGHT_CAP_CENTS) ?? d.nfcNoPinNightCapCents,
    pinKeypad: oneOf(s.pinKeypad, PIN_KEYPAD_LAYOUTS, d.pinKeypad),
    receptionQuickAmountsCents: quickAmounts(s.receptionQuickAmountsCents) ?? [...d.receptionQuickAmountsCents],
    receptionDefaultMethod: oneOf(s.receptionDefaultMethod, RECEPTION_METHODS, d.receptionDefaultMethod),
    feedbackVibration: flag('feedbackVibration'),
    feedbackSound: flag('feedbackSound'),
    receptionPayoutNightCapCents:
      intIn(s.receptionPayoutNightCapCents, 0, MAX_RECEPTION_PAYOUT_NIGHT_CAP_CENTS) ?? d.receptionPayoutNightCapCents,
  };
}

/** Lo guardado tras aplicar el cambio (siempre completo, con los importes ordenados). */
export function mergeNightSettings(current: unknown, patch: UpdateNightSettingsDto): VenueNightSettings {
  const base = nightSettingsOf(current);
  const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  return nightSettingsOf({ ...base, ...defined });
}

/** Por qué no se puede guardar (null: vale). El tope de la noche no baja del máximo por cobro. */
export function nightSettingsProblem(s: VenueNightSettings): string | null {
  if (s.nfcNoPinMaxCents > 0 && s.nfcNoPinNightCapCents < s.nfcNoPinMaxCents) {
    return 'El tope sin PIN por noche no puede ser menor que el máximo sin PIN por cobro.';
  }
  return null;
}

// ─── Cómo se autorizó cada consumo del saldo ──────────────────────────

/**
 *  - nfc_nopin: el NFC solo (hasta el tope del local, con su número de serie).
 *  - pin: el PIN del cliente (con su código o su NFC).
 *  - passkey: su Face ID / huella en su móvil (QR).
 *  - staff: el encargado lo cobró sin el cliente (sin batería…).
 */
export const CHARGE_AUTH_METHODS = ['nfc_nopin', 'pin', 'passkey', 'staff'] as const;
export type ChargeAuthMethod = (typeof CHARGE_AUTH_METHODS)[number];

/** 409 cuando el NFC solo no basta: el cliente pone su PIN (el mismo cobro sigue libre). */
export const PIN_REQUIRED_CODE = 'PIN_REQUIRED';

/**
 * Por qué hace falta el PIN:
 *  - off: el local no deja pagar sin PIN;
 *  - over_max: el cobro pasa del máximo sin PIN;
 *  - night_cap: con este cobro pasaría del tope de la noche;
 *  - no_uid: el NFC no se pudo comprobar (sin número de serie: un iPhone, o el NFC no lo tiene guardado);
 *  - pin_locked: su PIN está bloqueado por fallos (puede que no lo lleve su dueño).
 */
export const PIN_REQUIRED_REASONS = ['off', 'over_max', 'night_cap', 'no_uid', 'pin_locked'] as const;
export type PinRequiredReason = (typeof PIN_REQUIRED_REASONS)[number];

export const PIN_REQUIRED_MESSAGES: Readonly<Record<PinRequiredReason, string>> = {
  off: 'Este local pide siempre el PIN.',
  over_max: 'Este cobro pasa del máximo sin PIN: que ponga su PIN.',
  night_cap: 'Ya lleva el tope sin PIN de esta noche: que ponga su PIN una vez.',
  no_uid: 'Este NFC no se puede comprobar: que ponga su PIN.',
  pin_locked: 'Su PIN está bloqueado por fallos: avisa al encargado.',
};
