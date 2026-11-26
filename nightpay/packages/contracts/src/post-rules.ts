import { z } from 'zod';
import {
  POST_CODES,
  SECTION_CODES,
  SectionCodeSchema,
  effectivePost,
  isPostCode,
  postSection,
  puestoLabel,
  type PostCode,
  type SectionCode,
  type VenueSection,
} from './sections';

/**
 * Qué cobra cada puesto (Ajustes → Secciones → Puestos): las secciones que
 * puede cobrar, si se le dejan propinas, si cobra en efectivo y si carga
 * saldos (las recargas, con tarjeta o en efectivo, solo en recepción). Se
 * guarda en `venues.postRules` (migración 20261023100100); lo que falte vale
 * lo de fábrica. El dueño y el encargado lo pueden todo. Las chicas (rol
 * OPERATOR) usan siempre la fila «Sala».
 */
export interface PostRule {
  sections: SectionCode[];
  /** Las propinas del cliente en sus cobros (y la que apunte al cobrar). */
  tips: boolean;
  /** Cobrar en efectivo (recargas en efectivo y devoluciones en efectivo). */
  cash: boolean;
  /** Cargar saldos (recargas con tarjeta o en efectivo). */
  topUps: boolean;
  /**
   * Devolver el saldo en efectivo a la salida (con el NFC del cliente). Aparte
   * de las recargas: de fábrica solo Recepción; a una persona se le quita en
   * Permisos sin quitarle las recargas.
   */
  cashPayout: boolean;
}

export type PostRules = Record<PostCode, PostRule>;

export const DEFAULT_POST_RULES: Readonly<PostRules> = {
  SALA: { sections: ['CHICA_SERVICE'], tips: true, cash: false, topUps: false, cashPayout: false },
  BARRA: { sections: ['VENUE_BAR', 'VENUE_ENTRY', 'VENUE_FOOD'], tips: true, cash: false, topUps: false, cashPayout: false },
  HABITACIONES: { sections: ['VENUE_ROOM'], tips: true, cash: false, topUps: false, cashPayout: false },
  COCINA: { sections: ['VENUE_FOOD'], tips: true, cash: false, topUps: false, cashPayout: false },
  RECEPCION: { sections: [...SECTION_CODES], tips: false, cash: true, topUps: true, cashPayout: true },
};

function ruleOf(raw: unknown, fallback: Readonly<PostRule>): PostRule {
  const stored = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  // Siempre en el orden de las secciones (Servicios, Copas, Habitaciones, Comida, Entradas).
  const source: readonly unknown[] = Array.isArray(stored.sections) ? (stored.sections as unknown[]) : fallback.sections;
  const sections = SECTION_CODES.filter((c) => source.includes(c));
  const flag = (key: 'tips' | 'cash' | 'topUps' | 'cashPayout') => (typeof stored[key] === 'boolean' ? (stored[key] as boolean) : fallback[key]);
  return { sections, tips: flag('tips'), cash: flag('cash'), topUps: flag('topUps'), cashPayout: flag('cashPayout') };
}

/** Lo guardado (JSON o null) con lo que falte a lo de fábrica. Un valor raro no rompe nada. */
export function postRulesOf(raw: unknown): PostRules {
  const stored = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return Object.fromEntries(POST_CODES.map((p) => [p, ruleOf(stored[p], DEFAULT_POST_RULES[p])])) as PostRules;
}

const PostRulePatchSchema = z
  .object({
    sections: z.array(SectionCodeSchema).max(SECTION_CODES.length).optional(),
    tips: z.boolean().optional(),
    cash: z.boolean().optional(),
    topUps: z.boolean().optional(),
    cashPayout: z.boolean().optional(),
  })
  .strict();

export const UpdatePostRulesSchema = z
  .object({
    posts: z
      .object(Object.fromEntries(POST_CODES.map((p) => [p, PostRulePatchSchema.optional()])) as Record<
        PostCode,
        z.ZodOptional<typeof PostRulePatchSchema>
      >)
      .strict(),
  })
  .strict()
  .refine((d) => Object.values(d.posts).some((v) => v !== undefined), { message: 'No hay nada que cambiar' });
export type UpdatePostRulesDto = z.infer<typeof UpdatePostRulesSchema>;

export function mergePostRules(current: unknown, patch: UpdatePostRulesDto): PostRules {
  const base = postRulesOf(current);
  const next = { ...base };
  for (const p of POST_CODES) {
    const change = patch.posts[p];
    if (!change) continue;
    next[p] = {
      sections: change.sections ? SECTION_CODES.filter((c) => change.sections!.includes(c)) : base[p].sections,
      tips: change.tips ?? base[p].tips,
      cash: change.cash ?? base[p].cash,
      topUps: change.topUps ?? base[p].topUps,
      cashPayout: change.cashPayout ?? base[p].cashPayout,
    };
  }
  return next;
}

