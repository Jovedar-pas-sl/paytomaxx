import { Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DebugEndpointsGuard } from '../../common/guards/debug-endpoints.guard';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedsysAdapter } from '../gateways/redsys.adapter';

interface KeyCheckResponse {
  merchantCodeOk: boolean;
  terminal: string | null;
  /** La clave de firma tiene el formato de Redsys (sin decir longitud ni contenido). */
  secretKeyOk: boolean;
  apiUrl: string | null;
  nextPublicApiUrl: string | null;
  merchantUrlWeWillSend: string;
  paymethods: string | null;
  hint: string;
}

interface PaymentSummary {
  id: string;
  status: string;
  provider: string | null;
  providerTxId: string | null;
  amountCents: number;
  createdAt: string;
  updatedAt: string;
  ageSeconds: number;
}

interface WebhookSummary {
  id: string;
  provider: string;
  externalEventId: string;
  processedAt: string | null;
  createdAt: string;
  ageSeconds: number;
  /** Tamaño del aviso; el cuerpo crudo ya no se devuelve (datos del pago y firma). */
  rawBodyBytes: number;
}

interface PaymentRow {
  id: string;
  status: string;
  provider: string | null;
  providerTxId: string | null;
  tenantId: string;
}

const REDSYS_KEY_LENGTH = 32;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * TEMP DIAG. Configuración Redsys + estado reciente de pagos y avisos para
 * diagnosticar sin acceso a terminal. Solo superadmin y con
 * DEBUG_ENDPOINTS_ENABLED (DebugEndpointsGuard). Cruza locales a propósito:
 * consultas de sistema (asSystem), parametrizadas. No devuelve la clave de
 * firma (ni su longitud), ni tokens de tarjeta, ni el cuerpo de los avisos.
 */
@Controller('debug/redsys')
@UseGuards(DebugEndpointsGuard)
export class RedsysDebugController {
  private readonly config: ConfigService;
  private readonly prisma: PrismaService;
  private readonly redsys: RedsysAdapter;

  constructor(
    @Inject(ConfigService) config: ConfigService,
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(RedsysAdapter) redsys: RedsysAdapter,
  ) {
    this.config = config;
    this.prisma = prisma;
    this.redsys = redsys;
  }

  @Get('keycheck')
  keycheck(): KeyCheckResponse {
    const merchantCode = this.config.get<string>('REDSYS_MERCHANT_CODE') ?? '';
    const terminal = this.config.get<string>('REDSYS_TERMINAL') ?? '';
    const secretKey = this.config.get<string>('REDSYS_SECRET_KEY') ?? '';
    const nextPublicApiUrl = this.config.get<string>('NEXT_PUBLIC_API_URL') ?? null;
    const merchantUrlWeWillSend = `${(nextPublicApiUrl ?? 'http://localhost:4100').replace(/\/+$/, '')}/v1/webhooks/redsys`;
    const secretKeyOk = secretKey.length === REDSYS_KEY_LENGTH && BASE64.test(secretKey);

    return {
      merchantCodeOk: /^\d{1,9}$/.test(merchantCode),
      terminal: terminal || null,
      secretKeyOk,
      apiUrl: this.config.get<string>('REDSYS_API_URL') ?? null,
      nextPublicApiUrl,
      merchantUrlWeWillSend,
      paymethods: this.config.get<string>('REDSYS_PAYMETHODS') ?? null,
      hint: keycheckHint(secretKey, secretKeyOk, nextPublicApiUrl, merchantUrlWeWillSend),
    };
  }

