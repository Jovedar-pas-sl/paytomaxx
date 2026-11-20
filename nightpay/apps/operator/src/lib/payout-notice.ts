// «Tu cuenta de cobro ha cambiado»: el aviso que ve la compañera al entrar en
// la app cuando alguien cambia a dónde se le paga (también llega por correo).
// Sale hasta que pulsa «Entendido». La cuenta va siempre tapada.

import type { PayoutAccountNotice } from '@nightpay/contracts';
import { authedFetch } from './api';
import { payoutMethodLabel } from './payout-method';

const DAY = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', day: 'numeric', month: 'long' });
const TIME = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export interface PayoutNoticeText {
  title: string;
  when: string;
  now: string;
  advice: string;
}

/** Los textos del aviso (los mismos que el correo). */
export function payoutNoticeText(notice: PayoutAccountNotice): PayoutNoticeText {
  const at = new Date(notice.changedAt);
  return {
    title: 'Tu cuenta de cobro ha cambiado',
    when: `El ${DAY.format(at)} a las ${TIME.format(at)}.`,
    now: notice.masked
      ? `Ahora te pagan a: ${payoutMethodLabel(notice.method)} · ${notice.masked}.`
      : notice.method === 'MANUAL_CASH'
        ? 'Ahora cobras en efectivo.'
        : 'Ya no tienes cuenta de cobro: hasta que pongas otra, se te paga en efectivo.',
    advice: 'Si no lo has pedido tú, habla hoy mismo con el dueño del local.',
  };
}

/** El aviso pendiente (null si no hay, o si no se pudo preguntar: ya saldrá la próxima vez). */
export async function fetchPayoutNotice(): Promise<PayoutAccountNotice | null> {
  const res = await authedFetch('/v1/operators/me/payout-notice');
  if (!res.ok) return null;
  const text = await res.text();
  return text ? (JSON.parse(text) as PayoutAccountNotice | null) : null;
}

/** «Entendido»: queda visto. */
export async function markPayoutNoticeSeen(): Promise<boolean> {
  const res = await authedFetch('/v1/operators/me/payout-notice/seen', { method: 'POST' });
  return res.ok;
}
