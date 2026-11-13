// La edición del panel: 'club' = OxioPay (por defecto) y 'party' = OxioParty
// (fiestas con pulsera y casetas). Sale de NEXT_PUBLIC_EDITION, que Next mete
// al construir (build arg del Dockerfile): tiene que ser la misma que EDITION
// del API. Con 'club', el panel es exactamente el de siempre.

import { parseEdition, type Edition } from '@nightpay/contracts';

/** La edición con la que se construyó el panel. */
export const PANEL_EDITION: Edition = parseEdition(process.env.NEXT_PUBLIC_EDITION);

/** ¿OxioParty? */
export function isPartyEdition(edition: Edition = PANEL_EDITION): boolean {
  return edition === 'party';
}
