import {
  CHARGE_METHOD_LABELS,
  confirmationCode,
  formatChargeRef,
  type ChargeLineView,
  type ChargeMethod,
  type CobroPerson,
  type CobroRow,
  type SectionAmount,
} from '@nightpay/contracts';
import { cardBrandLabel } from '../payments/card-brand';
import { lineViews } from '../payments/charge-lines';
import { paidTwiceOf } from '../payments/late-card-approval';

/**
 * El mapa del dinero en el panel (lógica pura): una fila de la lista de
 * cobros a partir de un cobro con tarjeta o de un cobro del saldo, con su
 * referencia, quién cobró, en qué sección cayó, cómo pagó y qué se vendió.
 */

export interface StoredLineLike {
  category: string;
  label: string;
  qty: number;
  unitCents: number;
  amountCents: number;
  serviceItemId: string | null;
  /** «Copa con invitación»: la chica invitada. */
  beneficiary?: PersonLike | null;
}

export interface PersonLike {
  id: string;
  displayName: string | null;
  email: string;
  role: string;
}

export interface PaymentFeedRow {
  id: string;
  ref: number | null;
  createdAt: Date;
  updatedAt: Date;
  amountCents: number;
  tipCents: number;
  /** «Comisión del servicio» del cobro (sin el campo: 0). */
  serviceFeeCents?: number;
  availableAmountCents: number;
  currency: string;
  status: string;
  provider: string | null;
  providerTxId: string | null;
  captureMethod: string | null;
  revenueCategory: string;
  serviceName: string | null;
  walletId: string | null;
  posOperationNumber: string | null;
  authCode: string | null;
  cardLast4: string | null;
  cardBrand: string | null;
  payMethodCode: string | null;
  authorizedAt: Date | null;
  attempts: Array<{
    providerTxId: string;
    status: string;
    createdAt: Date;
    amountCents: number | null;
    tipCents: number | null;
    payMethod: string | null;
  }>;
  terminal: { externalId: string; label: string };
  createdBy: PersonLike | null;
  wallet: { id: string; shortCode: string | null } | null;
  lines: StoredLineLike[];
  /** Tarjeta aprobada después de pagar con el saldo (late-card-approval): «cobrado dos veces». */
  events?: ReadonlyArray<{ eventType: string; payload: unknown }>;
}

export interface SaldoFeedRow {
  id: string;
  linkedPaymentId?: string | null;
  ref: number | null;
  createdAt: Date;
  amountCents: number;
  category: string;
  serviceName: string | null;
  status: string;
  person: PersonLike | null;
  wallet: { id: string; shortCode: string | null } | null;
  /** El consumo se anuló (devuelto al saldo). */
  reversed: boolean;
  tipCents: number;
  /** Cómo se autorizó el consumo (wallet_consumptions.authMethod). */
  authMethod?: string | null;
  lines: StoredLineLike[];
}

/**
 * Cómo se autorizó un cobro del saldo. Con PIN no se guarda si se leyó la
 * ficha o se tecleó el código (solo va al registro): sale «PIN».
 */
const AUTH_VIA: Readonly<Record<string, string>> = {
  nfc_nopin: 'NFC sin PIN',
  pin: 'PIN',
  passkey: 'Face ID',
  staff: 'Personal',
};

/** Por dónde se autorizó un cobro del saldo («NFC», «PIN», «Face ID»…); null si es de antes. */
export function saldoVia(authMethod: string | null | undefined): string | null {
  return authMethod ? (AUTH_VIA[authMethod] ?? null) : null;
}

/** Por dónde se cobró uno con tarjeta: el datáfono o el QR en el móvil del cliente (las recargas: null). */
export function paymentVia(method: ChargeMethod | null, isTopUp: boolean): string | null {
  if (isTopUp || !method) return null;
  return method === 'POS' ? 'Datáfono' : 'QR';
}

export function personOf(u: PersonLike | null | undefined): CobroPerson | null {
  return u ? { id: u.id, name: u.displayName?.trim() || u.email, role: u.role } : null;
}

/** La chica invitada de un cobro (la de su primera línea de invitación). */
export function invitedOf(lines: readonly StoredLineLike[]): CobroPerson | null {
  return personOf(lines.find((l) => l.beneficiary)?.beneficiary ?? null);
}

/** Las líneas para las apps, con la chica invitada si la hay. */
function rowLines(lines: readonly StoredLineLike[]): ChargeLineView[] {
  return lineViews(lines).map((v, i) => ({ ...v, beneficiaryOperatorId: lines[i]?.beneficiary?.id ?? null }));
}

/** «K7Q-•••»: el saldo se reconoce sin enseñar su código entero. */
export function walletHint(shortCode: string | null | undefined): string {
  return `${(shortCode ?? '').slice(0, 3)}-•••`;
}

/** Lo cobrado de cada sección (en orden de aparición). Sin líneas (cobros antiguos): su categoría. */
export function sectionsOfLines(lines: readonly StoredLineLike[], legacyCategory: string | null, amountCents: number): SectionAmount[] {
  if (lines.length === 0) return legacyCategory ? [{ category: legacyCategory, amountCents }] : [];
  const totals = new Map<string, number>();
  for (const l of lines) totals.set(l.category, (totals.get(l.category) ?? 0) + l.amountCents);
  return [...totals].map(([category, total]) => ({ category, amountCents: total }));
}

