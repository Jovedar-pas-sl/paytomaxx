import { z } from 'zod';

/**
 * El mapa del dinero: cada cobro cae en su SECCIÓN (Servicios, Copas,
 * Habitaciones, Comida, Entradas) sin adivinarla por el precio. Las
 * secciones de cada local (nombre, color y si se usa) se guardan en
 * `venues.sections` (migración 20261023100000); lo que falte vale lo de
 * fábrica. «Otros» (EXTRA) ya no se usa en cobros nuevos: queda para los
 * antiguos. Las propinas no son una sección de línea: van aparte (tipCents)
 * y en los informes salen como la suya.
 */

/** Las secciones en las que puede caer una línea de cobro, en el orden en que se enseñan. */
export const SECTION_CODES = ['CHICA_SERVICE', 'VENUE_BAR', 'VENUE_ROOM', 'VENUE_FOOD', 'VENUE_ENTRY'] as const;
export type SectionCode = (typeof SECTION_CODES)[number];
export const SectionCodeSchema = z.enum(SECTION_CODES);

/** Sección de los cobros antiguos sin sección («Otros»). Nunca en uno nuevo. */
export const LEGACY_SECTION = 'EXTRA' as const;

export function isSectionCode(value: unknown): value is SectionCode {
  return typeof value === 'string' && (SECTION_CODES as readonly string[]).includes(value);
}

export interface VenueSection {
  code: SectionCode;
  /** Se usa en este local: sale en la carta, en «Otro importe» y en los puestos. */
  enabled: boolean;
  label: string;
  /** Color de la sección (#rrggbb): el mismo en la app, el panel y los informes. */
  color: string;
}

export const SECTION_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const MAX_LABEL = 24;

export const DEFAULT_SECTIONS: Readonly<Record<SectionCode, Readonly<Omit<VenueSection, 'code'>>>> = {
  CHICA_SERVICE: { enabled: true, label: 'Servicios', color: '#ff6fae' },
  VENUE_BAR: { enabled: true, label: 'Copas', color: '#ffd23f' },
  VENUE_ROOM: { enabled: true, label: 'Habitaciones', color: '#b98cff' },
  VENUE_FOOD: { enabled: true, label: 'Comida', color: '#ff9147' },
  VENUE_ENTRY: { enabled: true, label: 'Entradas', color: '#4fc3f7' },
};

/** «Otros»: solo para enseñar los cobros antiguos. */
export const LEGACY_SECTION_META = { label: 'Otros', color: '#a3a39b' } as const;
/** Propinas: no son una línea; en los informes y el panel salen como su propia sección. */
export const TIPS_SECTION_META = { label: 'Propinas', color: '#5be38f' } as const;
/** Recarga de saldo: no es venta (va al saldo vivo); se enseña así en la lista de cobros. */
export const TOP_UP_SECTION_META = { label: 'Recarga de saldo', color: '#8a8f98' } as const;

/** Lo guardado (JSON o null) con lo que falte a lo de fábrica, en orden. Un valor raro no rompe nada. */
export function sectionsOf(raw: unknown): VenueSection[] {
  const stored = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out = SECTION_CODES.map((code): VenueSection => {
    const base = DEFAULT_SECTIONS[code];
    const own = stored[code] && typeof stored[code] === 'object' ? (stored[code] as Record<string, unknown>) : {};
    const label = typeof own.label === 'string' ? own.label.trim().slice(0, MAX_LABEL) : '';
    const color = typeof own.color === 'string' && SECTION_COLOR_RE.test(own.color) ? own.color.toLowerCase() : '';
    return {
      code,
      enabled: typeof own.enabled === 'boolean' ? own.enabled : base.enabled,
      label: label || base.label,
      color: color || base.color,
    };
  });
  // Siempre queda al menos una: con todas apagadas no se podría cobrar nada.
  if (!out.some((s) => s.enabled)) return out.map((s) => ({ ...s, enabled: DEFAULT_SECTIONS[s.code].enabled }));
  return out;
}

const SectionPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    label: z.string().trim().min(1, 'Pon un nombre a la sección').max(MAX_LABEL).optional(),
    color: z.string().regex(SECTION_COLOR_RE, 'El color va como #rrggbb').optional(),
  })
  .strict();

export const UpdateSectionsSchema = z
  .object({
    sections: z
      .object(Object.fromEntries(SECTION_CODES.map((c) => [c, SectionPatchSchema.optional()])) as Record<
        SectionCode,
        z.ZodOptional<typeof SectionPatchSchema>
      >)
      .strict(),
  })
  .strict()
  .refine((d) => Object.values(d.sections).some((v) => v !== undefined), { message: 'No hay nada que cambiar' });
export type UpdateSectionsDto = z.infer<typeof UpdateSectionsSchema>;

