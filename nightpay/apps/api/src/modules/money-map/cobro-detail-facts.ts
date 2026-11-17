import {
  cobroPanelUrl,
  confirmationCode,
  deviceLabel,
  DEVICE_STEPS,
  firstNameOf,
  formatMoney,
  formatChargeRef,
  type CobroDetailBank,
  type CobroDetailHistoryItem,
  type CobroDetailLine,
  type CobroDetailStaffShare,
  type CobroDetailUndo,
  type CobroFlag,
  type DeviceStep,
  type DeviceWho,
} from '@nightpay/contracts';
import { isHomeTopUpPayment } from '../home-topup/home-topup-rules';
import { cardBrandLabel } from '../payments/card-brand';
import { paidTwiceOf } from '../payments/late-card-approval';
import {
  PAYMENT_DEVICE_EVENT,
  WALLET_CHARGE_CREATED_ACTION,
  WALLET_CHARGE_SETTLED_ACTION,
  WALLET_CREDITED_EVENT,
} from '../payments/payment-device';
import type { CobroDetailFacts, DeviceFact } from './cobro-detail-policy';
import {
  paymentMethodLabel,
  paymentMethodOf,
  paymentVia,
  saldoVia,
  sectionsOfLines,
  walletHint,
  type PaymentFeedRow,
  type PersonLike,
  type StoredLineLike,
} from './cobros-rows';

/**
 * El detalle de un cobro (lógica pura): de las filas guardadas (el cobro, sus
 * líneas, eventos, intentos, devoluciones, ganancias y el registro) a todo
 * lo que se sabe de él (CobroDetailFacts). Lo que ve cada uno lo recorta
 * cobro-detail-policy.ts.
 */

export interface EventRow {
  eventType: string;
  payload: unknown;
  occurredAt: Date;
}

export interface AuditRow {
  action: string;
  actorId: string | null;
  payload: unknown;
  occurredAt: Date;
}

/** Una ganancia del cobro (operator_earnings), con lo que ya debe si se le pagó antes de devolverlo. */
export interface EarningRow {
  operatorId: string;
  commissionCents: number;
  tipCents: number;
  reversedCents: number;
  /** De una invitación («Copa con invitación»): null, la comisión de siempre. */
  paymentLineId: string | null;
  /** Lo descontado después de pagarle (earning_reversals.afterPayout): no está en reversedCents. */
  debtCents: number;
}

export interface RefundRow {
  id: string;
  amountCents: number;
  reason: string | null;
  requestedBy: string;
  status: string;
  createdAt: Date;
  registeredManually: boolean;
  bankRefundedAt: Date | null;
  serviceFeeCents: number;
  /** Se dio en efectivo («Devolver en efectivo» de lo pagado con bitcoin), no a la tarjeta. */
  paidInCash?: boolean;
}

export interface PaymentDetailInput {
  payment: Omit<PaymentFeedRow, 'events'> & {
    tenantId: string;
    cardType: string | null;
    cardCountry: string | null;
    secure3ds: boolean | null;
    tokenizationData: unknown;
    platformCommissionBps: number | null;
    events: EventRow[];
    refunds: RefundRow[];
  };
  venueName: string;
  people: ReadonlyMap<string, PersonLike>;
  earnings: readonly EarningRow[];
  audits: readonly AuditRow[];
  panelBase: string | null;
}

export interface SaldoDetailInput {
  request: {
    id: string;
    tenantId: string;
    ref: number | null;
    createdAt: Date;
    amountCents: number;
    category: string;
    serviceName: string | null;
    status: string;
    requestedByUserId: string;
    linkedPaymentId: string | null;
    tipCents: number;
    decidedAt: Date | null;
  };
  consumption: {
    amountCents: number;
    tipCents: number;
    reversedAt: Date | null;
    reversedByUserId: string | null;
    notes: string | null;
    authMethod: string | null;
    platformCommissionBps: number | null;
    serviceFeeSaldoCents: number;
  } | null;
  wallet: { id: string; shortCode: string | null } | null;
  lines: readonly StoredLineLike[];
  /** Eventos del cobro con tarjeta enlazado (cobro único): su dispositivo al crearlo y al pagar. */
  linkedEvents: readonly EventRow[];
  people: ReadonlyMap<string, PersonLike>;
  earnings: readonly EarningRow[];
  audits: readonly AuditRow[];
  /** La ficha NFC del saldo al pagar («Ficha nº 0522»): solo si se pagó con ella. */
  fichaNumber: string | null;
  venueName: string;
  /** % de plataforma del local (los consumos de antes no lo llevaban fijado). */
  venuePlatformBps: number;
  panelBase: string | null;
}

