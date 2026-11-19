import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@nightpay/db';
import {
  PAYOUT_ACCOUNT_HOLD_HOURS,
  maskHolderName,
  maskPayoutAddress,
  payoutHolderProblem,
  payoutMetadataFor,
  type PayoutMetadata,
  type PayoutMethod,
} from '@nightpay/contracts';
import { isSealedPayoutValue, openPayoutValue, sealPayoutValue } from './payout-account-crypto';
import { payoutRoutingChanges } from './payout-routing';

/**
 * La cuenta de cobro de una persona del personal (columnas de users): la
 * cuenta y el titular van cifrados (payout-account-crypto) y, aparte, tapados
 * para enseñarlos. Aquí se abre, se tapa y se calcula qué guardar al
 * cambiarla (con la espera de 48 h y los avisos). Lógica pura.
 */
export interface StoredPayoutAccount {
  id: string;
  payoutMethod: string | null;
  /** Cifrada (pa1:...) o, si es antigua, en claro. */
  payoutAddress: string | null;
  /** JSON; el titular (accountHolder), cifrado o antiguo en claro. */
  payoutMetadata: unknown;
  payoutLabel: string | null;
  payoutAddressMasked?: string | null;
  payoutHolderMasked?: string | null;
  payoutAccountChangedAt?: Date | null;
  payoutHoldUntil?: Date | null;
}

/** Las columnas de users que hacen falta para lo de aquí (select de Prisma). */
export const PAYOUT_ACCOUNT_SELECT = {
  id: true,
  payoutMethod: true,
  payoutAddress: true,
  payoutMetadata: true,
  payoutLabel: true,
  payoutAddressMasked: true,
  payoutHolderMasked: true,
  payoutAccountChangedAt: true,
  payoutHoldUntil: true,
} as const;

/** La cuenta en claro: solo en memoria, nunca a un listado ni al registro. */
export interface OpenPayoutAccount {
  method: PayoutMethod | null;
  address: string | null;
  metadata: PayoutMetadata | null;
  label: string | null;
}

/** Tapada: para listados, respuestas y la app de la compañera. */
export interface MaskedPayoutAccount {
  method: PayoutMethod | null;
  addressMasked: string | null;
  holderMasked: string | null;
  /** Banco, SWIFT y país, sin el titular (null si no queda nada). */
  metadata: PayoutMetadata | null;
  label: string | null;
}

const HOLD_MS = PAYOUT_ACCOUNT_HOLD_HOURS * 60 * 60 * 1000;

function metadataOf(value: unknown): PayoutMetadata | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as PayoutMetadata) : null;
}

function withoutHolder(meta: PayoutMetadata | null): PayoutMetadata | null {
  if (!meta) return null;
  const { accountHolder: _holder, ...rest } = meta;
  return Object.keys(rest).length > 0 ? (rest as PayoutMetadata) : null;
}

/** La cuenta guardada (cifrada o antigua en claro) en claro. Lanza si está cifrada y la clave no es la buena. */
export function openPayoutAddress(row: Pick<StoredPayoutAccount, 'id' | 'payoutAddress'>, kek?: string): string | null {
  if (!row.payoutAddress) return null;
  return openPayoutValue(row.payoutAddress, { userId: row.id, field: 'address' }, kek ?? process.env.ENCRYPTION_KEK);
}

export function openPayoutAccount(row: StoredPayoutAccount, kek?: string): OpenPayoutAccount {
  const meta = metadataOf(row.payoutMetadata);
  const holder = meta?.accountHolder
    ? openPayoutValue(meta.accountHolder, { userId: row.id, field: 'holder' }, kek ?? process.env.ENCRYPTION_KEK)
    : undefined;
  return {
    method: (row.payoutMethod as PayoutMethod | null) ?? null,
    address: openPayoutAddress(row, kek),
    metadata: meta ? { ...meta, ...(holder !== undefined ? { accountHolder: holder } : {}) } : null,
    label: row.payoutLabel ?? null,
  };
}

/**
 * Tapada sin abrirla. Cifrada: lo tapado que se guardó con ella ("••••" si
 * faltara, que no debería). En claro (antigua, antes del relleno): tapada al
 * vuelo, sin mirar lo tapado guardado (si la escribió el API anterior
 * mientras se publicaba, sería lo tapado de otra cuenta).
 */
export function maskedPayoutAccount(row: StoredPayoutAccount): MaskedPayoutAccount {
  const method = (row.payoutMethod as PayoutMethod | null) ?? null;
  const meta = metadataOf(row.payoutMetadata);
  return {
    method,
    addressMasked: maskStored(row.payoutAddress, row.payoutAddressMasked, (a) => maskPayoutAddress(method, a)),
    holderMasked: maskStored(meta?.accountHolder, row.payoutHolderMasked, maskHolderName),
    metadata: withoutHolder(meta),
    label: row.payoutLabel ?? null,
  };
}

