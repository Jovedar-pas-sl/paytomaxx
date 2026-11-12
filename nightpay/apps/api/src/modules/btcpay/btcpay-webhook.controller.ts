import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@nightpay/db';
import { Public } from '../../common/decorators/public.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { PrismaService } from '../../common/prisma/prisma.service';
import { MetricsService } from '../metrics/metrics.service';
import { WEBHOOKS_INGEST_QUEUE } from '../queues/queue-tokens';
import { enqueueWebhookDelivery } from '../queues/webhook-enqueue';
import { BtcpayEnabledGuard } from './btcpay-flag';
import { verifyBtcpaySignature } from './btcpay-logic';
import { BtcpayStoreService, type BtcpayAccess } from './btcpay-store.service';

/** Los avisos que se usan; el resto de tipos se ignoran con 200. */
export const USED_WEBHOOK_TYPES: ReadonlySet<string> = new Set([
  'InvoiceSettled',
  'InvoiceExpired',
  'InvoiceInvalid',
  'InvoiceProcessing',
  'InvoiceExpiredPaidPartial',
  'InvoicePaidAfterExpiration',
]);

export const BtcpayWebhookEventSchema = z
  .object({
    type: z.string().max(100),
    deliveryId: z.string().min(1).max(200),
    originalDeliveryId: z.string().min(1).max(200).nullish(),
    storeId: z.string().max(100).nullish(),
    invoiceId: z.string().max(100).nullish(),
  })
  .passthrough();

interface RequestWithRawBody extends FastifyRequest {
  rawBody?: Buffer;
}

export type BtcpayHookAnswer = { received: true; ignored?: string; duplicate?: true };

/**
 * POST /v1/webhooks/btcpay/:hookToken — el aviso de BTCPay de UN local.
 *
 * El token de la ruta identifica al local ANTES de verificar la firma (el
 * secreto es de cada local). Después:
 *  - la firma `BTCPay-Sig: sha256=<HMAC del cuerpo EXACTO>` sobre el Buffer
 *    recibido (nunca el JSON vuelto a escribir: sin Buffer no se acepta) →
 *    401 solo si está mal;
 *  - tipos que no se usan, tienda que no es la del local → 200 y se ignoran;
 *  - se guarda en webhook_deliveries (clave: originalDeliveryId, así un reenvío
 *    no se repite) y se procesa en la cola, como los otros avisos. 200 enseguida;
 *  - un fallo nuestro y pasajero (base, Redis) → 503: BTCPay reintenta (con otro
 *    4xx no lo haría).
 * El aviso no trae estado ni importe: al procesarlo se vuelve a pedir la
 * factura a BTCPay (BtcpayInvoiceService).
 */
@Controller('webhooks/btcpay')
@UseGuards(BtcpayEnabledGuard)
export class BtcpayWebhookController {
  private readonly logger = new Logger(BtcpayWebhookController.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BtcpayStoreService) private readonly stores: BtcpayStoreService,
    @Inject(MetricsService) private readonly metrics: MetricsService,
    @InjectQueue(WEBHOOKS_INGEST_QUEUE) private readonly queue: Queue,
  ) {}

  @Public()
  @Post(':hookToken')
  @HttpCode(200)
  @IpRateLimit({ max: 600, windowSec: 60, scope: 'btcpay-hook', failOpen: true })
  async receive(
    @Param('hookToken') hookToken: string,
    @Headers('btcpay-sig') signature: string | undefined,
    @Req() req: FastifyRequest,
  ): Promise<BtcpayHookAnswer> {
    let access: BtcpayAccess | null;
    try {
      access = await this.stores.accessByHookToken(hookToken);
    } catch (err) {
      this.logger.error(`aviso de BTCPay: no se pudo leer el local del token: ${(err as Error).message}`);
      throw new ServiceUnavailableException();
    }
    // Token desconocido, o local sin secreto abierto: como si no existiera.
    if (!access?.webhookSecret) throw new NotFoundException();

    // La firma es sobre los bytes recibidos: sin el Buffer original no hay forma de comprobarla.
    const raw = (req as RequestWithRawBody).rawBody;
    if (!Buffer.isBuffer(raw)) {
      this.logger.error('aviso de BTCPay sin rawBody: ¿main.ts sin rawBody:true?');
      throw new ServiceUnavailableException();
    }
    if (!verifyBtcpaySignature(access.webhookSecret, raw, signature)) {
      this.metrics.webhooksReceived.inc({ provider: 'BTCPAY', outcome: 'invalid' });
      this.logger.warn(`aviso de BTCPay con firma mala (local ${access.tenantId})`);
      throw new UnauthorizedException();
    }

    let json: unknown;
    try {
      json = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new BadRequestException('Cuerpo no válido');
    }
    const parsed = BtcpayWebhookEventSchema.safeParse(json);
    if (!parsed.success) throw new BadRequestException('Cuerpo no válido');
    const event = parsed.data;

    if (!USED_WEBHOOK_TYPES.has(event.type)) return { received: true, ignored: 'type' };
    // Un aviso de otra tienda (o sin factura) no es de este local.
    if (!event.invoiceId || event.storeId !== access.storeId) {
      this.logger.warn(`aviso de BTCPay ${event.type} de otra tienda o sin factura (local ${access.tenantId}) — ignorado`);
      return { received: true, ignored: 'store' };
    }

    const externalEventId = event.originalDeliveryId ?? event.deliveryId;
    try {
      const existing = await this.prisma.webhookDelivery.findUnique({
        where: { provider_externalEventId: { provider: 'BTCPAY', externalEventId } },
      });
      if (existing?.processedAt) {
        this.metrics.webhooksReceived.inc({ provider: 'BTCPAY', outcome: 'duplicate' });
        return { received: true, duplicate: true };
      }
      const delivery = existing ?? (await this.saveDelivery({ externalEventId, rawBody: raw, signature: 'btcpay-sig', tenantId: access.tenantId }));
      await enqueueWebhookDelivery(this.queue, this.logger, { id: delivery.id, provider: 'BTCPAY', externalEventId });
    } catch (err) {
      this.logger.error(`aviso de BTCPay: no se pudo guardar o encolar: ${(err as Error).message}`);
      throw new ServiceUnavailableException();
    }
    this.metrics.webhooksReceived.inc({ provider: 'BTCPAY', outcome: 'valid' });
    return { received: true };
  }

  /** Dos entregas a la vez: la segunda choca con la clave única y usa el registro de la primera. */
  private async saveDelivery(d: { externalEventId: string; rawBody: Buffer; signature: string; tenantId: string }): Promise<{ id: bigint }> {
    try {
      return await this.prisma.webhookDelivery.create({ data: { provider: 'BTCPAY', ...d } });
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') throw err;
      return this.prisma.webhookDelivery.findUniqueOrThrow({
        where: { provider_externalEventId: { provider: 'BTCPAY', externalEventId: d.externalEventId } },
        select: { id: true },
      });
    }
  }
}
