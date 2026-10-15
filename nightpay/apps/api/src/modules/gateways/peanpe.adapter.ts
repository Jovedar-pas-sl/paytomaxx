import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type CircuitBreaker from 'opossum';
import type {
  AuthorizeInput,
  AuthorizeResult,
  GatewayStatus,
  RefundInput,
  RefundResult,
  WebhookVerifyResult,
} from '@nightpay/contracts';
import type { ApprovalProof, GatewayAdapter, WebhookFsmEvent } from './gateway.adapter';
import { createBreaker, timedFire } from './circuit-breaker';
import { MetricsService } from '../metrics/metrics.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { BRAND_NAME } from '../../common/brand';

const PROVIDER_LABEL = 'PEANPE' as const;
function stateToNumber(s: 'closed' | 'halfOpen' | 'open'): number {
  return s === 'closed' ? 0 : s === 'halfOpen' ? 1 : 2;
}

/**
 * H1 safety guard — la doc oficial Peanpe NO especifica si `cantidad` es
 * céntimos o euros enteros. Por defecto enviamos céntimos (idéntico a Redsys,
 * Wipay, Stripe), pero si Peanpe interpreta el campo como euros, un cobro de
 * 50€ se cargaría como 5.000€ (×100). Hasta que el formato esté verificado
 * via cobro de prueba en sandbox, BLOQUEAMOS cobros ≥500€.
 *
 * Para verificar y desactivar el guard:
 *   1. Hacer un cobro de prueba con tarjeta debug `4548812049400004` por 1€
 *      (100 céntimos). Comprobar en panel Peanpe el importe registrado.
 *   2. Si registra "1.00 EUR" → formato correcto, set env
 *      `PEANPE_AMOUNT_FORMAT_VERIFIED=cents`.
 *   3. Si registra "100.00 EUR" → cantidad espera euros: set
 *      `PEANPE_AMOUNT_FORMAT_VERIFIED=euros` (se envían euros enteros y los
 *      cobros con céntimos se rechazan: ver peanpeCantidad).
 *   4. El guard se desactiva cuando `PEANPE_AMOUNT_FORMAT_VERIFIED` está set
 *      a `cents` o `euros`.
 */
const PEANPE_SAFETY_MAX_UNVERIFIED_CENTS = 50_000;

/**
 * `cantidad` que se manda a Peanpe. En euros la doc pide "número entero sin
 * puntos ni comas": un importe con céntimos (12,50 €) NO se redondea — se
 * rechaza con un mensaje claro (antes se cobraban 13 € sin avisar).
 */
export function peanpeCantidad(amountCents: number, format: 'cents' | 'euros'): string {
  if (format === 'cents') return String(amountCents);
  if (amountCents % 100 !== 0) {
    const euros = (amountCents / 100).toFixed(2).replace('.', ',');
    throw new Error(
      `peanpe-solo-euros-enteros: Peanpe está configurado en euros enteros ` +
        `(PEANPE_AMOUNT_FORMAT_VERIFIED=euros) y no puede cobrar ${euros} €. ` +
        `Cobra un importe sin céntimos o usa otra pasarela.`,
    );
  }
  return String(amountCents / 100);
}