function maskStored(
  stored: string | null | undefined,
  savedMask: string | null | undefined,
  mask: (plain: string) => string | null,
): string | null {
  if (!stored) return null;
  return isSealedPayoutValue(stored) ? (savedMask ?? '••••') : mask(stored);
}

type SealedPayoutColumns = Pick<
  Prisma.UserUpdateInput,
  'payoutAddress' | 'payoutAddressMasked' | 'payoutMetadata' | 'payoutHolderMasked'
>;

/**
 * El relleno: lo que hay que guardar para cifrar una cuenta (o un titular)
 * que estaba en claro, con lo tapado aparte. null si no hay nada en claro: se
 * puede repetir. No es un cambio de cuenta: ni fechas, ni espera, ni avisos.
 * Lanza sin ENCRYPTION_KEK.
 */
export function sealLegacyPayoutAccount(
  row: StoredPayoutAccount,
  kek: string | undefined = process.env.ENCRYPTION_KEK,
): SealedPayoutColumns | null {
  const data: SealedPayoutColumns = {};
  const address = row.payoutAddress;
  if (address?.trim() && !isSealedPayoutValue(address)) {
    data.payoutAddress = sealPayoutValue(address, { userId: row.id, field: 'address' }, kek);
    data.payoutAddressMasked = maskPayoutAddress(row.payoutMethod, address);
  }
  const meta = metadataOf(row.payoutMetadata);
  const holder = meta?.accountHolder;
  if (meta && holder?.trim() && !isSealedPayoutValue(holder)) {
    data.payoutMetadata = { ...meta, accountHolder: sealPayoutValue(holder, { userId: row.id, field: 'holder' }, kek) } as Prisma.InputJsonValue;
    data.payoutHolderMasked = maskHolderName(holder);
  }
  return Object.keys(data).length > 0 ? data : null;
}

/**
 * Para el registro: la cuenta y el titular tapados. De una transferencia
 * internacional, también su banco, SWIFT y país (no son secretos): si solo
 * cambian ellos, el antes y el después tapados saldrían iguales.
 */
export function accountForAudit(a: OpenPayoutAccount): {
  payoutMethod: string | null;
  payoutAddress: string | null;
  payoutHolder: string | null;
  payoutLabel: string | null;
  payoutBank?: PayoutMetadata;
} {
  // Solo banco, SWIFT y país (payoutMetadataFor): nada más de lo que hubiera guardado.
  const bank = withoutHolder(payoutMetadataFor(a.method, a.metadata));
  return {
    payoutMethod: a.method,
    payoutAddress: maskPayoutAddress(a.method, a.address),
    payoutHolder: maskHolderName(a.metadata?.accountHolder),
    payoutLabel: a.label,
    ...(bank ? { payoutBank: bank } : {}),
  };
}

/** Lo que pide un cambio (undefined = sin tocar). */
export interface PayoutAccountChange {
  method?: PayoutMethod | null;
  address?: string | null;
  metadata?: PayoutMetadata | null;
  label?: string | null;
}

export interface PayoutAccountPlan {
  /** Las columnas de users a guardar (solo las que cambian). */
  data: Prisma.UserUpdateInput;
  before: OpenPayoutAccount;
  after: OpenPayoutAccount;
  /** Cambió a dónde va el dinero: el método, la cuenta o, en una transferencia internacional, su banco, SWIFT o país. */
  destinationChanged: boolean;
  /** Cambió la cuenta o el titular: avisos a la compañera, incidencia y Telegram. */
  accountChanged: boolean;
  /** No tenía ninguna cuenta ni hubo cambios antes: sin espera. */
  first: boolean;
  /** Hasta cuándo no se le paga a la cuenta (la que queda tras el cambio). */
  holdUntil: Date | null;
  /**
   * Para el `where` al guardarlo: solo si la cuenta sigue como se leyó. Si
   * otro cambio entró a la vez, no se pisa (P2025 → payoutAccountChangedMeanwhile)
   * ni salen avisos con un «antes» que ya no era. Esa fecha solo la escribe
   * este plan (en milisegundos, como la lee Prisma).
   */
  ifUnchanged: { payoutAccountChangedAt: Date | null };
}

/** 409 al guardar un plan: la cuenta cambió por otro lado después de leerla. */
export function payoutAccountChangedMeanwhile(): ConflictException {
  return new ConflictException('La cuenta de cobro de esta persona acaba de cambiar por otro lado: vuelve a abrir su ficha y repite el cambio.');
}

/**
 * El banco, el SWIFT y el país de una transferencia internacional, limpios
 * (lo guardado por el API de antes puede no estarlo): con la cuenta, deciden
 * a dónde va el dinero. Los demás métodos no llevan.
 */