export const NO_SECTION_ENABLED_MESSAGE = 'Deja al menos una sección encendida: sin ninguna no se podría cobrar.';

/** Lo guardado tras el cambio (objeto por código, completo), o null si deja todas apagadas. */
export function mergeSections(current: unknown, patch: UpdateSectionsDto): Record<SectionCode, Omit<VenueSection, 'code'>> | null {
  const base = sectionsOf(current);
  const next = base.map((s) => {
    const change = patch.sections[s.code];
    return change
      ? {
          ...s,
          ...(change.enabled !== undefined ? { enabled: change.enabled } : {}),
          ...(change.label !== undefined ? { label: change.label } : {}),
          ...(change.color !== undefined ? { color: change.color.toLowerCase() } : {}),
        }
      : s;
  });
  if (!next.some((s) => s.enabled)) return null;
  return Object.fromEntries(next.map(({ code, ...rest }) => [code, rest])) as Record<SectionCode, Omit<VenueSection, 'code'>>;
}

/** Nombre y color de una sección (también «Otros» de los antiguos y una desconocida). */
export function sectionMeta(sections: readonly VenueSection[], code: string): { label: string; color: string } {
  const own = sections.find((s) => s.code === code);
  if (own) return { label: own.label, color: own.color };
  if (isSectionCode(code)) return { label: DEFAULT_SECTIONS[code].label, color: DEFAULT_SECTIONS[code].color };
  return { ...LEGACY_SECTION_META };
}

// ─── Puestos ──────────────────────────────────────────────────────────

/**
 * El puesto de cada persona (users.post). Da la sección de sus cobros cuando
 * no la dice la carta ni la petición. Sin puesto: el de su rol (la chica,
 * Sala; el resto, Barra).
 */
export const POST_CODES = ['SALA', 'BARRA', 'HABITACIONES', 'COCINA', 'RECEPCION'] as const;
export type PostCode = (typeof POST_CODES)[number];
export const PostCodeSchema = z.enum(POST_CODES);

export function isPostCode(value: unknown): value is PostCode {
  return typeof value === 'string' && (POST_CODES as readonly string[]).includes(value);
}

export const PUESTOS: ReadonlyArray<{ code: PostCode; label: string; section: SectionCode }> = [
  { code: 'SALA', label: 'Sala', section: 'CHICA_SERVICE' },
  { code: 'BARRA', label: 'Barra', section: 'VENUE_BAR' },
  { code: 'HABITACIONES', label: 'Habitaciones', section: 'VENUE_ROOM' },
  { code: 'COCINA', label: 'Cocina', section: 'VENUE_FOOD' },
  { code: 'RECEPCION', label: 'Recepción', section: 'VENUE_ENTRY' },
];

export function puestoLabel(code: PostCode): string {
  return PUESTOS.find((p) => p.code === code)?.label ?? code;
}

/** Puesto de un rol sin puesto propio: la chica, Sala; el resto, Barra. */
export function rolePost(role: string | null | undefined): PostCode {
  return role === 'OPERATOR' ? 'SALA' : 'BARRA';
}

/** El puesto que vale para una persona (el suyo o el de su rol). */
export function effectivePost(person: { role: string | null | undefined; post: string | null | undefined }): PostCode {
  return isPostCode(person.post) ? person.post : rolePost(person.role);
}

/** Sección por defecto de un puesto (Sala → Servicios, Barra → Copas…). */
export function postSection(post: PostCode): SectionCode {
  return PUESTOS.find((p) => p.code === post)?.section ?? 'VENUE_BAR';
}

/** Sección por defecto de un rol (sin puesto). */
export function roleDefaultSection(role: string | null | undefined): SectionCode {
  return postSection(rolePost(role));
}

export const UpdatePuestoSchema = z.object({ post: PostCodeSchema.nullable() }).strict();
export type UpdatePuestoDto = z.infer<typeof UpdatePuestoSchema>;

/** Persona del local con su puesto (Ajustes → Permisos → Puestos). */
export interface PuestoPerson {
  id: string;
  name: string;
  role: 'MANAGER' | 'WAITER' | 'OPERATOR';
  /** null = el de su rol. */
  post: PostCode | null;
  /** El puesto que le vale de verdad (el suyo o el de su rol). */
  effectivePost: PostCode;
  /** Sección por defecto de sus cobros. */
  defaultCategory: SectionCode;
}

// ─── Referencia corta ─────────────────────────────────────────────────

/** 17 → «C-0017». Los cobros antiguos no tienen (null). */
export function formatChargeRef(ref: number | null | undefined): string | null {
  return typeof ref === 'number' && ref > 0 ? `C-${String(ref).padStart(4, '0')}` : null;
}
