// Edición de la app: OxioPay (de siempre) u OxioParty (fiestas: barras de
// caseta y taquilla de pulseras). La fija el build con NEXT_PUBLIC_EDITION;
// solo 'party' enciende OxioParty y cualquier otro valor (o ninguno) es
// OxioPay, que no cambia en nada. Se lee con el nombre literal para que Next
// lo ponga al compilar. Más adelante irá a @nightpay/contracts.

export type Edition = 'club' | 'party';

/** La edición de un valor de NEXT_PUBLIC_EDITION: solo 'party' es OxioParty. */
export function editionOf(raw: string | null | undefined): Edition {
  return raw?.trim().toLowerCase() === 'party' ? 'party' : 'club';
}

/** ¿Es OxioParty? (NEXT_PUBLIC_EDITION=party). */
export function isParty(): boolean {
  return editionOf(process.env.NEXT_PUBLIC_EDITION) === 'party';
}

/**
 * En OxioParty el cliente lleva una pulsera donde en OxioPay lleva una ficha.
 * Las dos palabras son femeninas: «su ficha» → «su pulsera», «la ficha nº
 * 0522» → «la pulsera nº 0522». En OxioPay, el texto tal cual.
 */
export function pulseraText(text: string, party: boolean = isParty()): string {
  if (!party) return text;
  return text
    .replace(/\bfichas\b/g, 'pulseras')
    .replace(/\bFichas\b/g, 'Pulseras')
    .replace(/\bficha\b/g, 'pulsera')
    .replace(/\bFicha\b/g, 'Pulsera');
}
