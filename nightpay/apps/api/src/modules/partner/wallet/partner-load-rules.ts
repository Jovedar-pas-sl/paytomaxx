import { createHash } from 'node:crypto';
import {
  LOAD_LIMITS_FIXED,
  LOAD_VOID_WINDOW_MS,
  PARTNER_DESCRIPTION_MAX,
  PARTNER_IDEMPOTENCY_KEY_RE,
  PARTNER_LOAD_LIMITS,
  PARTNER_REASON_MAX,
  cleanPartnerText,
  codePointLength,
  luhnRun,
  normalizeWalletCardUid,
  partnerTextPersonalData,
  partnerTextProblem,
  type PartnerLoadLimit,
  type WalletLoadBody,
  type WalletLoadRequestBody,
} from '@nightpay/contracts';
import { madridAt, nextDay } from '../../../common/time/madrid';
import { stableJson } from '../../payments/idempotency';
import { cashTopUpOverLimit } from '../../wallets/wallet-cash-limits';
import { partnerError } from '../http/partner-problem';

/**
 * Reglas puras de las cargas de los socios (PR 3): la clave y la huella de la
 * petición, los textos, el orden de los topes, la noche y el cursor de la
 * lista, y lo que se enseña de una carga. Sin base, Redis ni Nest.
 */

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** La `Idempotency-Key` de la petición: sin ella, 400 idempotency_key_missing; mal formada, 400 invalid_request. */
export function idempotencyKeyOf(headers: Readonly<Record<string, string | string[] | undefined>>): string {
  const raw = headers['idempotency-key'];
  if (raw === undefined) throw partnerError('idempotency_key_missing');
  if (typeof raw !== 'string' || !PARTNER_IDEMPOTENCY_KEY_RE.test(raw)) throw partnerError('invalid_request', { param: 'Idempotency-Key' });
  return raw;
}

/**
 * La huella de una carga: «la misma petición» del contrato, tras leer el JSON
 * (orden y espacios no cuentan). Nunca guarda el `qr` ni el UID: solo su sha256.
 */
export function loadRequestHash(body: WalletLoadRequestBody): string {
  return sha256(
    stableJson({
      v: 1,
      op: 'load',
      amount: body.amount,
      description: cleanPartnerText(body.description),
      reference: body.reference ?? null,
      funding: body.funding,
      device: body.device ?? null,
      qr: sha256(body.qr.trim()),
      uid: body.nfc_uid === undefined ? null : sha256(normalizeWalletCardUid(body.nfc_uid) ?? body.nfc_uid),
    }),
  );
}

/** El miembro de los rechazos por `per_operation` (la misma petición repetida cuenta una vez). */
export function refusalMember(idempotencyKey: string, requestHash: string): string {
  return `${sha256(idempotencyKey)}:${requestHash}`;
}

/**
 * Los textos de la carga, en el orden del contrato (solo sin carga guardada
 * con esa clave: un reintento nunca los recibe). Devuelve la descripción limpia.
 */
export function assertLoadTexts(body: WalletLoadRequestBody): string {
  if (partnerTextProblem(body.description)) throw partnerError('description_invalid');
  const description = cleanPartnerText(body.description);
  const length = codePointLength(description);
  if (length < 1 || length > PARTNER_DESCRIPTION_MAX) {
    throw partnerError('validation_failed', { param: 'description' }, undefined, {
      en: 'description must be 1 to 60 characters.',
      es: 'description: de 1 a 60 caracteres.',
    });
  }
  if (partnerTextPersonalData(description)) throw partnerError('description_personal_data');
  if (body.reference !== undefined && luhnRun(body.reference)) {
    throw partnerError('validation_failed', { param: 'reference' }, undefined, {
      en: 'reference must not hold a card number.',
      es: 'reference: sin números de tarjeta.',
    });
  }
  // shortcut: solo efectivo; la tarjeta llega en su PR (pregunta 6).
  if (body.funding !== 'cash') throw partnerError('funding_not_allowed');
  return description;
}

/** El motivo de una anulación por la API: las reglas de `description`, de 1 a 140, o 422 validation_failed (`reason`). */
export function voidReasonOf(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const clean = cleanPartnerText(raw);
  const length = codePointLength(clean);
  if (length < 1 || length > PARTNER_REASON_MAX) {
    throw partnerError('validation_failed', { param: 'reason' }, undefined, {
      en: 'reason must be 1 to 140 characters.',
      es: 'reason: de 1 a 140 caracteres.',
    });
  }
  if (partnerTextProblem(raw) || partnerTextPersonalData(clean)) {
    throw partnerError('validation_failed', { param: 'reason' }, undefined, {
      en: 'reason breaks the text rules of description.',
      es: 'reason: las mismas reglas que description (sin enlaces, caracteres de control ni datos personales).',
    });
  }
  return clean;
}

// ─── Topes ───────────────────────────────────────────────────────────────

/** Lo que ya va cargado en cada ventana (céntimos, cargas sin anular). */
export interface LoadWindowTotals {
  /** Este saldo (y los sumados a él), esta conexión, 24 h. */
  wallet24h: number;
  /** Este saldo, todos los socios, 24 h. */
  wallet24hAllPartners: number;
  /** Este saldo, todas las conexiones del socio, 30 días (solo cuenta sin teléfono). */
  wallet30dPartner: number;
  /** Esta conexión, desde las 08:00 de Madrid. */
  connectionNight: number;
}

export interface LoadCaps {
  perOperationCents: number;
  walletDayCents: number;
  nightCents: number;
}

