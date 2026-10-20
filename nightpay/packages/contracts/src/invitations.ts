import { z } from 'zod';

/**
 * «Invitar a una copa»: el cliente invita a una chica a una copa en la barra.
 * El camarero escanea el QR personal de la chica («Mi QR» en su app) y la
 * venta se reparte: una parte para la chica, otra (si el local quiere) para
 * el camarero que la cobra y el resto para el local. Las invitaciones son
 * servicios de la carta en Copas (`isInvitation`), con su propio precio.
 *
 * Partes en `venues.invitationRules` (migración 20261023100200). Las de
 * fábrica son PROVISIONALES (chica 50 %, camarero 0 %): las pone el dueño.
 */

export type InvitationShare = { kind: 'PERCENT'; bps: number } | { kind: 'FIXED'; cents: number };

export interface InvitationRules {
  /** Para la chica invitada. */
  chica: InvitationShare;
  /** Para el camarero que cobra la invitación (si es camarero). */
  camarero: InvitationShare;
}

/** Provisionales hasta que el dueño ponga las suyas. */
export const DEFAULT_INVITATION_RULES: Readonly<InvitationRules> = {
  chica: { kind: 'PERCENT', bps: 5000 },
  camarero: { kind: 'PERCENT', bps: 0 },
};

const MAX_FIXED_CENTS = 1_000_00;

export const InvitationShareSchema = z.union([
  z.object({ kind: z.literal('PERCENT'), bps: z.number().int().min(0).max(10_000) }).strict(),
  z.object({ kind: z.literal('FIXED'), cents: z.number().int().min(0).max(MAX_FIXED_CENTS) }).strict(),
]);

export const UpdateInvitationRulesSchema = z
  .object({ chica: InvitationShareSchema.optional(), camarero: InvitationShareSchema.optional() })
  .strict()
  .refine((d) => d.chica !== undefined || d.camarero !== undefined, { message: 'No hay nada que cambiar' });
export type UpdateInvitationRulesDto = z.infer<typeof UpdateInvitationRulesSchema>;

function shareOf(raw: unknown, fallback: InvitationShare): InvitationShare {
  const parsed = InvitationShareSchema.safeParse(raw);
  return parsed.success ? parsed.data : { ...fallback };
}

/** Lo guardado (JSON o null) con lo que falte a lo de fábrica. */
export function invitationRulesOf(raw: unknown): InvitationRules {
  const stored = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return { chica: shareOf(stored.chica, DEFAULT_INVITATION_RULES.chica), camarero: shareOf(stored.camarero, DEFAULT_INVITATION_RULES.camarero) };
}

export function mergeInvitationRules(current: unknown, patch: UpdateInvitationRulesDto): InvitationRules {
  const base = invitationRulesOf(current);
  return { chica: patch.chica ?? base.chica, camarero: patch.camarero ?? base.camarero };
}

/**
 * Cuánto va a cada uno de una invitación de `unitCents` × `qty`: el % sobre
 * el importe o el fijo por copa. Nunca más que la venta: primero la chica y
 * después el camarero, con lo que quede; el resto, del local.
 */
export function invitationShares(
  rules: InvitationRules,
  line: { unitCents: number; qty: number },
  charger: { getsShare: boolean },
): { beneficiaryCents: number; chargerCents: number } {
  const amount = line.unitCents * line.qty;
  const part = (s: InvitationShare) => (s.kind === 'PERCENT' ? Math.round((amount * s.bps) / 10_000) : s.cents * line.qty);
  const beneficiaryCents = Math.min(part(rules.chica), amount);
  const chargerCents = charger.getsShare ? Math.min(part(rules.camarero), amount - beneficiaryCents) : 0;
  return { beneficiaryCents, chargerCents };
}

/** El texto de una parte: «50 %» o «5,00 € por copa». */
export function invitationShareLabel(s: InvitationShare): string {
  if (s.kind === 'PERCENT') return `${(s.bps / 100).toLocaleString('es-ES', { maximumFractionDigits: 2 })} %`;
  return `${(s.cents / 100).toFixed(2).replace('.', ',')} € por copa`;
}

// ─── QR personal de la chica («Mi QR») ────────────────────────────────

/**
 * El QR que enseña la chica para que la inviten. Solo dice quién es (firmado
 * y de vida corta): no sirve para entrar en su cuenta ni para cobrar nada.
 */
export interface StaffQrView {
  /** Lo que lleva el QR: la app del personal con ?invita=<token>. */
  url: string;
  token: string;
  qrPngDataUrl: string;
  expiresAt: string;
}

/** El token de un QR leído (la URL entera o el token suelto). */
export function staffTokenFrom(scanned: string): string | null {
  const text = scanned.trim();
  const fromUrl = /[?&]invita=([A-Za-z0-9._-]{20,400})/.exec(text)?.[1];
  if (fromUrl) return fromUrl;
  return /^[A-Za-z0-9._-]{20,400}$/.test(text) ? text : null;
}

export const INVITATION_TOKEN_MISSING = 'Escanea el QR de la chica a la que invita (en su app, «Mi QR»).';
export const INVITATION_TOKEN_INVALID = 'Ese QR no vale o ha caducado: que la chica lo vuelva a abrir en su app y escanéalo otra vez.';
export const INVITATION_NOT_IN_CHARGE = 'Ese cobro no lleva ninguna invitación de la carta.';

/** Resumen de las invitaciones de una chica (su ficha). */
export interface InvitationSummary {
  /** Copas a las que la invitaron (cobradas, sin las devueltas ni anuladas). */
  count: number;
  amountCents: number;
  /** Lo que le tocó a ella. */
  shareCents: number;
}
