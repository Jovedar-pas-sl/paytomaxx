import { z } from 'zod';
import { UuidSchema } from './common';
import { RevenueCategorySchema } from './payments';

/**
 * Fase 1A — carta de servicios por local. La chica elige un servicio
 * ("30 min · 100 €") en vez de teclear un importe; precio y categoría los
 * fija el local desde el panel.
 */
export const ServiceItemSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  durationMin: z.number().int().nullable(),
  priceCents: z.number().int().positive(),
  category: RevenueCategorySchema,
  active: z.boolean(),
  sortOrder: z.number().int(),
});
export type ServiceItem = z.infer<typeof ServiceItemSchema>;

export const CreateServiceItemSchema = z.object({
  name: z.string().trim().min(1, 'Pon un nombre').max(60),
  durationMin: z.number().int().min(1).max(24 * 60).nullable().optional(),
  priceCents: z.number().int().positive('El precio tiene que ser mayor que 0').max(10_000_00),
  category: RevenueCategorySchema.default('CHICA_SERVICE'),
  sortOrder: z.number().int().min(0).max(1000).optional(),
});
export type CreateServiceItemDto = z.infer<typeof CreateServiceItemSchema>;

export const UpdateServiceItemSchema = CreateServiceItemSchema.partial().extend({
  active: z.boolean().optional(),
});
export type UpdateServiceItemDto = z.infer<typeof UpdateServiceItemSchema>;
