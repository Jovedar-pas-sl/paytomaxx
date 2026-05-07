import { z } from 'zod';
import { UuidSchema } from './common';

// ─── Vistas públicas ────────────────────────────────────────────────

/** Vista de operadora para listados de admin (no expone hash, totp). */
export const OperatorPublicViewSchema = z.object({
  id: UuidSchema,
  email: z.string().email(),
  displayName: z.string().nullable(),
  commissionBps: z.number().int().nonnegative(),
  active: z.boolean(),
  createdAt: z.string().datetime(),
  invitedAt: z.string().datetime().nullable(),
});
export type OperatorPublicView = z.infer<typeof OperatorPublicViewSchema>;

/** Saldo agregado de la operadora — puede ser negativo si refunds > earnings. */
export const OperatorBalanceSchema = z.object({
  pendingCents: z.number().int(),
  paidCents: z.number().int().nonnegative(),
  lifetimeGrossCents: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
});
export type OperatorBalance = z.infer<typeof OperatorBalanceSchema>;

/** Earning individual con info del payment asociado. */
export const EarningViewSchema = z.object({
  id: UuidSchema,
  paymentId: UuidSchema,
  paymentAmountCents: z.number().int(),
  commissionBps: z.number().int(),
  commissionCents: z.number().int(),
  reversedCents: z.number().int().nonnegative(),
  netCents: z.number().int(),
  payoutId: UuidSchema.nullable(),
  paymentStatus: z.string(),
  createdAt: z.string().datetime(),
});
export type EarningView = z.infer<typeof EarningViewSchema>;

/** Liquidación pasada de admin → operadora. */
export const PayoutViewSchema = z.object({
  id: UuidSchema,
  totalCents: z.number().int(),
  paidByEmail: z.string().email().nullable(),
  notes: z.string().nullable(),
  earningCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
});
export type PayoutView = z.infer<typeof PayoutViewSchema>;

/** Vista enriquecida en el panel admin con saldo agregado. */
export const OperatorWithBalanceSchema = OperatorPublicViewSchema.extend({
  balance: OperatorBalanceSchema,
});
export type OperatorWithBalance = z.infer<typeof OperatorWithBalanceSchema>;

// ─── DTOs ───────────────────────────────────────────────────────────

export const CreateOperatorSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1).max(80),
  commissionBps: z.number().int().min(0).max(10_000).describe('basis points: 1500 = 15%'),
});
export type CreateOperatorDto = z.infer<typeof CreateOperatorSchema>;

export const UpdateOperatorSchema = z.object({
  displayName: z.string().min(1).max(80).optional(),
  commissionBps: z.number().int().min(0).max(10_000).optional(),
  active: z.boolean().optional(),
});
export type UpdateOperatorDto = z.infer<typeof UpdateOperatorSchema>;

export const CreatePayoutSchema = z.object({
  notes: z.string().max(500).optional(),
});
export type CreatePayoutDto = z.infer<typeof CreatePayoutSchema>;

export const AcceptInviteSchema = z.object({
  token: z.string().min(20),
  password: z.string().min(8).max(128),
});
export type AcceptInviteDto = z.infer<typeof AcceptInviteSchema>;

/** Respuesta del endpoint createOperator — incluye URL de invite (para copiar a WhatsApp si SMTP off). */
export const CreateOperatorResponseSchema = z.object({
  operator: OperatorPublicViewSchema,
  inviteUrl: z.string().url().describe('Link único para set-password — TTL 24h'),
  emailSent: z.boolean(),
});
export type CreateOperatorResponse = z.infer<typeof CreateOperatorResponseSchema>;
