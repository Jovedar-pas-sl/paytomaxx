import { createHash, createHmac } from 'node:crypto';
import { serviceFeeBpsFor, serviceFeeQuote, type VenueServiceFee } from '@nightpay/contracts';

/**
 * «Recargar» desde la página del saldo (/w/:token): el cliente recarga SU
 * saldo desde su móvil, sin el personal. Reglas puras; las consultas las hace
 * WalletTopUpService.
 *
 * Límites (constantes, no ajustes del local: sin migración ni pantalla nueva
 * en el panel; si un local los necesita distintos, irían en paymentMethods):
 *  - Mínimo 10 €: por debajo la comisión fija de la tarjeta se come la recarga
 *    y nadie recarga 3 € en una sala; además, las sugeridas empiezan en 20 €.
 *  - Máximo 300 € por recarga: aquí no hay nadie del local delante. Es más
 *    que una noche normal (el tope de los cobros de la chica es 200 € por
 *    defecto); para más, el personal recarga desde su app como siempre.
 *  - Tope acumulado por saldo en 24 h (SELF_TOPUP_DAILY_*): como mucho 600 €
 *    y 4 recargas pagadas desde el móvil. Si se usa una tarjeta robada o un
 *    enlace del saldo que ha visto otro, lo que se pierde (y el contracargo
 *    que paga el local) queda acotado de verdad: antes, 300 € × 6 cada 15 min.
 *    Se cuenta en la base (los cobros de recarga desde /w), no en Redis.
 *  - Como mucho SELF_TOPUP_MAX_UNRESOLVED a medias o sin confirmar por el
 *    banco a la vez (las que se quedan en el banco sin respuesta acaban en
 *    ORPHAN, en Incidencias, y hay que resolverlas a mano).
 *  - Euros enteros: como la propina «Otra» (sin céntimos que teclear mal).
 *  - Como mucho SELF_TOPUP_PER_WALLET_MAX recargas empezadas por saldo cada
 *    15 min (además del límite por IP del controlador): cada una abre un cobro.
 */

export const SELF_TOPUP_MIN_CENTS = 10_00;
export const SELF_TOPUP_MAX_CENTS = 300_00;
export const SELF_TOPUP_PRESETS_CENTS: readonly number[] = Object.freeze([20_00, 50_00, 100_00]);
export const SELF_TOPUP_PER_WALLET_MAX = 6;
export const SELF_TOPUP_PER_WALLET_WINDOW_S = 15 * 60;
export const SELF_TOPUP_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const SELF_TOPUP_DAILY_MAX_CENTS = 600_00;
export const SELF_TOPUP_DAILY_MAX_PAID = 4;
export const SELF_TOPUP_MAX_UNRESOLVED = 3;

/**
 * La «Comisión del servicio» de cada importe que se puede recargar desde /w
 * (euros enteros de `minCents` a `maxCents`): [i] es la de minCents + i euros.
 * La calcula el servidor con serviceFeeQuote, lo mismo que cobra al crear la
 * recarga, y la página solo la lee (M-3: antes el JS de la página la
 * recalculaba con su propia copia de la fórmula). null: sin comisión.
 */
export function topUpFeeTable(fee: VenueServiceFee | null | undefined, minCents: number, maxCents: number): number[] | null {
  if (serviceFeeBpsFor(fee, 'topUp') === null) return null;
  const table: number[] = [];
  for (let cents = minCents; cents <= maxCents; cents += 100) table.push(serviceFeeQuote(fee, 'topUp', cents).feeCents);
  return table;
}

/** Una recarga desde /w del saldo, tal como la lee el tope (cobros con la clave `wtopup:`). */
export interface SelfTopUpRow {
  amountCents: number;
  status: string;
  qrExpiresAt: Date;
}

export type SelfTopUpCapProblem = 'daily-amount' | 'daily-count' | 'unresolved';

const PAID_TOPUP = new Set(['AUTHORIZED', 'PARTIALLY_REFUNDED', 'REFUNDED']);

/** A medias o sin confirmar: puede acabar cobrada (QR vigente, en el banco o en ORPHAN). */
function unresolved(row: SelfTopUpRow, now: Date): boolean {
  if (row.status === 'CREATED') return row.qrExpiresAt.getTime() > now.getTime();
  return row.status === 'AUTHORIZING' || row.status === 'ORPHAN';
}

/**
 * ¿Cabe una recarga más de `amountCents` con estas de las últimas 24 h? Cuenta
 * lo pagado (también lo ya devuelto: el tope es contra fraude) y lo que aún
 * puede cobrarse; lo caducado, fallido o cancelado no cuenta.
 */
export function selfTopUpCapProblem(
  rows: readonly SelfTopUpRow[],
  amountCents: number,
  now: Date,
): SelfTopUpCapProblem | null {
  const live = rows.filter((r) => PAID_TOPUP.has(r.status) || unresolved(r, now));
  if (live.filter((r) => unresolved(r, now)).length >= SELF_TOPUP_MAX_UNRESOLVED) return 'unresolved';
  if (live.filter((r) => PAID_TOPUP.has(r.status)).length >= SELF_TOPUP_DAILY_MAX_PAID) return 'daily-count';
  const total = live.reduce((sum, r) => sum + r.amountCents, 0);
  return total + amountCents > SELF_TOPUP_DAILY_MAX_CENTS ? 'daily-amount' : null;
}

