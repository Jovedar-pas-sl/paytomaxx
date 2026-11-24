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
  NotFoundException,
  Optional,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
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
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { PrismaService } from '../../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { GatewayRegistry } from '../gateways/gateway.registry';
import { PeanpeAdapter } from '../gateways/peanpe.adapter';
import { WipayAdapter } from '../gateways/wipay.adapter';
import { sealTokenizationData } from '../payments/tokenization-seal';
import { RedsysAdapter } from '../gateways/redsys.adapter';
import { boundedInput } from '../../common/pipes/input-limits';
import { parseWebhookBody } from '../gateways/header-utils';
import { WEBHOOKS_INGEST_QUEUE } from '../queues/queue-tokens';
import { enqueueWebhookDelivery } from '../queues/webhook-enqueue';
import { WebhookIngestProcessor } from '../queues/webhook-ingest.processor';
import { MetricsService } from '../metrics/metrics.service';
import { WebhookProviderGate, type GatedWebhookProvider } from './webhook-provider-gate';

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
// rawBody form-urlencoded. Ruta pública: con más de 100 campos ni se valida
// (zod guardaba un error por campo: 1 MB de cuerpo, 20 s de CPU; SEC-05).
const FormUrlencodedBodySchema = boundedInput(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])), {
  maxObjectKeys: 100,
});

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

