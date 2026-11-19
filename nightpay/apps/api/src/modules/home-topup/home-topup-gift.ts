import { randomBytes } from 'node:crypto';
import type { HomeTopUpGiftRow } from '@nightpay/contracts';
import type { PrismaService, TransactionalClient } from '../../common/prisma/prisma.service';
import type { IpRateLimitConfig } from '../../common/guards/ip-rate-limit.guard';
import type { PayLanguage } from '../payments/customer-lang';

/**
 * «Regala una noche»: reglas puras del regalo (las consultas, en
 * HomeTopUpGiftService y HomeTopUpService.start).
 *  - Se compra en el enlace del local (/r/<código>, «Para regalar») con los
 *    mismos importes, topes y freno que una carga normal, y se paga en /pay
 *    como cualquier recarga. Es un saldo nuevo de ESE local (sin grupo).
 *  - Quien regala nunca tiene el saldo: solo el enlace del regalo
 *    (/r/regalo/<token>). Quien lo recibe pulsa «Guardar en mi móvil» y activa
 *    el saldo con su Face ID o un PIN (el QR de activación de siempre, /w/a).
 *    Al gastarse ese QR el regalo queda guardado (claimedAt) y su enlace ya no
 *    da nada: ni a quien regaló ni a nadie más.
 *  - Sin guardar, espera hasta GIFT_UNCLAIMED_MAX_DAYS; después el enlace ya
 *    no vale, pero el regalo no se pierde en silencio: lo ve el dueño en el panel.
 */

/** Los importes del regalo (el del medio, marcado). «Otro importe»: los de siempre (de 10 a 300 €). */
export const GIFT_PRESETS_CENTS: readonly number[] = Object.freeze([2500, 5000, 10000]);
/** El nombre de quien lo recibe (opcional) y el mensaje (opcional), en caracteres. */
export const GIFT_NAME_MAX = 40;
export const GIFT_MESSAGE_MAX = 120;

/**
 * Días que espera un regalo sin guardar: después su enlace ya no vale (el
 * dinero no se borra: el regalo sigue en el panel). A confirmar con el abogado.
 */
export const GIFT_UNCLAIMED_MAX_DAYS = 90;
/** Días que se guardan el nombre y el mensaje después de guardar el regalo (datos personales). */
export const GIFT_TEXT_KEEP_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Las frases con efecto legal que ve quien regala, en los cuatro idiomas. A
 * revisar por el abogado: se cambian aquí y en ningún otro sitio. `{days}`:
 * GIFT_UNCLAIMED_MAX_DAYS.
 */
export const GIFT_LEGAL_TEXT: Readonly<Record<PayLanguage, { notRefundable: string; unclaimedExpiry: string }>> = Object.freeze({
  es: {
    notRefundable: 'Cuando tu amigo lo guarde en su móvil, el regalo es suyo: ya no se te puede devolver ni lo puedes usar tú.',
    unclaimedExpiry: 'Si nadie lo guarda en {days} días, el enlace del regalo deja de valer.',
  },
  en: {
    notRefundable: 'Once your friend saves it on their phone, the gift is theirs: it can no longer be refunded to you and you can’t use it.',
    unclaimedExpiry: 'If nobody saves it within {days} days, the gift link stops working.',
  },
  fr: {
    notRefundable: 'Dès que votre ami l’enregistre sur son téléphone, le cadeau est à lui : il ne peut plus vous être remboursé et vous ne pouvez plus l’utiliser.',
    unclaimedExpiry: 'Si personne ne l’enregistre dans les {days} jours, le lien du cadeau ne fonctionne plus.',
  },
  pt: {
    notRefundable: 'Quando o seu amigo o guardar no telemóvel, o presente é dele: já não lhe pode ser devolvido nem o pode usar.',
    unclaimedExpiry: 'Se ninguém o guardar em {days} dias, a ligação do presente deixa de funcionar.',
  },
});

/** «Guardar en mi móvil» (POST): emite un QR de activación; más estricto que la página. */
export const GIFT_CLAIM_LIMIT: IpRateLimitConfig = Object.freeze({
  max: 20,
  windowSec: 15 * 60,
  scope: 'home-topup-gift-claim',
  perKey: { param: 'token', max: 10 },
});

// ─── El enlace del regalo ───────────────────────────────────────────

const GIFT_TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