/**
 * Los importes que se ofrecen en /w y en /r (estudio de fichas, A9): los
 * mismos que en la recepción del local (Ajustes → Noche), los que se pueden
 * recargar desde el móvil (euros enteros de SELF_TOPUP_MIN_CENTS a
 * SELF_TOPUP_MAX_CENTS). Si no queda ninguno, los de fábrica. El del medio
 * sigue saliendo marcado (quitarlo es otro punto, B14, sin aprobar).
 */
export function selfTopUpPresets(receptionQuickAmountsCents: readonly number[]): number[] {
  const usable = [...new Set(receptionQuickAmountsCents.filter((c) => parseTopUpAmount(c) !== null))].sort((a, b) => a - b);
  return usable.length > 0 ? usable : [...SELF_TOPUP_PRESETS_CENTS];
}

/** Importe pedido → céntimos, o null si no vale (euros enteros entre el mínimo y el máximo). */
export function parseTopUpAmount(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return null;
  if (raw % 100 !== 0) return null;
  if (raw < SELF_TOPUP_MIN_CENTS || raw > SELF_TOPUP_MAX_CENTS) return null;
  return raw;
}

/** Clave que pone el navegador en cada intento (un doble toque repite la misma). */
export function isClientTopUpKey(raw: unknown): raw is string {
  return typeof raw === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(raw);
}

/** Por qué no se puede recargar ahora (null = sí se puede). */
export type TopUpBlock =
  | 'blocked'
  | 'closed'
  | 'merged'
  | 'leaving'
  | 'paused'
  | 'method-off'
  | 'no-gateway'
  | 'no-terminal';

export interface TopUpWalletState {
  status: string;
  blockedAt: Date | null;
  mergedIntoId: string | null;
  closeRequestedAt: Date | null;
}

export interface TopUpVenueState {
  paused: boolean;
  /** «Formas de cobro»: la recarga es un cobro con tarjeta (QR) que va al saldo. */
  card: boolean;
  wallet: boolean;
  hasGateway: boolean;
  hasTerminal: boolean;
}

/**
 * Lo del saldo primero (lo que el cliente puede entender), luego lo del local.
 * A cero (DEPLETED) sí se puede: es justo cuando más se recarga; al cobrarse,
 * el saldo vuelve a estar activo (topup-credit).
 */
export function topUpBlock(wallet: TopUpWalletState, venue: TopUpVenueState): TopUpBlock | null {
  if (wallet.blockedAt) return 'blocked';
  if (wallet.mergedIntoId) return 'merged';
  if (wallet.status !== 'ACTIVE' && wallet.status !== 'DEPLETED') return 'closed';
  if (wallet.closeRequestedAt) return 'leaving';
  if (venue.paused) return 'paused';
  if (!venue.card || !venue.wallet) return 'method-off';
  if (!venue.hasGateway) return 'no-gateway';
  if (!venue.hasTerminal) return 'no-terminal';
  return null;
}

const VENUE_CANNOT = 'Ahora no se puede recargar desde el móvil en este local. Pide la recarga en el local.';

/**
 * Mensaje del API (en castellano, como el resto). La pausa y las formas de
 * cobro apagadas salen con su error de siempre (423 VENUE_PAUSED, 409
 * PAYMENT_METHOD_DISABLED); estos son para lo demás.
 */
export const TOPUP_BLOCK_MESSAGES: Readonly<Record<TopUpBlock, string>> = {
  blocked: 'Este saldo está bloqueado: no se puede recargar. Pregunta en el local.',
  merged: 'Esta recarga se sumó a tu otro saldo: recarga desde aquel.',
  closed: 'Este saldo ya está cerrado: no se puede recargar.',
  leaving: 'Has pedido que te devuelvan el saldo: ya no se puede recargar.',
  paused: VENUE_CANNOT,
  'method-off': VENUE_CANNOT,
  'no-gateway': VENUE_CANNOT,
  'no-terminal': VENUE_CANNOT,
};

// ─── Volver a /w después de pagar ────────────────────────────────────────

export const SELF_TOPUP_KEY_PREFIX = 'wtopup:';

/**
 * Valor de la cookie de vuelta del navegador que empezó la recarga en /w. Sale
 * de la clave del navegador: si repite la petición (doble toque, red), la
 * misma cookie. Con el secreto del servidor: nadie la saca de la clave.
 */
export function selfTopUpClaim(secret: string, walletId: string, clientKey: string): string {
  return createHmac('sha256', secret).update(`wallet-topup:${walletId}:${clientKey}`).digest('base64url');
}

/**
 * Idempotency-Key de la recarga: `wtopup:<sha256 de la cookie de vuelta>`.
 * Lleva «:», que la cabecera Idempotency-Key no admite: el personal no puede
 * crear un cobro que pase por recarga desde /w. Y dice qué navegador vuelve
 * al saldo tras pagar (si otro paga el enlace, no ve el saldo).
 */
export function selfTopUpKey(claim: string): string {
  return `${SELF_TOPUP_KEY_PREFIX}${sha256(claim)}`;
}

/** Huella de la cookie de vuelta si el cobro es una recarga desde /w; si no, null. */
export function selfTopUpClaimHash(idempotencyKey: string | null | undefined): string | null {
  if (typeof idempotencyKey !== 'string' || !idempotencyKey.startsWith(SELF_TOPUP_KEY_PREFIX)) return null;
  const hash = idempotencyKey.slice(SELF_TOPUP_KEY_PREFIX.length);
  return /^[0-9a-f]{64}$/.test(hash) ? hash : null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
