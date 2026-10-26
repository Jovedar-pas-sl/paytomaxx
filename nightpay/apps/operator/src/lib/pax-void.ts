// «Anular en el datáfono»: el lector anula la operación y OxioPay se entera.
// Lo usan el cobro en el lector (PaxChargeFlow) y la lista de ventas por
// revisar de /pax. Si OxioPay no se entera (sin red), se dice y el aviso queda
// en cola; si no la tiene en el cobro, queda un aviso para el encargado (A2-07).

import { clearSaleToReview, saveSaleToReview, sendVoid, voidUnknownNotice, type VoidReport } from './pax-api';
import { callReader } from './pax-bridge';
import { formatEur } from './money';
import { voidedMessage } from './pax-flow';

export interface SaleToVoid {
  paymentId: string;
  operationNumber: string;
  amountCents: number;
  reference: string;
}

export interface VoidResult {
  /** El lector la anuló. */
  approved: boolean;
  /** Si OxioPay se enteró. */
  report: VoidReport;
  /** Lo que se enseña al camarero. */
  message: string;
}

export async function voidSaleOnReader(sale: SaleToVoid): Promise<VoidResult> {
  const r = await callReader('voidSale', {
    operationNumber: sale.operationNumber,
    amountCents: sale.amountCents,
    reference: sale.reference,
  });
  const approved = r.ok && Boolean(r.result?.approved);
  const report = await sendVoid(sale.paymentId, {
    operationNumber: sale.operationNumber,
    approved,
    ...(r.ok ? {} : { resultText: r.message ?? r.error }),
  });
  if (approved) {
    // Anulada: ya no hay que anularla. Si OxioPay no la tiene en el cobro, queda el aviso.
    if (report === 'refused') {
      saveSaleToReview(voidUnknownNotice(sale.paymentId, sale.operationNumber, 'OxioPay no ha admitido el aviso de esta anulación.'));
    } else {
      clearSaleToReview(sale.paymentId, sale.operationNumber);
    }
  }
  return { approved, report, message: voidedMessage(approved, report) };
}

/** Lo que se enseña tras «Anular en el datáfono»: se queda aunque la venta ya no esté en la lista. */
export interface VoidNotice {
  key: string;
  ok: boolean;
  text: string;
}

export function voidNoticeOf(sale: Pick<SaleToVoid, 'paymentId' | 'operationNumber' | 'amountCents'>, out: VoidResult): VoidNotice {
  return {
    key: `${sale.paymentId}:${sale.operationNumber}`,
    ok: out.approved,
    text: `Operación ${sale.operationNumber} · ${formatEur(sale.amountCents)}: ${out.message}`,
  };
}
