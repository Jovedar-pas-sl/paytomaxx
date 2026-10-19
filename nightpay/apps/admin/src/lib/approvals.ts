// «Por aprobar»: textos y cuentas de las tarjetas (funciones puras, sin React).
// El encargado pide; el dueño aprueba con 2FA o rechaza con el motivo.

import type { ApprovalStatus, ApprovalView, PayoutMethod } from '@nightpay/contracts';
import { formatEur } from './money';

type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export const APPROVAL_STATUS: Record<ApprovalStatus, { label: string; tone: Tone }> = {
  PENDING: { label: 'Esperando al dueño', tone: 'warning' },
  APPROVED: { label: 'Aprobada', tone: 'success' },
  REJECTED: { label: 'Rechazada', tone: 'danger' },
  EXPIRED: { label: 'Caducada', tone: 'neutral' },
  FAILED: { label: 'No se pudo hacer', tone: 'danger' },
};

export function kindLabel(v: Pick<ApprovalView, 'kind'>): string {
  return v.kind === 'PAYOUT' ? 'Pago a chica' : 'Devolución';
}

/** Nombre corto del método ("USDT TRC20"); quien llama pasa la tabla de nombres. */
export type MethodLabel = (method: PayoutMethod) => string;

/** A quién va: "Lola · USDT TRC20 · T…9f2a" o "Cobro de 200,00 € · tarjeta ••4242". */
export function approvalTarget(v: ApprovalView, methodLabel: MethodLabel): string {
  if (v.kind === 'PAYOUT') {
    const p = v.payout;
    return [p.operatorName, p.method ? methodLabel(p.method) : null, p.accountMasked].filter(Boolean).join(' · ');
  }
  const r = v.refund;
  const card = r.cardLast4 ? ` · tarjeta ••${r.cardLast4}` : '';
  return `Cobro de ${formatEur(r.paymentAmountCents)}${card}`;
}

/** El motivo o las notas que puso quien lo pidió (null si no puso nada). */
export function approvalReason(v: ApprovalView): string | null {
  const text = v.kind === 'PAYOUT' ? v.payout.notes : v.refund.reason;
  return text?.trim() ? text.trim() : null;
}

const IRREVERSIBLE = 'No se puede deshacer.';

/** La frase antes de aprobar (ConfirmLine): cuánto, a quién, por dónde y desde qué local. */
export function approveSummary(v: ApprovalView, venueName: string, methodLabel: MethodLabel): string {
  const amount = formatEur(v.amountCents);
  if (v.kind === 'PAYOUT') {
    const p = v.payout;
    const via = p.method ? ` en ${methodLabel(p.method)}` : '';
    // Ya viene tapada del API (la de cuando se pidió).
    const to = p.accountMasked ? ` a ${p.accountMasked}` : '';
    return `Vas a aprobar el pago de ${amount} a ${p.operatorName}${via}${to} desde ${venueName}. ${IRREVERSIBLE}`;
  }
  const to = v.refund.cardLast4 ? `a la tarjeta ••${v.refund.cardLast4}` : 'al cliente de ese cobro';
  return `Vas a aprobar devolver ${amount} ${to} desde ${venueName}. ${IRREVERSIBLE}`;
}

const MINUTE = 60_000;