/**
 * Peanpe API v2.0 adapter — implementado según doc oficial (Vers: 2.0).
 *
 * Flow diferente al de gateways REST estándar:
 *   1. authorize() genera identificador_llamada (6 chars), persiste mapping
 *      payment ↔ id_llamada en peanpe_calls + securityToken pre-generado.
 *      Devuelve providerTxId = identificador_llamada. NO hace request HTTP a
 *      Peanpe — el flujo continúa cuando el USUARIO accede a la URL hosted.
 *   2. La URL hosted la construye el endpoint pblico
 *      `GET /v1/payments/public/:token/peanpe-redirect-url` con la firma
 *      HMAC calculada con apikey hex→bytes raw (ver doc Peanpe).
 *   3. Cliente paga en peanpe.com formulario hosted.
 *   4. Peanpe llama a NightPay vía challenge-response:
 *      a) POST /v1/webhooks/peanpe/notify con identificador_llamada → NightPay
 *         responde con `securityToken` (10 dígitos, texto plano).
 *      b) GET /v1/webhooks/peanpe/notify con status, msg, identificador_llamada,
 *         debug, accion, seguridad → NightPay valida seguridad === securityToken
 *         y apunta el resultado (sin marcar el cobro pagado: ver abajo).
 *
 * Limitaciones documentadas:
 *  - identificador_llamada max 6 chars (tabla mapping resuelve el problema con
 *    nuestros UUIDs).
 *  - No hay endpoint refund por API — refund manual desde panel peanpe.com.
 *  - No hay endpoint status — orphan-reconcile no puede consultar Peanpe.
 *  - El aviso de resultado NO prueba nada: el identificador_llamada va en la
 *    URL que ve el cliente, y el reto (POST) devuelve el securityToken a
 *    quien lo pida. Cualquiera puede mandar "status=200". Por eso un aviso
 *    "pagado" de Peanpe nunca marca el cobro como pagado: queda apuntado,
 *    sale en Incidencias y el dueño lo comprueba en el panel de Peanpe y lo
 *    resuelve a mano (proveApproval → unverifiable).
 *  - HTTP en URL base (riesgo MITM; mitigación: la firma HMAC protege la
 *    integridad de los parámetros aunque la URL viaje en HTTP). La base es
 *    configurable (PEANPE_API_BASE_URL); no se fuerza https porque no está
 *    comprobado que el API de Peanpe responda igual por https.
 */
@Injectable()
export class PeanpeAdapter implements GatewayAdapter {
  readonly provider = 'PEANPE' as const;
  private readonly logger = new Logger(PeanpeAdapter.name);

  private readonly config: ConfigService;
  private readonly metrics: MetricsService;
  private readonly prisma: PrismaService;
  private readonly authorizeBreaker: CircuitBreaker<[AuthorizeInput], AuthorizeResult>;
  private readonly statusBreaker: CircuitBreaker<[string, string], GatewayStatus>;
  private readonly refundBreaker: CircuitBreaker<[RefundInput], RefundResult>;
  private readonly timeoutMs: number;

  constructor(
    @Inject(ConfigService) config: ConfigService,
    @Inject(MetricsService) metrics: MetricsService,
    @Inject(PrismaService) prisma: PrismaService,
  ) {
    this.config = config;
    this.metrics = metrics;
    this.prisma = prisma;
    this.timeoutMs = config.get<number>('GATEWAY_TIMEOUT_MS') ?? 5000;

    this.authorizeBreaker = createBreaker((input: AuthorizeInput) => this.doAuthorize(input), {
      name: 'peanpe.authorize',
      timeoutMs: this.timeoutMs,
      onStateChange: (s) =>
        this.metrics.circuitState.set({ provider: PROVIDER_LABEL, op: 'authorize' }, stateToNumber(s)),
    });
    this.statusBreaker = createBreaker(
      (tenantId: string, providerTxId: string) => this.doGetStatus(tenantId, providerTxId),
      {
        name: 'peanpe.getStatus',
        timeoutMs: this.timeoutMs,
        onStateChange: (s) =>
          this.metrics.circuitState.set({ provider: PROVIDER_LABEL, op: 'getStatus' }, stateToNumber(s)),
      },
    );
    this.refundBreaker = createBreaker((input: RefundInput) => this.doRefund(input), {
      name: 'peanpe.refund',
      timeoutMs: this.timeoutMs,
      onStateChange: (s) =>
        this.metrics.circuitState.set({ provider: PROVIDER_LABEL, op: 'refund' }, stateToNumber(s)),
    });
  }

