import { ConflictException, HttpException } from '@nestjs/common';
import { isApprovalExpired, type ApprovalKind, type ApprovalRules, type ApprovalStatus, type Role } from '@nightpay/contracts';

/**
 * «Por aprobar»: quién pide, quién aprueba y qué se le dice a cada uno.
 * Funciones puras (decisiones del dueño, 2026-10-16):
 *  - El encargado PIDE los pagos a las chicas (si el local tiene
 *    payoutRequiresApproval) y las devoluciones desde el umbral del local.
 *  - El dueño APRUEBA con 2FA. Quien pide nunca decide (tampoco un dueño ni
 *    un super-admin con lo suyo).
 *  - El dueño que lo hace él mismo sigue como siempre: el pago con 2FA si la
 *    tiene, la devolución con 2FA según lo devuelto acumulado.
 *  - Sin payoutRequiresApproval el encargado paga directo, con 2FA obligatoria.
 */

/** Las reglas del local (las pone el super-admin). */
export interface VenueApprovalRules {
  payoutRequiresApproval: boolean;
  refundApprovalThresholdCents: number;
}

export type PayoutRoute =
  | { kind: 'direct'; twoFactor: 'if_enrolled' | 'required' }
  | { kind: 'request' }
  | { kind: 'forbidden' };

export type RefundRoute = 'direct' | 'request' | 'forbidden';

/** Pagar a una chica: quién lo hace directo y con qué 2FA, y quién lo pide. */
export function payoutRoute(role: Role, venue: VenueApprovalRules): PayoutRoute {
  if (role === 'OWNER') return { kind: 'direct', twoFactor: 'if_enrolled' };
  if (role === 'MANAGER') {
    return venue.payoutRequiresApproval ? { kind: 'request' } : { kind: 'direct', twoFactor: 'required' };
  }
  return { kind: 'forbidden' };
}

/**
 * Devolver por la pasarela: el encargado pide desde el umbral del local
 * (incluido), contando lo ya devuelto por la pasarela en ese mismo cobro por
 * cualquiera: partirla en trozos de 99 € (o repartirla entre dos encargados)
 * no se salta al dueño.
 */
export function refundRoute(
  role: Role,
  amountCents: number,
  venue: VenueApprovalRules,
  alreadyOnPaymentCents = 0,
): RefundRoute {
  if (role === 'OWNER') return 'direct';
  if (role === 'MANAGER') {
    return amountCents + alreadyOnPaymentCents >= venue.refundApprovalThresholdCents ? 'request' : 'direct';
  }
  return 'forbidden';
}

/** La devolución que el encargado iba a hacer directa llega ya al umbral (con el cobro bloqueado). */
export const REFUND_NEEDS_APPROVAL_CODE = 'REFUND_NEEDS_APPROVAL';

export function refundNeedsApproval(totalCents: number, thresholdCents: number): ConflictException {
  return new ConflictException({
    message: `En este cobro ya se devolverían ${eurShort(totalCents)} entre todos: desde ${eurShort(thresholdCents)} lo aprueba el dueño.`,
    code: REFUND_NEEDS_APPROVAL_CODE,
  });
}

export function isRefundNeedsApproval(err: unknown): boolean {
  if (!(err instanceof ConflictException)) return false;
  const body = err.getResponse();
  return typeof body === 'object' && body !== null && (body as { code?: unknown }).code === REFUND_NEEDS_APPROVAL_CODE;
}

/** Lo que el panel necesita saber para pintar «Marcar pagado» / «Pedir al dueño». */
export function rulesFor(role: Role, venue: VenueApprovalRules): ApprovalRules {
  const payout = payoutRoute(role, venue);
  return {
    payoutRequiresApproval: venue.payoutRequiresApproval,
    refundApprovalThresholdCents: venue.refundApprovalThresholdCents,
    payout:
      payout.kind === 'request'
        ? 'request'
        : payout.kind === 'forbidden'
          ? 'forbidden'
          : payout.twoFactor === 'required'
            ? 'direct_2fa'
            : 'direct',
    refundRequestFromCents: role === 'MANAGER' ? venue.refundApprovalThresholdCents : null,
  };
}

export type DecisionProblem = 'not_owner' | 'own_request' | 'not_pending' | 'expired';

/**
 * ¿Puede esta persona aprobar o rechazar? Solo el dueño, solo pendientes sin
 * caducar y nunca lo que pidió ella misma (separación de funciones, también
 * para el super-admin). null = sí.
 */
