import { eurPlain } from '../../common/money/eur';
import { sameWalletGroup } from '../wallets/wallet-rules';

/**
 * Recarga de saldo cobrada (AUTHORIZED): a qué saldo se suma. Reglas puras;
 * las consultas (con el saldo bloqueado FOR UPDATE) las pasa quien llama.
 *
 *  - Saldo activo o a cero (DEPLETED) → ese.
 *  - Saldo ya sumado a otro (Face ID: mergedIntoId) → se sigue la cadena hasta
 *    el saldo bueno, del mismo grupo de locales. Antes la recarga no se sumaba
 *    a nada: el cliente pagaba y no tenía el saldo.
 *  - Devuelto o caducado (REFUNDED / EXPIRED), cadena rota o de otro grupo →
 *    no se suma: incidencia para devolver la recarga o reactivar el saldo.
 *  - Bloqueado por el super-admin (después de crear el cobro: al crearlo ya
 *    da 409) → tampoco: incidencia, como un saldo cerrado.
 */

export interface CreditWalletRow {
  id: string;
  tenantId: string;
  walletGroup: string | null;
  balanceCents: number;
  status: string;
  mergedIntoId: string | null;
  shortCode: string | null;
  /** Bloqueado por el super-admin (no siempre viene: null o ausente = no). */
  blockedAt?: Date | null;
}

/** Saltos como mucho siguiendo saldos sumados a otros (y sin vueltas). */
export const MAX_MERGE_DEPTH = 5;

export type CreditSkipCause = 'missing' | 'closed' | 'merge-loop' | 'other-group' | 'blocked';

export type CreditTarget =
  | { ok: true; wallet: CreditWalletRow; mergedFrom: string | null }
  | { ok: false; cause: CreditSkipCause; walletStatus: string };

export async function findCreditTarget(
  first: CreditWalletRow | null,
  lockById: (id: string) => Promise<CreditWalletRow | null>,
): Promise<CreditTarget> {
  if (!first) return { ok: false, cause: 'missing', walletStatus: 'missing' };
  let current = first;
  const seen = new Set([first.id]);
  while (current.mergedIntoId) {
    const nextId = current.mergedIntoId;
    if (seen.size > MAX_MERGE_DEPTH || seen.has(nextId)) {
      return { ok: false, cause: 'merge-loop', walletStatus: 'merged' };
    }
    const next = await lockById(nextId);
    if (!next) return { ok: false, cause: 'missing', walletStatus: 'missing' };
    if (!sameWalletGroup(next, { id: first.tenantId, walletGroup: first.walletGroup })) {
      return { ok: false, cause: 'other-group', walletStatus: next.status };
    }
    seen.add(next.id);
    current = next;
  }
  if (current.status !== 'ACTIVE' && current.status !== 'DEPLETED') {
    return { ok: false, cause: 'closed', walletStatus: current.status };
  }
  if (current.blockedAt) return { ok: false, cause: 'blocked', walletStatus: current.status };
  return { ok: true, wallet: current, mergedFrom: current.id === first.id ? null : first.id };
}

/**
 * Código corto con el que queda el saldo al reactivarse. Un saldo a cero
 * (DEPLETED) no ocupa su código (índice único solo entre los activos): si
 * otro saldo activo lo cogió mientras tanto, al reactivarse lleva uno nuevo
 * (si no, la recarga chocaba con el índice y no se podía cobrar).
 * null = sin código (no debería pasar: se agotaron los intentos).
 */
export async function shortCodeOnCredit(
  wallet: Pick<CreditWalletRow, 'status' | 'shortCode'>,
  isTaken: (code: string) => Promise<boolean>,
  newCode: () => string,
  attempts = 5,
): Promise<string | null> {
  if (wallet.status === 'ACTIVE' || !wallet.shortCode) return wallet.shortCode;
  if (!(await isTaken(wallet.shortCode))) return wallet.shortCode;
  for (let i = 0; i < attempts; i += 1) {
    const code = newCode();
    if (!(await isTaken(code))) return code;
  }
  return null;
}

const CAUSE_TEXT: Record<CreditSkipCause, string> = {
  closed: 'el saldo está cerrado',
  missing: 'el saldo no existe',
  'merge-loop': 'el saldo está sumado a otro y no se encuentra el bueno',
  'other-group': 'el saldo está sumado a uno de otro grupo de locales',
  blocked: 'el saldo está bloqueado',
};

/** Lo que tiene que hacer el dueño cuando una recarga cobrada no se pudo sumar. */
export function skippedCreditDetail(args: {
  cause: CreditSkipCause;
  walletStatus: string;
  amountCents: number;
  paymentId: string;
}): string {
  const amount = eurPlain(args.amountCents);
  const status = args.cause === 'closed' ? ` (${args.walletStatus})` : '';
  return (
    `Recarga de ${amount} cobrada (cobro ${args.paymentId.slice(0, 8)}) pero ${CAUSE_TEXT[args.cause]}${status}: ` +
    'devuélvela en el banco o reactiva el saldo y súmale el importe.'
  );
}
