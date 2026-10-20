import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  PayoutMethodSchema,
  approvalExpiresAt,
  maskPayoutAddress,
  type ApprovalKind,
  type ApprovalStatus,
  type ApprovalView,
  type Role,
} from '@nightpay/contracts';
import { personName } from './approval-rules';

/**
 * Lo que se guarda en approval_requests.payload: todo lo necesario para hacer
 * luego lo pedido y para enseñarlo en la tarjeta. Se vuelve a validar al leer
 * (es JSON de la base, no se da por bueno).
 */

const Uuid = z.string().uuid();

export const PayoutPayloadSchema = z.object({
  operatorId: Uuid,
  operatorName: z.string(),
  /** Cómo se le paga (el elegido o el suyo guardado). */
  method: PayoutMethodSchema.nullable(),
  accountMasked: z.string().nullable(),
  /** Huella de su cuenta de cobro guardada al pedirlo: si cambia, no se aprueba. */
  accountFingerprint: z.string(),
  payoutLabel: z.string().nullable(),
  externalTxId: z.string().nullable(),
  receiptUrl: z.string().nullable(),
  notes: z.string().nullable(),
  /** Las comisiones y deudas que entran: se paga esto, ni una más. */
  earningIds: z.array(Uuid).min(1),
  debtIds: z.array(Uuid),
  holdDays: z.number().int().nonnegative(),
  /**
   * La cifra que vio quien lo pidió (si la mandó): al pedirlo era lo pagable,
   * y al aprobarlo se vuelve a comprobar (PAYOUT_CHANGED si ya es otra). Las
   * solicitudes de antes del 23-oct-2026 no la traen.
   */
  expectedTotalCents: z.number().int().positive().nullable().optional(),
});
export type PayoutPayload = z.infer<typeof PayoutPayloadSchema>;

export const RefundPayloadSchema = z.object({
  paymentId: Uuid,
  reason: z.string().nullable(),
  paymentAmountCents: z.number().int().nonnegative(),
  paymentCreatedAt: z.string().datetime(),
  cardLast4: z.string().nullable(),
  cardBrand: z.string().nullable(),
  provider: z.string().nullable(),
});
export type RefundPayload = z.infer<typeof RefundPayloadSchema>;

/** Huella de la cuenta de cobro guardada de la chica (método + dirección). */
export function accountFingerprint(saved: { payoutMethod: string | null; payoutAddress: string | null }): string {
  return createHash('sha256')
    .update(`${saved.payoutMethod ?? ''}|${saved.payoutAddress ?? ''}`)
    .digest('hex');
}

export function buildPayoutPayload(input: {
  operator: {
    id: string;
    displayName: string | null;
    email: string;
    payoutMethod: string | null;
    payoutAddress: string | null;
    payoutLabel: string | null;
  };
  method: string;
  externalTxId?: string;
  receiptUrl?: string;
  notes?: string;
  earningIds: string[];
  debtIds: string[];
  holdDays: number;
  expectedTotalCents?: number;
}): PayoutPayload {
  const { operator } = input;
  // La dirección guardada es la de su método guardado; pagando por otra vía no aplica.
  const address = input.method === operator.payoutMethod ? operator.payoutAddress : null;
  return PayoutPayloadSchema.parse({
    operatorId: operator.id,
    operatorName: personName(operator),
    method: input.method,
    accountMasked: maskPayoutAddress(input.method, address),
    accountFingerprint: accountFingerprint(operator),
    payoutLabel: operator.payoutLabel,
    externalTxId: input.externalTxId?.trim() || null,
    receiptUrl: input.receiptUrl ?? null,
    notes: input.notes?.trim() || null,
    earningIds: input.earningIds,
    debtIds: input.debtIds,
    holdDays: input.holdDays,
    expectedTotalCents: input.expectedTotalCents ?? null,
  });
}

/** Fila de approval_requests tal como se lee. */
export interface ApprovalRow {
  id: string;
  tenantId: string;
  kind: ApprovalKind;
  status: ApprovalStatus;
  targetId: string;
  amountCents: number;
  payload: unknown;
  requestedById: string;
  requestedAt: Date;
  decidedById: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  resultRef: string | null;
  failureReason: string | null;
  idempotencyKey?: string | null;
  idempotencyHash?: string | null;
}

export interface PersonRow {
  id: string;
  displayName: string | null;
  email: string;
  role: Role;
}

function person(id: string, people: ReadonlyMap<string, PersonRow>) {
  const row = people.get(id);
  return { id, name: row ? personName(row) : 'Usuario borrado', role: row?.role ?? null };
}

/** La fila para el panel (lo de la chica o del cobro sale del payload). */
export function toApprovalView(
  row: ApprovalRow,
  people: ReadonlyMap<string, PersonRow>,
  canDecide: boolean,
): ApprovalView {
  const base = {
    id: row.id,
    status: row.status,
    amountCents: row.amountCents,
    requestedAt: row.requestedAt.toISOString(),
    expiresAt: approvalExpiresAt(row.requestedAt).toISOString(),
    requestedBy: person(row.requestedById, people),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decidedBy: row.decidedById ? person(row.decidedById, people) : null,
    decisionNote: row.decisionNote,
    failureReason: row.failureReason,
    resultRef: row.resultRef,
    canDecide,
  };
  if (row.kind === 'PAYOUT') {
    const p = PayoutPayloadSchema.safeParse(row.payload);
    return {
      ...base,
      kind: 'PAYOUT',
      payout: p.success
        ? {
            operatorId: p.data.operatorId,
            operatorName: p.data.operatorName,
            method: p.data.method,
            accountMasked: p.data.accountMasked,
            payoutLabel: p.data.payoutLabel,
            earningCount: p.data.earningIds.length,
            externalTxId: p.data.externalTxId,
            receiptUrl: p.data.receiptUrl,
            notes: p.data.notes,
          }
        : {
            operatorId: row.targetId,
            operatorName: 'Chica',
            method: null,
            accountMasked: null,
            payoutLabel: null,
            earningCount: 0,
            externalTxId: null,
            receiptUrl: null,
            notes: null,
          },
    };
  }
  const r = RefundPayloadSchema.safeParse(row.payload);
  return {
    ...base,
    kind: 'REFUND',
    refund: r.success
      ? {
          paymentId: r.data.paymentId,
          paymentAmountCents: r.data.paymentAmountCents,
          paymentCreatedAt: new Date(r.data.paymentCreatedAt).toISOString(),
          cardLast4: r.data.cardLast4,
          cardBrand: r.data.cardBrand,
          provider: r.data.provider,
          reason: r.data.reason,
        }
      : {
          paymentId: row.targetId,
          paymentAmountCents: 0,
          paymentCreatedAt: row.requestedAt.toISOString(),
          cardLast4: null,
          cardBrand: null,
          provider: null,
          reason: null,
        },
  };
}
