import { z } from 'zod';

/**
 * «Copa con invitación»: el cliente invita a una chica a una copa en la
 * barra. Es un producto más de la carta (en Copas, `isInvitation`), con su
 * propio precio; la «Copa» de siempre es la copa normal, sin invitación. Al
 * tocar «Copa con invitación», quien cobra escanea el QR personal de la chica
 * («Mi QR» en su app) y la venta se reparte entre la chica y el local.
 *
 * Partes en `venues.invitationRules` (migración 20261023100200). De fábrica:
 * la chica 50 % y el resto, del local (20 € = 10 € la chica y 10 € el local).
 * El camarero que la cobra consta como quien la cobró (sus cobros, sus
 * estadísticas), sin parte propia. La del camarero que el formulario de antes
 * guardaba de fábrica (50 %, hasta el 2026-10-28) la pone a 0 % la migración
 * 20261028100000; la que eligió el dueño (otro %, € por copa) se queda hasta
 * que la quite. Lo ya cobrado no cambia: las partes se fijan en la línea al
 * cobrar.
 */

export type InvitationShare = { kind: 'PERCENT'; bps: number } | { kind: 'FIXED'; cents: number };

export interface InvitationRules {
  /** Para la chica invitada. */
  chica: InvitationShare;
  /**
   * Para el camarero que la cobra (si es camarero). De fábrica, nada: el
   * local se queda lo que no es de la chica.
   */
  camarero: InvitationShare;
  /**
   * Pedir el QR de la chica: la invitación se cobra escaneando su «Mi QR». Si
   * no, también se puede elegir de la lista de chicas. Sin el campo: sí.
   */
  requireQr?: boolean;
}

/** Las de fábrica, hasta que el dueño ponga las suyas: 20 € = 10 € la chica y 10 € el local. */
export const DEFAULT_INVITATION_RULES: Readonly<InvitationRules> = {
  chica: { kind: 'PERCENT', bps: 5000 },
  camarero: { kind: 'PERCENT', bps: 0 },
  requireQr: true,
};

/** El nombre de la invitación en la carta de referencia. */
export const INVITATION_ITEM_NAME = 'Copa con invitación';

const MAX_FIXED_CENTS = 1_000_00;

export const InvitationShareSchema = z.union([
  z.object({ kind: z.literal('PERCENT'), bps: z.number().int().min(0).max(10_000) }).strict(),
  z.object({ kind: z.literal('FIXED'), cents: z.number().int().min(0).max(MAX_FIXED_CENTS) }).strict(),
]);

export const UpdateInvitationRulesSchema = z
  .object({
    chica: InvitationShareSchema.optional(),
    camarero: InvitationShareSchema.optional(),
    requireQr: z.boolean().optional(),
  })
  .strict()
  .refine((d) => Object.values(d).some((v) => v !== undefined), { message: 'No hay nada que cambiar' });
export type UpdateInvitationRulesDto = z.infer<typeof UpdateInvitationRulesSchema>;

function shareOf(raw: unknown, fallback: InvitationShare): InvitationShare {
  const parsed = InvitationShareSchema.safeParse(raw);
  return parsed.success ? parsed.data : { ...fallback };
}

/**
 * Lo guardado (JSON o null) con lo que falte a lo de fábrica. Lo que ya no
 * existe (p. ej. `inviteFirst`, «Invitar» primero, hasta el 2026-10-28) se
 * lee sin error y no sale: se olvida la próxima vez que se guardan.
 */
export function invitationRulesOf(raw: unknown): Required<InvitationRules> {
  const stored = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    chica: shareOf(stored.chica, DEFAULT_INVITATION_RULES.chica),
    camarero: shareOf(stored.camarero, DEFAULT_INVITATION_RULES.camarero),
    requireQr: typeof stored.requireQr === 'boolean' ? stored.requireQr : true,
  };
}

export function mergeInvitationRules(current: unknown, patch: UpdateInvitationRulesDto): Required<InvitationRules> {
  const base = invitationRulesOf(current);
  return {
    chica: patch.chica ?? base.chica,
    camarero: patch.camarero ?? base.camarero,
    requireQr: patch.requireQr ?? base.requireQr,
  };
}

/** ¿No le toca nada? (0 % o 0 € por copa). */
export function isZeroShare(s: InvitationShare): boolean {
  return s.kind === 'PERCENT' ? s.bps === 0 : s.cents === 0;
}

/**
 * Cuánto va a cada uno de una invitación de `unitCents` × `qty`: el % sobre
 * el importe o el fijo por copa. Nunca más que la venta: primero la chica y
 * después (solo si el local se lo da) el camarero, con lo que quede; el
 * resto, del local.
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

/** Una chica a la que se puede invitar (la lista, si el local no pide su QR). */
export interface InvitableStaff {
  id: string;
  name: string;
}

export const INVITATION_TOKEN_MISSING = 'Escanea el QR de la chica a la que invita (en su app, «Mi QR»).';
export const INVITATION_QR_REQUIRED = 'Este local pide el QR de la chica: escanéalo en su app («Mi QR»).';
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
