import type { WalletPayoutMethod } from './wallet-rules';

/**
 * «Me voy» visto por el cliente en su página del saldo: cuánto se le devuelve,
 * cómo y en qué paso va (Pedido → Aprobado → Devuelto).
 *  - requested: pulsó «Me voy» y aún no se ha empezado a devolver.
 *  - approved:  el dueño la está apuntando a la tarjeta (devolución PENDING).
 *  - done:      devuelto (a la tarjeta o en efectivo) y el saldo cerrado.
 */
export interface ClientRefundState {
  stage: 'requested' | 'approved' | 'done';
  amountCents: number;
  /** Cómo se devolvió o se está devolviendo; vacío mientras no se sabe. */
  methods: WalletPayoutMethod[];
}

const LAST4 = /^[0-9]{4}$/;

/**
 * Últimas 4 cifras distintas y bien formadas de las tarjetas con las que se
 * recargó: a ellas vuelve el dinero si se devuelve a la tarjeta.
 */
export function refundCards(last4s: ReadonlyArray<string | null | undefined>): string[] {
  return [...new Set(last4s.filter((c): c is string => typeof c === 'string' && LAST4.test(c)))].slice(0, 3);
}

function methodsOf(rows: ReadonlyArray<{ method: string }>): WalletPayoutMethod[] {
  return [...new Set(rows.map((r) => r.method))].filter(
    (m): m is WalletPayoutMethod => m === 'CARD' || m === 'CASH',
  );
}

const sum = (rows: ReadonlyArray<{ amountCents: number }>): number => rows.reduce((a, r) => a + r.amountCents, 0);

export function clientRefundState(
  wallet: { status: string; balanceCents: number; closeRequested: boolean },
  payouts: ReadonlyArray<{ amountCents: number; method: string; status: string }>,
): ClientRefundState | null {
  const pending = payouts.filter((p) => p.status === 'PENDING');
  if (pending.length > 0) {
    return { stage: 'approved', amountCents: sum(pending), methods: methodsOf(pending) };
  }
  const done = payouts.filter((p) => p.status === 'DONE');
  if (wallet.status === 'REFUNDED' && done.length > 0) {
    return { stage: 'done', amountCents: sum(done), methods: methodsOf(done) };
  }
  if (wallet.closeRequested && wallet.status === 'ACTIVE' && wallet.balanceCents > 0) {
    return { stage: 'requested', amountCents: wallet.balanceCents, methods: [] };
  }
  return null;
}