/** 24 bytes al azar (192 bits) en base64url, como el QR de activación: no se adivina. */
export function newGiftToken(): string {
  return randomBytes(24).toString('base64url');
}

export function isGiftToken(value: unknown): value is string {
  return typeof value === 'string' && GIFT_TOKEN_RE.test(value);
}

export function giftExpiresAt(now: Date): Date {
  return new Date(now.getTime() + GIFT_UNCLAIMED_MAX_DAYS * DAY_MS);
}

// ─── El nombre y el mensaje ─────────────────────────────────────────

/**
 * Texto plano de una línea (sin controles, los espacios juntos), o null si
 * viene vacío. Se cuenta en caracteres de verdad (como char_length en la base).
 */
function plainText(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (text === '') return null;
  return [...text].length <= max ? text : undefined;
}

/** El nombre (≤ 40) y el mensaje (≤ 120), limpios; null si no valen (400). */
export function parseGiftTexts(name: unknown, message: unknown): { toName: string | null; message: string | null } | null {
  const toName = plainText(name, GIFT_NAME_MAX);
  const msg = plainText(message, GIFT_MESSAGE_MAX);
  return toName === undefined || msg === undefined ? null : { toName, message: msg };
}

// ─── El estado ──────────────────────────────────────────────────────

export type GiftState = 'open' | 'claimed' | 'expired';

/**
 * Guardado: con claimedAt o con el saldo ya activado por otra vía (Face ID o
 * PIN): entonces el enlace del regalo no da nada. Caducado: sin guardar y pasado
 * su plazo. Si no, se puede guardar.
 */
export function giftState(g: { claimedAt: Date | null; expiresAt: Date; walletActivated: boolean }, now: Date): GiftState {
  if (g.claimedAt || g.walletActivated) return 'claimed';
  return g.expiresAt.getTime() <= now.getTime() ? 'expired' : 'open';
}

// ─── El panel y la retención ────────────────────────────────────────

/** Lo pagado de verdad (lo sin pagar no es un regalo: no sale en el panel ni se guarda). */
export const GIFT_PAID_STATUSES = ['AUTHORIZED', 'PARTIALLY_REFUNDED', 'REFUNDED'] as const;
/** Filas del panel: primero las sin guardar (todas las que quepan), después las más nuevas. */
const PANEL_MAX_ROWS = 100;

/** Los regalos pagados del local para Ajustes: sin guardar primero, con su estado. */
export async function giftRowsForPanel(tx: TransactionalClient, venueId: string, now: Date = new Date()): Promise<HomeTopUpGiftRow[]> {
  const rows = await tx.walletGift.findMany({
    where: { tenantId: venueId, payment: { status: { in: [...GIFT_PAID_STATUSES] } } },
    orderBy: [{ claimedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'desc' }],
    take: PANEL_MAX_ROWS,
    select: {
      id: true,
      createdAt: true,
      expiresAt: true,
      claimedAt: true,
      payment: { select: { amountCents: true } },
      wallet: { select: { pinHash: true, _count: { select: { passkeys: true } } } },
    },
  });
  return rows.map((g) => ({
    id: g.id,
    amountCents: g.payment.amountCents,
    createdAt: g.createdAt.toISOString(),
    expiresAt: g.expiresAt.toISOString(),
    claimedAt: g.claimedAt?.toISOString() ?? null,
    state: giftState({ ...g, walletActivated: g.wallet.pinHash !== null || g.wallet._count.passkeys > 0 }, now),
  }));
}

/**
 * Borra el nombre y el mensaje de los regalos guardados hace más de
 * GIFT_TEXT_KEEP_DAYS y de los caducados sin guardar. Lo lanza el repaso de
 * la retención de datos (DeviceIpRetentionService, cada 6 h). Devuelve cuántos.
 */
export async function eraseGiftTexts(prisma: Pick<PrismaService, 'asSystem'>, now: Date = new Date()): Promise<number> {
  const claimedBefore = new Date(now.getTime() - GIFT_TEXT_KEEP_DAYS * DAY_MS);
  const out = await prisma.asSystem((tx) =>
    tx.walletGift.updateMany({
      where: {
        OR: [{ toName: { not: null } }, { message: { not: null } }],
        AND: [{ OR: [{ claimedAt: { lt: claimedBefore } }, { claimedAt: null, expiresAt: { lte: now } }] }],
      },
      data: { toName: null, message: null },
    }),
  );
  return out.count;
}
