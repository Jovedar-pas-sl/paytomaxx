import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
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
import type { ApprovalClaim, ApprovalProof, GatewayAdapter, WebhookFsmEvent } from './gateway.adapter';
import { createBreaker, fetchWithTimeout, timedFire } from './circuit-breaker';
import { GatewayTransientError, gatewayFetch, gatewayHttpError } from './gateway-errors';
import { openYavinKey } from './yavin-credential';
import { yavinEnabled } from './yavin-flag';
import { MetricsService } from '../metrics/metrics.service';
import { PrismaService } from '../../common/prisma/prisma.service';

const PROVIDER_LABEL = 'YAVIN' as const;
function stateToNumber(s: 'closed' | 'halfOpen' | 'open'): number {
  return s === 'closed' ? 0 : s === 'halfOpen' ? 1 : 2;
}

/** Yavin no crea enlaces por menos de 1,00 €. */
export const YAVIN_MIN_CENTS = 100;
/** El enlace de Yavin vive 72 h (lo fija Yavin). */
export const YAVIN_LINK_TTL_HOURS = 72;
const DEFAULT_BASE_URL = 'https://api.yavin.com';

/** Código del 409 de una segunda devolución de un cobro de Yavin (las apps lo distinguen sin leer el texto). */
export const YAVIN_SECOND_REFUND_CODE = 'YAVIN_ONE_REFUND_ONLY';
export const YAVIN_SECOND_REFUND_TEXT =
  'Este cobro se pagó con Yavin y ya tiene una devolución: Yavin solo admite una devolución por operación. Si hay que devolver más, hazlo desde el portal de Yavin.';

/**
 * Error de Yavin con su HTTP (status): con él, una devolución rechazada por
 * Yavin (4xx) se da por NO hecha (gateway-refund-outcome.ts) y no se queda
 * pendiente para siempre.
 */