  async authorize(input: AuthorizeInput): Promise<AuthorizeResult> {
    // Antes del circuit breaker: un importe que Peanpe no admite es un error
    // del cobro, no de la pasarela (no debe contar para abrir el breaker).
    peanpeCantidad(input.amountCents, this.amountFormat());
    return timedFire(
      () => this.authorizeBreaker.fire(input),
      (dur, outcome) =>
        this.metrics.gatewayDuration.observe({ provider: PROVIDER_LABEL, op: 'authorize', outcome }, dur),
    );
  }

  async getStatus(tenantId: string, providerTxId: string): Promise<GatewayStatus> {
    return timedFire(
      () => this.statusBreaker.fire(tenantId, providerTxId),
      (dur, outcome) =>
        this.metrics.gatewayDuration.observe({ provider: PROVIDER_LABEL, op: 'getStatus', outcome }, dur),
    );
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    return timedFire(
      () => this.refundBreaker.fire(input),
      (dur, outcome) =>
        this.metrics.gatewayDuration.observe({ provider: PROVIDER_LABEL, op: 'refund', outcome }, dur),
    );
  }

  // ─── Implementaciones tras circuit breaker ───────────────────────

  /**
   * NO hace HTTP a Peanpe — solo prepara el mapping local. El cliente paga
   * cuando entra a la URL hosted (generada por el endpoint /peanpe-redirect-url).
   */
  private async doAuthorize(input: AuthorizeInput): Promise<AuthorizeResult> {
    const apiKey = this.config.get<string>('PEANPE_API_KEY');
    const accountId = this.config.get<string>('PEANPE_ACCOUNT_ID');
    if (!apiKey || !accountId) {
      throw new Error('PEANPE_API_KEY o PEANPE_ACCOUNT_ID no configurado');
    }

    // H1 safety guard — ver constante PEANPE_SAFETY_MAX_UNVERIFIED_CENTS.
    const verified = this.config.get<string>('PEANPE_AMOUNT_FORMAT_VERIFIED');
    if (
      verified !== 'cents' &&
      verified !== 'euros' &&
      input.amountCents >= PEANPE_SAFETY_MAX_UNVERIFIED_CENTS
    ) {
      throw new Error(
        `peanpe-amount-format-unverified: bloqueando cobro ${input.amountCents}c ≥ ` +
          `${PEANPE_SAFETY_MAX_UNVERIFIED_CENTS}c hasta verificar formato de cantidad. ` +
          `Ejecuta /v1/debug/peanpe/dry-run para verificar y set PEANPE_AMOUNT_FORMAT_VERIFIED=cents|euros.`,
      );
    }

    // M2 race fix — la generación previa hacía findUnique seguido de create:
    // dos requests concurrentes podían pasar el findUnique con el mismo
    // candidate y solo una ganaba el create (P2002 sin captura). Ahora
    // ponemos el create dentro del retry y capturamos P2002 explícitamente.
    let idLlamada: string | null = null;
    const securityToken = String(randomInt(1_000_000_000, 9_999_999_999));
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generate6CharId();
      try {
        await this.prisma.peanpeCall.create({
          data: {
            identificadorLlamada: candidate,
            paymentId: input.paymentId,
            tenantId: input.tenantId,
            securityToken,
            amountCents: input.amountCents,
          },
        });
        idLlamada = candidate;
        break;
      } catch (err) {
        // Prisma P2002 = unique constraint violation. Cualquier otro error
        // se propaga (DB caída, FK violation, etc.) — no es problema de
        // colisión de identificador.
        const code = (err as { code?: string } | null)?.code;
        if (code !== 'P2002') throw err;
        this.logger.warn(
          `Peanpe id_llamada collision attempt=${attempt + 1} candidate=${candidate} — retry`,
        );
      }
    }
    if (!idLlamada) {
      throw new Error('No se pudo generar identificador_llamada único tras 5 intentos');
    }