const BPS = 10_000;
const PAID_PAYMENT = new Set(['AUTHORIZED', 'PARTIALLY_REFUNDED', 'REFUNDED']);
/** País de la tarjeta de España (Redsys manda el ISO numérico). */
const DOMESTIC = new Set(['724', 'ES', 'ESP']);
const FICHA_VIAS = new Set(['nfc_nopin']);

// ─── Cobro con tarjeta (o recarga) ──────────────────────────────────────

export function paymentDetailFacts(i: PaymentDetailInput): CobroDetailFacts {
  const p = i.payment;
  const isTopUp = p.walletId !== null;
  const method = paymentMethodOf(p);
  const ref = formatChargeRef(p.ref);
  const canceled = p.events.find((e) => e.eventType === 'payment.canceled');
  const succeededRefunds = p.refunds.filter((r) => r.status === 'SUCCEEDED');
  const refundedFee = sum(succeededRefunds, (r) => r.serviceFeeCents);
  const refundedTotal = sum(succeededRefunds, (r) => r.amountCents);
  const paid = PAID_PAYMENT.has(p.status);
  const shares = sharesOf(i.earnings, i.people);
  const sold = p.amountCents + p.tipCents;
  const refundedSale = Math.min(sold, Math.max(0, refundedTotal - refundedFee));
  const keptAmount = Math.max(0, p.amountCents - Math.max(0, refundedSale - p.tipCents));
  const platformCents = paid ? Math.round((keptAmount * (p.platformCommissionBps ?? 0)) / BPS) : 0;
  const undo: CobroDetailUndo[] = [
    ...p.refunds.map((r) => ({
      kind: 'REFUND' as const,
      at: (r.bankRefundedAt ?? r.createdAt).toISOString(),
      amountCents: r.amountCents,
      by: nameOf(i.people.get(r.requestedBy)),
      reason: r.reason?.trim() || null,
      status: r.status,
      // Lo pagado con bitcoin devuelto en efectivo: el detalle y el ticket no dicen «a la tarjeta».
      ...(r.paidInCash === true ? { paidInCash: true } : {}),
    })),
    ...(p.status === 'CANCELED' && canceled && !p.events.some((e) => e.eventType === 'payment.paid_with_saldo')
      ? [
          {
            kind: 'CANCEL' as const,
            at: canceled.occurredAt.toISOString(),
            amountCents: null,
            by: nameOf(i.people.get(stringOf(payloadOf(canceled).byUserId) ?? '')),
            reason: cancelReasonText(stringOf(payloadOf(canceled).reason)),
            status: null,
          },
        ]
      : []),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const flags: CobroFlag[] = [];
  if (paidTwiceOf(p.events)) flags.push('PAID_TWICE');
  if (isHomeTopUpPayment(p)) flags.push('FROM_HOME');
  if ((method === 'CARD' || method === 'MOBILE_WALLET') && p.secure3ds === false) flags.push('NO_3DS');
  if (p.cardCountry && !DOMESTIC.has(p.cardCountry.trim().toUpperCase())) flags.push('FOREIGN_CARD');
  const credited = p.events.find((e) => e.eventType === WALLET_CREDITED_EVENT);
  const bank: CobroDetailBank = {
    authCode: p.authCode,
    secure3ds: p.secure3ds,
    cardCountry: p.cardCountry,
    provider: p.provider,
    bankOrder: p.attempts.find((a) => a.status === 'APPROVED')?.providerTxId ?? p.providerTxId ?? p.posOperationNumber,
  };
  const token = p.tokenizationData && typeof p.tokenizationData === 'object' ? (p.tokenizationData as Record<string, unknown>) : null;
  return {
    base: {
      kind: 'PAYMENT',
      id: p.id,
      ref,
      confirmationCode: confirmationCode(p.id),
      status: p.status,
      createdAt: p.createdAt.toISOString(),
      paidAt: p.authorizedAt?.toISOString() ?? null,
      venueName: i.venueName,
      sections: isTopUp ? [] : sectionsOfLines(p.lines, p.revenueCategory, p.amountCents),
      lines: detailLines(p.lines),
      service: p.serviceName,
      isTopUp,
      amountCents: p.amountCents,
      tipCents: p.tipCents,
      serviceFeeCents: p.serviceFeeCents ?? 0,
      totalCents: p.amountCents + p.tipCents + (p.serviceFeeCents ?? 0),
      method: {
        method,
        label: paymentMethodLabel(method, p),
        cardBrand: cardBrandLabel(p.cardBrand),
        cardLast4: p.cardLast4,
        fichaNumber: null,
        via: paymentVia(method, isTopUp),
        walletHint: p.wallet ? walletHint(p.wallet.shortCode) : null,
      },
      undo,
    },
    chargedBy: personFact(p.createdBy),
    flags,
    balance: balanceOf(credited ? payloadOf(credited) : null),
    shares,
    split: isTopUp
      ? null
      : {
          soldCents: sold,
          refundedCents: refundedSale,
          staff: shares,
          oxioPay: { serviceFeeCents: Math.max(0, (p.serviceFeeCents ?? 0) - refundedFee), platformCents },
          venueCents: paid ? sold - refundedSale - sum(shares, (s) => s.totalCents) - platformCents : 0,
        },
    bank,
    panelUrl: cobroPanelUrl(i.panelBase, ref),
    devices: devicesOf(p.events, [], i.people),
    card: {
      type: p.cardType,
      payMethodCode: p.payMethodCode,
      expiry: typeof token?.expiry === 'string' ? token.expiry : null,
      tokenized: typeof token?.identifier === 'string' && token.identifier.length > 0,
    },
    history: paymentHistory(p, i.people, i.audits),
  };
}

// ─── Cobro del saldo ────────────────────────────────────────────────────

export function saldoDetailFacts(i: SaldoDetailInput): CobroDetailFacts {
  const r = i.request;
  const c = i.consumption;
  const reversed = Boolean(c?.reversedAt);
  const tipCents = c?.tipCents ?? r.tipCents ?? 0;
  const amountCents = c?.amountCents ?? r.amountCents;
  const ref = formatChargeRef(r.ref);
  const hint = i.wallet ? walletHint(i.wallet.shortCode) : null;
  const settled = settledPayloadOf(r.id, i.linkedEvents, i.audits);
  const shares = sharesOf(i.earnings, i.people);
  const sold = amountCents + tipCents;
  const paid = r.status === 'ACCEPTED' && !reversed;
  const bps = c?.platformCommissionBps ?? i.venuePlatformBps;
  const platformCents = paid ? Math.round(((amountCents - Math.max(0, c?.serviceFeeSaldoCents ?? 0)) * bps) / BPS) : 0;
  const flags: CobroFlag[] = [];
  if (paidTwiceOf(i.linkedEvents)) flags.push('PAID_TWICE');
  if (c?.authMethod === 'nfc_nopin') flags.push('NFC_NO_PIN');
  if (c?.authMethod === 'staff') flags.push('APPROVED_BY_STAFF');
  if (i.audits.some((a) => a.action === 'wallet.card_copy_suspected' && stringOf(payloadOf(a).requestId) === r.id)) {
    flags.push('CARD_COPY_SUSPECTED');
  }
  const pinVia = stringOf(settled?.pinVia);
  const screenBy = screenTextOf(settled, i.people.get(r.requestedByUserId));
  const paidWithFicha = c ? FICHA_VIAS.has(c.authMethod ?? '') || (c.authMethod === 'pin' && pinVia === 'ficha') : false;
  const undo: CobroDetailUndo[] =
    c?.reversedAt
      ? [
          {
            kind: 'VOID',
            at: c.reversedAt.toISOString(),
            amountCents: sold,
            by: nameOf(i.people.get(c.reversedByUserId ?? '')),
            reason: reversalReasonOf(c.notes, i.audits),
            status: null,
          },
        ]
      : [];
  return {
    base: {
      kind: 'SALDO',
      id: r.id,
      ref,
      confirmationCode: r.linkedPaymentId ? confirmationCode(r.linkedPaymentId) : null,
      status: reversed ? 'REVERSED' : r.status,
      createdAt: r.createdAt.toISOString(),
      paidAt: r.status === 'ACCEPTED' ? (r.decidedAt?.toISOString() ?? null) : null,
      venueName: i.venueName,
      sections: sectionsOfLines(i.lines, r.category, amountCents),
      lines: detailLines(i.lines),
      service: r.serviceName,
      isTopUp: false,
      amountCents,
      tipCents,
      serviceFeeCents: 0,
      totalCents: sold,
      method: {
        method: 'SALDO',
        label: `Saldo ${hint ?? ''}`.trim(),
        cardBrand: null,
        cardLast4: null,
        fichaNumber: paidWithFicha ? i.fichaNumber : null,
        via: [saldoVia(c?.authMethod ?? null), screenBy].filter(Boolean).join(' · ') || null,
        walletHint: hint,
      },
      undo,
    },
    chargedBy: personFact(i.people.get(r.requestedByUserId) ?? null),
    flags,
    balance: balanceOf(settled),
    shares,
    split: {
      soldCents: sold,
      refundedCents: reversed ? sold : 0,
      staff: shares,
      oxioPay: { serviceFeeCents: 0, platformCents },
      venueCents: paid ? sold - sum(shares, (s) => s.totalCents) - platformCents : 0,
    },
    bank: null,
    panelUrl: cobroPanelUrl(i.panelBase, ref),
    devices: devicesOf(i.linkedEvents, i.audits, i.people, r.id),
    card: null,
    history: saldoHistory(i, settled),
  };
}

// ─── Piezas ─────────────────────────────────────────────────────────────

/** Lo de cada persona: comisión o parte de una invitación, propina y lo descontado (también lo que ya debe). */
export function sharesOf(earnings: readonly EarningRow[], people: ReadonlyMap<string, PersonLike>): CobroDetailStaffShare[] {
  return earnings.map((e) => {
    const person = people.get(e.operatorId);
    const commissionCents = e.paymentLineId ? 0 : e.commissionCents;
    const invitationCents = e.paymentLineId ? e.commissionCents : 0;
    const reversedCents = e.reversedCents + e.debtCents;
    return {
      personId: e.operatorId,
      name: nameOf(person) ?? 'Personal',
      role: person?.role ?? null,
      commissionCents,
      tipCents: e.tipCents,
      invitationCents,
      reversedCents,
      totalCents: commissionCents + e.tipCents + invitationCents - reversedCents,
    };
  });
}

function detailLines(lines: readonly StoredLineLike[]): CobroDetailLine[] {
  return lines.map((l) => ({
    label: l.label,
    qty: l.qty,
    unitCents: l.unitCents,
    amountCents: l.amountCents,
    category: l.category,
    invitedName: l.beneficiary ? firstNameOf(l.beneficiary.displayName) : null,
  }));
}

function personFact(u: PersonLike | null | undefined): CobroDetailFacts['chargedBy'] {
  return u ? { name: nameOf(u) ?? 'Personal', displayName: u.displayName?.trim() || null, role: u.role } : null;
}

/** El nombre visible (o el email, como en la lista del panel). */
function nameOf(u: PersonLike | null | undefined): string | null {
  return u ? u.displayName?.trim() || u.email : null;
}

function balanceOf(p: Record<string, unknown> | null): { beforeCents: number; afterCents: number } | null {
  if (!p) return null;
  const before = p.balanceBeforeCents;
  const after = p.balanceAfterCents;
  return typeof before === 'number' && typeof after === 'number' ? { beforeCents: before, afterCents: after } : null;
}

/** Cómo se pagó este cobro del saldo: el evento del cobro enlazado o, saldo suelto, el registro. */
/** Pagado con la ficha en la «Pantalla del cliente»: «desde la pantalla de Pablo» (o null). */
export function screenTextOf(settled: Record<string, unknown> | null, requester: Parameters<typeof nameOf>[0]): string | null {
  if (settled?.screen !== true) return null;
  const name = nameOf(requester);
  return name ? `desde la pantalla de ${name}` : 'desde la pantalla del cliente';
}

function settledPayloadOf(requestId: string, linkedEvents: readonly EventRow[], audits: readonly AuditRow[]): Record<string, unknown> | null {
  const fromEvent = linkedEvents.find(
    (e) => e.eventType === PAYMENT_DEVICE_EVENT && payloadOf(e).step === 'saldo' && payloadOf(e).walletChargeId === requestId,
  );
  if (fromEvent) return payloadOf(fromEvent);
  const fromAudit = audits.find((a) => a.action === WALLET_CHARGE_SETTLED_ACTION);
  return fromAudit ? payloadOf(fromAudit) : null;
}

/** «[REVERSED: motivo]» al final de las notas del consumo; si no, el del registro. */
export function reversalReasonOf(notes: string | null, audits: readonly AuditRow[]): string | null {
  const fromNotes = [...(notes ?? '').matchAll(/\[REVERSED: ([^\]]*)\]/g)].pop()?.[1]?.trim();
  if (fromNotes) return fromNotes;
  const audit = audits.find((a) => a.action === 'wallet.consumption.reversed');
  return stringOf(audit ? payloadOf(audit).reason : null)?.trim() || null;
}

