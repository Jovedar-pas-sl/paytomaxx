import { z } from 'zod';

/**
 * La edición del producto: 'club' = OxioPay (por defecto, como siempre) y
 * 'party' = OxioParty (fiestas con pulsera NFC y saldo prepago). Mismo código:
 * el API la lee de EDITION y las apps de NEXT_PUBLIC_EDITION (al construir).
 * Ver docs/OXIOPARTY.md.
 */
export const EDITIONS = ['club', 'party'] as const;
export type Edition = 'club' | 'party';
export const EditionSchema = z.enum(EDITIONS);
export const DEFAULT_EDITION: Edition = 'club';

/**
 * EDITION / NEXT_PUBLIC_EDITION → la edición. Sin valor o con uno que no es
 * 'party' → 'club' (OxioPay): una errata nunca cambia OxioPay.
 */
export function parseEdition(v?: string | null): Edition {
  return v?.trim().toLowerCase() === 'party' ? 'party' : 'club';
}
