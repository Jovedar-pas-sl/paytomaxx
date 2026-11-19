import { z } from 'zod';
import { PackComponentSchema, PackComponentsSchema, packProblem } from './charge-lines';
import { CartaIconSchema } from './carta-icons';
import { UuidSchema } from './common';
import { RevenueCategorySchema } from './payments';
import { SectionCodeSchema } from './sections';

/**
 * Fase 1A — carta de servicios por local. La chica elige un servicio
 * ("30 min · 100 €") en vez de teclear un importe; precio y categoría los
 * fija el local desde el panel.
 *
 * El mapa del dinero (20261023100000): la carta vale para todas las
 * secciones (copas, habitaciones, comida, entradas, servicios) y un servicio
 * puede ser un pack que se reparte solo entre secciones (`components`).
 */
export const ServiceItemSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  durationMin: z.number().int().nullable(),
  priceCents: z.number().int().positive(),
  /** Sección (los antiguos pueden tener EXTRA). */
  category: RevenueCategorySchema,
  active: z.boolean(),
  sortOrder: z.number().int(),
  /** Pack: sus partes, que suman el precio. Null = de una sola sección. */
  components: z.array(PackComponentSchema).nullable(),
  /** «Copa con invitación»: en Copas; la venta se reparte con la chica invitada. */
  isInvitation: z.boolean(),
  /** Icono de la colección; null = el de su sección. */
  icon: CartaIconSchema.nullable(),
  /** «Agotado esta noche»: marcado durante la noche abierta (vuelve solo al cambiar la noche). */
  soldOut: z.boolean(),
  /** Ruta de su logo o foto (versionada por la huella; el navegador la guarda), o null. */
  imageUrl: z.string().nullable(),
});
export type ServiceItem = z.infer<typeof ServiceItemSchema>;

const ServiceItemFieldsSchema = z.object({
  name: z.string().trim().min(1, 'Pon un nombre').max(60),
  durationMin: z.number().int().min(1).max(24 * 60).nullable().optional(),
  priceCents: z.number().int().positive('El precio tiene que ser mayor que 0').max(10_000_00),
  /** Una de las secciones (no «Otros»). */
  category: SectionCodeSchema.default('CHICA_SERVICE'),
  sortOrder: z.number().int().min(0).max(1000).optional(),
  /** Pack: partes que suman el precio (null = quitar el pack). */
  components: PackComponentsSchema.nullable().optional(),
  /** «Copa con invitación» (solo en Copas y sin pack). */
  isInvitation: z.boolean().optional(),
  /** Icono de la colección (null = el de su sección). */
  icon: CartaIconSchema.nullable().optional(),
});

export const CreateServiceItemSchema = ServiceItemFieldsSchema.superRefine((d, ctx) => {
  const problem = packProblem(d.priceCents, d.category, d.components);
  if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem, path: ['components'] });
  const invitation = invitationItemProblem(d.isInvitation, d.category, d.components);
  if (invitation) ctx.addIssue({ code: z.ZodIssueCode.custom, message: invitation, path: ['isInvitation'] });
});

/** Una invitación va en Copas y no es un pack (null = vale). */
export function invitationItemProblem(
  isInvitation: boolean | undefined,
  category: string,
  components: readonly unknown[] | null | undefined,
): string | null {
  if (!isInvitation) return null;
  if (category !== 'VENUE_BAR') return 'Una invitación va en la sección Copas.';
  if (components && components.length > 0) return 'Una invitación no puede ser un pack.';
  return null;
}
export type CreateServiceItemDto = z.infer<typeof CreateServiceItemSchema>;

/** Sin precio o sin sección, el servidor comprueba el pack con lo guardado. */
export const UpdateServiceItemSchema = ServiceItemFieldsSchema.partial().extend({
  active: z.boolean().optional(),
});
export type UpdateServiceItemDto = z.infer<typeof UpdateServiceItemSchema>;

/**
 * ¿Está agotado esta noche? Solo si se marcó dentro de la noche abierta; sin
 * noche abierta, o marcado en una anterior, hay (vuelve solo, sin tarea programada).
 */
export function isSoldOutTonight(soldOutAt: Date | null | undefined, nightOpenedAt: Date | null | undefined): boolean {
  return Boolean(soldOutAt && nightOpenedAt && soldOutAt.getTime() >= nightOpenedAt.getTime());
}

/** Marcar o quitar «Agotado» (PUT /v1/services/:id/sold-out). */
export const SetSoldOutSchema = z.object({ soldOut: z.boolean() });
export type SetSoldOutDto = z.infer<typeof SetSoldOutSchema>;
