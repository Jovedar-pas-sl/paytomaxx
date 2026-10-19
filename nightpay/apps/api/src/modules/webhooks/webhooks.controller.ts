import {
  BadRequestException,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpException,
  HttpStatus,
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
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Provider } from '@nightpay/contracts';
import { Prisma } from '@nightpay/db';
import { Public } from '../../common/decorators/public.decorator';
import { PrismaService } from '../../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { GatewayRegistry } from '../gateways/gateway.registry';
import { PeanpeAdapter } from '../gateways/peanpe.adapter';
import { WipayAdapter } from '../gateways/wipay.adapter';
import { sealTokenizationData } from '../payments/tokenization-seal';
import { RedsysAdapter } from '../gateways/redsys.adapter';
import { parseWebhookBody } from '../gateways/header-utils';
import { WEBHOOKS_INGEST_QUEUE } from '../queues/queue-tokens';
import { enqueueWebhookDelivery } from '../queues/webhook-enqueue';
import { MetricsService } from '../metrics/metrics.service';

// M1: Fastify guarda el rawBody en `req.rawBody` cuando se configura el
// `rawBody` plugin (ver main.ts). El tipo oficial de FastifyRequest no lo
// expone, por eso necesitamos esta extensión local.
interface RequestWithRawBody extends FastifyRequest {
  rawBody?: Buffer;
}

function extractRawBody(req: FastifyRequest): Buffer {
  const r = req as RequestWithRawBody;
  if (r.rawBody instanceof Buffer) return r.rawBody;
  return Buffer.from(JSON.stringify(req.body ?? {}), 'utf8');
}

// M1: schemas Zod para validar bodies form-urlencoded sin `as any`.
// Peanpe POST challenge solo necesita identificador_llamada.
const PeanpePostBodySchema = z
  .object({ identificador_llamada: z.string().optional() })
  .passthrough();

// Wipay y Redsys envían form-urlencoded con muchos campos string-stringueables.
// La validación real (firma HMAC, campos obligatorios) la hace cada adapter
// en verifyWebhook — aquí solo necesitamos shape laxa para re-codificar a
// rawBody form-urlencoded.
const FormUrlencodedBodySchema = z.record(z.union([z.string(), z.number(), z.boolean(), z.null()]));

