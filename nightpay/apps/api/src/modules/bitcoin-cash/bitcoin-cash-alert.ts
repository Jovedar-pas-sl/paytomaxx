import { eurPlain } from '../../common/money/eur';

/**
 * El aviso por Telegram de CADA devolución en efectivo de un pago con bitcoin
 * (decisión del dueño, 17-nov-2026), con el formato de los avisos de dinero
 * («⚠️ Local: título» y el detalle debajo). Sin datos del cliente: ni el código
 * de su recibo ni nada que lo identifique; del personal, quién la hizo y quién
 * la aprobó (como los avisos de «Por aprobar»).
 */
export interface CashRefundAlert {
  venueName: string;
  amountCents: number;
  reason: string;
  /** Un cobro pagado con bitcoin (su referencia, C-0012) o el bitcoin que llegó sin cobro (su factura). */
  target: { kind: 'payment'; ref: string | null } | { kind: 'invoice'; invoiceId: string };
  doneBy: string;
  /** El dueño que la aprobó (pasaba del límite); null: la hizo directa. */
  approvedBy: string | null;
}

export function cashRefundAlertText(a: CashRefundAlert): string {
  const what = a.target.kind === 'payment' ? `Cobro ${a.target.ref ?? 'sin referencia'}` : `Bitcoin sin cobro (factura ${a.target.invoiceId})`;
  return [
    `⚠️ ${a.venueName}: Devolución en efectivo de un pago con bitcoin`,
    `${eurPlain(a.amountCents)} de la caja · ${what}`,
    `Motivo: ${a.reason}`,
    a.approvedBy ? `La hizo ${a.doneBy} · la aprobó ${a.approvedBy}` : `La hizo ${a.doneBy}`,
    'El bitcoin se queda en la cartera del local.',
  ].join('\n');
}
