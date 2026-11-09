// Lo que necesitan las pantallas de cobrar del local y de quien cobra: las
// secciones (nombre), su puesto y lo que puede cobrar, la carta, las formas de
// cobro y los ajustes de la noche. Los colores son los de la marca
// (@nightpay/ui), nunca lima.

import {
  SECTION_CODES,
  postSection,
  puestoLabel,
  sectionMeta,
  type InvitationRules,
  type PostCode,
  type SectionCode,
  type VenueNightSettings,
  type VenuePaymentMethods,
  type VenueSection,
} from '@nightpay/contracts';
import { sectionVar } from '@nightpay/ui';
import type { OperatorUser } from '@/lib/api';
import { PROPINAS, type CartaItem } from '@/lib/cuenta';

export interface CobrarContext {
  user: OperatorUser;
  sections: readonly VenueSection[];
  /** Lo que su puesto puede cobrar (null: no se sabe; el API decide). */
  allowed: readonly SectionCode[] | null;
  post: PostCode | null;
  /** La sección marcada de entrada en «Otro importe». */
  defaultCategory: SectionCode | null;
  /** Su puesto lleva propinas. */
  tips: boolean;
  methods: VenuePaymentMethods;
  night: VenueNightSettings;
  rules: InvitationRules | null;
  carta: readonly CartaItem[];
  /** La carta ya contestó (con algo, vacía o con error). */
  cartaLoaded: boolean;
  /** No se pudo cargar: se cobra con «Otro importe» y se ofrece reintentar. */
  cartaFailed: boolean;
}

/** Color de una sección (o de las propinas): el punto, el chip y las barras. Las losetas, cartaTileColor (sólido, con tinta). */
export function colorOf(section: string): string {
  return section === PROPINAS ? 'var(--np-sec-propinas)' : sectionVar(section);
}

/** Nombre de una sección (el del local) o «Propinas». */
export function labelOf(ctx: Pick<CobrarContext, 'sections'>, section: string): string {
  return section === PROPINAS ? 'Propinas' : sectionMeta(ctx.sections, section).label;
}

/** Las secciones que se le enseñan: encendidas en el local y que su puesto cobra, en su orden. */
export function offeredCodes(ctx: Pick<CobrarContext, 'sections' | 'allowed'>): SectionCode[] {
  const enabled = SECTION_CODES.filter((c) => ctx.sections.find((s) => s.code === c)?.enabled ?? true);
  const mine = enabled.filter((c) => !ctx.allowed || ctx.allowed.includes(c));
  return mine.length > 0 ? mine : enabled;
}

/** El chip de la cabecera: su puesto con el color de su sección (la chica: «Servicios»). */
export function puestoChip(ctx: Pick<CobrarContext, 'post' | 'user' | 'sections'>): { label: string; color: string } | null {
  const post = ctx.post ?? (ctx.user.role === 'OPERATOR' ? 'SALA' : null);
  if (!post) return null;
  const section = postSection(post);
  return { label: post === 'SALA' ? labelOf(ctx, section) : puestoLabel(post), color: colorOf(section) };
}

/** La sección del puesto (la marcada de entrada en «Otro importe»). */
export function puestoSection(ctx: Pick<CobrarContext, 'post' | 'user' | 'defaultCategory'>): SectionCode {
  const post = ctx.post ?? (ctx.user.role === 'OPERATOR' ? 'SALA' : null);
  return post ? postSection(post) : (ctx.defaultCategory ?? 'VENUE_BAR');
}

/** Las propinas que se ofrecen como losetas (las sugeridas del local), si su puesto las lleva. */
export function tipTiles(ctx: Pick<CobrarContext, 'tips' | 'methods'>): number[] {
  if (!ctx.tips || !ctx.methods.tips) return [];
  return ctx.methods.tipFlatCents.filter((c) => c > 0).slice(0, 3);
}