  /**
   * Etapa A — tokenización probe. ¿Hay algún cobro Redsys con token de tarjeta
   * guardado? (= BBVA tiene Pago por Referencia activo). Solo dice si existe:
   * el token de la tarjeta no sale de la base de datos.
   */
  @Get('last-tokenized')
  async lastTokenized(): Promise<{
    found: boolean;
    requestTokenEnvActive: boolean;
    hint: string;
    payment: { id: string; providerTxId: string | null; amountCents: number; createdAt: string } | null;
  }> {
    const requestTokenEnvActive =
      (this.config.get<string>('REDSYS_REQUEST_TOKEN') ?? '').toLowerCase() === 'true';

    const rows = await this.prisma.asSystem((tx) =>
      tx.$queryRaw<Array<{ id: string; providerTxId: string | null; amountCents: number; createdAt: Date }>>`
        SELECT id::text, "providerTxId", "amountCents", "createdAt"
          FROM payments
         WHERE provider = 'REDSYS' AND "tokenizationData" IS NOT NULL
         ORDER BY "createdAt" DESC
         LIMIT 1`,
    );

    const row = rows[0];
    if (!row) {
      const hint = !requestTokenEnvActive
        ? 'REDSYS_REQUEST_TOKEN no está set a "true" en Dokploy — el authorize no pide token. Configura y haz un cobro de prueba.'
        : 'Aún ningún cobro Redsys ha devuelto tokenización. Posibles causas: (a) BBVA no tiene activado "Pago por Referencia"; (b) el cobro de prueba aún no se ha hecho; (c) el callback no llegó (revisa /recent-webhooks).';
      return { found: false, requestTokenEnvActive, hint, payment: null };
    }

    return {
      found: true,
      requestTokenEnvActive,
      hint: 'BBVA TIENE tokenización activa. Plan PIN-flow / MIT recurrente es viable.',
      payment: {
        id: row.id,
        providerTxId: row.providerTxId,
        amountCents: row.amountCents,
        createdAt: row.createdAt.toISOString(),
      },
    };
  }

  /**
   * Últimos 20 payments en BD (cualquier provider). Permite ver si un cobro
   * está atascado en AUTHORIZING (= webhook no llegó) o en AUTHORIZED.
   */
  @Get('recent-payments')
  async recentPayments(): Promise<{ total: number; payments: PaymentSummary[] }> {
    const rows = await this.prisma.asSystem((tx) =>
      tx.$queryRaw<Array<Omit<PaymentSummary, 'createdAt' | 'updatedAt' | 'ageSeconds'> & { createdAt: Date; updatedAt: Date }>>`
        SELECT id::text, status::text, provider::text, "providerTxId", "amountCents", "createdAt", "updatedAt"
          FROM payments
         ORDER BY "createdAt" DESC
         LIMIT 20`,
    );

    const now = Date.now();
    return {
      total: rows.length,
      payments: rows.map((p) => ({
        ...p,
        createdAt: p.createdAt.toISOString(),
        updatedAt: p.updatedAt.toISOString(),
        ageSeconds: Math.floor((now - p.createdAt.getTime()) / 1000),
      })),
    };
  }

  /**
   * Últimos 20 avisos de pasarela (cualquier provider). Si un cobro pasó por
   * Redsys y aquí no hay un REDSYS reciente → Redsys NO llamó al webhook.
   */
  @Get('recent-webhooks')
  async recentWebhooks(): Promise<{ total: number; webhooks: WebhookSummary[] }> {
    const rows = await this.prisma.asSystem((tx) =>
      tx.$queryRaw<
        Array<{
          id: bigint;
          provider: string;
          externalEventId: string;
          processedAt: Date | null;
          createdAt: Date;
          rawBodyBytes: number | null;
        }>
      >`
        SELECT id, provider::text, "externalEventId", "processedAt", "createdAt",
               octet_length("rawBody")::int AS "rawBodyBytes"
          FROM webhook_deliveries
         ORDER BY "createdAt" DESC
         LIMIT 20`,
    );

    const now = Date.now();
    return {
      total: rows.length,
      webhooks: rows.map((w) => ({
        id: w.id.toString(),
        provider: w.provider,
        externalEventId: w.externalEventId,
        processedAt: w.processedAt ? w.processedAt.toISOString() : null,
        createdAt: w.createdAt.toISOString(),
        ageSeconds: Math.floor((now - w.createdAt.getTime()) / 1000),
        rawBodyBytes: w.rawBodyBytes ?? 0,
      })),
    };
  }