/** Cómo pagó un cobro con tarjeta: datáfono, Apple Pay / Google Pay o tarjeta (sin pagar aún: null). */
export function paymentMethodOf(p: {
  captureMethod: string | null;
  posOperationNumber: string | null;
  authorizedAt: Date | null;
  attempts: ReadonlyArray<{ status: string; payMethod: string | null }>;
}): ChargeMethod | null {
  if (p.captureMethod === 'POS_EXTERNAL' || p.posOperationNumber) return 'POS';
  const approved = p.attempts.find((a) => a.status === 'APPROVED');
  if (approved?.payMethod === 'wallet') return 'MOBILE_WALLET';
  if (approved || p.authorizedAt) return 'CARD';
  return null;
}

export function paymentMethodLabel(method: ChargeMethod | null, p: Pick<PaymentFeedRow, 'cardBrand' | 'cardLast4'>): string {
  if (!method) return '—';
  const card = [cardBrandLabel(p.cardBrand), p.cardLast4 ? `••${p.cardLast4}` : null].filter(Boolean).join(' ');
  return card && method !== 'MOBILE_WALLET' ? `${CHARGE_METHOD_LABELS[method]} ${card}` : CHARGE_METHOD_LABELS[method];
}

export function paymentCobroRow(p: PaymentFeedRow): CobroRow {
  const isTopUp = p.walletId !== null;
  const method = paymentMethodOf(p);
  const lines = rowLines(p.lines);
  return {
    kind: 'PAYMENT',
    id: p.id,
    confirmationCode: confirmationCode(p.id),
    ref: formatChargeRef(p.ref),
    createdAt: p.createdAt.toISOString(),
    amountCents: p.amountCents,
    tipCents: p.tipCents,
    serviceFeeCents: p.serviceFeeCents ?? 0,
    currency: p.currency,
    status: p.status,
    person: personOf(p.createdBy),
    sections: isTopUp ? [] : sectionsOfLines(p.lines, p.revenueCategory, p.amountCents),
    isTopUp,
    method,
    methodLabel: paymentMethodLabel(method, p),
    via: paymentVia(method, isTopUp),
    wallet: p.wallet ? { id: p.wallet.id, codeHint: walletHint(p.wallet.shortCode) } : null,
    service: p.serviceName,
    invited: invitedOf(p.lines),
    lines,
    payment: {
      availableAmountCents: p.availableAmountCents,
      provider: p.provider,
      providerTxId: p.attempts.find((a) => a.status === 'APPROVED')?.providerTxId ?? p.providerTxId ?? p.posOperationNumber,
      captureMethod: p.captureMethod,
      updatedAt: p.updatedAt.toISOString(),
      authCode: p.authCode,
      cardLast4: p.cardLast4,
      cardBrand: p.cardBrand,
      payMethodCode: p.payMethodCode,
      authorizedAt: p.authorizedAt?.toISOString() ?? null,
      attempts: p.attempts.map((a) => ({
        providerTxId: a.providerTxId,
        status: a.status,
        createdAt: a.createdAt.toISOString(),
        amountCents: a.amountCents,
        tipCents: a.tipCents,
      })),
      terminal: p.terminal,
    },
    paidTwice: paidTwiceOf(p.events ?? []),
  };
}

export function saldoCobroRow(s: SaldoFeedRow): CobroRow {
  const hint = walletHint(s.wallet?.shortCode);
  return {
    kind: 'SALDO',
    id: s.id,
    confirmationCode: s.linkedPaymentId ? confirmationCode(s.linkedPaymentId) : null,
    ref: formatChargeRef(s.ref),
    createdAt: s.createdAt.toISOString(),
    amountCents: s.amountCents,
    tipCents: s.tipCents,
    currency: 'EUR',
    status: s.reversed ? 'REVERSED' : s.status,
    person: personOf(s.person),
    sections: sectionsOfLines(s.lines, s.category, s.amountCents),
    isTopUp: false,
    method: 'SALDO',
    methodLabel: `${CHARGE_METHOD_LABELS.SALDO} ${hint}`,
    via: saldoVia(s.authMethod),
    wallet: s.wallet ? { id: s.wallet.id, codeHint: hint } : null,
    service: s.serviceName,
    invited: invitedOf(s.lines),
    lines: rowLines(s.lines),
    payment: null,
  };
}

// ─── Paginación por (fecha, id) de dos tablas a la vez ────────────────

export interface FeedCursor {
  at: Date;
  id: string;
}

export function encodeCursor(row: { createdAt: string; id: string }): string {
  return Buffer.from(`${row.createdAt}|${row.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | undefined): FeedCursor | null {
  if (!raw) return null;
  const [at, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  const date = at ? new Date(at) : null;
  if (!date || Number.isNaN(date.getTime()) || !id || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  return { at: date, id: id.toLowerCase() };
}

/** Más nuevo primero; a la misma hora, el id mayor (como los `where` de la siguiente página). */
export function compareFeed(a: { createdAt: string; id: string }, b: { createdAt: string; id: string }): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Junta las dos listas (cada una ya con como mucho limit + 1) en una página. */
export function mergePage(rows: CobroRow[], limit: number): { items: CobroRow[]; nextCursor: string | null } {
  const sorted = [...rows].sort(compareFeed);
  const items = sorted.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: sorted.length > limit && last ? encodeCursor(last) : null };
}
