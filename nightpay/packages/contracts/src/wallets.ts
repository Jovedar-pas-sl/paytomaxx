import { z } from 'zod';
import { UuidSchema } from './common';

// ─── Phase 1B — Client wallet (cash-in-advance closed-loop) ─────────

export const ClientClientWalletStatusSchema = z.enum([
  'ACTIVE',
  'EXPIRED',
  'REFUNDED',
  'DEPLETED',
]);
export type ClientClientWalletStatus = z.infer<typeof ClientClientWalletStatusSchema>;

/** Categorías sugeridas — el venue puede tener las suyas propias. */
export const WALLET_CONSUMPTION_CATEGORIES = [
  'bar',
  'room',
  'time',
  'service',
  'other',
] as const;
export type WalletConsumptionCategory =
  (typeof WALLET_CONSUMPTION_CATEGORIES)[number];

// ─── Vistas públicas ────────────────────────────────────────────────

export const ClientWalletViewSchema = z.object({
  id: UuidSchema,
  identifier: z.string().nullable(),
  balanceCents: z.number().int().nonnegative(),
  status: ClientClientWalletStatusSchema,
  expiresAt: z.string().datetime().nullable(),
  qrToken: z.string(),
  createdAt: z.string().datetime(),
});
export type ClientWalletView = z.infer<typeof ClientWalletViewSchema>;

/** Vista pública para el cliente — sin qrToken (el cliente ya lo tiene). */
export const ClientWalletPublicViewSchema = z.object({
  id: UuidSchema,
  balanceCents: z.number().int().nonnegative(),
  status: ClientClientWalletStatusSchema,
  expiresAt: z.string().datetime().nullable(),
  consumptions: z.array(
    z.object({
      id: UuidSchema,
      amountCents: z.number().int().positive(),
      category: z.string(),
      providedByName: z.string().nullable(),
      createdAt: z.string().datetime(),
    }),
  ),
});
export type ClientWalletPublicView = z.infer<typeof ClientWalletPublicViewSchema>;

export const WalletConsumptionViewSchema = z.object({
  id: UuidSchema,
  walletId: UuidSchema,
  amountCents: z.number().int().positive(),
  providedByUserId: UuidSchema,
  providedByEmail: z.string().email().nullable(),
  providedByName: z.string().nullable(),
  category: z.string(),
  notes: z.string().nullable(),
  reversedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type WalletConsumptionView = z.infer<typeof WalletConsumptionViewSchema>;

// ─── DTOs ───────────────────────────────────────────────────────────

/** POST /v1/payments con wallet.create → top-up que crea wallet nueva. */
export const CreateWalletTopUpSchema = z.object({
  amountCents: z.number().int().min(100).max(1_000_000), // 1€ – 10.000€
  /** Identificador opcional del cliente (phone, email, anon hash). */
  identifier: z.string().min(1).max(200).optional(),
});
export type CreateWalletTopUpDto = z.infer<typeof CreateWalletTopUpSchema>;

/** Cobra contra una wallet existente. */
export const ConsumeWalletSchema = z.object({
  amountCents: z.number().int().min(1).max(1_000_000),
  category: z.string().min(1).max(40),
  notes: z.string().max(500).optional(),
  /**
   * Propina opcional añadida al consumo. 100% va al providedBy (chica) si
   * tipGoesTo='operator' o si es OPERATOR y no se especifica.
   */
  tipCents: z.number().int().nonnegative().max(500_000).optional(),
  tipGoesTo: z.enum(['operator', 'venue', 'shared']).optional(),
});
export type ConsumeWalletDto = z.infer<typeof ConsumeWalletSchema>;

export const ConsumeWalletResultSchema = z.object({
  consumptionId: UuidSchema,
  newBalanceCents: z.number().int().nonnegative(),
  earningCreated: z.boolean(),
  earningCommissionCents: z.number().int().nullable(),
  /** Propinas asignadas al earning (si aplica). */
  tipCents: z.number().int().nonnegative().optional(),
});
export type ConsumeWalletResult = z.infer<typeof ConsumeWalletResultSchema>;

/** Refund manual del balance restante (PSP refund o crédito futuro). */
export const RefundWalletSchema = z.object({
  method: z.enum(['CARD', 'CREDIT']),
  notes: z.string().max(500).optional(),
});
export type RefundWalletDto = z.infer<typeof RefundWalletSchema>;

export const RefundWalletResultSchema = z.object({
  walletId: UuidSchema,
  method: z.enum(['CARD', 'CREDIT']),
  refundedCents: z.number().int().nonnegative(),
  newStatus: ClientClientWalletStatusSchema,
  expiresAt: z.string().datetime().nullable(),
});
export type RefundWalletResult = z.infer<typeof RefundWalletResultSchema>;

/** Rollback de un consumo concreto. */
export const ReverseConsumptionSchema = z.object({
  reason: z.string().min(1).max(500),
});
export type ReverseConsumptionDto = z.infer<typeof ReverseConsumptionSchema>;

// ─── Métricas admin ─────────────────────────────────────────────────

export const WalletsAdminStatsSchema = z.object({
  activeCount: z.number().int().nonnegative(),
  totalBalanceCents: z.number().int().nonnegative(),
  todayTopUpsCents: z.number().int().nonnegative(),
  todayConsumptionsCents: z.number().int().nonnegative(),
  todayRefundsCents: z.number().int().nonnegative(),
  byCategory: z.record(z.string(), z.number().int().nonnegative()),
});
export type WalletsAdminStats = z.infer<typeof WalletsAdminStatsSchema>;
