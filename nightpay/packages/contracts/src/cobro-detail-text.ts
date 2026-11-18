// «Detalle del pago»: los textos que ven igual el panel y la app del personal
// (puros). Las palabras únicas: «Devuelto» para lo pagado que vuelve (a la
// tarjeta o al saldo), «Cancelado» solo para lo que no se pagó, «Pagado» (no
// «Cobrado») y «ficha» (nunca «NFC»).

import {
  COBRO_FLAG_TEXT,
  detailAmountRows,
  type CobroDetail,
  type CobroDetailDevice,
  type CobroDetailLine,
  type CobroDetailMine,
  type CobroDetailUndo,
  type DetailAmountKey,
  type DeviceStep,
} from './cobro-detail';

export interface DetailTextRow {
  label: string;
  value: string;
}

export const DETAIL_AMOUNT_LABELS: Readonly<Record<DetailAmountKey, string>> = {
  amount: 'Importe',
  tip: 'Propina',
  serviceFee: 'Comisión del servicio',
  total: 'Total',
};

/** Importe, propina, comisión del servicio y total (o solo el total: DETAIL_TIP_AND_FEE_APART). */
export function detailAmountTexts(
  d: Pick<CobroDetail, 'amountCents' | 'tipCents' | 'serviceFeeCents' | 'totalCents'>,
  eur: (cents: number) => string,
): DetailTextRow[] {
  return detailAmountRows(d).map((r) => ({ label: DETAIL_AMOUNT_LABELS[r.key], value: eur(r.cents) }));
}

/** Una línea de lo cobrado: «2× Copa · invitación a Ana». */
export function detailLineLabel(l: Pick<CobroDetailLine, 'qty' | 'label' | 'invitedName'>): string {
  return `${l.qty > 1 ? `${l.qty}× ` : ''}${l.label}${l.invitedName ? ` · invitación a ${l.invitedName}` : ''}`;
}

/** Por dónde se autorizó, con las palabras únicas («NFC» → «ficha»). */
export function detailViaWord(via: string | null): string | null {
  return via ? via.replace(/NFC/g, 'ficha') : null;
}

/** Cómo se pagó: «Tarjeta Visa ••4242 · QR», «Saldo K7Q-••• · ficha nº 0522 · ficha sin PIN». */
export function detailMethodText(d: Pick<CobroDetail, 'method'>): string {
  const m = d.method;
  return (
    [m.label && m.label !== '—' ? m.label : null, m.fichaNumber ? `ficha nº ${m.fichaNumber}` : null, detailViaWord(m.via)]
      .filter(Boolean)
      .join(' · ') || '—'
  );
}

const UNDO_KIND: Readonly<Record<CobroDetailUndo['kind'], string>> = {
  REFUND: 'Devuelto a la tarjeta',
  VOID: 'Devuelto al saldo',
  CANCEL: 'Cancelado sin pagar',
};

const UNDO_STATUS: Readonly<Record<string, string>> = { SUCCEEDED: 'hecha', FAILED: 'no se hizo', PENDING: 'sin confirmar' };

/** Una devolución: a la tarjeta o, lo pagado con bitcoin («Devolver en efectivo»), en efectivo. */
export function refundUndoLabel(u: Pick<CobroDetailUndo, 'paidInCash'>): string {
  return u.paidInCash === true ? 'Devuelto en efectivo' : UNDO_KIND.REFUND;
}

/** «Devuelto a la tarjeta: 10,00 € · 08/11 01:00 · Javi · «Copa derramada» · hecha». */
export function detailUndoText(u: CobroDetailUndo, eur: (cents: number) => string, when: (iso: string) => string): string {
  const what = u.kind === 'REFUND' ? refundUndoLabel(u) : UNDO_KIND[u.kind];
  return [
    u.amountCents !== null ? `${what}: ${eur(u.amountCents)}` : what,
    when(u.at),
    u.by,
    u.reason ? `«${u.reason}»` : null,
    u.status ? (UNDO_STATUS[u.status] ?? u.status) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function detailFlagTexts(d: Pick<CobroDetail, 'flags'>): string[] {
  return d.flags.map((f) => COBRO_FLAG_TEXT[f]);
}

/** «Lo tuyo» en un cobro (la app del personal): su comisión, su propina, su parte de la invitación y lo devuelto. */
export function detailMineTexts(m: CobroDetailMine, eur: (cents: number) => string): DetailTextRow[] {
  return [
    ...(m.commissionCents !== 0 ? [{ label: 'Tu comisión', value: eur(m.commissionCents) }] : []),
    ...(m.tipCents !== 0 ? [{ label: 'Tu propina', value: eur(m.tipCents) }] : []),
    ...(m.invitationCents !== 0 ? [{ label: 'Tu parte de la invitación', value: eur(m.invitationCents) }] : []),
    ...(m.reversedCents !== 0 ? [{ label: 'Descontado por devoluciones', value: `−${eur(m.reversedCents)}` }] : []),
    { label: 'Para ti', value: eur(m.totalCents) },
  ];
}

const STEP_TEXT: Readonly<Record<DeviceStep, string>> = {
  create: 'Al crear el cobro',
  card: 'Al pagar con tarjeta',
  saldo: 'Al pagar con el saldo',
  pos: 'Al confirmarlo en el datáfono',
  cancel: 'Al cancelarlo',
};

/** Un dispositivo: de quién, en qué paso, cuál y su IP (o que ya se borró). */
export function detailDeviceRow(d: CobroDetailDevice): { who: string; step: string; device: string; ip: string } {
  const who = d.who === 'client' ? 'El cliente' : d.who === 'device' ? 'El datáfono' : (d.personName ?? 'El personal');
  return { who, step: STEP_TEXT[d.step], device: d.label, ip: d.ip ?? (d.ipErased ? 'IP borrada (a los 90 días)' : 'IP sin saber') };
}
