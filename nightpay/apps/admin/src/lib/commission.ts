// Porcentajes de comisión: lo que se teclea en Ajustes y el ejemplo de reparto.

const PERCENT = /^(\d{1,3})(?:[.,](\d{1,2}))?$/;

/**
 * "10" / "10,5" / "10.25" → puntos básicos (1000 / 1050 / 1025). Solo 0-100 %.
 * Lo que no es un porcentaje limpio ("10abc", "1,2,3", "") → null; antes
 * parseFloat("10abc") daba 10 y se guardaba sin avisar.
 */
export function parsePercentToBps(input: string): number | null {
  const match = PERCENT.exec(input.trim().replace(/\s*%$/, ''));
  if (!match) return null;
  const bps = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return bps <= 10_000 ? bps : null;
}

/** Puntos básicos → texto del campo ("10,00"). */
export function bpsToPercentInput(bps: number): string {
  return (bps / 100).toFixed(2).replace('.', ',');
}

/** Puntos básicos → «10 %» / «10,5 %» para leer: el de toda la app. */
export { formatBps } from '@nightpay/ui';

export interface SplitExample {
  platformCents: number;
  chicaCents: number;
  /** Lo que queda para el local; negativo si OxioPay + chica pasan del 100 %. */
  venueCents: number;
}

/** Reparto de un cobro: OxioPay se lleva su %, la chica el suyo y el local el resto. */
export function splitExample(amountCents: number, platformBps: number, chicaBps: number): SplitExample {
  const platformCents = Math.round((amountCents * platformBps) / 10_000);
  const chicaCents = Math.round((amountCents * chicaBps) / 10_000);
  return { platformCents, chicaCents, venueCents: amountCents - platformCents - chicaCents };
}