export interface LimitHit {
  limit: PartnerLoadLimit;
  /** Lo que ese tope aún deja (null en `wallet_24h_all_partners`, que revelaría lo de otros socios). */
  remaining: number | null;
}

/** El primer tope que salta, en el orden del contrato (decisión 8); null si la carga cabe en todos. */
export function firstLimitHit(amount: number, caps: LoadCaps, totals: LoadWindowTotals, unnamed: boolean): LimitHit | null {
  const left = (cap: number, used: number) => Math.max(0, cap - used);
  const checks: Record<PartnerLoadLimit, LimitHit | null> = {
    per_operation: amount > caps.perOperationCents ? { limit: 'per_operation', remaining: caps.perOperationCents } : null,
    wallet_24h:
      totals.wallet24h + amount > caps.walletDayCents ? { limit: 'wallet_24h', remaining: left(caps.walletDayCents, totals.wallet24h) } : null,
    wallet_24h_all_partners:
      totals.wallet24hAllPartners + amount > LOAD_LIMITS_FIXED.wallet_24h_all_partners ? { limit: 'wallet_24h_all_partners', remaining: null } : null,
    unnamed_wallet_30d:
      unnamed && totals.wallet30dPartner + amount > LOAD_LIMITS_FIXED.unnamed_wallet_30d
        ? { limit: 'unnamed_wallet_30d', remaining: left(LOAD_LIMITS_FIXED.unnamed_wallet_30d, totals.wallet30dPartner) }
        : null,
    connection_night:
      totals.connectionNight + amount > caps.nightCents ? { limit: 'connection_night', remaining: left(caps.nightCents, totals.connectionNight) } : null,
  };
  for (const limit of PARTNER_LOAD_LIMITS) if (checks[limit]) return checks[limit];
  return null;
}

/**
 * Por qué no se puede hacer esta carga: el primer tope (en el orden del
 * contrato) y, solo si ninguno salta, el efectivo de 24 h (decisión 9: lo
 * último y sin `remaining`). null si cabe.
 */
export function loadRefusal(
  amount: number,
  caps: LoadCaps,
  totals: LoadWindowTotals,
  unnamed: boolean,
  cash: Parameters<typeof cashTopUpOverLimit>[1],
): LimitHit | { limit: 'cash' } | null {
  return firstLimitHit(amount, caps, totals, unnamed) ?? (cashTopUpOverLimit(amount, cash) ? { limit: 'cash' } : null);
}

/** «Sin nombre» = sin teléfono de contacto apuntado (decisión 10). */
export function unnamedWallet(contactPhone: string | null | undefined): boolean {
  return !contactPhone || contactPhone.trim() === '';
}

// ─── Noche y cursor ─────────────────────────────────────────────────────

/** La noche del local: de las 08:00 de Madrid de ese día a las 08:00 del siguiente (23 o 25 h al cambiar la hora). */
export function nightOf(day: string): { from: Date; to: Date } {
  return { from: madridAt(day, 8), to: madridAt(nextDay(day), 8) };
}

interface CursorFilters {
  from: Date;
  to: Date;
  reference: string | null;
}

const filtersTag = (f: CursorFilters) =>
  sha256(stableJson({ from: f.from.toISOString(), to: f.to.toISOString(), reference: f.reference })).slice(0, 8);

/** El cursor de la página siguiente: base64url de `createdAt|id|` + 8 hex de la huella de los filtros. */
export function encodeLoadsCursor(last: { createdAt: Date; id: string }, filters: CursorFilters): string {
  return Buffer.from(`${last.createdAt.toISOString()}|${last.id}|${filtersTag(filters)}`, 'utf8').toString('base64url');
}

/** El punto donde sigue la lista; un cursor ilegible o de otros filtros, 422 validation_failed (`cursor`). */
export function decodeLoadsCursor(cursor: string, filters: CursorFilters): { createdAt: Date; id: string } {
  const bad = () =>
    partnerError('validation_failed', { param: 'cursor' }, undefined, {
      en: 'cursor cannot be read with these filters.',
      es: 'cursor: no vale con estos filtros.',
    });
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw bad();
  const [at, id, tag, extra] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (extra !== undefined || !at || !id || tag !== filtersTag(filters)) throw bad();
  const createdAt = new Date(at);
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== at) throw bad();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw bad();
  return { createdAt, id };
}

// ─── Lo que se enseña ───────────────────────────────────────────────────

/** Una carga leída de la base: su respuesta guardada, su saldo de después y su anulación. */
export interface StoredLoad {
  response: unknown;
  balanceAfterCents: number;
  voidedAt: Date | null;
}

/**
 * La carga al leerla, listarla o anularla: la respuesta guardada sin su
 * `balance_after`, con el estado de ahora, `voided_at` y el `balance_after`
 * de la columna solo si la clave tiene `wallet:balance` (aunque en pausa).
 */
export function loadView(row: StoredLoad, withBalance: boolean): WalletLoadBody {
  const { balance_after: _stored, voided_at: _v, ...rest } = row.response as WalletLoadBody;
  return {
    ...rest,
    status: row.voidedAt ? 'voided' : 'succeeded',
    ...(withBalance ? { balance_after: row.balanceAfterCents } : {}),
    voided_at: row.voidedAt?.toISOString() ?? null,
  };
}

/** `void_until`: 10 minutos después de la carga. */
export function voidUntil(createdAt: Date): Date {
  return new Date(createdAt.getTime() + LOAD_VOID_WINDOW_MS);
}