/** Secreto de la URL comparado en tiempo constante, sin delatar su longitud. */
export function sameSecret(received: string, expected: string): boolean {
  const a = createHash('sha256').update(received, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

function reencodeFormBody(body: Record<string, unknown>): Buffer {
  const rawText =
    Object.keys(body).length > 0
      ? Object.entries(body)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join('&')
      : '';
  return Buffer.from(rawText, 'utf8');
}

// C2: rate-limit del callback Peanpe GET para mitigar brute-force online del
// securityToken (10 dígitos = 10^10 combinaciones — costoso pero no imposible
// sin freno). 5 intentos/min por identificador_llamada es suficiente para
// reintentos legítimos de Peanpe ante timeouts y bloquea cualquier ataque
// práctico al subir el coste a >10^9 minutos = imposible.
const PEANPE_NOTIFY_MAX_ATTEMPTS_PER_MIN = 5;
const PEANPE_NOTIFY_WINDOW_SECONDS = 60;

/**
 * obs #3 (code review): rate-limiter atómico con Lua EVAL.
 *
 * El patrón previo `INCR; if attempts==1 then EXPIRE` tenía race window: si
 * INCR succeed pero EXPIRE falla (Redis hiccup, network blip), el counter queda
 * sin TTL → block permanente. Lua EVAL ejecuta ambos como una sola op atómica.
 *
 * Devuelve el contador actual (entero). El caller decide si supera el límite.
 */
const RATE_LIMIT_LUA = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return current
`;

@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);
  private readonly prisma: PrismaService;
  private readonly gateways: GatewayRegistry;
  private readonly queue: Queue;
  private readonly metrics: MetricsService;
  private readonly config: ConfigService;
  private readonly redis: Redis;

  private readonly peanpe: PeanpeAdapter;
  private readonly wipay: WipayAdapter;
  private readonly redsys: RedsysAdapter;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(GatewayRegistry) gateways: GatewayRegistry,
    @InjectQueue(WEBHOOKS_INGEST_QUEUE) queue: Queue,
    @Inject(MetricsService) metrics: MetricsService,
    @Inject(ConfigService) config: ConfigService,
    @Inject(REDIS_CLIENT) redis: Redis,
    @Inject(PeanpeAdapter) peanpe: PeanpeAdapter,
    @Inject(WipayAdapter) wipay: WipayAdapter,
    @Inject(RedsysAdapter) redsys: RedsysAdapter,
  ) {
    this.prisma = prisma;
    this.gateways = gateways;
    this.queue = queue;
    this.metrics = metrics;
    this.config = config;
    this.redis = redis;
    this.peanpe = peanpe;
    this.wipay = wipay;
    this.redsys = redsys;
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
    if (
      provider !== 'WIPAY' &&
      provider !== 'PEANPE' &&
      provider !== 'PAYTEF' &&
      provider !== 'REDSYS'
    ) {
      throw new BadRequestException(`Unknown provider: ${providerParam}`);
    }
    if (provider === 'REDSYS') {
      throw new UnauthorizedException(
        'Redsys webhooks usan ruta dedicada POST /v1/webhooks/redsys (form-urlencoded)',
      );
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
    const rawBody = extractRawBody(req);

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

    const delivery =
      existing ??
      (await this.saveDelivery({
        provider,
        externalEventId: verify.externalEventId!,
        rawBody,
        signature:
          ((req.headers['x-signature'] ?? '') as string | string[])?.toString() || '',
      }));

    await this.enqueueDelivery(provider, verify.externalEventId, delivery.id);

    this.metrics.webhooksReceived.inc({ provider, outcome: 'valid' });
    return { received: true };
  }

  /**
   * Webhook Paytef con URL secreta.
   * Paytef NO firma HMAC — la "firma" es que solo Paytef conoce esta URL
   * (configurada en notifyResultURL del panel). Validamos secret contra env
   * + dejamos que el adapter valide payload. Un "aprobado" se confirma con la
   * API de Paytef antes de dar el cobro por pagado (proveApproval).
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
    // Comparación en tiempo constante (también la longitud: se comparan los
    // SHA-256). La URL secreta solo deja pasar el aviso; para dar un cobro por
    // pagado, el procesador lo comprueba con la API de Paytef.
    if (!sameSecret(secret, expectedSecret)) {
      this.metrics.webhooksReceived.inc({ provider: 'PAYTEF', outcome: 'invalid' });
      throw new UnauthorizedException();
    }

    const provider: Provider = 'PAYTEF';
    const adapter = this.gateways.get(provider);
    const rawBody = extractRawBody(req);

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

    const delivery =
      existing ??
      (await this.saveDelivery({
        provider,
        externalEventId: verify.externalEventId,
        rawBody,
        signature: 'paytef-url-secret',
      }));

    await this.enqueueDelivery(provider, verify.externalEventId, delivery.id);

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
    // M1: schema Zod en vez de `as any`.
    const parsed = PeanpePostBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      this.logger.warn('Peanpe POST body con shape inesperada');
      throw new BadRequestException('invalid body shape');
    }
    const id = parsed.data.identificador_llamada ?? '';
    if (!id) {
      this.logger.warn('Peanpe POST sin identificador_llamada');
      throw new BadRequestException('missing identificador_llamada');
    }

    // H4: rate-limit por id_llamada también en POST challenge. Sin esto, un
    // atacante puede enumerar id_llamadas válidos via timing (200 con token
    // de 10 dígitos vs 401). Mismo límite que el GET — 5/min por id.
    const attempts = await this.peanpeRateLimit(`peanpe:challenge-posts:${id}`);
    if (attempts > PEANPE_NOTIFY_MAX_ATTEMPTS_PER_MIN) {
      this.metrics.webhooksReceived.inc({ provider: 'PEANPE', outcome: 'invalid' });
      this.logger.warn(
        `Peanpe POST rate-limited: id_llamada=${id} attempts=${attempts}`,
      );
      throw new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);
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
   * accion, seguridad. Validamos seguridad === securityToken persistido,
   * guardamos el resultado y encolamos el aviso. Ojo: esto NO prueba que
   * pagó (el cliente tiene el identificador y el reto le da el token): el
   * procesador nunca marca pagado un cobro por este aviso — lo deja en
   * Incidencias para comprobarlo en el panel de Peanpe.
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

    // C2: rate-limit por id_llamada — anti brute-force online del securityToken.
    // EVAL atómico (INCR + EXPIRE en single round-trip). Si >MAX devolvemos 429
    // y NO consultamos el adapter (evita timing oracle adicional).
    const attempts = await this.peanpeRateLimit(`peanpe:notify-attempts:${idLlamada}`);
    if (attempts > PEANPE_NOTIFY_MAX_ATTEMPTS_PER_MIN) {
      this.metrics.webhooksReceived.inc({ provider: 'PEANPE', outcome: 'invalid' });
      this.logger.warn(
        `Peanpe notify rate-limited: id_llamada=${idLlamada} attempts=${attempts} (window=${PEANPE_NOTIFY_WINDOW_SECONDS}s, max=${PEANPE_NOTIFY_MAX_ATTEMPTS_PER_MIN})`,
      );
      throw new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);
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
      // Sin msg, fuera del cuerpo (undefined no sale en el JSON): el esquema del
      // adaptador lo admite opcional pero no null, y con null el aviso daba 400.
      msg: msg ?? undefined,
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

    const delivery =
      existing ??
      (await this.saveDelivery({
        provider,
        tenantId: resolved.tenantId,
        externalEventId: verify.externalEventId,
        rawBody,
        signature: 'peanpe-challenge-response',
      }));

    // Persistir el resultado en peanpe_calls (audit + reintentos)
    await this.peanpe.persistCallbackResult(idLlamada, status, msg ?? null);

    await this.enqueueDelivery(provider, verify.externalEventId, delivery.id);

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
    // reciben rawBody. M1: validamos shape laxa con Zod (firma real la valida
    // verifyWebhook con el rawBody re-codificado).
    const parsed = FormUrlencodedBodySchema.safeParse(req.body ?? {});
    const body = parsed.success ? parsed.data : {};
    const rawBody = reencodeFormBody(body);

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

    const delivery =
      existing ??
      (await this.saveDelivery({
        provider,
        externalEventId: verify.externalEventId,
        rawBody,
        signature: typeof body.Firma === 'string' ? (body.Firma as string) : '',
      }));

    await this.enqueueDelivery(provider, verify.externalEventId, delivery.id);

    this.metrics.webhooksReceived.inc({ provider, outcome: 'valid' });
    return '$*$OKY$*$';
  }

  /**
   * Comunicación on-line de Redsys SIS (BBVA, Santander, CaixaBank, etc.).
   *
   * Body: form-urlencoded con 3 campos:
   *   Ds_SignatureVersion=HMAC_SHA256_V1
   *   Ds_MerchantParameters=<base64 JSON con Ds_Order, Ds_Response, etc.>
   *   Ds_Signature=<base64 HMAC>
   *
   * Respuesta esperada por Redsys: 200 OK con cualquier cuerpo (suele ser
   * JSON simple o vacío). Sin formato especial obligatorio como Cecabank.
   * Devolvemos OK INMEDIATAMENTE y procesamos en background.
   */
  @Public()
  @Post('redsys')
  @HttpCode(200)
  async receiveRedsys(@Req() req: FastifyRequest): Promise<{ received: true; duplicate?: boolean }> {
    const provider: Provider = 'REDSYS';

    // Fastify form-urlencoded → req.body es Record<string,string>. Re-encodeamos
    // a Buffer para que verifyWebhook() pueda parsearlo. M1: shape Zod laxa.
    const parsed = FormUrlencodedBodySchema.safeParse(req.body ?? {});
    // Campos `_*` son nuestros (p.ej. `_paymentId`, que añadimos tras resolver
    // el pedido). Fuera de la firma → nunca aceptarlos del cliente.
    const body = Object.fromEntries(
      Object.entries(parsed.success ? parsed.data : {}).filter(([k]) => !k.startsWith('_')),
    );
    const rawBody = reencodeFormBody(body);

    const verify = this.redsys.verifyWebhook(req.headers, rawBody);
    if (!verify.valid) {
      this.metrics.webhooksReceived.inc({ provider, outcome: 'invalid' });
      this.logger.warn(`webhook redsys rejected: ${verify.reason}`);
      throw new UnauthorizedException();
    }
    if (!verify.externalEventId) {
      this.metrics.webhooksReceived.inc({ provider, outcome: 'invalid' });
      throw new BadRequestException('Missing externalEventId');
    }

    // Idempotency por (provider, Ds_Order + Ds_Response).
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

    // Ds_Order es nuestro providerTxId (lo genera authorize). Lo resolvemos a
    // payment UUID + tenant aquí, igual que Peanpe con _paymentId: el adapter
    // no toca la DB y el processor aplica la defensa cross-tenant.
    // Cada intento de pago es un Ds_Order distinto (payment_attempts); los
    // pagos anteriores a Fase 0 solo lo tienen en payments.providerTxId.
    const dsOrder = verify.paymentRef ?? '';
    const payment = dsOrder ? await this.findRedsysPayment(dsOrder) : null;
    if (!payment) {
      this.logger.warn(`webhook redsys: ningún payment con Ds_Order=${dsOrder}`);
    }
    // Se añade un campo fuera de la firma: Ds_Signature solo cubre
    // Ds_MerchantParameters, así que la verificación en el processor sigue valiendo.
    const storedBody = payment
      ? Buffer.concat([rawBody, Buffer.from(`&_paymentId=${encodeURIComponent(payment.id)}`)])
      : rawBody;

    const delivery =
      existing ??
      (await this.saveDelivery({
        provider,
        ...(payment ? { tenantId: payment.tenantId } : {}),
        externalEventId: verify.externalEventId,
        rawBody: storedBody,
        signature: typeof body.Ds_Signature === 'string' ? (body.Ds_Signature as string) : '',
      }));

    if (payment) {
      await this.recordRedsysOutcome(payment.id, rawBody);
    }

    // Tokenización probe — si Redsys devolvió Ds_Merchant_Identifier en el
    // callback (porque el authorize lo pidió con REDSYS_REQUEST_TOKEN=true),
    // lo persistimos en payment.tokenizationData para reuso en cobros MIT.
    // Idempotente: si ya estaba persistido, no sobreescribe (lo hacemos en
    // el processor también, pero aquí lo hacemos inmediato para que el
    // endpoint debug /v1/debug/redsys/last-tokenized lo vea sin esperar).
    // El token se guarda cifrado (sealTokenizationData) y en el pago resuelto:
    // con varios intentos, payments.providerTxId solo tiene el último Ds_Order.
    try {
      const tokenData = payment ? this.redsys.extractTokenizationData(rawBody) : null;
      if (payment && tokenData) {
        const sealed = sealTokenizationData({ ...tokenData }, process.env.ENCRYPTION_KEK);
        await this.prisma.asSystem((tx) => tx.$executeRaw`
          UPDATE payments
             SET "tokenizationData" = ${JSON.stringify(sealed)}::jsonb
           WHERE id = ${payment.id}::uuid
             AND "tokenizationData" IS NULL
        `);
        this.logger.log(
          `[REDSYS TOKEN CAPTURED] payment=${payment.id} last4=${tokenData.cardLast4} brand=${tokenData.cardBrand} expiry=${tokenData.expiry}`,
        );
      }
    } catch (e) {
      // Capturar token no debe romper el flujo del webhook. Loguear y seguir.
      this.logger.warn(
        `Failed to capture Redsys tokenization data: ${(e as Error).message}`,
      );
    }

    await this.enqueueDelivery(provider, verify.externalEventId, delivery.id);

    this.metrics.webhooksReceived.inc({ provider, outcome: 'valid' });
    return { received: true };
  }

  /**
   * Guarda el aviso. Si la pasarela lo manda dos veces a la vez, el segundo
   * choca con la clave única (P2002): se usa el registro del primero en vez de
   * contestar 500 (Wipay espera $*$OKY$*$ y anularía un cobro bueno).
   */
  private async saveDelivery(data: Prisma.WebhookDeliveryUncheckedCreateInput): Promise<{ id: bigint }> {
    try {
      return await this.prisma.webhookDelivery.create({ data });
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') throw err;
      return this.prisma.webhookDelivery.findUniqueOrThrow({
        where: { provider_externalEventId: { provider: data.provider, externalEventId: data.externalEventId } },
        select: { id: true },
      });
    }
  }

  /** Encola el procesado (aunque un intento anterior agotara los reintentos). */
  private async enqueueDelivery(provider: Provider, externalEventId: string, deliveryId: bigint): Promise<void> {
    await enqueueWebhookDelivery(this.queue, this.logger, { id: deliveryId, provider, externalEventId });
  }

  private async findRedsysPayment(
    dsOrder: string,
  ): Promise<{ id: string; tenantId: string } | null> {
    return this.prisma.asSystem(async (tx) => {
      const attempt = await tx.paymentAttempt.findUnique({
        where: { provider_providerTxId: { provider: 'REDSYS', providerTxId: dsOrder } },
        select: { paymentId: true, tenantId: true },
      });
      if (attempt) return { id: attempt.paymentId, tenantId: attempt.tenantId };
      return tx.payment.findFirst({
        where: { provider: 'REDSYS', providerTxId: dsOrder },
        select: { id: true, tenantId: true },
      });
    });
  }

  /**
   * Anota el resultado del intento (APPROVED/DENIED) y, si es un cobro
   * aprobado, los datos que manda el banco (método, tarjeta, autorización).
   * No bloquea el aviso: si falla, se loguea y el pago sigue su curso.
   *
   * El doble cobro (otro pedido aprobado del mismo cobro) NO se mira aquí:
   * sin el candado del cobro, dos avisos a la vez no se veían el uno al otro.
   * Lo apunta transition(), con la fila bloqueada, al procesar el aviso.
   */
  private async recordRedsysOutcome(paymentId: string, rawBody: Buffer): Promise<void> {
    try {
      const n = this.redsys.parseNotification(parseWebhookBody(rawBody));
      if (!n || n.transactionType !== '0') return;
      await this.prisma.asSystem(async (tx) => {
        // Un KO tardío (aviso viejo o reintento) no deshace un intento que el
        // banco ya aprobó: la aprobación manda.
        await tx.paymentAttempt.updateMany({
          where: n.approved
            ? { provider: 'REDSYS', providerTxId: n.order }
            : { provider: 'REDSYS', providerTxId: n.order, status: { not: 'APPROVED' } },
          data: { status: n.approved ? 'APPROVED' : 'DENIED', responseCode: n.response },
        });
        if (n.approved) {
          // Solo los datos de la tarjeta, mientras el cobro no esté pagado.
          // authorizedAt NO se pone aquí: lo pone transition() al pasar de
          // verdad a AUTHORIZED (COALESCE(authorizedAt, NOW())). Si el aviso
          // no se puede dar por bueno (importe que no cuadra, cobro
          // caducado…), el cobro no debe parecer pagado en informes ni recibos.
          await tx.payment.updateMany({
            where: { id: paymentId, authorizedAt: null },
            data: {
              payMethodCode: n.payMethodCode,
              cardBrand: n.cardBrand,
              cardType: n.cardType,
              cardCountry: n.cardCountry,
              cardLast4: n.cardLast4,
              authCode: n.authCode,
              secure3ds: n.secure3ds,
            },
          });
        }
      });
    } catch (e) {
      this.logger.warn(`No se pudo anotar el resultado Redsys de ${paymentId}: ${(e as Error).message}`);
    }
  }

  /**
   * obs #3 helper: INCR + EXPIRE en un único EVAL Lua → atómico.
   * Devuelve el contador actualizado. Caller decide si supera el límite.
   *
   * ioredis v5 firma: `eval(script, numKeys, ...keysThenArgs)` y devuelve
   * `unknown`. Sabemos que el script devuelve siempre un integer.
   */
  private async peanpeRateLimit(key: string): Promise<number> {
    const result = await this.redis.eval(
      RATE_LIMIT_LUA,
      1,
      key,
      String(PEANPE_NOTIFY_WINDOW_SECONDS),
    );
    return typeof result === 'number' ? result : Number(result);
  }
}