function cancelReasonText(reason: string | null): string | null {
  if (!reason || reason === 'user-canceled') return null;
  return reason;
}

/** Los dispositivos: los eventos `payment.device` y, en el saldo suelto, el registro (sin IP). */
export function devicesOf(
  events: readonly EventRow[],
  audits: readonly AuditRow[],
  people: ReadonlyMap<string, PersonLike>,
  walletChargeId?: string,
): DeviceFact[] {
  const fromEvents = events
    .filter((e) => e.eventType === PAYMENT_DEVICE_EVENT)
    // En un cobro del saldo enlazado, lo del saldo de otro cobro del saldo no (no pasa, pero por si acaso).
    .filter((e) => !walletChargeId || !payloadOf(e).walletChargeId || payloadOf(e).walletChargeId === walletChargeId)
    .map((e) => deviceFact(payloadOf(e), e.occurredAt, people, true));
  const fromAudits = audits
    .filter((a) => a.action === WALLET_CHARGE_SETTLED_ACTION || a.action === WALLET_CHARGE_CREATED_ACTION)
    .map((a) => deviceFact(payloadOf(a), a.occurredAt, people, false));
  return [...fromEvents, ...fromAudits]
    .filter((d): d is DeviceFact => d !== null)
    .sort((a, b) => a.at.localeCompare(b.at));
}

