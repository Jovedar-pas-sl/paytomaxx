import type { ApprovalProof } from '../gateways/gateway.adapter';

/**
 * ¿Se puede dar un cobro por pagado con la prueba que da la pasarela?
 * Funciones puras: las usa el procesador de avisos (webhook-ingest).
 */

/** Lo que se mandó al banco en ese intento. */
export interface ExpectedCharge {
  amountCents: number;
  currency: string;
}

/** Tipos de payment_events que acaban en la bandeja de incidencias. */
export const APPROVAL_UNVERIFIED_EVENT = 'payment.approval_unverified';
export const AMOUNT_MISMATCH_EVENT = 'payment.amount_mismatch';
export const APPROVAL_UNBOOKED_EVENT = 'payment.approval_unbooked';

export type ApprovalVerdict =
  | { ok: true }
  | { ok: false; eventType: typeof APPROVAL_UNVERIFIED_EVENT; reason: string }
  | {
      ok: false;
      eventType: typeof AMOUNT_MISMATCH_EVENT;
      chargedCents: number;
      chargedCurrency: string | null;
      expectedCents: number;
      expectedCurrency: string;
    };

/**
 * Importe esperado: el del intento de ese pedido (importe + propina desde la
 * Fase 1B) o, si el intento es anterior o no existe, el importe del cobro.
 */
export function expectedCharge(
  payment: { amountCents: number; currency: string },
  attempt: { amountCents: number | null } | null,
): ExpectedCharge {
  return { amountCents: attempt?.amountCents ?? payment.amountCents, currency: payment.currency };
}

/**
 * Solo `confirmed` con el mismo importe (y moneda, si la pasarela la dice)
 * deja pasar la aprobación. `unavailable` no llega aquí: se reintenta antes.
 */
export function judgeApproval(
  proof: Exclude<ApprovalProof, { kind: 'unavailable' }>,
  expected: ExpectedCharge,
): ApprovalVerdict {
  if (proof.kind !== 'confirmed') {
    return { ok: false, eventType: APPROVAL_UNVERIFIED_EVENT, reason: proof.reason };
  }
  const sameAmount = proof.amountCents === expected.amountCents;
  const sameCurrency =
    proof.currency === null || proof.currency.toUpperCase() === expected.currency.toUpperCase();
  if (sameAmount && sameCurrency) return { ok: true };
  return {
    ok: false,
    eventType: AMOUNT_MISMATCH_EVENT,
    chargedCents: proof.amountCents,
    chargedCurrency: proof.currency,
    expectedCents: expected.amountCents,
    expectedCurrency: expected.currency,
  };
}

/** Datos que se guardan con la incidencia, según por qué no se dio por pagado. */
export function verdictDetail(verdict: Exclude<ApprovalVerdict, { ok: true }>): Record<string, unknown> {
  if (verdict.eventType === AMOUNT_MISMATCH_EVENT) {
    return {
      chargedCents: verdict.chargedCents,
      chargedCurrency: verdict.chargedCurrency,
      expectedCents: verdict.expectedCents,
      expectedCurrency: verdict.expectedCurrency,
    };
  }
  return { reason: verdict.reason };
}