export class YavinHttpError extends Error {
  override readonly name = 'YavinHttpError';
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// shortcut: los nombres de la respuesta de generate_link no se pudieron
// confirmar en docs.yavin.com (sin acceso desde aquí). Se aceptan las formas
// más probables: el enlace en `link` / `url` / `payment_link` y el carrito en
// `cart_id` / `cartId` / `id`.
const GenerateLinkResponseSchema = z
  .object({
    link: z.string().url().optional(),
    url: z.string().url().optional(),
    payment_link: z.string().url().optional(),
    cart_id: z.union([z.string(), z.number()]).optional(),
    cartId: z.union([z.string(), z.number()]).optional(),
    id: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

// shortcut: forma de la respuesta de get_cart_information no confirmada. Se
// supone `status` (pagado = «paid»/«PAID»), `amount` en céntimos, `currency`,
// la referencia que se mandó (`order_id` / `reference`) y sus operaciones en
// `transactions` (id en `id` / `transaction_id`; devuelta = status «refunded»
// o `refunded_amount` > 0).
const CartTransactionSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    transaction_id: z.union([z.string(), z.number()]).optional(),
    status: z.string().optional(),
    amount: z.number().optional(),
    refunded_amount: z.number().optional(),
  })
  .passthrough();
const CartSchema = z
  .object({
    status: z.string().optional(),
    amount: z.number().optional(),
    currency: z.string().optional(),
    order_id: z.string().optional(),
    reference: z.string().optional(),
    transactions: z.array(CartTransactionSchema).optional(),
    transaction_id: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();
export type YavinCart = z.infer<typeof CartSchema>;

/** Lo que dice Yavin de un carrito; ok=false si no se pudo preguntar (red, 5xx, respuesta rara). */
export type CartLookup = { ok: true; cart: YavinCart } | { ok: false; reason: string };

/** El aviso tal como lo guarda NightPay (no el cuerpo de Yavin, que no está firmado). */
const NoticeSchema = z.object({ attemptId: z.string().uuid(), cartId: z.string().min(1).max(200) });
export type YavinNotice = z.infer<typeof NoticeSchema>;

// shortcut: valores de estado «pagado» de Yavin sin confirmar.
const PAID_STATUSES = new Set(['paid', 'PAID', 'succeeded', 'SUCCEEDED']);
// shortcut: valores de estado «ya no se puede pagar» sin confirmar.
const CLOSED_STATUSES = new Set(['cancelled', 'canceled', 'CANCELLED', 'CANCELED', 'expired', 'EXPIRED']);

export function cartIsPaid(cart: YavinCart): boolean {
  return typeof cart.status === 'string' && PAID_STATUSES.has(cart.status);
}

/** PAGADO solo si Yavin dice pagado Y el importe es el mandado, al céntimo. */
export function cartPaidFor(cart: YavinCart, expectedCents: number): boolean {
  return cartIsPaid(cart) && typeof cart.amount === 'number' && cart.amount === expectedCents;
}

/** La operación del carrito (la que se devuelve). */
function transactionOf(cart: YavinCart): { id: string; refunded: boolean } | null {
  const tx = cart.transactions?.[0];
  const id = tx?.id ?? tx?.transaction_id ?? cart.transaction_id;
  if (id === undefined || id === null || String(id).trim() === '') return null;
  const refunded = Boolean(tx && (tx.status?.toLowerCase() === 'refunded' || (tx.refunded_amount ?? 0) > 0));
  return { id: String(id), refunded };
}

/** Token secreto de la URL del aviso: 32 bytes al azar. Solo se guarda su huella. */
export function newNoticeToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: noticeTokenHash(token) };
}

export function noticeTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Yavin — segunda pasarela de tarjeta: un enlace de pago online (página de
 * Yavin) que el cliente abre desde el QR del cobro. No es datáfono.
 *
 *  - authorize: POST /api/v5/ecommerce/generate_link/ con la clave del local
 *    (gateway_credentials, cifrada). El enlace vive 72 h. NO cobra.
 *  - Aviso: Yavin no lo firma. Va a /v1/webhooks/yavin/<token>, con un token
 *    al azar por intento (solo su huella en payment_attempts). Aun con el token
 *    bueno, el aviso nunca da nada por pagado: siempre se pregunta a Yavin
 *    (get_cart_information): pagado y por el importe exacto.
 *  - Cancelar el cobro: cancel_link (cancelLink, lo llama el gancho de cancelar).
 *  - Devolver: POST /api/v5/transaction/{id}/refund/. Una sola por operación.
 */
@Injectable()
export class YavinAdapter implements GatewayAdapter {
  readonly provider = 'YAVIN' as const;
  private readonly logger = new Logger(YavinAdapter.name);

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
    const breaker = <TIn extends unknown[], TOut>(op: string, fn: (...a: TIn) => Promise<TOut>) =>
      createBreaker(fn, {
        name: `yavin.${op}`,
        timeoutMs: this.timeoutMs,
        onStateChange: (s) => this.metrics.circuitState.set({ provider: PROVIDER_LABEL, op }, stateToNumber(s)),
      });
    this.authorizeBreaker = breaker('authorize', (input: AuthorizeInput) => this.doAuthorize(input));
    this.statusBreaker = breaker('getStatus', (tenantId: string, cartId: string) => this.doGetStatus(tenantId, cartId));
    this.refundBreaker = breaker('refund', (input: RefundInput) => this.doRefund(input));
  }

  authorize(input: AuthorizeInput): Promise<AuthorizeResult> {
    // El interruptor solo frena lo NUEVO: comprobar, anular y devolver siguen.
    if (!yavinEnabled()) return Promise.reject(new Error('Yavin apagado (YAVIN_ENABLED): no se abren enlaces nuevos'));
    return this.timed('authorize', () => this.authorizeBreaker.fire(input));
  }

  getStatus(tenantId: string, providerTxId: string): Promise<GatewayStatus> {
    return this.timed('getStatus', () => this.statusBreaker.fire(tenantId, providerTxId));
  }

  refund(input: RefundInput): Promise<RefundResult> {
    return this.timed('refund', () => this.refundBreaker.fire(input));
  }

