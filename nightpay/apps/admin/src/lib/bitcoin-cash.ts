// «Devolver en efectivo» lo pagado con bitcoin (lógica pura, bitcoin-cash.test.ts).
// El API decide igual: aquí solo se enseña el botón cuando tiene sentido y se
// adelanta si lo va a pedir al dueño (entonces no hace falta el 2FA).

import type { BitcoinCashConfig } from '@nightpay/contracts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Lo que hace falta de un cobro para saber si sale el botón. */
export interface CashRefundablePayment {
  provider: string | null;
  status: string;
  availableAmountCents: number;
  walletId?: string | null;
  authorizedAt?: string | null;
}

/**
 * El botón «Devolver en efectivo» de un cobro: pagado con bitcoin (no una
 * recarga), con algo por devolver, dentro del plazo y con el interruptor del
 * local encendido; solo el encargado y el dueño.
 */
export function canCashRefund(p: CashRefundablePayment, role: string, config: BitcoinCashConfig | null, now: number): boolean {
  if (!config?.enabled || (role !== 'OWNER' && role !== 'MANAGER')) return false;
  if (p.provider !== 'BTCPAY' || p.walletId) return false;
  if (p.status !== 'AUTHORIZED' && p.status !== 'PARTIALLY_REFUNDED') return false;
  if (p.availableAmountCents <= 0 || !p.authorizedAt) return false;
  return now - Date.parse(p.authorizedAt) <= config.days * DAY_MS;
}

/** ¿Lo pedirá al dueño? (pasa de su umbral contando lo ya devuelto del cobro). */
export function cashGoesToOwner(config: BitcoinCashConfig | null, alreadyCents: number, amountCents: number): boolean {
  const above = config?.approvalAboveCents;
  return above !== null && above !== undefined && alreadyCents + amountCents > above;
}

/** Lo máximo de una vez: lo que queda, por debajo de 1.000 €. */
export function cashMaxCents(config: BitcoinCashConfig | null, leftCents: number): number {
  return Math.max(0, Math.min(leftCents, config?.maxCents ?? 99_999));
}

/** «Sacas 45,00 € de la caja. El bitcoin se queda en la cartera del local.» */
export function cashConfirmLine(amount: string): string {
  return `Sacas ${amount} de la caja y se los das al cliente. El bitcoin se queda en la cartera del local: no se devuelve bitcoin.`;
}
