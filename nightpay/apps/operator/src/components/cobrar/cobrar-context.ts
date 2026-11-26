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
  /** false: la compañera con la casilla del local apagada («Hoy cobra el encargado»; null: no se sabe). */
  fromPhone?: boolean | null;
  /** Un servicio a nombre de una compañera lleva propinas: la fila de Sala (null: no se sabe). */
  serviceTips?: boolean | null;
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

/** Las secciones que se le enseñan: encendidas en el local y que su puesto cobra, en su orden (todas solo si no se sabe). */
export function offeredCodes(ctx: Pick<CobrarContext, 'sections' | 'allowed'>): SectionCode[] {
  const enabled = SECTION_CODES.filter((c) => ctx.sections.find((s) => s.code === c)?.enabled ?? true);
  const mine = enabled.filter((c) => !ctx.allowed || ctx.allowed.includes(c));
  return ctx.allowed ? mine : enabled;
}

/**
 * La compañera con la casilla del local apagada: «Hoy cobra el encargado» en
 * lugar de la carta. Sala sin secciones con la casilla encendida no lo es:
 * nadie le cobra a su nombre, así que su parte no le llegaría.
 */
export function cobraElEncargado(ctx: Pick<CobrarContext, 'user' | 'fromPhone'>): boolean {
  return ctx.user.role === 'OPERATOR' && ctx.fromPhone === false;
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

/**
 * ¿Puede el cliente dejar propina en este cobro? Con las propinas encendidas
 * en el local y en el puesto de quien cobra. B1: la elige el cliente al pagar
 * (en la pantalla del PIN, en su página de pago o en /s); el personal ya no la
 * añade en Cobrar.
 */
export function customerTipsOn(ctx: Pick<CobrarContext, 'tips' | 'methods'>): boolean {
  return ctx.tips && ctx.methods.tips;
}

/**
 * ¿Ofrece propina el PIN de un servicio cobrado a nombre de una compañera?
 * La regla de Sala (la de ella), no el puesto de quien cobra: si no, en un
 * local con Sala sin propinas el cliente la elige y el API la rechaza
 * (TIP_NOT_VALID). Sin el dato (un API de antes), su puesto.
 */
export function servedTipsOn(ctx: Pick<CobrarContext, 'tips' | 'methods' | 'serviceTips'>): boolean {
  return ctx.methods.tips && (ctx.serviceTips ?? ctx.tips);
}
