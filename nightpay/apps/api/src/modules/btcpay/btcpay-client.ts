import type CircuitBreaker from 'opossum';
import { z } from 'zod';
import { createBreaker, type BreakerOptions } from '../gateways/circuit-breaker';
import { GatewayTransientError, isTransientGatewayError } from '../gateways/gateway-errors';
import { BtcpayNet, type BtcpayHttpRequest, type BtcpayHttpResponse } from './btcpay-net';
import {
  InvoiceDataSchema,
  PaymentMethodSchema,
  centsToDecimal,
  describeBtcpayFailure,
  type BtcpayFailure,
  type InvoiceData,
  type InvoicePaymentMethod,
} from './btcpay-logic';

/**
 * Cliente de la API Greenfield de BTCPay (v2.4.7) de UN local. La clave va en
 * `Authorization: token …`; nunca se escribe en un error ni en un log.
 */

/** Los avisos que se usan; el resto de eventos de BTCPay no hacen falta. */
export const BTCPAY_WEBHOOK_EVENTS = [
  'InvoiceSettled',
  'InvoiceExpired',
  'InvoiceInvalid',
  'InvoiceProcessing',
  'InvoiceExpiredPaidPartial',
  'InvoicePaidAfterExpiration',
] as const;

/** BTCPay contestó, pero no con lo que se esperaba (clave, permiso, tienda, validación…). */
export class BtcpayApiError extends Error {
  override readonly name = 'BtcpayApiError';
  constructor(
    readonly status: number,
    readonly failure: BtcpayFailure,
  ) {
    super(failure.message);
  }
  toJSON(): Record<string, unknown> {
    return { name: this.name, status: this.status, code: this.failure.code };
  }
}

export interface BtcpayStoreAccess {
  tenantId: string;
  origin: string;
  storeId: string;
  apiKey: string;
}

type Send = (req: BtcpayHttpRequest) => Promise<BtcpayHttpResponse>;

const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

function safeId(id: string, what: string): string {
  if (!SAFE_ID_RE.test(id)) throw new Error(`${what} no válido`);
  return id;
}