function deviceFact(p: Record<string, unknown>, at: Date, people: ReadonlyMap<string, PersonLike>, withIp: boolean): DeviceFact | null {
  const step = stringOf(p.step);
  const who = stringOf(p.who);
  if (!step || !(DEVICE_STEPS as readonly string[]).includes(step) || (who !== 'staff' && who !== 'client' && who !== 'device')) return null;
  const info = {
    model: stringOf(p.model),
    os: stringOf(p.os),
    osVersion: stringOf(p.osVersion),
    browser: stringOf(p.browser),
    mobile: typeof p.mobile === 'boolean' ? p.mobile : null,
    inApp: stringOf(p.inApp),
  };
  const userId = stringOf(p.userId);
  return {
    who: who as DeviceWho,
    step: step as DeviceStep,
    at: at.toISOString(),
    label: deviceLabel(info),
    ...info,
    ip: withIp ? stringOf(p.ip) : null,
    ipErased: p.ipErased === true,
    personName: who === 'staff' ? nameOf(people.get(userId ?? '')) : null,
    userId,
  };
}

const EVENT_TEXT: Readonly<Record<string, string>> = {
  'payment.created': 'Cobro creado',
  'payment.qr_viewed': 'El cliente abrió el cobro',
  'payment.authorizing': 'El cliente fue a pagar al banco',
  'payment.authorized': 'Pagado',
  'payment.pos_confirmed': 'Confirmado en el datáfono',
  'pos.confirmed': 'Confirmado con el ticket del datáfono',
  'pos.device_confirmed': 'Cobrado en el datáfono',
  'payment.failed': 'El banco no lo aprobó',
  'payment.checkout_failed': 'La pasarela no abrió el pago',
  'payment.timeout': 'Caducó sin pagar',
  'payment.expired': 'Caducó sin pagar',
  'payment.refund_partial': 'Devolución hecha',
  'payment.canceled': 'Cancelado',
  'payment.paid_with_saldo': 'Pagado con el saldo (el cobro con tarjeta se canceló)',
  'payment.duplicate_charge': 'El banco aprobó otro pedido: cobrado dos veces',
  'payment.card_refunded_after_saldo': 'La tarjeta cobrada de más se devolvió sola',
  'payment.approval_unbooked': 'El banco aprobó la tarjeta después de pagar con el saldo',
  [WALLET_CREDITED_EVENT]: 'Saldo recargado',
};

