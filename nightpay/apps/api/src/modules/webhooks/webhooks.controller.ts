import {
  BadRequestException,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Logger,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type { FastifyRequest } from 'fastify';
import type { Provider } from '@nightpay/contracts';
import { Public } from '../../common/decorators/public.decorator';
import { PrismaService } from '../../common/prisma/prisma.service';
import { GatewayRegistry } from '../gateways/gateway.registry';
import { PeanpeAdapter } from '../gateways/peanpe.adapter';
import { WipayAdapter } from '../gateways/wipay.adapter';
import { WEBHOOKS_INGEST_QUEUE } from '../queues/queue-tokens';
import { MetricsService } from '../metrics/metrics.service';

@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);
  private readonly prisma: PrismaService;
  private readonly gateways: GatewayRegistry;
  private readonly queue: Queue;
  private readonly metrics: MetricsService;
  private readonly config: ConfigService;

  private readonly peanpe: PeanpeAdapter;
  private readonly wipay: WipayAdapter;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(GatewayRegistry) gateways: GatewayRegistry,
    @InjectQueue(WEBHOOKS_INGEST_QUEUE) queue: Queue,
    @Inject(MetricsService) metrics: MetricsService,
    @Inject(ConfigService) config: ConfigService,
    @Inject(PeanpeAdapter) peanpe: PeanpeAdapter,
    @Inject(WipayAdapter) wipay: WipayAdapter,
  ) {
    this.prisma = prisma;
    this.gateways = gateways;
    this.queue = queue;
    this.metrics = metrics;
    this.config = config;
    this.peanpe = peanpe;
    this.wipay = wipay;
  }

  /**
   * Recepción de webhook desde una pasarela (sin URL secreta).
   * Wipay/Peanpe firman con HMAC en headers — esta ruta basta.
   */
  @Public()
  @Post(':provider')
  @HttpCode(200)
  async receive(
    @Param('provider') providerParam: string,
    @Req() req: FastifyRequest,
  ): Promise<{ received: true; duplicate?: boolean }> {
    const provider = providerParam.toUpperCase() as Provider;
    if (provider !== 'WIPAY' && provider !== 'PEANPE' && provider !== 'PAYTEF') {
      throw new BadRequestException(`Unknown provider: ${providerParam}`);
    }
    // Wipay, Paytef y Peanpe usan rutas dedicadas:
    //  - PAYTEF: URL secreta
    //  - PEANPE: challenge-response
    //  - WIPAY: form-urlencoded + response texto plano $*$OKY$*$
    if (provider === 'PAYTEF') {
      throw new UnauthorizedException(
        'Paytef webhooks require secret path: /v1/webhooks/paytef/<secret>',
      );
    }
    if (provider === 'PEANPE') {
      throw new UnauthorizedException(
        'Peanpe webhooks usan challenge-response: POST /v1/webhooks/peanpe/notify (challenge) y GET (result)',
      );
    }
    if (provider === 'WIPAY') {
      throw new UnauthorizedException(
        'Wipay/Cecabank webhooks usan ruta dedicada POST /v1/webhooks/wipay (form-urlencoded)',
      );
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
      this.metrics.webhooksReceived.inc({ provider, outcome: 'invalid' });
      this.logger.warn(`webhook ${provider} rejected: ${verify.reason}`);
      throw new UnauthorizedException();
    }
    if (!verify.externalEventId) {
      this.metrics.webhooksReceived.inc({ provider, outcome: 'invalid' });
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
      this.metrics.webhooksReceived.inc({ provider, outcome: 'duplicate' });
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

    this.metrics.webhooksReceived.inc({ provider, outcome: 'valid' });
    return { received: true };
  }

  /**
   * Webhook Paytef con URL secreta.
   * Paytef NO firma HMAC — la "firma" es que solo Paytef conoce esta URL
   * (configurada en notifyResultURL del panel). Validamos secret contra env
   * + dejamos que el adapter valide payload.
   */
  @Public()
  @Post('paytef/:secret')
  @HttpCode(200)
  async receivePaytef(
    @Param('secret') secret: string,
    @Req() req: FastifyRequest,
  ): Promise<{ received: true; duplicate?: boolean }> {
    const expectedSecret = this.config.get<string>('PAYTEF_WEBHOOK_SECRET');
    if (!expectedSecret) {
      this.logger.warn('PAYTEF_WEBHOOK_SECRET not configured — refusing webhook');
      throw new UnauthorizedException();
    }
    // timing-safe compare
    const a = Buffer.from(secret);
    const b = Buffer.from(expectedSecret);
    if (a.length !== b.length) {
      this.metrics.webhooksReceived.inc({ provider: 'PAYTEF', outcome: 'invalid' });
      throw new UnauthorizedException();
    }
    let match = 0;
    for (let i = 0; i < a.length; i++) match |= a[i]! ^ b[i]!;
    if (match !== 0) {
      this.metrics.webhooksReceived.inc({ provider: 'PAYTEF', outcome: 'invalid' });
      throw new UnauthorizedException();
    }

    const provider: Provider = 'PAYTEF';
    const adapter = this.gateways.get(provider);
    const rawBody =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (req as any).rawBody instanceof Buffer
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ((req as any).rawBody as Buffer)
        : Buffer.from(JSON.stringify(req.body ?? {}), 'utf8');

    const verify = adapter.verifyWebhook(req.headers, rawBody);
    if (!verify.valid) {
      this.metrics.webhooksReceived.inc({ provider, outcome: 'invalid' });
      this.logger.warn(`webhook paytef rejected: ${verify.reason}`);
      throw new UnauthorizedException();
    }
    if (!verify.externalEventId) {
      this.metrics.webhooksReceived.inc({ provider, outcome: 'invalid' });
      throw new BadRequestException('Missing externalEventId');
    }

    const existing = await this.prisma.webhookDelivery.findUnique({
      where: {
        provider_externalEventId: {
          provider,
          externalEventId: verify.externalEventId,
        },
      },
    });
    if (existing?.processedAt) {
      this.metrics.webhooksReceived.inc({ provider, outcome: 'duplicate' });
      return { received: true, duplicate: true };
    }

    const delivery = existing
      ? existing
      : await this.prisma.webhookDelivery.create({
          data: {
            provider,
            externalEventId: verify.externalEventId,
            rawBody,
            signature: 'paytef-url-secret',
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

    this.metrics.webhooksReceived.inc({ provider, outcome: 'valid' });
    return { received: true };
  }

  /**
   * Peanpe challenge — paso 1 del flujo (POST).
   * Peanpe POST a esta URL con `identificador_llamada` → respondemos el
   * securityToken como texto plano (número entero 10 cifras).
   * Doc Peanpe: "devolver un numero entero en formato texto plano de 10 cifras".
   */
  @Public()
  @Post('peanpe/notify')
  @HttpCode(200)
  @Header('Content-Type', 'text/plain; charset=utf-8')
  async peanpeChallenge(@Req() req: FastifyRequest): Promise<string> {
    // Peanpe envía form-urlencoded en POST. Fastify ya parsea a req.body.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (req.body ?? {}) as Record<string, any>;
    const id =
      typeof body.identificador_llamada === 'string'
        ? body.identificador_llamada
        : '';
    if (!id) {
      this.logger.warn('Peanpe POST sin identificador_llamada');
      throw new BadRequestException('missing identificador_llamada');
    }
    const token = await this.peanpe.getSecurityTokenForCall(id);
    if (!token) {
      this.logger.warn(`Peanpe POST id_llamada desconocido: ${id}`);
      throw new UnauthorizedException();
    }
    this.metrics.webhooksReceived.inc({ provider: 'PEANPE', outcome: 'valid' });
    return token;
  }

  /**
   * Peanpe result callback — paso 2 del flujo (GET).
   * Peanpe GET a esta URL con status, msg, identificador_llamada, debug,
   * accion, seguridad. Validamos seguridad === securityToken persistido +
   * encolamos job para transitar FSM.
   */
  @Public()
  @Get('peanpe/notify')
  @HttpCode(200)
  async peanpeResult(
    @Query('identificador_llamada') idLlamada: string | undefined,
    @Query('seguridad') seguridad: string | undefined,
    @Query('status') status: string | undefined,
    @Query('msg') msg: string | undefined,
    @Query('accion') accion: string | undefined,
    @Query('debug') debug: string | undefined,
  ): Promise<{ received: true; duplicate?: boolean }> {
    if (!idLlamada || !seguridad || !status) {
      throw new BadRequestException('missing required query params');
    }
    const resolved = await this.peanpe.resolvePaymentFromCallback({
      identificadorLlamada: idLlamada,
      seguridad,
    });
    if (!resolved) {
      this.metrics.webhooksReceived.inc({ provider: 'PEANPE', outcome: 'invalid' });
      throw new UnauthorizedException();
    }

    // Construir un body sintético para reuse del pipeline de webhook genérico
    // (verifyWebhook + mapWebhookToFsmEvent del adapter Peanpe).
    const synthetic = {
      identificador_llamada: idLlamada,
      seguridad,
      status,
      msg: msg ?? null,
      accion: accion ?? 'pagar',
      debug: debug ?? '0',
      // El controller adjunta el paymentId resuelto para que el adapter
      // mapWebhookToFsmEvent lo use sin re-consultar la DB.
      _paymentId: resolved.paymentId,
    };
    const rawBody = Buffer.from(JSON.stringify(synthetic), 'utf8');

    const verify = this.peanpe.verifyWebhook({}, rawBody);
    if (!verify.valid || !verify.externalEventId) {
      this.metrics.webhooksReceived.inc({ provider: 'PEANPE', outcome: 'invalid' });
      throw new BadRequestException('invalid payload');
    }

    // Idempotency vía webhookDeliveries por (provider, externalEventId).
    const provider: Provider = 'PEANPE';
    const existing = await this.prisma.webhookDelivery.findUnique({
      where: {
        provider_externalEventId: {
          provider,
          externalEventId: verify.externalEventId,
        },
      },
    });
    if (existing?.processedAt) {
      this.metrics.webhooksReceived.inc({ provider, outcome: 'duplicate' });
      return { received: true, duplicate: true };
    }

    const delivery = existing
      ? existing
      : await this.prisma.webhookDelivery.create({
          data: {
            provider,
            tenantId: resolved.tenantId,
            externalEventId: verify.externalEventId,
            rawBody,
            signature: 'peanpe-challenge-response',
          },
        });

    // Persistir el resultado en peanpe_calls (audit + reintentos)
    await this.peanpe.persistCallbackResult(idLlamada, status, msg ?? null);

    await this.queue.add(
      'process-webhook',
      { deliveryId: delivery.id.toString() },
      {
        jobId: `webhook-${provider}-${verify.externalEventId}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 5000 },
      },
    );

    this.metrics.webhooksReceived.inc({ provider, outcome: 'valid' });
    return { received: true };
  }

  /**
   * Comunicación on-line del TPV Virtual de Cecabank / Wipay.
   *
   * Body: form-urlencoded con MerchantID, AcquirerBIN, TerminalID,
   *       Num_operacion, Importe, TipoMoneda, Exponente, Referencia,
   *       Firma, Num_aut, etc.
   * Firma: SHA-256(clave + MerchantID + AcquirerBIN + TerminalID +
   *                Num_operacion + Importe + TipoMoneda + Exponente +
   *                Referencia)
   * Respuesta esperada: texto plano `$*$OKY$*$` en <30s. Si NightPay no
   *   responde a tiempo (o devuelve otro string), Cecabank anula la
   *   operación. Por eso devolvemos OKY INMEDIATAMENTE — el procesado
   *   real lo encolamos como job en background con retries.
   */
  @Public()
  @Post('wipay')
  @HttpCode(200)
  @Header('Content-Type', 'text/plain; charset=utf-8')
  async receiveWipay(@Req() req: FastifyRequest): Promise<string> {
    const provider: Provider = 'WIPAY';

    // Fastify form-urlencoded → req.body es Record<string,string>. Re-encodeamos
    // a Buffer para que verifyWebhook() pueda parsearlo igual que rutas que
    // reciben rawBody.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (req.body ?? {}) as Record<string, any>;
    const rawText =
      Object.keys(body).length > 0
        ? Object.entries(body)
            .map(
              ([k, v]) =>
                `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`,
            )
            .join('&')
        : '';
    const rawBody = Buffer.from(rawText, 'utf8');

    const verify = this.wipay.verifyWebhook(req.headers, rawBody);
    if (!verify.valid) {
      this.metrics.webhooksReceived.inc({ provider, outcome: 'invalid' });
      this.logger.warn(`webhook wipay rejected: ${verify.reason}`);
      // Cecabank espera $*$NOK$*$ para anular. Devolvemos eso si la firma
      // no cuadra para que no cuente como cobro válido.
      return '$*$NOK$*$';
    }
    if (!verify.externalEventId) {
      this.metrics.webhooksReceived.inc({ provider, outcome: 'invalid' });
      return '$*$NOK$*$';
    }

    // Idempotency por (provider, Num_operacion). Cecabank puede reintentar
    // si nuestra respuesta llega tarde.
    const existing = await this.prisma.webhookDelivery.findUnique({
      where: {
        provider_externalEventId: {
          provider,
          externalEventId: verify.externalEventId,
        },
      },
    });
    if (existing?.processedAt) {
      this.metrics.webhooksReceived.inc({ provider, outcome: 'duplicate' });
      return '$*$OKY$*$';
    }

    const delivery = existing
      ? existing
      : await this.prisma.webhookDelivery.create({
          data: {
            provider,
            externalEventId: verify.externalEventId,
            rawBody,
            signature: typeof body.Firma === 'string' ? (body.Firma as string) : '',
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

    this.metrics.webhooksReceived.inc({ provider, outcome: 'valid' });
    return '$*$OKY$*$';
  }
}