function parseBody(res: BtcpayHttpResponse): unknown {
  if (res.body.length === 0) return null;
  try {
    return JSON.parse(res.body.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

export class BtcpayClient {
  constructor(
    private readonly access: BtcpayStoreAccess,
    private readonly send: Send,
  ) {}

  private store(path: string): string {
    return `/api/v1/stores/${safeId(this.access.storeId, 'El id de tienda')}${path}`;
  }

  /** Una llamada. Devuelve el cuerpo ya leído; lanza BtcpayApiError (o GatewayTransientError si BTCPay no está). */
  private async call(method: BtcpayHttpRequest['method'], path: string, body?: unknown, opts: { anonymous?: boolean; tolerate?: readonly number[] } = {}): Promise<{ status: number; json: unknown }> {
    const headers: Record<string, string> = body === undefined ? {} : { 'Content-Type': 'application/json' };
    if (!opts.anonymous) headers.Authorization = `token ${this.access.apiKey}`;
    const res = await this.send({
      origin: this.access.origin,
      path,
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = parseBody(res);
    if (res.status >= 200 && res.status < 300) return { status: res.status, json };
    if (opts.tolerate?.includes(res.status)) return { status: res.status, json };
    const failure = describeBtcpayFailure(res.status, json);
    if (failure.transient) throw new GatewayTransientError(`BTCPay ${res.status}`);
    throw new BtcpayApiError(res.status, failure);
  }

  private invalidAnswer(): BtcpayApiError {
    return new BtcpayApiError(502, {
      code: 'UNKNOWN',
      transient: false,
      message: 'BTCPay ha contestado algo inesperado. Revisa la dirección, la tienda y la clave.',
    });
  }

  async health(): Promise<{ synchronized: boolean }> {
    const { json } = await this.call('GET', '/api/v1/health', undefined, { anonymous: true });
    const parsed = z.object({ synchronized: z.boolean() }).safeParse(json);
    if (!parsed.success) throw this.invalidAnswer();
    return parsed.data;
  }

  async currentKey(): Promise<{ permissions: string[] }> {
    const { json } = await this.call('GET', '/api/v1/api-keys/current');
    const parsed = z.object({ permissions: z.array(z.string().max(200)).max(200) }).safeParse(json);
    if (!parsed.success) throw this.invalidAnswer();
    return { permissions: parsed.data.permissions };
  }

  /** La tienda existe y la clave llega a ella (permiso de ver facturas). */
  async probeStore(): Promise<void> {
    await this.call('GET', this.store('/invoices?take=1'));
  }

  async createInvoice(input: { amountCents: number; orderId: string; expirationMinutes: number }): Promise<InvoiceData> {
    const amount = centsToDecimal(input.amountCents);
    const { json } = await this.call('POST', this.store('/invoices'), {
      amount,
      currency: 'EUR',
      metadata: { orderId: input.orderId },
      checkout: { speedPolicy: 'MediumSpeed', expirationMinutes: input.expirationMinutes },
    });
    return this.invoiceFrom(json);
  }

  async getInvoice(invoiceId: string): Promise<InvoiceData> {
    const { json } = await this.call('GET', this.store(`/invoices/${safeId(invoiceId, 'La factura')}`));
    return this.invoiceFrom(json);
  }

  async getPaymentMethods(invoiceId: string): Promise<InvoicePaymentMethod[]> {
    const { json } = await this.call('GET', this.store(`/invoices/${safeId(invoiceId, 'La factura')}/payment-methods`));
    const parsed = z.array(PaymentMethodSchema).max(20).safeParse(json);
    if (!parsed.success) throw this.invalidAnswer();
    return parsed.data;
  }

  /** Marca la factura como inválida si la clave puede; si no (403/404), caducará sola. */
  async markInvalid(invoiceId: string): Promise<boolean> {
    const { status } = await this.call('POST', this.store(`/invoices/${safeId(invoiceId, 'La factura')}/status`), { status: 'Invalid' }, { tolerate: [400, 403, 404, 422] });
    return status >= 200 && status < 300;
  }

  async createWebhook(input: { url: string; secret: string }): Promise<{ id: string; secret: string }> {
    const { json } = await this.call('POST', this.store('/webhooks'), this.webhookBody(input));
    const parsed = z.object({ id: z.string().min(1).max(100), secret: z.string().min(1).max(200) }).safeParse(json);
    if (!parsed.success) throw this.invalidAnswer();
    return parsed.data;
  }

  async updateWebhook(webhookId: string, input: { url: string; secret: string }): Promise<void> {
    await this.call('PUT', this.store(`/webhooks/${safeId(webhookId, 'El aviso')}`), this.webhookBody(input));
  }

  async deleteWebhook(webhookId: string): Promise<void> {
    await this.call('DELETE', this.store(`/webhooks/${safeId(webhookId, 'El aviso')}`), undefined, { tolerate: [404] });
  }

  private webhookBody(input: { url: string; secret: string }): Record<string, unknown> {
    return {
      enabled: true,
      automaticRedelivery: true,
      url: input.url,
      secret: input.secret,
      authorizedEvents: { everything: false, specificEvents: [...BTCPAY_WEBHOOK_EVENTS] },
    };
  }

  private invoiceFrom(json: unknown): InvoiceData {
    const parsed = InvoiceDataSchema.safeParse(json);
    if (!parsed.success) throw this.invalidAnswer();
    return parsed.data;
  }
}

const MAX_BREAKERS = 500;
const BREAKER_TIMEOUT_MS = 12_000;

/**
 * Los clientes por local. Cada local tiene SU cortacircuitos (opossum, el de las
 * pasarelas): un BTCPay lento o caído de un local no frena a los demás.
 */
/** Se registra con un provider de fábrica (sin decoradores de Nest): ver btcpay.module.ts. */
export class BtcpayClients {
  private readonly breakers = new Map<string, CircuitBreaker<[BtcpayHttpRequest], BtcpayHttpResponse>>();

  constructor(
    private readonly net: BtcpayNet,
    private readonly breakerOpts: Partial<Pick<BreakerOptions, 'volumeThreshold' | 'errorThresholdPercentage' | 'resetTimeoutMs'>> = {},
  ) {}

  forStore(access: BtcpayStoreAccess): BtcpayClient {
    return new BtcpayClient(access, (req) => this.fire(access.tenantId, req));
  }

  private breakerFor(tenantId: string): CircuitBreaker<[BtcpayHttpRequest], BtcpayHttpResponse> {
    const existing = this.breakers.get(tenantId);
    if (existing) return existing;
    if (this.breakers.size >= MAX_BREAKERS) {
      const oldest = this.breakers.keys().next().value;
      if (oldest !== undefined) {
        this.breakers.get(oldest)?.shutdown();
        this.breakers.delete(oldest);
      }
    }
    const breaker = createBreaker((req: BtcpayHttpRequest) => this.net.request(req), {
      timeoutMs: BREAKER_TIMEOUT_MS,
      name: `btcpay:${tenantId.slice(0, 8)}`,
      ...this.breakerOpts,
    });
    this.breakers.set(tenantId, breaker);
    return breaker;
  }

  private async fire(tenantId: string, req: BtcpayHttpRequest): Promise<BtcpayHttpResponse> {
    try {
      return await this.breakerFor(tenantId).fire(req);
    } catch (err) {
      // Cortacircuitos abierto o tiempo agotado: pasajero, como en las pasarelas.
      if (!(err instanceof GatewayTransientError) && isTransientGatewayError(err)) {
        throw new GatewayTransientError(`BTCPay no disponible (${(err as { code?: string }).code ?? 'error'})`);
      }
      throw err;
    }
  }
}
