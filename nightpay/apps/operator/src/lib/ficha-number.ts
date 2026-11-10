// El número impreso de la ficha, para no equivocarse de ficha (estudio de
// fichas, capa A): en grande y en grupos de 4 («0000 1013», la parte que
// importa en negrita), el corto que se dice en voz alta («la 1013»), el aviso
// si en el mostrador se acerca otra y, al preparar fichas, si el número
// tecleado no sigue al anterior. Funciones puras (ficha-number.test.ts).

import { isPrintedFichaNumber, normalizePrintedFichaNumber } from '@nightpay/contracts';

/** Un trozo del número: los ceros de delante, flojos; lo demás, en negrita. */
export interface FichaDigitsPart {
  text: string;
  strong: boolean;
}

/**
 * «00001013» → «0000 » + «1013» (en negrita): grupos de 4 cifras desde la
 * derecha, como se leen en la ficha. Sin número impreso, nada.
 */
export function fichaDigits(printed: string | null | undefined): FichaDigitsPart[] {
  if (!printed || !isPrintedFichaNumber(printed)) return [];
  // Todo ceros: el último cuenta (es el número 0).
  const nonZero = printed.search(/[1-9]/);
  const firstSignificant = nonZero === -1 ? printed.length - 1 : nonZero;
  const parts: FichaDigitsPart[] = [];
  const push = (text: string, strong: boolean) => {
    const last = parts.at(-1);
    if (last && last.strong === strong) last.text += text;
    else parts.push({ text, strong });
  };
  for (let i = 0; i < printed.length; i += 1) {
    const strong = i >= firstSignificant;
    // Un espacio delante de cada grupo de 4 (contando desde la derecha), con el peso de lo de antes.
    if (i > 0 && (printed.length - i) % 4 === 0) push(' ', parts.at(-1)?.strong ?? strong);
    push(printed[i]!, strong);
  }
  return parts;
}

/** «00001013» → «1013»: como se dice («la 1013»). Sin número, null. */
export function fichaShort(printed: string | null | undefined): string | null {
  return printed ? normalizePrintedFichaNumber(printed) : null;
}

/**
 * En el mostrador se acerca otra ficha que la de este cliente (A3): solo un
 * aviso, nunca cambia de pantalla. `expected`: el número impreso de la suya;
 * `tapped`: el de la acercada (null si no se sabe: en blanco, de otro local…).
 */
export function wrongFichaText(expected: string | null | undefined, tapped: string | null | undefined): string {
  const mine = fichaShort(expected);
  const other = fichaShort(tapped);
  if (mine && other) return `Esa es la ${other}, no la ${mine}`;
  if (mine) return `Esa no es la ${mine}`;
  if (other) return `Esa es la ${other}: no es la de este cliente`;
  return 'Esa no es la ficha de este cliente';
}

/**
 * «Preparar fichas» (A12): ¿el número tecleado sigue al de la anterior? null
 * si no hay anterior o no son cifras válidas (no se avisa de nada).
 */
export function followsPrevious(previous: string | null | undefined, typed: string): boolean | null {
  const prev = previous ? normalizePrintedFichaNumber(previous) : null;
  const next = normalizePrintedFichaNumber(typed);
  if (prev === null || next === null) return null;
  return Number(next) === Number(prev) + 1;
}

/** CARGADO (A11): lo que el cliente puede fotografiar para no perder su saldo. */
export function photoHint(has: { ficha: boolean; code: boolean }): string | null {
  if (has.ficha && has.code) return 'Haz una foto a tu ficha o a tu código';
  if (has.ficha) return 'Haz una foto a tu ficha';
  if (has.code) return 'Haz una foto a tu código';
  return null;
}
