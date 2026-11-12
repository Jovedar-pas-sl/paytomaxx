import { Injectable } from '@nestjs/common';
import type {
  AuthorizeInput,
  AuthorizeResult,
  GatewayStatus,
  Provider,
  RefundInput,
  RefundResult,
  WebhookVerifyResult,
} from '@nightpay/contracts';
import type { ApprovalClaim, ApprovalProof, GatewayAdapter, WebhookFsmEvent } from './gateway.adapter';

/**
 * BTCPAY en el registro de pasarelas. Bitcoin NO es la pasarela de tarjeta del
 * local: lo abre, vigila y da por pagado BtcpayInvoiceService (modules/btcpay),
 * con la conexión de CADA local. Aquí solo está lo que el resto del API espera de
 * toda pasarela y no puede hacerse con bitcoin:
 *  - refund: lanza, como Redsys y Paytef (la devolución se hace fuera: desde la
 *    cartera del local);
 *  - authorize / verifyWebhook: no aplican (la factura no pasa por este camino
 *    y el aviso tiene su ruta, con el token del local);
 *  - proveApproval: nunca da nada por probado (el aviso se comprueba contra la
 *    API de BTCPay en BtcpayInvoiceService, no aquí).
 */
@Injectable()
export class BtcpayAdapter implements GatewayAdapter {
  readonly provider: Provider = 'BTCPAY';

  authorize(_input: AuthorizeInput): Promise<AuthorizeResult> {
    return Promise.reject(new Error('Las facturas de bitcoin las abre BtcpayInvoiceService, no la pasarela de tarjeta.'));
  }

  getStatus(_tenantId: string, _providerTxId: string): Promise<GatewayStatus> {
    return Promise.resolve('UNKNOWN');
  }

  refund(_input: RefundInput): Promise<RefundResult> {
    return Promise.reject(
      new Error('Bitcoin: la devolución no se hace por el API. Devuélvelo desde la cartera del local y apúntalo como «devuelto fuera».'),
    );
  }

  verifyWebhook(): WebhookVerifyResult {
    return { valid: false, reason: 'BTCPay avisa por POST /v1/webhooks/btcpay/:token, no por la ruta genérica' };
  }

  mapWebhookToFsmEvent(): WebhookFsmEvent | null {
    return null;
  }

  proveApproval(_claim: ApprovalClaim): Promise<ApprovalProof> {
    return Promise.resolve({ kind: 'unverifiable', reason: 'Las facturas de bitcoin se comprueban contra BTCPay en BtcpayInvoiceService' });
  }
}
