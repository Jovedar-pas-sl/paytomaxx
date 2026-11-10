// «Detalle del pago» en la app del personal: uno de sus cobros, lo básico y
// «lo tuyo» (su comisión, su propina, su parte de una invitación). Nunca la
// parte del local ni el reparto (el API no los manda). Lo delicado (su móvil y
// el historial), tras «Ver más» y verificarse (5 minutos).

import {
  cobroStatusText,
  detailDeviceRow,
  type CobroDetail,
  type CobroDetailDevice,
  type CobroKind,
} from '@nightpay/contracts';
import { authedFetch } from './api';

export const OWN_DETAIL_NOT_FOUND = 'Ese cobro no es tuyo o ya no está.';
export const OWN_DETAIL_FAILED = 'No se pudo abrir el cobro. Vuelve a intentarlo.';

export async function fetchOwnCobroDetail(kind: CobroKind, id: string, signal?: AbortSignal): Promise<CobroDetail> {
  const res = await authedFetch(`/v1/staff/me/cobros/${kind}/${encodeURIComponent(id)}`, { signal, cache: 'no-store' });
  if (res.status === 404) throw new Error(OWN_DETAIL_NOT_FOUND);
  if (!res.ok) throw new Error(OWN_DETAIL_FAILED);
  return res.json();
}

/** El estado en una palabra: «Pagado», «Devuelto», «Cancelado»… (las del texto que se comparte). */
export function ownDetailStatus(status: string): string {
  return cobroStatusText(status);
}

/** Su propio móvil en un paso: «Al crear el cobro · iPhone · iOS 18.1 · Safari · 203.0.113.7». */
export function ownDeviceText(d: CobroDetailDevice): { step: string; text: string } {
  const r = detailDeviceRow(d);
  return { step: r.step, text: `${r.device} · ${r.ip}` };
}

/** «Sala Bambú · Copa», o «… · Recarga de saldo». */
export function ownWhereText(d: Pick<CobroDetail, 'venueName' | 'service' | 'isTopUp'>): string {
  return [d.venueName, d.isTopUp ? 'Recarga de saldo' : d.service].filter(Boolean).join(' · ');
}