const AUDIT_TEXT: Readonly<Record<string, string>> = {
  'refund.created': 'Devolución pedida',
  'refund.failed': 'La devolución falló',
  'refund.resolved': 'Devolución resuelta a mano',
  'payment.orphan_resolved': 'Resuelto a mano',
  'approval.requested': 'Devolución pedida al dueño',
  'approval.approved': 'Aprobado por el dueño',
  'approval.rejected': 'Rechazado por el dueño',
  'wallet.consumption.reversed': 'Anulado: el dinero volvió al saldo',
  'wallet.card_copy_suspected': 'Intentaron pagar con una copia de la ficha',
  'wallet.charge_nfc_nopin': 'Pagado con la ficha sin PIN',
  'wallet.pin_charge_terminal': 'Pagado con PIN en el datáfono',
  'wallet.charge_approved_without_faceid': 'Cobrado sin que el cliente lo confirmara',
};

function paymentHistory(
  p: PaymentDetailInput['payment'],
  people: ReadonlyMap<string, PersonLike>,
  audits: readonly AuditRow[],
): CobroDetailHistoryItem[] {
  const items: CobroDetailHistoryItem[] = [];
  // Con bitcoin (BTCPay) no hay banco: el cliente va a pagar su factura de bitcoin.
  const bitcoin = p.provider === 'BTCPAY';
  for (const e of p.events) {
    if (e.eventType === PAYMENT_DEVICE_EVENT) continue;
    const payload = payloadOf(e);
    const what = bitcoin && e.eventType === 'payment.authorizing' ? 'El cliente fue a pagar con bitcoin' : (EVENT_TEXT[e.eventType] ?? e.eventType);
    items.push({ at: e.occurredAt.toISOString(), what, detail: eventDetail(e.eventType, payload, people) });
  }
  for (const a of p.attempts) {
    const status = a.status === 'APPROVED' ? 'aprobado' : a.status === 'DENIED' ? 'denegado' : 'sin respuesta';
    if (a.payMethod === 'bitcoin') {
      items.push({ at: a.createdAt.toISOString(), what: `Intento de pago con bitcoin: ${status}`, detail: `Factura de BTCPay ${a.providerTxId}` });
      continue;
    }
    const how = a.payMethod === 'wallet' ? 'Apple Pay / Google Pay' : 'tarjeta';
    items.push({ at: a.createdAt.toISOString(), what: `Intento de pago con ${how}: ${status}`, detail: `Pedido ${a.providerTxId}` });
  }
  for (const r of p.refunds) {
    const who = nameOf(people.get(r.requestedBy));
    items.push({
      at: r.createdAt.toISOString(),
      what: r.registeredManually ? 'Devolución apuntada (hecha en el banco)' : 'Devolución pedida',
      detail: [eurText(r.amountCents), who, r.reason?.trim() || null, refundStatusText(r.status)].filter(Boolean).join(' · '),
    });
  }
  items.push(...auditHistory(audits, people));
  return items.sort((a, b) => a.at.localeCompare(b.at));
}

