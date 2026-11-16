import { z } from 'zod';
import { RoleSchema } from './auth';
import { UuidSchema } from './common';
import { PayoutMethodSchema } from './operators';

// ═══════════════════════════════════════════════════════════════════════
// «Por aprobar»: el encargado pide, el dueño aprueba con 2FA.
//
//  - Pagos a las chicas, si el local tiene payoutRequiresApproval.
//  - Devoluciones por la pasarela desde refundApprovalThresholdCents.
//
// El encargado llama a los endpoints de siempre (POST /v1/admin/operators/:id/payouts
// y POST /v1/payments/:id/refunds): si hace falta aprobación responden 202
// con ApprovalRequestedResponse en vez de hacerlo. Quien pide nunca aprueba
// (tampoco un dueño ni un super-admin). Ver docs/APROBACIONES.md.
//
//   GET  /v1/approvals?status=PENDING   → { items: ApprovalView[] }
//   GET  /v1/approvals/rules            → ApprovalRules
//   POST /v1/approvals/:id/approve      ApproveApprovalDto → ApprovalView
//   POST /v1/approvals/:id/reject       RejectApprovalDto  → ApprovalView
// ═══════════════════════════════════════════════════════════════════════

export const ApprovalKindSchema = z.enum(['PAYOUT', 'REFUND']);
export type ApprovalKind = z.infer<typeof ApprovalKindSchema>;

