import { Controller, Get, Inject, NotFoundException, Param, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DebugEndpointsGuard } from '../../common/guards/debug-endpoints.guard';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedsysAdapter } from '../gateways/redsys.adapter';

interface KeyCheckResponse {
  merchantCodePresent: boolean;
  merchantCodeLength: number;
  terminalPresent: boolean;
  terminal: string | null;
  secretKeyPresent: boolean;
  secretKeyLength: number;
  secretKeyLooksBase64: boolean;
  secretKeyExpectedLength: number;
  secretKeyMatchesExpected: boolean;
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
  rawBodyPreview: string;
}

/**
 * TEMP DIAG. Reports configuración Redsys + estado reciente de pagos +
 * webhooks recibidos para diagnosticar fallos sin acceso a terminal.
 *
 * NO leak la secret key — solo length + match contra esperado.
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
    const apiUrl = this.config.get<string>('REDSYS_API_URL') ?? null;
    const nextPublicApiUrl = this.config.get<string>('NEXT_PUBLIC_API_URL') ?? null;
    const paymethods = this.config.get<string>('REDSYS_PAYMETHODS') ?? null;
    const merchantUrlWeWillSend = `${(nextPublicApiUrl ?? 'http://localhost:4100').replace(/\/+$/, '')}/v1/webhooks/redsys`;

    const looksBase64 = /^[A-Za-z0-9+/]+={0,2}$/.test(secretKey);
    const expectedLen = 32;

    let hint = '';
    if (!secretKey) {
      hint = 'REDSYS_SECRET_KEY no está configurado en Dokploy.';
    } else if (secretKey.length !== expectedLen) {
      hint = `Clave tiene ${secretKey.length} chars; estándar Redsys es ${expectedLen}.`;
    } else if (!looksBase64) {
      hint = 'Clave tiene 32 chars pero charset fuera de base64.';
    } else if (!nextPublicApiUrl) {
      hint = 'NEXT_PUBLIC_API_URL no configurado — MERCHANTURL apunta a localhost y Redsys NUNCA podrá entregar el webhook. Configura NEXT_PUBLIC_API_URL=https://api.paytomaxx.com en Dokploy.';
    } else if (!nextPublicApiUrl.startsWith('https://')) {
      hint = `NEXT_PUBLIC_API_URL=${nextPublicApiUrl} no es HTTPS. Redsys exige HTTPS para webhooks.`;
    } else {
      hint = `OK. MERCHANTURL que mandamos a Redsys: ${merchantUrlWeWillSend}`;
    }

    return {
      merchantCodePresent: merchantCode.length > 0,
      merchantCodeLength: merchantCode.length,
      terminalPresent: terminal.length > 0,
      terminal: terminal || null,
      secretKeyPresent: secretKey.length > 0,
      secretKeyLength: secretKey.length,
      secretKeyLooksBase64: looksBase64,
      secretKeyExpectedLength: expectedLen,
      secretKeyMatchesExpected: secretKey.length === expectedLen && looksBase64,
      apiUrl,
      nextPublicApiUrl,
      merchantUrlWeWillSend,
      paymethods,
      hint,
    };
  }

  /**
   * Etapa A — tokenización probe. Devuelve el ÚLTIMO cobro Redsys con
   * `tokenizationData` capturado (= Redsys/BBVA devolvió un token de
   * tarjeta en el callback porque el authorize lo pidió con
   * REDSYS_REQUEST_TOKEN=true).
   *
   * Si `tokenizationData != null` → BBVA tiene Pago por Referencia activo,
   * podemos hacer plan PIN con MIT.
   * Si null en todos los cobros recientes → BBVA no lo tiene activo o
   * REDSYS_REQUEST_TOKEN no estaba en el env al hacer el cobro.
   */
  @Get('last-tokenized')
  async lastTokenized(): Promise<{
    found: boolean;
    requestTokenEnvActive: boolean;
    hint: string;
    payment: {
      id: string;
      providerTxId: string | null;
      amountCents: number;
      createdAt: string;
      tokenizationData: unknown;
    } | null;
  }> {
    const requestTokenEnvActive =
      (this.config.get<string>('REDSYS_REQUEST_TOKEN') ?? '').toLowerCase() === 'true';

    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        id: string;
        providerTxId: string | null;
        amountCents: number;
        createdAt: Date;
        tokenizationData: unknown;
      }>
    >(
      `SELECT id::text, "providerTxId", "amountCents", "createdAt", "tokenizationData"
         FROM payments
        WHERE provider = 'REDSYS' AND "tokenizationData" IS NOT NULL
        ORDER BY "createdAt" DESC
        LIMIT 1`,
    );

    if (rows.length === 0) {
      const hint = !requestTokenEnvActive
        ? 'REDSYS_REQUEST_TOKEN no está set a "true" en Dokploy — el authorize no pide token. Configura y haz un cobro de prueba.'
        : 'Aún ningún cobro Redsys ha devuelto tokenización. Posibles causas: (a) BBVA no tiene activado "Pago por Referencia"; (b) el cobro de prueba aún no se ha hecho; (c) el callback no llegó (revisa /recent-webhooks).';
      return { found: false, requestTokenEnvActive, hint, payment: null };
    }

    const row = rows[0]!;
    return {
      found: true,
      requestTokenEnvActive,
      hint: 'BBVA TIENE tokenización activa. Plan PIN-flow / MIT recurrente es viable.',
      payment: {
        id: row.id,
        providerTxId: row.providerTxId,
        amountCents: row.amountCents,
        createdAt: row.createdAt.toISOString(),
        tokenizationData: row.tokenizationData,
      },
    };
  }

  /**
   * Últimos 20 payments en BD (cualquier provider). Permite ver si tu 0,01€
   * está atascado en AUTHORIZING (= webhook no llegó) o en AUTHORIZED (=
   * webhook OK pero UI no refresca).
   */
  @Get('recent-payments')
  async recentPayments(): Promise<{ total: number; payments: PaymentSummary[] }> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{
      id: string;
      status: string;
      provider: string | null;
      providerTxId: string | null;
      amountCents: number;
      createdAt: Date;
      updatedAt: Date;
    }>>(
      `SELECT id::text, status::text, provider::text, "providerTxId", "amountCents", "createdAt", "updatedAt"
       FROM payments
       ORDER BY "createdAt" DESC
       LIMIT 20`,
    );

    const now = Date.now();
    return {
      total: rows.length,
      payments: rows.map((p) => ({
        id: p.id,
        status: p.status,
        provider: p.provider,
        providerTxId: p.providerTxId,
        amountCents: p.amountCents,
        createdAt: p.createdAt.toISOString(),
        updatedAt: p.updatedAt.toISOString(),
        ageSeconds: Math.floor((now - p.createdAt.getTime()) / 1000),
      })),
    };
  }

  /**
   * Últimos 20 webhook deliveries de cualquier provider. Si tu cobro pasó
   * por Redsys pero esta lista no tiene una entrada REDSYS reciente →
   * Redsys NO llamó a nuestro webhook (panel BBVA mal configurado o
   * comunicación on-line off).
   */
  @Get('recent-webhooks')
  async recentWebhooks(): Promise<{ total: number; webhooks: WebhookSummary[] }> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{
      id: bigint;
      provider: string;
      externalEventId: string;
      processedAt: Date | null;
      createdAt: Date;
      rawBody: Buffer;
    }>>(
      `SELECT id, provider::text, "externalEventId", "processedAt", "createdAt", "rawBody"
       FROM webhook_deliveries
       ORDER BY "createdAt" DESC
       LIMIT 20`,
    );

    const now = Date.now();
    return {
      total: rows.length,
      webhooks: rows.map((w) => {
        const text = Buffer.isBuffer(w.rawBody) ? w.rawBody.toString('utf8') : '';
        return {
          id: w.id.toString(),
          provider: w.provider,
          externalEventId: w.externalEventId,
          processedAt: w.processedAt ? w.processedAt.toISOString() : null,
          createdAt: w.createdAt.toISOString(),
          ageSeconds: Math.floor((now - w.createdAt.getTime()) / 1000),
          rawBodyPreview: text.length > 500 ? text.slice(0, 500) + '...' : text,
        };
      }),
    };
  }

  /**
   * Como `consult/:paymentId` pero con detalles del error (stack, mensaje,
   * URL). Útil cuando consult devuelve UNKNOWN — el adapter swallow el
   * error original, este endpoint lo expone para diagnosticar.
   */
  @Get('consult-raw/:paymentId')
  async consultRaw(@Param('paymentId') paymentId: string): Promise<unknown> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{
      id: string;
      status: string;
      provider: string | null;
      providerTxId: string | null;
      tenantId: string;
    }>>(
      `SELECT id::text, status::text, provider::text, "providerTxId", "tenantId"::text
       FROM payments
       WHERE id = $1::uuid
       LIMIT 1`,
      paymentId,
    );
    const payment = rows[0];
    if (!payment) {
      throw new NotFoundException(`Payment ${paymentId} not found`);
    }
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

    const terminal = creds.terminal.padStart(3, '0');
    const params = {
      DS_MERCHANT_AMOUNT: '1',
      DS_MERCHANT_ORDER: payment.providerTxId,
      DS_MERCHANT_MERCHANTCODE: creds.merchantCode,
      DS_MERCHANT_CURRENCY: '978',
      DS_MERCHANT_TRANSACTIONTYPE: '44',
      DS_MERCHANT_TERMINAL: terminal,
    };

    try {
      const api = adapter.getApi();
      const result = await api.restTrataPeticion(params);
      return {
        ok: true,
        paymentId,
        providerTxId: payment.providerTxId,
        paramsSent: params,
        redsysResponse: result,
      };
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
        errorStack: (err.stack ?? '').split('\n').slice(0, 8).join(' | '),
      };
    }
  }

  /**
   * Pregunta a Redsys el estado real de un payment (vía REST trataPeticion
   * TransactionType=44). Útil para diagnosticar pagos atascados sin esperar
   * al job de reconciliación automática.
   *
   * Devuelve lo que Redsys dice (AUTHORIZED / FAILED / UNKNOWN) sin tocar
   * la BD. Para reconciliar de verdad, el orphan-reconcile processor
   * agarra ese estado y avanza el FSM.
   */
  @Get('consult/:paymentId')
  async consult(@Param('paymentId') paymentId: string): Promise<{
    paymentId: string;
    dbStatus: string;
    provider: string | null;
    providerTxId: string | null;
    redsysStatus: 'AUTHORIZED' | 'FAILED' | 'UNKNOWN';
  }> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{
      id: string;
      status: string;
      provider: string | null;
      providerTxId: string | null;
      tenantId: string;
    }>>(
      `SELECT id::text, status::text, provider::text, "providerTxId", "tenantId"::text
       FROM payments
       WHERE id = $1::uuid
       LIMIT 1`,
      paymentId,
    );
    const payment = rows[0];
    if (!payment) {
      throw new NotFoundException(`Payment ${paymentId} not found`);
    }
    if (payment.provider !== 'REDSYS' || !payment.providerTxId) {
      return {
        paymentId,
        dbStatus: payment.status,
        provider: payment.provider,
        providerTxId: payment.providerTxId,
        redsysStatus: 'UNKNOWN',
      };
    }
    const redsysStatus = await this.redsys.getStatus(payment.tenantId, payment.providerTxId);
    return {
      paymentId,
      dbStatus: payment.status,
      provider: payment.provider,
      providerTxId: payment.providerTxId,
      redsysStatus: redsysStatus as 'AUTHORIZED' | 'FAILED' | 'UNKNOWN',
    };
  }
}