  /**
   * Como `consult/:paymentId` pero con detalles del error (mensaje, código).
   * Útil cuando consult devuelve UNKNOWN — el adapter se traga el error.
   */
  @Get('consult-raw/:paymentId')
  async consultRaw(@Param('paymentId', new ParseUUIDPipe()) paymentId: string): Promise<unknown> {
    const payment = await this.findPayment(paymentId);
    if (payment.provider !== 'REDSYS' || !payment.providerTxId) {
      return { error: 'not-a-redsys-payment', payment };
    }

    // Acceder a internals del adapter para bypass circuit breaker y exponer
    // detalle del error sin que lo swallow doGetStatus.
    const adapter = this.redsys as unknown as {
      getApi: () => {
        restTrataPeticion: (params: Record<string, string>) => Promise<unknown>;
      };
      requireCreds: () => { merchantCode: string; terminal: string };
    };

    let creds;
    try {
      creds = adapter.requireCreds();
    } catch (e) {
      return { error: 'creds-missing', message: (e as Error).message };
    }

    const params = {
      DS_MERCHANT_AMOUNT: '1',
      DS_MERCHANT_ORDER: payment.providerTxId,
      DS_MERCHANT_MERCHANTCODE: creds.merchantCode,
      DS_MERCHANT_CURRENCY: '978',
      DS_MERCHANT_TRANSACTIONTYPE: '44',
      DS_MERCHANT_TERMINAL: creds.terminal.padStart(3, '0'),
    };

    try {
      const result = await adapter.getApi().restTrataPeticion(params);
      return { ok: true, paymentId, providerTxId: payment.providerTxId, paramsSent: params, redsysResponse: result };
    } catch (e) {
      const err = e as Error & { code?: string; cause?: unknown };
      return {
        ok: false,
        paymentId,
        providerTxId: payment.providerTxId,
        paramsSent: params,
        errorName: err.name,
        errorMessage: err.message,
        errorCode: err.code ?? null,
        errorCause: err.cause ? String(err.cause) : null,
      };
    }
  }

  /**
   * Pregunta a Redsys el estado real de un payment (REST trataPeticion,
   * TransactionType=44) sin tocar la BD. Para reconciliar de verdad, el
   * orphan-reconcile processor avanza el FSM.
   */
  @Get('consult/:paymentId')
  async consult(@Param('paymentId', new ParseUUIDPipe()) paymentId: string): Promise<{
    paymentId: string;
    dbStatus: string;
    provider: string | null;
    providerTxId: string | null;
    redsysStatus: 'AUTHORIZED' | 'FAILED' | 'UNKNOWN';
  }> {
    const payment = await this.findPayment(paymentId);
    const base = {
      paymentId,
      dbStatus: payment.status,
      provider: payment.provider,
      providerTxId: payment.providerTxId,
    };
    if (payment.provider !== 'REDSYS' || !payment.providerTxId) {
      return { ...base, redsysStatus: 'UNKNOWN' };
    }
    const redsysStatus = await this.redsys.getStatus(payment.tenantId, payment.providerTxId);
    return { ...base, redsysStatus: redsysStatus as 'AUTHORIZED' | 'FAILED' | 'UNKNOWN' };
  }

  private async findPayment(paymentId: string): Promise<PaymentRow> {
    const rows = await this.prisma.asSystem((tx) =>
      tx.$queryRaw<PaymentRow[]>`
        SELECT id::text, status::text, provider::text, "providerTxId", "tenantId"::text
          FROM payments
         WHERE id = ${paymentId}::uuid
         LIMIT 1`,
    );
    const payment = rows[0];
    if (!payment) throw new NotFoundException(`Payment ${paymentId} not found`);
    return payment;
  }
}

function keycheckHint(
  secretKey: string,
  secretKeyOk: boolean,
  nextPublicApiUrl: string | null,
  merchantUrlWeWillSend: string,
): string {
  if (!secretKey) return 'REDSYS_SECRET_KEY no está configurado en Dokploy.';
  if (!secretKeyOk) return 'REDSYS_SECRET_KEY no tiene el formato de Redsys (32 caracteres en base64): revísala en el portal del banco.';
  if (!nextPublicApiUrl) {
    return 'NEXT_PUBLIC_API_URL no configurado — MERCHANTURL apunta a localhost y Redsys NUNCA podrá entregar el webhook. Configura NEXT_PUBLIC_API_URL=https://api.paytomaxx.com en Dokploy.';
  }
  if (!nextPublicApiUrl.startsWith('https://')) {
    return `NEXT_PUBLIC_API_URL=${nextPublicApiUrl} no es HTTPS. Redsys exige HTTPS para webhooks.`;
  }
  return `OK. MERCHANTURL que mandamos a Redsys: ${merchantUrlWeWillSend}`;
}
