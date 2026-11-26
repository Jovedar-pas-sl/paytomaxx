// «Ver detalle» de un cobro en el panel (lógica pura): de lo que manda el API
// (CobroDetail, ya recortado para quien mira) a las líneas que se pintan, y el
// texto de «Compartir».

import {
  COBRO_REF_PARAM,
  cobroShareText,
  detailAmountTexts,
  detailDeviceRow,
  detailFlagTexts,
  detailLineLabel,
  detailMethodText,
  detailUndoText,
  detailViaWord,
  type CobroDetail,
  type CobroDetailBank,
  type CobroDetailCardMore,
  type CobroDetailSplit,
  type CobroRow,
  type VenueSection,
} from '@nightpay/contracts';
import { cobroStatus, type CobroStatusView } from './cobro-status';

// Lo que el panel y la app del personal dicen igual (contracts/cobro-detail-text).
export {
  detailAmountTexts as amountRows,
  detailDeviceRow as deviceRow,
  detailFlagTexts as flagTexts,
  detailLineLabel as lineLabel,
  detailMethodText as methodText,
  detailUndoText as undoText,
  detailViaWord as viaWord,
};

export interface DetailRow {
  label: string;
  value: string;
}

/** «Sala Bambú · Copas» (o «… · Copas y Habitaciones»); una recarga, «… · Recarga de saldo». */
export function whereText(d: Pick<CobroDetail, 'venueName' | 'sections' | 'isTopUp'>, sections: readonly VenueSection[]): string {
  if (d.isTopUp) return [d.venueName, 'Recarga de saldo'].filter(Boolean).join(' · ');
  const names = d.sections.map((s) => sections.find((x) => x.code === s.category)?.label ?? (s.category === 'EXTRA' ? 'Otros' : s.category));
  const what = names.length <= 1 ? (names[0] ?? null) : `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}`;
  return [d.venueName, what].filter(Boolean).join(' · ');
}

/** El reparto: lo vendido, lo devuelto, cada persona, OxioPay y lo que queda para el local. */
export function splitRows(s: CobroDetailSplit, eur: (cents: number) => string): DetailRow[] {
  return [
    { label: 'Vendido (importe y propina)', value: eur(s.soldCents) },
    ...(s.refundedCents > 0 ? [{ label: 'Devuelto', value: `−${eur(s.refundedCents)}` }] : []),
    ...s.staff.map((p) => ({ label: p.name, value: eur(p.totalCents) })),
    ...(s.oxioPay.serviceFeeCents > 0 ? [{ label: 'OxioPay: comisión del servicio', value: eur(s.oxioPay.serviceFeeCents) }] : []),
    ...(s.oxioPay.platformCents > 0 ? [{ label: 'OxioPay: su %', value: eur(s.oxioPay.platformCents) }] : []),
    { label: 'Para el local', value: eur(s.venueCents) },
  ];
}

/** El texto de «Compartir» (sin móvil, IP, historial ni id: cobroShareText). */
export function shareTextOf(d: CobroDetail, eur: (cents: number) => string, when: (iso: string) => string): string {
  return cobroShareText(d, { eur, when });
}

/** La referencia que pide el enlace de «Compartir» (?ref=C-0024), o null. */
export function refFromSearch(search: string): string | null {
  const ref = new URLSearchParams(search).get(COBRO_REF_PARAM)?.trim().toUpperCase() ?? '';
  return /^C-\d{4,9}$/.test(ref) ? ref : null;
}

/** La URL sin ?ref= (abierto una vez, una recarga no lo vuelve a abrir). */
export function withoutRef(search: string): string {
  const params = new URLSearchParams(search);
  params.delete(COBRO_REF_PARAM);
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}

/** El estado del cobro con las palabras únicas: un consumo del saldo deshecho sale «Devuelto». */
export function detailStatus(d: Pick<CobroDetail, 'kind' | 'status'>): CobroStatusView {
  if (d.kind === 'SALDO' && d.status === 'REVERSED') return { label: 'Devuelto', tone: 'refund' };
  return cobroStatus({ kind: d.kind, status: d.status as CobroRow['status'] });
}

/** Lo del banco: autorización, 3DS y país de la tarjeta (724 = España). */
export function bankRows(b: CobroDetailBank): DetailRow[] {
  return [
    { label: 'Autorización', value: b.authCode ?? '—' },
    { label: '3DS', value: b.secure3ds === null ? 'No se sabe' : b.secure3ds ? 'Sí' : 'No' },
    { label: 'País de la tarjeta', value: b.cardCountry ? (CARD_COUNTRY[b.cardCountry] ?? b.cardCountry) : '—' },
  ];
}

const CARD_COUNTRY: Readonly<Record<string, string>> = { '724': 'España (724)', ES: 'España' };

/** La tarjeta más allá de los 4 últimos (tras verificarse). */
export function cardMoreText(c: CobroDetailCardMore): string {
  return [c.type ? `tipo ${c.type}` : null, c.expiry ? `caduca ${c.expiry}` : null, c.tokenized ? 'guardada para cobros' : null].filter(Boolean).join(' · ') || '—';
}