export function decisionProblem(
  actor: { userId: string; role: Role },
  request: { requestedById: string; status: ApprovalStatus; requestedAt: Date },
  now: Date,
): DecisionProblem | null {
  if (actor.role !== 'OWNER') return 'not_owner';
  if (request.status !== 'PENDING') return 'not_pending';
  if (isApprovalExpired(request.requestedAt, now)) return 'expired';
  if (request.requestedById === actor.userId) return 'own_request';
  return null;
}

export const DECISION_MESSAGES: Record<DecisionProblem, string> = {
  not_owner: 'Solo el dueño aprueba o rechaza.',
  own_request: 'No puedes decidir sobre lo que has pedido tú: lo aprueba otra persona.',
  not_pending: 'Esta solicitud ya no está pendiente.',
  expired: 'Esta solicitud ha caducado (pasaron 24 h): que la pidan otra vez.',
};

const STATUS_TEXT: Record<ApprovalStatus, string> = {
  PENDING: 'pendiente',
  APPROVED: 'aprobada',
  REJECTED: 'rechazada',
  EXPIRED: 'caducada',
  FAILED: 'fallida',
};

export function notPendingMessage(status: ApprovalStatus): string {
  return `Esta solicitud ya está ${STATUS_TEXT[status]}.`;
}

/**
 * ¿El error al hacer lo aprobado es de las cosas (ya pagado, no cabe, cobro
 * que ya no se puede devolver…) y no un fallo pasajero? Entonces la solicitud
 * queda fallida con la razón; si no (base caída…), sigue pendiente y se reintenta.
 */
export function isLastingFailure(err: unknown): err is HttpException {
  if (!(err instanceof HttpException)) return false;
  const status = err.getStatus();
  return status === 400 || status === 404 || status === 409 || status === 422;
}

/** El texto para el encargado y el registro. */
export function failureReasonOf(err: unknown): string {
  if (err instanceof HttpException) {
    const body = err.getResponse();
    if (typeof body === 'string') return clip(body);
    const message = (body as { message?: unknown }).message;
    if (typeof message === 'string') return clip(message);
    if (Array.isArray(message)) return clip(message.join(' · '));
    return clip(err.message);
  }
  return clip(err instanceof Error ? err.message : String(err));
}

function clip(text: string): string {
  return text.length > 500 ? `${text.slice(0, 497)}…` : text;
}

/** "140 €" o "140,50 €" (Telegram y textos cortos). */
export function eurShort(cents: number): string {
  const whole = cents % 100 === 0;
  return `${whole ? String(cents / 100) : (cents / 100).toFixed(2).replace('.', ',')} €`;
}

/** Nombre para enseñar: el visible o, si no tiene, el principio del email. */
export function personName(user: { displayName: string | null; email: string } | null | undefined): string {
  const name = user?.displayName?.trim();
  if (name) return name;
  const local = user?.email.split('@')[0]?.trim();
  return local || 'Alguien';
}

const ROLE_TEXT: Partial<Record<Role, string>> = { MANAGER: 'encargado/a', OWNER: 'dueño/a' };

/**
 * Aviso por Telegram de una solicitud nueva. Corto y para el móvil; sin datos
 * del cliente (Telegram es un tercero). El nombre de la chica sí va: lo pidió
 * el dueño para saber de un vistazo qué aprueba.
 */
export function requestAlertText(input: {
  venueName: string;
  kind: ApprovalKind;
  requester: string;
  requesterRole: Role | null;
  amountCents: number;
  operatorName?: string | null;
  paymentAmountCents?: number | null;
}): string {
  const who = input.requesterRole && ROLE_TEXT[input.requesterRole] ? `${input.requester} (${ROLE_TEXT[input.requesterRole]})` : input.requester;
  const what =
    input.kind === 'PAYOUT'
      ? `pide pagar ${eurShort(input.amountCents)} a ${input.operatorName ?? 'una chica'}`
      : `pide devolver ${eurShort(input.amountCents)}${
          input.paymentAmountCents ? ` de un cobro de ${eurShort(input.paymentAmountCents)}` : ''
        }`;
  return `🔔 ${input.venueName}: ${who} ${what}. Aprueba en el panel (Por aprobar).`;
}

/** La marca de «ya avisado» es la misma que usan las alertas de Incidencias: no se repite. */
export function approvalAlertKey(tenantId: string, approvalId: string): string {
  return `np:alert:${tenantId}:approval_pending:${approvalId}`;
}
