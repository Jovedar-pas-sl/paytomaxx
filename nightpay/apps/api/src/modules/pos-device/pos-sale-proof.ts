import { Injectable } from '@nestjs/common';
import type { ApprovalProof } from '../gateways/gateway.adapter';

/**
 * Prueba de una venta del datáfono PAX. El resultado lo manda el propio
 * aparato (con su credencial), así que no basta para dar dinero por cobrado:
 * hay que preguntárselo a Paytef desde el servidor, como con los avisos de la
 * pasarela (webhook-ingest → proveApproval).
 */

/** Lo que dice el datáfono de una venta aprobada. */
export interface PosSaleClaim {
  paymentId: string;
  tenantId: string;
  terminalId: string;
  /** Número de operación de Paytef. */
  operationNumber: string;
  /** transactionReference de la venta (posReference del cobro). */
  reference: string;
  /** Importe cobrado según el datáfono (con propina). */
  amountCents: number;
  authCode: string | null;
}

export interface PosSaleProver {
  /** confirmed solo con la palabra de Paytef (no del datáfono) y su importe. */
  prove(claim: PosSaleClaim): Promise<ApprovalProof>;
}

export const POS_SALE_PROVER = Symbol('POS_SALE_PROVER');

/**
 * Paytef Device API: la venta se hace en el propio datáfono
 * (`127.0.0.1:8887`) y Paytef no nos da una consulta servidor a servidor de
 * esas operaciones. La del Payment LINK (`PaytefAdapter.proveApproval`,
 * `/payment-link/get/{id}`) solo conoce enlaces de pago, no ventas del PAX.
 * Hasta tenerla, ninguna venta del PAX queda probada: `unverifiable`.
 * Cuando Paytef la abra, se implementa aquí y lo demás no cambia.
 */
@Injectable()
export class PaytefDeviceSaleProver implements PosSaleProver {
  prove(): Promise<ApprovalProof> {
    return Promise.resolve({ kind: 'unverifiable', reason: 'paytef-device-sin-consulta-servidor' });
  }
}

export type SaleProofVerdict =
  | { kind: 'proven' }
  | { kind: 'rejected'; reason: string; chargedCents: number | null }
  | { kind: 'unproven'; reason: string };

/**
 * ¿Lo que dice Paytef deja dar la venta por cobrada? Solo `confirmed` por el
 * mismo importe. `rejected` (Paytef no la tiene aprobada o es otro importe) no
 * se cobra; sin respuesta o sin forma de comprobarlo, queda sin probar.
 */
export function judgeSaleProof(proof: ApprovalProof, expectedCents: number): SaleProofVerdict {
  if (proof.kind === 'confirmed') {
    if (proof.amountCents === expectedCents) return { kind: 'proven' };
    return { kind: 'rejected', reason: 'paytef-otro-importe', chargedCents: proof.amountCents };
  }
  if (proof.kind === 'rejected') return { kind: 'rejected', reason: proof.reason, chargedCents: null };
  return { kind: 'unproven', reason: proof.reason };
}