function saldoHistory(i: SaldoDetailInput, settled: Record<string, unknown> | null): CobroDetailHistoryItem[] {
  const r = i.request;
  const items: CobroDetailHistoryItem[] = [
    { at: r.createdAt.toISOString(), what: 'Cobro creado', detail: nameOf(i.people.get(r.requestedByUserId)) },
  ];
  if (r.status === 'ACCEPTED' && r.decidedAt) {
    const via = saldoVia(i.consumption?.authMethod ?? null);
    const balance = balanceOf(settled);
    const screenBy = screenTextOf(settled, i.people.get(r.requestedByUserId));
    items.push({
      at: r.decidedAt.toISOString(),
      what: screenBy ? `Pagado con ficha ${screenBy}` : 'Pagado con el saldo',
      detail: [via, balance ? `saldo ${eurText(balance.beforeCents)} → ${eurText(balance.afterCents)}` : null].filter(Boolean).join(' · ') || null,
    });
  } else if (r.status !== 'PENDING' && r.status !== 'ACCEPTED') {
    items.push({ at: (r.decidedAt ?? r.createdAt).toISOString(), what: saldoStatusText(r.status), detail: null });
  }
  if (i.consumption?.reversedAt) {
    items.push({
      at: i.consumption.reversedAt.toISOString(),
      what: 'Anulado: el dinero volvió al saldo',
      detail: [nameOf(i.people.get(i.consumption.reversedByUserId ?? '')), reversalReasonOf(i.consumption.notes, i.audits)]
        .filter(Boolean)
        .join(' · ') || null,
    });
  }
  for (const e of i.linkedEvents) {
    if (e.eventType === PAYMENT_DEVICE_EVENT || e.eventType === 'payment.created' || e.eventType === 'payment.canceled') continue;
    items.push({ at: e.occurredAt.toISOString(), what: EVENT_TEXT[e.eventType] ?? e.eventType, detail: eventDetail(e.eventType, payloadOf(e), i.people) });
  }
  items.push(
    ...auditHistory(
      i.audits.filter((a) => a.action !== 'wallet.consumption.reversed' && a.action !== WALLET_CHARGE_SETTLED_ACTION),
      i.people,
    ),
  );
  return items.sort((a, b) => a.at.localeCompare(b.at));
}