    // C1 fix: construimos la URL hosted aquí y la devolvemos como paymentLinkUrl
    // → startAuthorization la persiste en gatewayPaymentUrl
    // → resolveRedirect() devuelve kind:'redirect' → public-pay 302
    // Así el flujo /pay/{token} funciona end-to-end sin nuevo endpoint.
    const paymentLinkUrl = this.buildPaymentUrl({
      identificadorLlamada: idLlamada,
      amountCents: input.amountCents,
      concepto: `${BRAND_NAME} ${input.paymentId.slice(0, 8)}`,
      debug: process.env.NODE_ENV !== 'production',
    });

    this.logger.log(
      `Peanpe authorize prepared: payment=${input.paymentId} id_llamada=${idLlamada}`,
    );

    return {
      provider: 'PEANPE',
      providerTxId: idLlamada,
      status: 'PROCESSING',
      paymentLinkUrl,
    };
  }

  /**
   * Peanpe NO expone endpoint de status por API. Orphan-reconcile no puede
   * usar este adapter — devolvemos UNKNOWN siempre.
   */
  private async doGetStatus(_tenantId: string, _providerTxId: string): Promise<GatewayStatus> {
    this.logger.warn('Peanpe getStatus no soportado por API — devolviendo UNKNOWN');
    return 'UNKNOWN';
  }

  /**
   * Peanpe NO expone refund por API. Admin debe refundear desde el panel
   * (backoffice peanpe.com → estadísticas → buscar txn → Anular).
   */
  private async doRefund(_input: RefundInput): Promise<RefundResult> {
    this.logger.warn(
      'Peanpe refund vía API no soportado — admin debe usar panel peanpe.com',
    );
    throw new Error(
      'peanpe-refund-manual-required: Peanpe v2.0 no expone refund por API. ' +
        'Anula la transacción desde panel peanpe.com → Estadísticas → buscar txn → Anular. ' +
        `Después marca el refund manualmente en ${BRAND_NAME}.`,
    );
  }

  // ─── Webhook handling ────────────────────────────────────────────
  //
  // Peanpe NO usa headers HMAC estándar — usa el flujo challenge-response:
  // 1. POST con identificador_llamada → NightPay responde securityToken
  // 2. GET con seguridad → NightPay valida seguridad === securityToken
  //
  // El verifyWebhook implementa el camino #2 (GET con resultado). El POST
  // inicial se maneja directamente en webhooks.controller (devuelve plain text).
  //
  verifyWebhook(
    _headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
  ): WebhookVerifyResult {
    // Peanpe GET de resultado: los params vienen en query string, NOT en body.
    // El controller los habrá copiado al rawBody como JSON con shape:
    //   { status, msg, identificador_llamada, debug, accion, seguridad }
    let parsed: PeanpeResultPayload;
    try {
      const raw: unknown = JSON.parse(rawBody.toString('utf8'));
      const result = PeanpeResultPayloadSchema.safeParse(raw);
      if (!result.success) {
        return { valid: false, reason: 'invalid-payload-shape' };
      }
      parsed = result.data;
    } catch {
      return { valid: false, reason: 'invalid-json' };
    }

    if (!parsed.identificador_llamada || !parsed.seguridad || !parsed.status) {
      return { valid: false, reason: 'missing-required-params' };
    }

    // externalEventId único: id_llamada + accion + status (un mismo cobro
    // puede generar 2 callbacks: el primero "pagar" cuando paga, y otro
    // "recurrencia_no_cobrada" si hay recurrencia fallida).
    const externalEventId = `${parsed.identificador_llamada}_${parsed.accion ?? 'pagar'}_${parsed.status}`;

    // El paymentRef interno se resuelve en el controller via lookup en
    // peanpe_calls.paymentId. Aquí devolvemos identificador_llamada — el
    // controller hace la resolución antes de transitar FSM.
    return {
      valid: true,
      externalEventId,
      paymentRef: parsed.identificador_llamada,
    };
  }

  mapWebhookToFsmEvent(parsedPayload: unknown): WebhookFsmEvent | null {
    // El controller añade _paymentId tras resolver paymentRef → paymentId.
    // Validamos shape para evitar runtime errors en producción.
    const Schema = PeanpeResultPayloadSchema.extend({
      _paymentId: z.string().optional(),
    });
    const result = Schema.safeParse(parsedPayload);
    if (!result.success) return null;
    const p = result.data;
    // El controller habrá hecho el lookup paymentRef → paymentId y lo añade
    // como _paymentId al payload antes de llamar mapWebhookToFsmEvent.
    const paymentId = p._paymentId;
    const idLlamada = p.identificador_llamada ?? '';
    if (!paymentId || !idLlamada) return null;

    // Status "200" = el aviso DICE que está pagado. Es solo eso: el
    // procesador pide la prueba (proveApproval) y, como Peanpe no la puede
    // dar, no lo marca pagado — lo deja en Incidencias para comprobarlo.
    if (p.status === '200' || p.status === 200) {
      return {
        paymentId,
        event: { type: 'AUTHORIZED', providerTxId: idLlamada, provider: 'PEANPE' },
      };
    }
    // Denegación: NO se marca FAILED. El cliente puede reintentar en la
    // página de Peanpe, y este aviso lo puede mandar cualquiera. El
    // resultado queda guardado en peanpe_calls (persistCallbackResult).
    this.logger.log(`Peanpe aviso no pagado: id_llamada=${idLlamada} status=${String(p.status)}`);
    return null;
  }

  /**
   * Peanpe no tiene API para consultar un cobro y su aviso no va firmado
   * (ver cabecera): no hay forma de probar que se pagó. Nunca se da por
   * pagado solo; el dueño lo comprueba en el panel y lo resuelve a mano. Si
   * Peanpe ofrece algún día consulta de estado, se usa aquí.
   */
  proveApproval(): Promise<ApprovalProof> {
    return Promise.resolve({ kind: 'unverifiable', reason: 'peanpe-sin-consulta' });
  }

  // ─── Helpers públicos para webhook controller + endpoint redirect ─

  /**
   * Construye la URL HOSTED de Peanpe a la que se redirige al cliente.
   * Calcula firma HMAC-SHA256 con apikey hex→bytes raw + params concatenados
   * según doc Peanpe (orden importa).
   */
  buildPaymentUrl(input: {
    identificadorLlamada: string;
    amountCents: number;
    concepto: string;
    debug?: boolean;
    /**
     * obs #5 (review): override del formato `cantidad` desde el caller —
     * usado por el endpoint debug dry-run para probar ambos formatos sin
     * tocar la env. Si undefined, lee `PEANPE_AMOUNT_FORMAT_VERIFIED` (default cents).
     */
    formatOverride?: 'cents' | 'euros';
  }): string {
    const apiKey = this.config.getOrThrow<string>('PEANPE_API_KEY');
    const accountId = this.config.getOrThrow<string>('PEANPE_ACCOUNT_ID');
    // Base configurable; por defecto http (la doc de Peanpe da http y no está
    // comprobado que su API funcione igual por https).
    const base = this.config.get<string>('PEANPE_API_BASE_URL') ?? 'http://peanpe.com';

    // H1: la doc oficial Peanpe NO especifica si `cantidad` es céntimos o
    // euros. Default céntimos (más común en PSPs ES). Si el usuario verifica
    // empíricamente que Peanpe espera euros, set PEANPE_AMOUNT_FORMAT_VERIFIED=euros:
    // se mandan euros enteros (la doc dice "número entero sin puntos ni
    // comas") y un importe con céntimos se rechaza en vez de redondearlo.
    const format = input.formatOverride ?? this.amountFormat();
    const cantidad = peanpeCantidad(input.amountCents, format);

    // Firma según doc: concat(id_llamada, account, cantidad) firmado con
    // HMAC-SHA256, donde la apikey es HEX y debe convertirse a bytes raw.
    const concat = `${input.identificadorLlamada}${accountId}${cantidad}`;
    const apiKeyBytes = Buffer.from(apiKey, 'hex');
    const firma = createHmac('sha256', apiKeyBytes).update(concat).digest('hex');

    const params = new URLSearchParams({
      accion: 'pagar',
      identificador_cuenta_peanpe: accountId,
      identificador_llamada: input.identificadorLlamada,
      cantidad,
      concepto: input.concepto,
      firma,
    });
    if (input.debug) params.set('debug', '1');

    return `${base.replace(/\/$/, '')}/api?${params.toString()}`;
  }

  /**
   * Lookup del securityToken de una llamada para responder al challenge POST.
   * Llamado por webhooks.controller cuando Peanpe hace el POST inicial.
   */
  async getSecurityTokenForCall(identificadorLlamada: string): Promise<string | null> {
    const call = await this.prisma.peanpeCall.findUnique({
      where: { identificadorLlamada },
      select: { securityToken: true },
    });
    return call?.securityToken ?? null;
  }

  /**
   * Resolución id_llamada → paymentId para el webhook GET de resultado.
   * También valida que el `seguridad` recibido coincida con el securityToken
   * persistido. Ojo: eso NO autentica a Peanpe (el reto entrega el token a
   * quien lo pida); solo filtra avisos con un id_llamada inventado.
   */
  async resolvePaymentFromCallback(input: {
    identificadorLlamada: string;
    seguridad: string;
  }): Promise<{ paymentId: string; tenantId: string } | null> {
    const call = await this.prisma.peanpeCall.findUnique({
      where: { identificadorLlamada: input.identificadorLlamada },
      select: { paymentId: true, tenantId: true, securityToken: true },
    });
    if (!call) {
      this.logger.warn(`Peanpe callback con id_llamada desconocido: ${input.identificadorLlamada}`);
      return null;
    }
    // H1: comparación timing-safe — la `!==` original podía filtrar dígitos
    // del token via canal de tiempo (token=10 chars ASCII, oracle pequeño pero real).
    const expected = Buffer.from(call.securityToken, 'utf8');
    const received = Buffer.from(input.seguridad, 'utf8');
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      // H2: NO loggear bytes del securityToken (ni siquiera prefijo) — reducía
      // search-space si el log se filtraba. Solo loggeamos id_llamada + tag.
      this.logger.warn(
        `Peanpe callback seguridad mismatch: id_llamada=${input.identificadorLlamada} ` +
          `received_len=${received.length} expected_len=${expected.length}`,
      );
      return null;
    }
    return { paymentId: call.paymentId, tenantId: call.tenantId };
  }

  /** Formato de `cantidad` verificado en el entorno (céntimos por defecto). */
  private amountFormat(): 'cents' | 'euros' {
    return this.config.get<string>('PEANPE_AMOUNT_FORMAT_VERIFIED') === 'euros' ? 'euros' : 'cents';
  }

  /** Persiste el resultado del callback (idempotente). */
  async persistCallbackResult(
    identificadorLlamada: string,
    status: string,
    msg: string | null,
  ): Promise<void> {
    await this.prisma.peanpeCall.update({
      where: { identificadorLlamada },
      data: {
        resultStatus: status,
        resultMsg: msg ?? null,
        resultReceivedAt: new Date(),
      },
    });
  }
}

// H6: Zod schema en vez de `as` cast — narrowing real sobre webhook externo.
// `status` puede venir como string o number según el cliente Peanpe; coerción explícita.
const PeanpeResultPayloadSchema = z.object({
  status: z.union([z.string(), z.number()]).optional(),
  msg: z.string().optional(),
  identificador_llamada: z.string().optional(),
  debug: z.string().optional(),
  accion: z.string().optional(),
  seguridad: z.string().optional(),
});
type PeanpeResultPayload = z.infer<typeof PeanpeResultPayloadSchema>;

/**
 * 6 chars alfanuméricos. Excluye caracteres ambiguos (0/O, 1/l/I) para
 * facilitar lectura humana si alguna vez se transcribe verbalmente.
 */
function generate6CharId(): string {
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const buf = randomBytes(6);
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += charset[buf[i]! % charset.length];
  }
  return out;
}