function bankOf(method: PayoutMethod | null, meta: PayoutMetadata | null): string {
  const m = payoutMetadataFor(method, meta);
  return JSON.stringify([m?.bankName ?? null, m?.swiftBic ?? null, m?.country ?? null]);
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Qué guardar al cambiar la cuenta de cobro (panel, enlace de alta o
 * super-admin). La cuenta, del método que queda (400 si no); en SEPA y SWIFT,
 * con titular (400 si falta al cambiar). Cambiar a dónde va el dinero de una
 * cuenta que ya existía (el método, la cuenta o, con el mismo número, el
 * banco, el SWIFT o el país de una transferencia internacional) para a la
 * nueva 48 h (no la primera cuenta, ni el efectivo). Solo el titular o el
 * alias no mueven el dinero: sin espera. Todo lo nuevo se guarda cifrado y
 * tapado aparte.
 *
 * Si la guardada no se puede abrir (se cambió ENCRYPTION_KEK), cuenta como
 * «no se sabe cuál era»: así se puede poner otra vez, entera.
 */
export function planPayoutAccountChange(
  row: StoredPayoutAccount,
  change: PayoutAccountChange,
  now: Date,
  kek: string | undefined = process.env.ENCRYPTION_KEK,
): PayoutAccountPlan {
  const before = openOrUnknown(row, kek);
  const routing = payoutRoutingChanges(
    { payoutMethod: before.method, payoutAddress: before.address },
    { payoutMethod: change.method, payoutAddress: change.address },
  );
  const method = routing.payoutMethod !== undefined ? routing.payoutMethod : before.method;
  const address = routing.payoutAddress !== undefined ? routing.payoutAddress : before.address;
  const methodChanged = method !== before.method;
  const addressChanged = methodChanged || address !== before.address;
  const metadata =
    change.metadata !== undefined || methodChanged
      ? payoutMetadataFor(method, change.metadata !== undefined ? change.metadata : before.metadata)
      : before.metadata;
  const destinationChanged = addressChanged || bankOf(method, metadata) !== bankOf(method, before.metadata);
  const metadataChanged = !sameJson(metadata, before.metadata);
  const holderChanged = (metadata?.accountHolder ?? null) !== (before.metadata?.accountHolder ?? null);
  const accountChanged = destinationChanged || holderChanged;
  const label = change.label !== undefined ? change.label : before.label;

  if (accountChanged || change.metadata !== undefined) {
    const problem = payoutHolderProblem(method, metadata);
    if (problem) throw new BadRequestException(problem);
  }

  const first = !before.method && !before.address && !row.payoutAccountChangedAt;
  // Sin tocar la cuenta, la que hay guardada (aunque no se pueda abrir).
  const paysToAccount = Boolean(method && method !== 'MANUAL_CASH' && (addressChanged ? address : row.payoutAddress));
  const holdUntil = destinationChanged
    ? paysToAccount && !first
      ? new Date(now.getTime() + HOLD_MS)
      : null
    : (row.payoutHoldUntil ?? null);

  const data: Prisma.UserUpdateInput = {};
  if (methodChanged) data.payoutMethod = method;
  if (addressChanged) {
    data.payoutAddress = address ? sealPayoutValue(address, { userId: row.id, field: 'address' }, kek) : null;
    data.payoutAddressMasked = maskPayoutAddress(method, address);
  }
  if (destinationChanged) data.payoutHoldUntil = holdUntil;
  if (metadataChanged) {
    data.payoutMetadata = sealedMetadata(row.id, metadata, kek);
    data.payoutHolderMasked = maskHolderName(metadata?.accountHolder);
  }
  if (label !== before.label) data.payoutLabel = label;
  if (accountChanged) data.payoutAccountChangedAt = now;

  return {
    data,
    before,
    after: { method, address, metadata, label },
    destinationChanged,
    accountChanged,
    first,
    holdUntil,
    ifUnchanged: { payoutAccountChangedAt: row.payoutAccountChangedAt ?? null },
  };
}

function openOrUnknown(row: StoredPayoutAccount, kek: string | undefined): OpenPayoutAccount {
  try {
    return openPayoutAccount(row, kek);
  } catch {
    return { method: (row.payoutMethod as PayoutMethod | null) ?? null, address: null, metadata: null, label: row.payoutLabel ?? null };
  }
}

function sealedMetadata(
  userId: string,
  meta: PayoutMetadata | null,
  kek: string | undefined,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (!meta) return Prisma.DbNull;
  const holder = meta.accountHolder?.trim();
  return {
    ...meta,
    ...(holder ? { accountHolder: sealPayoutValue(holder, { userId, field: 'holder' }, kek) } : {}),
  } as Prisma.InputJsonValue;
}
