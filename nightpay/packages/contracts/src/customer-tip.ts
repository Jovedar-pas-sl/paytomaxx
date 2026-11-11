// La propina solo la pone el cliente (B1, decisión del dueño): la elige al
// pagar, sin nada marcado, con tarjeta (/pay), con su saldo (/s) o con su PIN
// en el móvil del personal. El personal ya no la añade al cobrar, y con la
// ficha sin PIN no hay propina. Lo que reciba el personal por propinas se
// reparte como siempre. Reglas compartidas por el API, sus páginas y la app
// del personal.

import { DEFAULT_TIP_FLAT_CENTS, DEFAULT_TIP_PERCENTS } from './venue-settings';

/** Hasta este importe se sugieren euros fijos; por encima, porcentajes. */
export const TIP_FLAT_UP_TO_CENTS = 40_00;
/** Propinas sugeridas para importes pequeños: +2 € y +5 €. */
export const TIP_FLAT_PRESETS_CENTS: readonly number[] = DEFAULT_TIP_FLAT_CENTS;
/** Propinas sugeridas para el resto: 10 % y 15 %, en euros enteros. */
export const TIP_PERCENT_PRESETS: readonly number[] = DEFAULT_TIP_PERCENTS;
/** Propina como mucho del importe del cobro y nunca más de esto. */
export const MAX_TIP_CENTS = 500_00;

/** Propina sugerida: su importe y, si sale de un porcentaje, cuál. */
export interface TipPreset {
  cents: number;
  percent: number | null;
}

/** Propinas sugeridas que eligió el local (Ajustes → Formas de cobro); sin ellas, las de siempre. */
export interface TipPresetConfig {
  flatCents?: readonly number[];
  percents?: readonly number[];
}

/** Propina máxima para un cobro de este importe (la misma regla en el datáfono). */
export function maxTipCents(amountCents: number): number {
  return Math.max(0, Math.min(amountCents, MAX_TIP_CENTS));
}

/**
 * Propinas sugeridas para un importe (además de «Sin propina» y «Otra»).
 * Las que pasarían del máximo no se sugieren.
 */
export function tipPresetsFor(amountCents: number, config: TipPresetConfig = {}): TipPreset[] {
  const cap = maxTipCents(amountCents);
  const flat = config.flatCents?.length ? config.flatCents : TIP_FLAT_PRESETS_CENTS;
  const percents = config.percents?.length ? config.percents : TIP_PERCENT_PRESETS;
  const raw: TipPreset[] =
    amountCents <= TIP_FLAT_UP_TO_CENTS
      ? flat.map((cents) => ({ cents, percent: null }))
      : percents.map((percent) => ({
          cents: Math.max(100, Math.round((amountCents * percent) / 10_000) * 100),
          percent,
        }));
  const seen = new Set<number>();
  return raw.filter((t) => {
    if (t.cents > cap || seen.has(t.cents)) return false;
    seen.add(t.cents);
    return true;
  });
}

/** Una app vieja del personal que aún manda la propina al crear el cobro: 400 con esto. */
export const STAFF_TIP_REMOVED_CODE = 'STAFF_TIP_REMOVED';
export const STAFF_TIP_REMOVED_MESSAGE =
  'La propina ya no la pone el personal: la elige el cliente al pagar. Quita la propina y vuelve a cobrar (o vuelve a abrir la app).';

/** Por qué no vale la propina que eligió el cliente. */
export type CustomerTipProblem = 'invalid' | 'too-high' | 'tips-off';

/**
 * ¿Vale la propina que eligió el cliente al pagar con su saldo o su PIN?
 * «Sin propina» (0) siempre. Si no, con las propinas encendidas (en el local
 * y en el puesto de quien cobra) y hasta el importe (y 500 €). La que ya
 * traía un cobro de antes (puesta por el personal) se respeta.
 */
export function customerTipProblem(p: {
  amountCents: number;
  tipCents: number;
  /** Propinas encendidas en el local y en el puesto de quien cobra. */
  tipsOn: boolean;
  /** La propina que ya traía el cobro (cobros de antes de B1; 0 en los nuevos). */
  previousTipCents?: number;
}): CustomerTipProblem | null {
  if (!Number.isInteger(p.tipCents) || p.tipCents < 0) return 'invalid';
  if (p.tipCents === 0 || p.tipCents === (p.previousTipCents ?? 0)) return null;
  if (!p.tipsOn) return 'tips-off';
  return p.tipCents > maxTipCents(p.amountCents) ? 'too-high' : null;
}
