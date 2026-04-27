import {
  BadRequestException,
  Controller,
  HttpCode,
  Inject,
  Logger,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type { FastifyRequest } from 'fastify';
import type { Provider } from '@nightpay/contracts';
import { Public } from '../../common/decorators/public.decorator';
import { PrismaService } from '../../common/prisma/prisma.service';
import { GatewayRegistry } from '../gateways/gateway.registry';
import { WEBHOOKS_INGEST_QUEUE } from '../queues/queue-tokens';

@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);
  private readonly prisma: PrismaService;
  private readonly gateways: GatewayRegistry;
  private readonly queue: Queue;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(GatewayRegistry) gateways: GatewayRegistry,
    @InjectQueue(WEBHOOKS_INGEST_QUEUE) queue: Queue,
  ) {
    this.prisma = prisma;
    this.gateways = gateways;
    this.queue = queue;
  }

  /**
   * Recepción de webhook desde una pasarela.
   * - Verifica HMAC + anti-replay
   * - Idempotencia por (provider, externalEventId)
   * - Persiste raw body
   * - Encola job para procesamiento async — devuelve 200 inmediato
   */
  @Public()
  @Post(':provider')
  @HttpCode(200)
  async receive(
    @Param('provider') providerParam: string,
    @Req() req: FastifyRequest,
  ): Promise<{ received: true; duplicate?: boolean }> {
    const provider = providerParam.toUpperCase() as Provider;
    if (provider !== 'WIPAY' && provider !== 'PEANPE') {
      throw new BadRequestException(`Unknown provider: ${providerParam}`);
    }

    const adapter = this.gateways.get(provider);

    // Fastify: req.rawBody requiere config; usamos JSON.stringify del body como fallback
    const rawBody =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (req as any).rawBody instanceof Buffer
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ((req as any).rawBody as Buffer)
        : Buffer.from(JSON.stringify(req.body ?? {}), 'utf8');

    const verify = adapter.verifyWebhook(req.headers, rawBody);
    if (!verify.valid) {
      this.logger.warn(`webhook ${provider} rejected: ${verify.reason}`);
      throw new UnauthorizedException();
    }
    if (!verify.externalEventId) {
      throw new BadRequestException('Missing externalEventId');
    }

    // Idempotencia — webhookDelivery NO es tenant-scoped, query directa.
    const existing = await this.prisma.webhookDelivery.findUnique({
      where: {
        provider_externalEventId: {
          provider,
          externalEventId: verify.externalEventId!,
        },
      },
    });

    if (existing?.processedAt) {
      return { received: true, duplicate: true };
    }

    const delivery = existing
      ? existing
      : await this.prisma.webhookDelivery.create({
          data: {
            provider,
            externalEventId: verify.externalEventId!,
            rawBody,
            signature:
              ((req.headers['x-signature'] ?? '') as string | string[])?.toString() || '',
          },
        });

    await this.queue.add(
      'process-webhook',
      { deliveryId: delivery.id.toString() },
      {
        jobId: `webhook-${provider}-${verify.externalEventId}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 5000 },
      },
    );

    return { received: true };
  }
}
