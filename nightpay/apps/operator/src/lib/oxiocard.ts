// Su OxioCard (OXIOCARD_ENABLED): «Abrir mi OxioCard» solo apunta la
// petición; el estado lo cambia a mano el dueño y ella lo ve en «Ganancias».
// Sin documentos ni emisor.

import { OXIOCARD_STATUS_LABELS, type OxiocardView } from '@nightpay/contracts';
import { authedFetch, parseOperatorApiError } from './api';

const DAY = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', day: 'numeric', month: 'long' });

const TEXTS: Readonly<Record<OxiocardView['status'], string>> = {
  NO_SOLICITADA: 'Una tarjeta a tu nombre para cobrar aunque no tengas cuenta de banco.',
  SOLICITADA: 'Aquí verás cómo va.',
  EN_VERIFICACION: 'La están revisando. El dueño te dirá cómo sigue.',
  APROBADA: 'Aprobada. El dueño te dirá cuándo la tienes.',
  RECHAZADA: 'No te la han aprobado. Habla con el dueño del local.',
};

export function oxiocardText(view: OxiocardView): { state: string; text: string; canRequest: boolean } {
  const asked = view.status === 'SOLICITADA' && view.at ? `La pediste el ${DAY.format(new Date(view.at))}. ` : '';
  return {
    state: OXIOCARD_STATUS_LABELS[view.status],
    text: `${asked}${TEXTS[view.status]}`,
    canRequest: view.status === 'NO_SOLICITADA',
  };
}

/** «Abrir mi OxioCard»: queda pedida (si ya lo estaba, como está). */
export async function requestMyOxiocard(): Promise<OxiocardView> {
  const res = await authedFetch('/v1/operators/me/oxiocard', { method: 'POST' });
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'OxioCard'));
  return res.json();
}
