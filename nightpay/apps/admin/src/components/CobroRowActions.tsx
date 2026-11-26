'use client';

import { Button } from '@nightpay/ui';
import type { BitcoinCashConfig, CobroRow } from '@nightpay/contracts';
import type { PaymentRow } from '@/lib/api';
import { canCashRefund } from '@/lib/bitcoin-cash';
import { COBRO_ACTION_LABELS, COBRO_ACTION_TITLES } from '@/lib/cobros-help';
import { paymentRowOf, reversibleSaldoCharge } from '@/lib/money-map';

const STUCK_AUTHORIZING_MS = 15 * 60 * 1000;

interface Props {
  row: CobroRow;
  role: string;
  onReverse: (row: CobroRow) => void;
  onResolve: (payment: PaymentRow) => void;
  onRefund: (payment: PaymentRow) => void;
  onRefunds: (payment: PaymentRow) => void;
  /** «Devolver en efectivo» lo pagado con bitcoin: el interruptor del local (null: apagado o cargando). */
  bitcoinCash?: BitcoinCashConfig | null;
  onCashRefund?: (payment: PaymentRow) => void;
}

/**
 * Los botones de un cobro, en el pie de su detalle (CobroDetailDock): anular
 * un cobro del saldo, resolver uno atascado, devolver (BBVA o la pasarela) y
 * ver las devoluciones. Quién ve cada uno no cambia por estar en el detalle.
 * No hay botón principal: lo que anula o devuelve dinero va con filete rojo;
 * mirar las devoluciones, discreto.
 */
export function CobroRowActions({ row, role, onReverse, onResolve, onRefund, onRefunds, bitcoinCash = null, onCashRefund }: Props) {
  if (reversibleSaldoCharge(row, role)) {
    return (
      <Button variant="danger-outline" onClick={() => onReverse(row)} size="sm" title={COBRO_ACTION_TITLES.reverse}>
        {COBRO_ACTION_LABELS.reverse}
      </Button>
    );
  }
  const p = paymentRowOf(row);
  if (!p) return null;
  // Redsys: se devuelve en el portal de BBVA y se apunta aquí (solo el dueño).
  const bankRefund = p.provider === 'REDSYS';
  // Bitcoin: el dinero no pasó por el banco ni por la pasarela: se devuelve en efectivo (si el local lo tiene encendido).
  const bitcoin = p.provider === 'BTCPAY';
  const canCash = Boolean(onCashRefund) && canCashRefund(p, role, bitcoinCash, Date.now());
  const canRefund =
    !bitcoin &&
    (p.status === 'AUTHORIZED' || p.status === 'PARTIALLY_REFUNDED') &&
    p.availableAmountCents > 0 &&
    (role === 'OWNER' || (!bankRefund && role === 'MANAGER'));
  const canResolve = role === 'OWNER' && isStuck(p);
  const refundKind = bankRefund ? 'bankRefund' : 'refund';
  return (
    <>
      {canResolve ? (
        <Button variant="ghost" onClick={() => onResolve(p)} size="sm" title={COBRO_ACTION_TITLES.resolve}>
          {COBRO_ACTION_LABELS.resolve}
        </Button>
      ) : null}
      {canRefund ? (
        <Button variant="danger-outline" onClick={() => onRefund(p)} size="sm" title={COBRO_ACTION_TITLES[refundKind]}>
          {COBRO_ACTION_LABELS[refundKind]}
        </Button>
      ) : null}
      {canCash ? (
        <Button variant="danger-outline" onClick={() => onCashRefund?.(p)} size="sm" title="Devolver en euros de la caja lo pagado con bitcoin (el bitcoin se queda en la cartera)">
          Devolver en efectivo
        </Button>
      ) : null}
      {/* Ya hay algo devuelto o reservado (p. ej. una devolución sin confirmar). */}
      {p.availableAmountCents < p.amountCents ? (
        <Button variant="quiet" onClick={() => onRefunds(p)} size="sm" title={COBRO_ACTION_TITLES.refunds}>
          {COBRO_ACTION_LABELS.refunds}
        </Button>
      ) : null}
    </>
  );
}

/** Sin confirmar, o más de 15 min esperando al banco: se puede resolver a mano. */
function isStuck(p: PaymentRow): boolean {
  if (p.status === 'ORPHAN') return true;
  return p.status === 'AUTHORIZING' && Date.now() - Date.parse(p.updatedAt) >= STUCK_AUTHORIZING_MS;
}