export const ApprovalStatusSchema = z.enum(['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'FAILED']);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

/** Una solicitud sin decidir caduca a las 24 h (deja de reservar). */
export const APPROVAL_TTL_HOURS = 24;
export const APPROVAL_TTL_MS = APPROVAL_TTL_HOURS * 60 * 60 * 1000;
/** Pendiente desde hace más de esto: sale en Incidencias. */
export const APPROVAL_INCIDENT_MINUTES = 30;

/** Lo que se le dice al encargado al pedir. */
export const APPROVAL_REQUESTED_MESSAGE = 'Pedido al dueño. Te avisamos cuando lo apruebe.';

/** Cuándo caduca una solicitud pedida en `requestedAt`. */
export function approvalExpiresAt(requestedAt: Date): Date {
  return new Date(requestedAt.getTime() + APPROVAL_TTL_MS);
}

/** ¿Una solicitud pendiente pedida en `requestedAt` ya ha caducado? */
export function isApprovalExpired(requestedAt: Date, now: Date): boolean {
  return now.getTime() >= approvalExpiresAt(requestedAt).getTime();
}

// ─── Respuesta 202 de los endpoints de siempre ──────────────────────────

export const ApprovalRequestedResponseSchema = z.object({
  approvalRequestId: UuidSchema,
  status: z.literal('PENDING'),
  kind: ApprovalKindSchema,
  amountCents: z.number().int().positive(),
  message: z.string(),
});
export type ApprovalRequestedResponse = z.infer<typeof ApprovalRequestedResponseSchema>;

/** ¿Es la respuesta 202 «pedido al dueño»? (el panel la distingue de un pago o devolución hecho). */
export function isApprovalRequested(body: unknown): body is ApprovalRequestedResponse {
  return ApprovalRequestedResponseSchema.safeParse(body).success;
}

// ─── Lectura ────────────────────────────────────────────────────────────

export const ApprovalListQuerySchema = z.object({
  status: ApprovalStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ApprovalListQuery = z.infer<typeof ApprovalListQuerySchema>;

const PersonSchema = z.object({
  id: UuidSchema,
  /** Nombre visible o, si no tiene, el principio del email. */
  name: z.string(),
  role: RoleSchema.nullable(),
});

/** A quién se paga: la chica y su cuenta tapada (la de cuando se pidió). */
export const PayoutApprovalTargetSchema = z.object({
  operatorId: UuidSchema,
  operatorName: z.string(),
  method: PayoutMethodSchema.nullable(),
  /** "T…9f2a", "ES12 •••• •••• 1234", "a•••@dominio"; null si no tiene cuenta (efectivo…). */
  accountMasked: z.string().nullable(),
  payoutLabel: z.string().nullable(),
  /** Comisiones que entran (las de cuando se pidió, ni una más). */
  earningCount: z.number().int().nonnegative(),
  externalTxId: z.string().nullable(),
  receiptUrl: z.string().nullable(),
  notes: z.string().nullable(),
});
export type PayoutApprovalTarget = z.infer<typeof PayoutApprovalTargetSchema>;

/** Qué cobro se devuelve. */
export const RefundApprovalTargetSchema = z.object({
  paymentId: UuidSchema,
  /** Lo cobrado (importe + propina). */
  paymentAmountCents: z.number().int().nonnegative(),
  paymentCreatedAt: z.string().datetime(),
  cardLast4: z.string().nullable(),
  cardBrand: z.string().nullable(),
  provider: z.string().nullable(),
  reason: z.string().nullable(),
  /**
   * En efectivo (lo pagado con bitcoin): al aprobarla no sale nada; quien lo
   * pidió da el dinero y pulsa «Entregado» (hasta `handUntil`). Sin el campo,
   * una devolución de siempre.
   */
  cash: z
    .object({
      /** Un cobro pagado con bitcoin, o el bitcoin que llegó sin cobro (su factura). */
      source: z.enum(['payment', 'invoice']),
      invoiceId: z.string().nullable(),
      handed: z.boolean(),
      handUntil: z.string().datetime().nullable(),
    })
    .optional(),
});
export type RefundApprovalTarget = z.infer<typeof RefundApprovalTargetSchema>;

const ApprovalBaseSchema = z.object({
  id: UuidSchema,
  status: ApprovalStatusSchema,
  amountCents: z.number().int().positive(),
  requestedAt: z.string().datetime(),
  /** Si sigue pendiente, cuándo caduca. */
  expiresAt: z.string().datetime(),
  requestedBy: PersonSchema,
  decidedAt: z.string().datetime().nullable(),
  decidedBy: PersonSchema.nullable(),
  decisionNote: z.string().nullable(),
  failureReason: z.string().nullable(),
  /** Id del pago a la chica o de la devolución que salió al aprobarla. */
  resultRef: UuidSchema.nullable(),
  /** Quien mira puede aprobarla o rechazarla (dueño, pendiente y no la pidió él). */
  canDecide: z.boolean(),
});

export const ApprovalViewSchema = z.discriminatedUnion('kind', [
  ApprovalBaseSchema.extend({ kind: z.literal('PAYOUT'), payout: PayoutApprovalTargetSchema }),
  ApprovalBaseSchema.extend({ kind: z.literal('REFUND'), refund: RefundApprovalTargetSchema }),
]);
export type ApprovalView = z.infer<typeof ApprovalViewSchema>;

export const ApprovalListResponseSchema = z.object({ items: z.array(ApprovalViewSchema) });
export type ApprovalListResponse = z.infer<typeof ApprovalListResponseSchema>;

/** Qué le toca a quien mira según las reglas del local. */
export const ApprovalRulesSchema = z.object({
  payoutRequiresApproval: z.boolean(),
  refundApprovalThresholdCents: z.number().int().nonnegative(),
  /** Pagar a una chica: directo (2FA si la tiene), directo con 2FA obligatoria, o pedirlo. */
  payout: z.enum(['direct', 'direct_2fa', 'request', 'forbidden']),
  /** Devoluciones desde este importe se piden al dueño; null = nunca (dueño). */
  refundRequestFromCents: z.number().int().nonnegative().nullable(),
});
export type ApprovalRules = z.infer<typeof ApprovalRulesSchema>;

// ─── Escritura ──────────────────────────────────────────────────────────

/**
 * Aprobar: el código de la app de verificación del dueño (acepta "123 456").
 * Sin 2FA, sin código: la prueba de su llave de acceso (cabecera X-Step-Up-Token).
 */
export const ApproveApprovalSchema = z.object({
  totpCode: z
    .string()
    .max(20)
    .transform((s) => s.replace(/\s+/g, ''))
    .pipe(z.string().regex(/^\d{6}$/, 'El código 2FA son 6 cifras'))
    .optional(),
});
export type ApproveApprovalDto = z.infer<typeof ApproveApprovalSchema>;

/** Rechazar: siempre con el motivo (lo ve el encargado). */
export const RejectApprovalSchema = z.object({
  note: z.string().trim().min(3, 'Explica por qué (mínimo 3 letras)').max(500),
});
export type RejectApprovalDto = z.infer<typeof RejectApprovalSchema>;