  private timed<T>(op: string, fire: () => Promise<T>): Promise<T> {
    return timedFire(fire, (dur, outcome) =>
      this.metrics.gatewayDuration.observe({ provider: PROVIDER_LABEL, op, outcome }, dur),
    );
  }

  // ─── Abrir el pago ────────────────────────────────────────────────

  private async doAuthorize(input: AuthorizeInput): Promise<AuthorizeResult> {
    if (input.amountCents < YAVIN_MIN_CENTS) {
      throw new Error(`Yavin no acepta cobros de menos de ${YAVIN_MIN_CENTS / 100} €: este es de ${input.amountCents} céntimos`);
    }
    if (!input.attemptId) throw new Error('Yavin: falta el id del intento');
    const apiKey = await this.apiKeyOf(input.tenantId);
    const notice = newNoticeToken();
    const apiBase = this.publicApiBase();
    const lang = input.language && input.language !== 'es' ? `&lang=${input.language}` : '';
    // shortcut: nombres de los campos de generate_link sin confirmar (amount en
    // céntimos, currency, order_id, return_url_success, return_url_cancelled,
    // webhook_url). La vuelta del cliente trae cartId y status en la URL.
    const body = {
      amount: input.amountCents,
      currency: input.currency,
      order_id: input.attemptId, // el id del intento (aleatorio), como Paytef: del id del pago sale el código de confirmación
      return_url_success: `${apiBase}/pay/yavin/return?r=ok${lang}`,
      return_url_cancelled: `${apiBase}/pay/yavin/return?r=ko${lang}`,
      webhook_url: `${apiBase}/v1/webhooks/yavin/${notice.token}`,
    };
    const res = await gatewayFetch(() => this.post('/api/v5/ecommerce/generate_link/', apiKey, body), 'Yavin generate_link');
    if (!res.ok) {
      // Ni el cuerpo mandado (lleva la URL del aviso con su token) ni la clave van al log.
      const text = await res.text().catch(() => '');
      throw gatewayHttpError(res.status, `Yavin generate_link: ${res.status} ${redact(text, apiKey).slice(0, 200)}`);
    }
    const parsed = GenerateLinkResponseSchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new Error('Yavin generate_link: respuesta con forma desconocida');
    const link = parsed.data.link ?? parsed.data.url ?? parsed.data.payment_link;
    const cartRaw = parsed.data.cart_id ?? parsed.data.cartId ?? parsed.data.id;
    const cartId = cartRaw === undefined ? '' : String(cartRaw).trim();
    if (!link || !cartId) throw new Error('Yavin generate_link: la respuesta no trae enlace o carrito');
    this.logger.log(`Yavin: enlace abierto (carrito ${cartId}) para el cobro ${input.paymentId.slice(0, 8)}`);
    return {
      provider: 'YAVIN',
      providerTxId: cartId,
      status: 'PROCESSING',
      paymentLinkUrl: link,
      noticeTokenHash: notice.hash,
    };
  }

  // ─── Consultar ────────────────────────────────────────────────────

  /** El carrito tal como lo tiene Yavin (fuente de verdad). Nunca lanza. */
  async cartOf(tenantId: string, cartId: string): Promise<CartLookup> {
    let apiKey: string;
    try {
      apiKey = await this.apiKeyOf(tenantId);
    } catch (err) {
      return { ok: false, reason: `yavin-sin-credencial: ${(err as Error).message}`.slice(0, 200) };
    }
    try {
      // shortcut: el carrito se pide como { cart_id } (sin confirmar).
      const res = await this.post('/api/v5/ecommerce/get_cart_information/', apiKey, { cart_id: cartId });
      if (!res.ok) return { ok: false, reason: `yavin-http-${res.status}` };
      const parsed = CartSchema.safeParse(await res.json().catch(() => null));
      if (!parsed.success) return { ok: false, reason: 'yavin-respuesta-rara' };
      return { ok: true, cart: parsed.data };
    } catch (err) {
      return { ok: false, reason: `yavin-sin-respuesta: ${(err as Error).message}`.slice(0, 200) };
    }
  }

