import { BadRequestException, Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { RedsysAdapter } from '../gateways/redsys.adapter';
import { WebhooksController } from '../webhooks/webhooks.controller';

type ReturnResult = 'sin-firma' | 'firma-mala' | 'pedido-distinto' | 'no-aprobado' | 'enviado' | 'error' | 'rechazado';

/** La vuelta solo aporta una prueba: el aviso y la cola siguen haciendo el trabajo. */
@Injectable()
export class RedsysReturnService {
  private readonly logger = new Logger(RedsysReturnService.name);

  constructor(
    @Inject(RedsysAdapter) private readonly redsys: RedsysAdapter,
    @Inject(WebhooksController) private readonly webhooks: WebhooksController,
  ) {}

  async process(order: string | undefined, query: Record<string, unknown> = {}): Promise<ReturnResult> {
    const safeOrder = typeof order === 'string' && /^[A-Za-z0-9]{1,12}$/.test(order) ? order : undefined;
    const finish = (signature: 'sí' | 'no', result: ReturnResult): ReturnResult => {
      if (Object.keys(query).some((key) => key.toLowerCase() === 'status' || key.toLowerCase().startsWith('ds_'))) {
        this.logger.log(`Redsys vuelta: pedido=${safeOrder ?? '-'} firma=${signature} resultado=${result}`);
      }
      return result;
    };
    const version = query.Ds_SignatureVersion ?? query.ds_signatureversion;
    const params = query.Ds_MerchantParameters ?? query.ds_merchantparameters;
    const signature = query.Ds_Signature ?? query.ds_signature;
    if ([version, params, signature].some((field) => field === null || field === undefined)) return finish('no', 'sin-firma');
    if (
      typeof version !== 'string' || typeof params !== 'string' || typeof signature !== 'string' ||
      version.length > 32 || params.length > 8192 || signature.length > 128
    ) return finish('no', 'firma-mala');
    // Al interpretar una query de formulario, un + sin escapar se convierte en espacio.
    const body = {
      Ds_SignatureVersion: version,
      Ds_MerchantParameters: params.replace(/ /g, '+'),
      Ds_Signature: signature.replace(/ /g, '+'),
    };
    const notice = this.redsys.parseNotification(body);
    if (!notice) return finish('no', 'firma-mala');
    if (!safeOrder || notice.order !== safeOrder) return finish('sí', 'pedido-distinto');
    if (!notice.approved) return finish('sí', 'no-aprobado');
    const proof = await this.redsys.proveApproval({ paymentId: '', providerTxId: safeOrder, payload: body });
    if (proof.kind !== 'confirmed') return finish('sí', 'no-aprobado');
    try {
      // Mismo registro, idempotencia y cola que una notificación directa del banco.
      await this.webhooks.receiveRedsys({ headers: {}, body } as FastifyRequest);
      return finish('sí', 'enviado');
    } catch (error) {
      if (error instanceof UnauthorizedException || error instanceof BadRequestException) return finish('sí', 'rechazado');
      // Si falla la cola, el registro persistido puede recuperarse por el repaso habitual.
      return finish('sí', 'error');
    }
  }
}