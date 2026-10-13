import { z } from 'zod';
import { UuidSchema } from './common';
import { TerminalZoneSchema } from './payments';

/**
 * Hardware models soportados. Ampliable según necesidad.
 * INGENICO_IM30 — datáfono Ingenico Move 30 (típico Paytef en España)
 * PAX_A920_PRO — datáfono Android NFC
 * OTRO — fallback (el deviceSerial captura el modelo real)
 */
export const HardwareModelSchema = z.enum([
  'PAX_A920_PRO',
  'INGENICO_IM30',
  'INGENICO_LANE_3000',
  'SUMUP_AIR',
  'REDSYS_VX520',
  'OTRO',
]);
export type HardwareModel = z.infer<typeof HardwareModelSchema>;

export const TerminalViewSchema = z.object({
  id: UuidSchema,
  externalId: z.string(),
  label: z.string(),
  zone: z.string().nullable(),
  zoneDisplay: z.string().nullable().describe('Versión bonita para UI: capitalizada'),
  hardwareModel: z.string().nullable(),
  deviceSerial: z.string().nullable(),
  active: z.boolean(),
  /** App NightPay del datáfono vinculada (Paytef Device API). */
  devicePaired: z.boolean().optional(),
  deviceLastSeenAt: z.string().nullable().optional(),
});
export type TerminalView = z.infer<typeof TerminalViewSchema>;

/** Resumen agregado por zona — usado por dropdown del operator app. */
export const ZoneViewSchema = z.object({
  zone: z.string().describe('Valor canónico (BARRA, HABITACIONES, MESAS, OTRO/<custom>)'),
  zoneDisplay: z.string().describe('Texto bonito para UI'),
  terminalCount: z.number().int().nonnegative(),
  activeCount: z.number().int().nonnegative(),
});
export type ZoneView = z.infer<typeof ZoneViewSchema>;

/** Crear un terminal individual. */
export const CreateTerminalSchema = z.object({
  externalId: z.string().min(1).max(80),
  label: z.string().min(1).max(120),
  zone: TerminalZoneSchema.optional(),
  zoneCustom: z.string().min(1).max(40).optional(),
  hardwareModel: HardwareModelSchema.optional(),
  deviceSerial: z.string().min(1).max(120).optional(),
  active: z.boolean().default(true),
}).refine(
  (d) => d.zone !== 'OTRO' || (d.zoneCustom !== undefined && d.zoneCustom.length > 0),
  { message: 'zoneCustom obligatorio cuando zone=OTRO' },
);
export type CreateTerminalDto = z.infer<typeof CreateTerminalSchema>;

/** Bulk create: N terminales con mismo prefijo + zona. */
export const BulkCreateTerminalsSchema = z.object({
  count: z.number().int().min(1).max(50),
  prefix: z.string().min(1).max(40).describe('Ej: "PAX-BARRA-" → genera PAX-BARRA-1, PAX-BARRA-2…'),
  zone: TerminalZoneSchema,
  zoneCustom: z.string().min(1).max(40).optional(),
  hardwareModel: HardwareModelSchema.default('PAX_A920_PRO'),
}).refine(
  (d) => d.zone !== 'OTRO' || (d.zoneCustom !== undefined && d.zoneCustom.length > 0),
  { message: 'zoneCustom obligatorio cuando zone=OTRO' },
);
export type BulkCreateTerminalsDto = z.infer<typeof BulkCreateTerminalsSchema>;

/** Update parcial. */
export const UpdateTerminalSchema = z.object({
  label: z.string().min(1).max(120).optional(),
  zone: TerminalZoneSchema.nullable().optional(),
  zoneCustom: z.string().min(1).max(40).nullable().optional(),
  hardwareModel: HardwareModelSchema.nullable().optional(),
  deviceSerial: z.string().min(1).max(120).nullable().optional(),
  active: z.boolean().optional(),
});
export type UpdateTerminalDto = z.infer<typeof UpdateTerminalSchema>;