  /**
   * AUTHORIZED solo si Yavin dice pagado y por el importe del intento, al
   * céntimo (la conciliación no mira importes: aquí sí). Pagado por otro
   * importe → UNKNOWN (no se da por pagado; queda para mirarlo).
   */
  private async doGetStatus(tenantId: string, cartId: string): Promise<GatewayStatus> {
    const found = await this.cartOf(tenantId, cartId);
    if (!found.ok) return 'UNKNOWN';
    const { cart } = found;
    if (cartIsPaid(cart)) {
      const expected = await this.expectedCentsOf(cartId);
      return expected !== null && cartPaidFor(cart, expected) ? 'AUTHORIZED' : 'UNKNOWN';
    }
    if (typeof cart.status === 'string' && CLOSED_STATUSES.has(cart.status)) return 'FAILED';
    return 'PROCESSING';
  }

  /**
   * Prueba de la aprobación: el carrito según Yavin. Pagado y de este cobro;
   * el importe lo compara el procesador con el del intento (judgeApproval).
   */
  async proveApproval(claim: ApprovalClaim): Promise<ApprovalProof> {
    const tenantId = await this.tenantOf(claim.paymentId);
    if (!tenantId) return { kind: 'rejected', reason: 'yavin-cobro-desconocido' };
    const found = await this.cartOf(tenantId, claim.providerTxId);
    if (!found.ok) return { kind: 'unavailable', reason: found.reason };
    const { cart } = found;
    const ref = cart.order_id ?? cart.reference;
    if (ref !== undefined && ref !== claim.attemptId && ref !== claim.paymentId) return { kind: 'rejected', reason: 'yavin-carrito-de-otro-cobro' };
    if (!cartIsPaid(cart)) return { kind: 'rejected', reason: 'yavin-no-pagado' };
    if (typeof cart.amount !== 'number') return { kind: 'rejected', reason: 'yavin-sin-importe' };
    return { kind: 'confirmed', amountCents: cart.amount, currency: cart.currency?.toUpperCase() ?? null };
  }

  // ─── Anular ───────────────────────────────────────────────────────