/** Lo más que la petición del aviso de Redsys espera a procesarlo: luego se contesta y termina aparte. */
export const INLINE_NOTICE_MAX_MS = 5_000;

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
  /** null solo si se construye a mano (pruebas de antes): entonces no se cierra nada. */
  private readonly gate: WebhookProviderGate | null;
  /** Para procesar el aviso de Redsys al llegar (WebhookIngestProcessor); sin él (pruebas de antes), solo la cola. */
  private readonly moduleRef: ModuleRef | null;

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
    @Inject(WebhookProviderGate) gate?: WebhookProviderGate,
    @Optional() @Inject(ModuleRef) moduleRef?: ModuleRef,
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
    this.gate = gate ?? null;
    this.moduleRef = moduleRef ?? null;
  }

  /**
   * Paytef y Peanpe: si ningún local tiene una credencial activa de esa
   * pasarela, su ruta de avisos no existe (404) y no se procesa nada: ni el
   * secreto, ni el cuerpo, ni el límite en Redis, ni la base.
   */
  private async assertProviderInUse(provider: GatedWebhookProvider): Promise<void> {
    if (this.gate && !(await this.gate.enabled(provider))) throw new NotFoundException();
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
    await this.assertProviderInUse('PAYTEF');
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
    await this.assertProviderInUse('PEANPE');
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
    await this.assertProviderInUse('PEANPE');
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
   * El aviso se procesa en la misma petición (processNowOrQueue); la cola, para reintentar.
   * Fuera del límite global (global-rate-limit.ts): todos llegan desde unas pocas IP del banco.
   */
  @Public()
  @Post('redsys')
  @HttpCode(200)
  @IpRateLimit({ max: 6_000, windowSec: 60, scope: 'webhook-redsys', failOpen: true })
  async receiveRedsys(@Req() req: FastifyRequest): Promise<{ received: true; duplicate?: boolean }> {
    const provider: Provider = 'REDSYS';

    // Fastify form-urlencoded → req.body es Record<string,string>. Re-encodeamos
    // a Buffer para que verifyWebhook() pueda parsearlo. M1: shape Zod laxa.
    const parsed = FormUrlencodedBodySchema.safeParse(req.body ?? {});
    // Campos `_*` son nuestros (p.ej. `_paymentId`, que se le añade al aviso
    // guardado al encontrar el cobro). Fuera de la firma → nunca aceptarlos
    // del cliente.
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

    // Se guarda nada más comprobar la firma: con la base saturada, una consulta
    // antes de guardarlo fallaba y el aviso se perdía (el banco no lo repite).
    // Idempotencia por (provider, Ds_Order + Ds_Response): el mismo aviso otra
    // vez choca con la clave única y se usa el ya guardado (saveDelivery).
    // El cobro lo busca el processor por el pedido (Ds_Order, dentro de la firma).
    const delivery = await this.saveDelivery({
      provider,
      externalEventId: verify.externalEventId,
      rawBody,
      signature: typeof body.Ds_Signature === 'string' ? (body.Ds_Signature as string) : '',
    });
    if (delivery.processedAt) {
      this.metrics.webhooksReceived.inc({ provider, outcome: 'duplicate' });
      return { received: true, duplicate: true };
    }

    // Ds_Order es nuestro providerTxId (lo genera authorize): aquí, para anotar
    // el intento, la tarjeta y el token. Cada intento de pago es un Ds_Order
    // distinto (payment_attempts); los pagos anteriores a Fase 0 solo lo tienen
    // en payments.providerTxId. Si ahora la base no contesta, se sigue: el
    // aviso ya está guardado y el processor busca el cobro por su cuenta.
    const dsOrder = verify.paymentRef ?? '';
    let payment: { id: string; tenantId: string } | null = null;
    try {
      payment = dsOrder ? await this.findRedsysPayment(dsOrder) : null;
      if (!payment) this.logger.warn(`webhook redsys: ningún payment con Ds_Order=${dsOrder}`);
    } catch (e) {
      this.logger.warn(`webhook redsys: no se pudo buscar el cobro de Ds_Order=${dsOrder} al llegar: ${(e as Error).message}`);
    }

    if (payment) {
      await this.addPaymentToRedsysDelivery(delivery.id, payment);
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

    await this.processNowOrQueue(provider, verify.externalEventId, delivery.id);

    this.metrics.webhooksReceived.inc({ provider, outcome: 'valid' });
    return { received: true };
  }

  /**
   * El aviso firmado se procesa en la misma petición: el «Pagado» no espera a
   * la cola (4 a la vez; con mucha gente pagando, minutos: carga del
   * 19-11-2026). La cola queda para reintentar: si falla, o si otra petición
   * tiene el mismo aviso (su candado, WebhookIngestProcessor.processDelivery).
   * Con la base muy lenta, al banco se le contesta a los INLINE_NOTICE_MAX_MS
   * y el aviso termina aparte. Uno ya procesado no cambia nada (processedAt).
   */
  private async processNowOrQueue(provider: Provider, externalEventId: string, deliveryId: bigint): Promise<void> {
    const ingest = this.ingestProcessor();
    if (!ingest) return this.enqueueDelivery(provider, externalEventId, deliveryId);
    const run = ingest.processDelivery(deliveryId.toString()).then(
      async (processed) => {
        if (!processed) await this.enqueueDelivery(provider, externalEventId, deliveryId);
      },
      async (err: unknown) => {
        this.logger.warn(`webhook ${provider} ${deliveryId}: no se pudo procesar al llegar, a la cola (${(err as Error).message})`);
        await this.enqueueDelivery(provider, externalEventId, deliveryId);
      },
    );
    let timer: NodeJS.Timeout | undefined;
    const slow = new Promise<'slow'>((resolve) => {
      timer = setTimeout(() => resolve('slow'), INLINE_NOTICE_MAX_MS);
    });
    try {
      if ((await Promise.race([run.then(() => 'done' as const), slow])) === 'slow') {
        run.catch((err: unknown) => this.logger.error(`webhook ${provider} ${deliveryId}: tampoco se pudo encolar: ${(err as Error).message}`));
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** El procesador de avisos de la cola (QueuesModule); null si no está (pruebas que construyen a mano). */
  private ingestProcessor(): Pick<WebhookIngestProcessor, 'processDelivery'> | null {
    if (!this.moduleRef) return null;
    try {
      return this.moduleRef.get(WebhookIngestProcessor, { strict: false });
    } catch {
      return null;
    }
  }

  /**
   * Guarda el aviso. Si la pasarela lo manda dos veces a la vez, el segundo
   * choca con la clave única (P2002): se usa el registro del primero en vez de
   * contestar 500 (Wipay espera $*$OKY$*$ y anularía un cobro bueno). Con su
   * processedAt: Redsys guarda sin mirar antes si ya estaba (y procesado).
   */
  private async saveDelivery(
    data: Prisma.WebhookDeliveryUncheckedCreateInput,
  ): Promise<{ id: bigint; processedAt: Date | null }> {
    try {
      return await this.prisma.webhookDelivery.create({ data });
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') throw err;
      return this.prisma.webhookDelivery.findUniqueOrThrow({
        where: { provider_externalEventId: { provider: data.provider, externalEventId: data.externalEventId } },
        select: { id: true, processedAt: true },
      });
    }
  }

  /** Encola el procesado (aunque un intento anterior agotara los reintentos). */
  private async enqueueDelivery(provider: Provider, externalEventId: string, deliveryId: bigint): Promise<void> {
    await enqueueWebhookDelivery(this.queue, this.logger, { id: deliveryId, provider, externalEventId });
  }

  /**
   * Le añade al aviso guardado su cobro (`_paymentId`, fuera de la firma) y su
   * local, como los guardaba la versión anterior (29ca2bd7): esa también
   * procesa avisos (en el despliegue conviven las dos, start-first, y se puede
   * volver a ella) y, sin `_paymentId`, da el aviso por procesado sin pagar el
   * cobro. Antes de procesarlo o encolarlo, y solo si sigue sin local y sin
   * procesar (el mismo aviso otra vez no lo repite). Si falla, se sigue: el
   * processor busca el cobro por el pedido.
   */
  private async addPaymentToRedsysDelivery(deliveryId: bigint, payment: { id: string; tenantId: string }): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        UPDATE webhook_deliveries
           SET "rawBody" = "rawBody" || convert_to(${`&_paymentId=${encodeURIComponent(payment.id)}`}, 'UTF8'),
               "tenantId" = ${payment.tenantId}::uuid
         WHERE id = ${deliveryId} AND "tenantId" IS NULL AND "processedAt" IS NULL`;
    } catch (e) {
      this.logger.warn(`webhook redsys ${deliveryId}: no se pudo apuntar el cobro en el aviso guardado: ${(e as Error).message}`);
    }
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