// ─── Lo que puede cobrar una persona ──────────────────────────────────

export interface ChargeRights {
  /** El puesto con el que cobra (el dueño y el encargado: el suyo si tienen, o null). */
  post: PostCode | null;
  /** Lo puede todo (dueño o encargado). */
  all: boolean;
  sections: SectionCode[];
  tips: boolean;
  cash: boolean;
  topUps: boolean;
  /** Devolver el saldo en efectivo a la salida (lo de su puesto; el permiso de la persona, aparte). */
  cashPayout: boolean;
}

export function chargeRightsOf(
  person: { role: string | null | undefined; post: string | null | undefined },
  rules: PostRules,
  venue: { operatorsChargeFromPhone?: boolean } = {},
): ChargeRights {
  if (person.role === 'OWNER' || person.role === 'MANAGER') {
    // Lo pueden todo; su puesto (si tienen) solo marca la sección por defecto.
    const own = isPostCode(person.post) ? person.post : null;
    return { post: own, all: true, sections: [...SECTION_CODES], tips: true, cash: true, topUps: true, cashPayout: true };
  }
  // Las chicas: siempre la fila de Sala.
  const post: PostCode = person.role === 'OPERATOR' ? 'SALA' : effectivePost(person);
  const rule = rules[post];
  // «Las compañeras cobran desde su móvil» apagada (super-admin): ni cobros ni recargas. Propinas y
  // efectivo, como su fila, para que sus cobros de antes se sigan pagando. Sin el dato, como hoy.
  const phoneOff = person.role === 'OPERATOR' && venue.operatorsChargeFromPhone === false;
  return {
    post,
    all: false,
    sections: phoneOff ? [] : [...rule.sections],
    tips: rule.tips,
    cash: rule.cash,
    topUps: phoneOff ? false : rule.topUps,
    cashPayout: rule.cashPayout,
  };
}

export function canChargeSection(rights: ChargeRights, section: string): boolean {
  return rights.all || (rights.sections as string[]).includes(section);
}

export const SECTION_NOT_ALLOWED_CODE = 'SECTION_NOT_ALLOWED';
export const TOP_UP_RECEPTION_ONLY_CODE = 'TOP_UP_RECEPTION_ONLY';
export const TOP_UP_RECEPTION_ONLY_MESSAGE = 'Las recargas se hacen en recepción.';
export const CASH_RECEPTION_ONLY_CODE = 'CASH_RECEPTION_ONLY';
export const CASH_RECEPTION_ONLY_MESSAGE = 'El efectivo se cobra en recepción.';
export const TIPS_NOT_ALLOWED_CODE = 'TIPS_NOT_ALLOWED';
export const TIPS_NOT_ALLOWED_MESSAGE = 'Desde tu puesto no se apuntan propinas.';
/** Sala sin secciones (la casilla «Las compañeras cobran desde su móvil» apagada): lo ven también las apps de antes. */
export const SALA_PHONE_OFF_MESSAGE = 'Hoy cobra el encargado: desde tu app no se cobra.';

/** «Desde tu puesto (Barra) no se cobra Habitaciones: solo Copas, Entradas y Comida.» */
export function sectionNotAllowedMessage(
  rights: ChargeRights,
  section: string,
  labelOf: (code: string) => string,
): string {
  if (rights.post === 'SALA' && rights.sections.length === 0) return SALA_PHONE_OFF_MESSAGE;
  const allowed = rights.sections.map(labelOf);
  const list = allowed.length === 0 ? 'nada' : allowed.length === 1 ? allowed[0]! : `${allowed.slice(0, -1).join(', ')} y ${allowed[allowed.length - 1]}`;
  if (rights.post === 'SALA') return `Desde tu app solo puedes cobrar ${list}. ${labelOf(section)} lo cobra otra persona del local.`;
  const where = rights.post ? ` (${puestoLabel(rights.post)})` : '';
  return `Desde tu puesto${where} no se cobra ${labelOf(section)}: solo ${list}.`;
}

/** Las secciones que se le enseñan a una persona: encendidas en el local y que puede cobrar. */
export function allowedSections(sections: readonly VenueSection[], rights: ChargeRights): VenueSection[] {
  return sections.filter((s) => s.enabled && canChargeSection(rights, s.code));
}

/** La sección marcada de entrada en «Otro importe»: la de su puesto si la puede cobrar; si no, la primera. */
export function initialOfferedSection(sections: readonly VenueSection[], rights: ChargeRights): SectionCode {
  const preferred: SectionCode = rights.post ? postSection(rights.post) : 'VENUE_BAR';
  const offered = allowedSections(sections, rights);
  if (offered.some((s) => s.code === preferred)) return preferred;
  return offered[0]?.code ?? preferred;
}