  /** Anula el enlace en Yavin (al cancelar el cobro): ya no se puede pagar. */
  async cancelLink(tenantId: string, cartId: string): Promise<void> {
    const apiKey = await this.apiKeyOf(tenantId);
    // shortcut: cancel_link recibe { cart_id } (sin confirmar).
    const res = await gatewayFetch(() => this.post('/api/v5/ecommerce/cancel_link/', apiKey, { cart_id: cartId }), 'Yavin cancel_link');
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw gatewayHttpError(res.status, `Yavin cancel_link: ${res.status} ${redact(text, apiKey).slice(0, 200)}`);
    }
  }

  // ─── Devolver ─────────────────────────────────────────────────────

  /**
   * Una sola devolución por operación (regla de Yavin). Si Yavin ya la tiene
   * devuelta, no se llama: error 4xx (seguro que no se hizo otra).
   */
  private async doRefund(input: RefundInput): Promise<RefundResult> {
    const found = await this.cartOf(input.tenantId, input.providerTxId);
    if (!found.ok) {
      // No se llegó a pedir la devolución: no se hizo.
      throw Object.assign(new GatewayTransientError(`Yavin: no se pudo leer el carrito antes de devolver (${found.reason})`), {
        code: 'ECONNREFUSED',
      });
    }
    const tx = transactionOf(found.cart);
    if (!tx) throw new YavinHttpError('Yavin: el carrito no tiene operación que devolver', 422);
    if (tx.refunded) throw new YavinHttpError(YAVIN_SECOND_REFUND_TEXT, 422);
    const apiKey = await this.apiKeyOf(input.tenantId);
    // shortcut: el cuerpo de la devolución ({ amount } en céntimos) y el id de
    // la respuesta (`id` / `refund_id`) sin confirmar.
    const res = await this.post(`/api/v5/transaction/${encodeURIComponent(tx.id)}/refund/`, apiKey, { amount: input.amountCents });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const message = `Yavin refund: ${res.status} ${redact(text, apiKey).slice(0, 200)}`;
      if (res.status >= 400 && res.status < 500) throw new YavinHttpError(message, res.status);
      throw gatewayHttpError(res.status, message);
    }
    const data = (await res.json().catch(() => ({}))) as { id?: unknown; refund_id?: unknown };
    const refundId = data.id ?? data.refund_id;
    return { providerRefundId: refundId !== undefined ? String(refundId) : `${tx.id}-refund`, status: 'SUCCEEDED' };
  }

  // ─── Avisos ───────────────────────────────────────────────────────

  /**
   * El aviso de Yavin no está firmado y su cuerpo no se usa: lo que se guarda
   * en webhook_deliveries es lo de NightPay ({ attemptId, cartId }, del intento
   * que encontró el token de la URL). Ver webhooks.controller (receiveYavin).
   */
  verifyWebhook(_headers: Record<string, string | string[] | undefined>, rawBody: Buffer): WebhookVerifyResult {
    const notice = parseNotice(rawBody);
    if (!notice) return { valid: false, reason: 'invalid-payload-shape' };
    return { valid: true, externalEventId: `${notice.cartId}_paid`, paymentRef: notice.attemptId };
  }

  /** Solo se guarda un aviso cuando Yavin ya dijo «pagado»: el procesador lo vuelve a comprobar (proveApproval). */
  mapWebhookToFsmEvent(parsedPayload: unknown): WebhookFsmEvent | null {
    const parsed = NoticeSchema.safeParse(parsedPayload);
    if (!parsed.success) return null;
    return {
      paymentId: parsed.data.attemptId,
      event: { type: 'AUTHORIZED', providerTxId: parsed.data.cartId, provider: 'YAVIN' },
    };
  }

  // ─── Ayudas ───────────────────────────────────────────────────────

  private post(path: string, apiKey: string, body: unknown): Promise<Response> {
    const base = (this.config.get<string>('YAVIN_API_URL') ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    return fetchWithTimeout(
      `${base}${path}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Yavin-Secret': apiKey },
        body: JSON.stringify(body),
      },
      this.timeoutMs,
    );
  }

  private publicApiBase(): string {
    return (this.config.get<string>('NEXT_PUBLIC_API_URL') ?? 'http://localhost:4100').replace(/\/+$/, '');
  }

  /** La clave de API del local, descifrada (solo en memoria, para la llamada). */
  private async apiKeyOf(tenantId: string): Promise<string> {
    const row = await this.prisma.asSystem((tx) =>
      tx.gatewayCredential.findFirst({
        where: { tenantId, provider: 'YAVIN', active: true },
        orderBy: { createdAt: 'desc' },
        select: { encKey: true, encNonce: true, encTag: true },
      }),
    );
    if (!row) throw new Error('Yavin: el local no tiene credencial activa');
    try {
      return openYavinKey(this.config.get<string>('ENCRYPTION_KEK'), tenantId, row);
    } catch {
      throw new Error('Yavin: la credencial del local no se pudo descifrar');
    }
  }

  private async tenantOf(paymentId: string): Promise<string | null> {
    const p = await this.prisma.asSystem((tx) => tx.payment.findUnique({ where: { id: paymentId }, select: { tenantId: true } }));
    return p?.tenantId ?? null;
  }

  /** Lo que se mandó a Yavin en el intento de ese carrito. */
  private async expectedCentsOf(cartId: string): Promise<number | null> {
    const attempt = await this.prisma.asSystem((tx) =>
      tx.paymentAttempt.findUnique({
        where: { provider_providerTxId: { provider: 'YAVIN', providerTxId: cartId } },
        select: { amountCents: true },
      }),
    );
    return attempt?.amountCents ?? null;
  }
}

function parseNotice(rawBody: Buffer): YavinNotice | null {
  try {
    const parsed = NoticeSchema.safeParse(JSON.parse(rawBody.toString('utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Por si Yavin devuelve la clave en un mensaje de error: nunca al log. */
function redact(text: string, apiKey: string): string {
  return apiKey ? text.split(apiKey).join('[clave]') : text;
}
