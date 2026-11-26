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

// Cobrar del saldo: con el QR de la chica (Face ID) o con su código / ficha y
// su PIN (/v1/wallet-charges). Ya no hay cobro directo sin el cliente.
// Devolver el saldo: /v1/wallet-charges/wallets/:id/payout (tarjeta o efectivo).

/** Rollback de un consumo concreto. */
export const ReverseConsumptionSchema = z.object({
  reason: z.string().min(1).max(500),
  /** El encargado, desde el umbral del local (sumando lo ya anulado en el saldo). */
  totpCode: z.string().regex(/^\d{6}$/).optional(),
});
export type ReverseConsumptionDto = z.infer<typeof ReverseConsumptionSchema>;

// ─── Métricas admin ─────────────────────────────────────────────────

// Recargas, consumido y devuelto (los «today…»): desde donde cuenta la noche
// (la abierta) o, sin noche abierta, desde el último cierre (como el mapa del dinero).
export const WalletsAdminStatsSchema = z.object({
  activeCount: z.number().int().nonnegative(),
  totalBalanceCents: z.number().int().nonnegative(),
  nightOpen: z.boolean(),
  todayTopUpsCents: z.number().int().nonnegative(),
  todayConsumptionsCents: z.number().int().nonnegative(),
  todayRefundsCents: z.number().int().nonnegative(),
  byCategory: z.record(z.string(), z.number().int().nonnegative()),
});
export type WalletsAdminStats = z.infer<typeof WalletsAdminStatsSchema>;