function span(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / MINUTE));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} días`;
}

/** "ahora", "hace 12 min", "hace 3 h". */
export function timeAgo(iso: string, now: Date): string {
  const ms = now.getTime() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  return ms < MINUTE ? 'ahora' : `hace ${span(ms)}`;
}

/** "caduca en 40 min" / "caduca en 23 h"; "caducada" si ya pasó. */
export function expiresIn(iso: string, now: Date): string {
  const ms = Date.parse(iso) - now.getTime();
  if (!Number.isFinite(ms)) return '';
  return ms <= 0 ? 'caducada' : `caduca en ${span(Math.max(ms, MINUTE))}`;
}

/** Qué pasó con una solicitud, en una línea (para el encargado). */
export function decisionLine(v: ApprovalView, now: Date): string {
  switch (v.status) {
    case 'PENDING':
      // El estado ya lo dice la etiqueta: aquí, cuándo se pidió y cuándo caduca.
      return `Pedida ${timeAgo(v.requestedAt, now)} · ${expiresIn(v.expiresAt, now)}`;
    case 'APPROVED':
      return `Aprobada${v.decidedBy ? ` por ${v.decidedBy.name}` : ''}${v.decidedAt ? ` ${timeAgo(v.decidedAt, now)}` : ''}`;
    case 'REJECTED':
      return `Rechazada${v.decidedBy ? ` por ${v.decidedBy.name}` : ''}: ${v.decisionNote ?? 'sin motivo'}`;
    case 'EXPIRED':
      return 'Caducó sin decidir (24 h): pídelo otra vez si hace falta.';
    case 'FAILED':
      return `No se pudo hacer: ${v.failureReason ?? 'sin motivo'}`;
  }
}

/** Pendientes primero (la más antigua arriba: es la que antes caduca); luego lo decidido, lo último arriba. */
export function sortApprovals(items: readonly ApprovalView[]): ApprovalView[] {
  const pending = items.filter((i) => i.status === 'PENDING').sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  const decided = items
    .filter((i) => i.status !== 'PENDING')
    .sort((a, b) => (b.decidedAt ?? b.requestedAt).localeCompare(a.decidedAt ?? a.requestedAt));
  return [...pending, ...decided];
}

/** Las que puede decidir quien mira (para el globo de la barra). */
export function decidableCount(items: readonly ApprovalView[] | null): number | null {
  return items ? items.filter((i) => i.status === 'PENDING' && i.canDecide).length : null;
}

/** Lo que se le dice al dueño al aprobarla. */
export function approvedMessage(v: ApprovalView): string {
  const amount = formatEur(v.amountCents);
  return v.kind === 'PAYOUT'
    ? `Aprobado: pago de ${amount} a ${v.payout.operatorName} apuntado.`
    : `Aprobada: devolución de ${amount} hecha.`;
}

/** La frase antes de pedirlo (el encargado): no mueve dinero hasta que el dueño apruebe. */
export function requestSummary(input: {
  kind: 'PAYOUT' | 'REFUND';
  amountCents: number;
  /** Chica (pago) o "a la tarjeta ••4242" (devolución). */
  to: string;
  venueName: string;
}): string {
  const amount = formatEur(input.amountCents);
  const what = input.kind === 'PAYOUT' ? `pagar ${amount} a ${input.to}` : `devolver ${amount} ${input.to}`;
  return `Vas a pedir al dueño que apruebe ${what} desde ${input.venueName}. No se mueve dinero hasta que lo apruebe.`;
}

/** Ya no se puede decidir desde la tarjeta: se dice arriba y se refresca la lista. */
const FINAL_CODES: ReadonlySet<string> = new Set([
  'APPROVAL_FAILED',
  'APPROVAL_NOT_PENDING',
  'APPROVAL_EXPIRED',
  'REFUND_OUTCOME_UNKNOWN',
]);

const ENROL_TEXT =
  'Para aprobar hace falta tu app de verificación (2FA): actívala en Ajustes → Verificación en dos pasos.';
const LOST_TEXT =
  'No se pudo confirmar con el servidor. Mira la lista antes de volver a probar: puede que sí se aprobara.';

export type ApproveFailure =
  /** Ya no se decide aquí (hecha, fallida, caducada, sin respuesta): aviso arriba y refrescar. */
  | { kind: 'done'; tone: 'danger' | 'warning'; text: string }
  /** Sin 2FA activada: no sirve probar otro código. */
  | { kind: 'enrol'; text: string }
  /** Corregir y volver a probar (con el campo vacío si el código no valía). */
  | { kind: 'retry'; text: string; clearCode: boolean };

/**
 * Qué hacer cuando falla «Aprobar». `err` = el error del API (estado, código
 * y mensaje) o null si ni contestó (sin red): entonces no se sabe si se
 * aprobó y se manda mirar la lista.
 */
export function approveFailure(err: { status: number; code: string | null; message: string } | null): ApproveFailure {
  if (!err || err.status === 0) return { kind: 'done', tone: 'warning', text: LOST_TEXT };
  if (err.code && FINAL_CODES.has(err.code)) {
    return { kind: 'done', tone: err.code === 'REFUND_OUTCOME_UNKNOWN' ? 'warning' : 'danger', text: err.message };
  }
  if (err.code === 'TOTP_NOT_ENROLLED' || err.code === 'TOTP_UNREADABLE') return { kind: 'enrol', text: ENROL_TEXT };
  return { kind: 'retry', text: err.message, clearCode: err.code === 'TOTP_INVALID' };
}

/** El motivo del rechazo: obligatorio (lo lee el encargado). null = vale. */
export function rejectNoteProblem(note: string): string | null {
  return note.trim().length < 3 ? 'Explica por qué la rechazas (mínimo 3 letras).' : null;
}

/** ¿Esta devolución la pide el encargado al dueño? (`fromCents` null = nunca, el dueño). */
export function refundGoesToApproval(fromCents: number | null | undefined, cents: number): boolean {
  return typeof fromCents === 'number' && Number.isFinite(cents) && cents >= fromCents;
}