function auditHistory(audits: readonly AuditRow[], people: ReadonlyMap<string, PersonLike>): CobroDetailHistoryItem[] {
  return audits
    .filter((a) => a.action !== WALLET_CHARGE_SETTLED_ACTION && a.action !== WALLET_CHARGE_CREATED_ACTION)
    .map((a) => ({
      at: a.occurredAt.toISOString(),
      what: AUDIT_TEXT[a.action] ?? `Registro: ${a.action}`,
      detail: nameOf(people.get(a.actorId ?? '')),
    }));
}

function eventDetail(type: string, p: Record<string, unknown>, people: ReadonlyMap<string, PersonLike>): string | null {
  if (type === 'payment.created') return typeof p.amountCents === 'number' ? eurText(p.amountCents) : null;
  if (type === 'payment.authorized') return stringOf(p.providerTxId) ? `Pedido ${stringOf(p.providerTxId)}` : null;
  if (type === 'payment.failed' || type === 'payment.checkout_failed') return stringOf(p.reason);
  if (type === 'payment.refund_partial') return typeof p.amountCents === 'number' ? eurText(p.amountCents) : null;
  if (type === 'payment.canceled') return nameOf(people.get(stringOf(p.byUserId) ?? ''));
  if (type === 'pos.confirmed') return nameOf(people.get(stringOf(p.confirmedByUserId) ?? ''));
  if (type === WALLET_CREDITED_EVENT) {
    const b = balanceOf(p);
    return b ? `saldo ${eurText(b.beforeCents)} → ${eurText(b.afterCents)}` : null;
  }
  return null;
}

function refundStatusText(status: string): string {
  return status === 'SUCCEEDED' ? 'hecha' : status === 'FAILED' ? 'falló' : 'sin confirmar';
}

function saldoStatusText(status: string): string {
  return status === 'EXPIRED' ? 'Caducó sin pagar' : status === 'CANCELED' ? 'Cancelado' : status === 'REJECTED' ? 'Rechazado' : status;
}

export function payloadOf(e: { payload: unknown }): Record<string, unknown> {
  return e.payload && typeof e.payload === 'object' && !Array.isArray(e.payload) ? (e.payload as Record<string, unknown>) : {};
}

function stringOf(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function sum<T>(xs: readonly T[], f: (x: T) => number): number {
  return xs.reduce((a, x) => a + f(x), 0);
}

function eurText(cents: number): string {
  return formatMoney(cents);
}
