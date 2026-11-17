// La propina en la pantalla del PIN (B1, decisión del dueño): la propina solo
// la pone el cliente. Al pagar con su PIN en el móvil del personal la elige él,
// sin nada marcado: una de las sugeridas, «Otra» o «Sin propina». Con la ficha
// sin PIN no hay propina. Las sugeridas y el máximo, los mismos que en la
// página de pago (@nightpay/contracts).

import { maxTipCents, tipPresetsFor, type TipPreset } from '@nightpay/contracts';

export interface PinTipSetup {
  /** Lo vendido, sin propina. */
  baseCents: number;
  /** La que traía un cobro de antes (puesta por el personal): sale marcada y se puede quitar. */
  previousCents: number;
  maxCents: number;
  presets: TipPreset[];
}

/** Lo elegido: nada (sin propina), un botón (0 = «Sin propina») o «Otra» con lo tecleado. */
export type PinTipChoice = { kind: 'none' } | { kind: 'button'; cents: number } | { kind: 'other'; text: string };

/**
 * La propina que se ofrece: con las propinas encendidas en el local y en el
 * puesto de quien cobra (si no, null). `totalCents` lleva la propina que
 * traía el cobro (`tipCents`, solo en cobros de antes).
 */
export function pinTipSetup(p: {
  totalCents: number;
  tipCents?: number;
  tipsOn: boolean;
  flatCents: readonly number[];
  percents: readonly number[];
}): PinTipSetup | null {
  if (!p.tipsOn) return null;
  const previousCents = Math.max(0, p.tipCents ?? 0);
  const baseCents = p.totalCents - previousCents;
  return {
    baseCents,
    previousCents,
    maxCents: maxTipCents(baseCents),
    presets: tipPresetsFor(baseCents, { flatCents: p.flatCents, percents: p.percents }),
  };
}

/** Los importes de los botones: las sugeridas y, si el cobro traía otra (de antes), esa. */
export function pinTipButtons(setup: PinTipSetup): number[] {
  const cents = setup.presets.map((p) => p.cents);
  if (setup.previousCents > 0 && !cents.includes(setup.previousCents)) cents.push(setup.previousCents);
  return cents.sort((a, b) => a - b);
}

/** Al abrir, nada marcado; un cobro de antes, con su propina marcada. */
export function pinTipInitial(setup: PinTipSetup): PinTipChoice {
  return setup.previousCents > 0 ? { kind: 'button', cents: setup.previousCents } : { kind: 'none' };
}

/** La propina elegida (sin elegir, 0) o por qué «Otra» no vale aún. */
export function pinTipCents(choice: PinTipChoice, setup: PinTipSetup): { cents: number; error: 'empty' | 'max' | null } {
  if (choice.kind === 'none') return { cents: 0, error: null };
  if (choice.kind === 'button') return { cents: choice.cents, error: null };
  const digits = choice.text.replace(/[^0-9]/g, '');
  const euros = digits ? Number.parseInt(digits, 10) : 0;
  if (!(euros > 0)) return { cents: 0, error: 'empty' };
  if (euros * 100 > setup.maxCents) return { cents: 0, error: 'max' };
  return { cents: euros * 100, error: null };
}

/**
 * La propina que el cliente ya eligió en la «Pantalla del cliente» de la barra
 * (va en el cobro del saldo): sale marcada en la pantalla del PIN y se puede
 * quitar, como la de un cobro de antes. Sin ella (o fuera del tope), lo de siempre.
 */
export function withScreenTip(setup: PinTipSetup | null, chosenCents: number): PinTipSetup | null {
  if (!setup || chosenCents <= 0 || setup.previousCents > 0 || chosenCents > setup.maxCents) return setup;
  return { ...setup, previousCents: chosenCents };
}
