/**
 * Lo de un cobro en cada sección (lógica pura), para el Z, los informes y el
 * mapa del dinero: sus líneas (payment_lines, cada una en su sección) y, si
 * no suman su importe (los cobros de antes de las líneas no tienen), lo que
 * falta en su sección principal (revenueCategory / la del consumo). Así un
 * cobro reparte exactamente su importe, y uno de una sola sección cuenta
 * igual que antes.
 */

export interface LineAmount {
  category: string;
  amountCents: number;
}

export interface ChargeLike {
  amountCents: number;
  /** Sección principal (la de los cobros sin líneas y la de la propina). */
  category: string;
  lines: readonly LineAmount[] | null | undefined;
}

/** Sección → importe, en el orden de las líneas (y la principal al final si falta algo). */
export function chargeSections(charge: ChargeLike): Map<string, number> {
  const lines = charge.lines ?? [];
  const out = new Map<string, number>();
  for (const l of lines) out.set(l.category, (out.get(l.category) ?? 0) + l.amountCents);
  const rest = charge.amountCents - lines.reduce((a, l) => a + l.amountCents, 0);
  if (rest !== 0 || lines.length === 0) out.set(charge.category, (out.get(charge.category) ?? 0) + rest);
  return out;
}
