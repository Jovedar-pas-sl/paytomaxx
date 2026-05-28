import { Controller, Get, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Public } from '../../common/decorators/public.decorator';
import { PrismaService } from '../../common/prisma/prisma.service';

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
export class RedsysDebugController {
  private readonly logger = new Logger(RedsysDebugController.name);
  private readonly config: ConfigService;
  private readonly prisma: PrismaService;

  constructor(
    @Inject(ConfigService) config: ConfigService,
    @Inject(PrismaService) prisma: PrismaService,
  ) {
    this.config = config;
    this.prisma = prisma;
  }

  @Public()
  @Get('keycheck')
  keycheck(): KeyCheckResponse {
    const merchantCode = this.config.get<string>('REDSYS_MERCHANT_CODE') ?? '';
    const terminal = this.config.get<string>('REDSYS_TERMINAL') ?? '';
    const secretKey = this.config.get<string>('REDSYS_SECRET_KEY') ?? '';
    const apiUrl = this.config.get<string>('REDSYS_API_URL') ?? null;
    const nextPublicApiUrl = this.config.get<string>('NEXT_PUBLIC_API_URL') ?? null;
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
      hint,
    };
  }

  /**
   * Últimos 20 payments en BD (cualquier provider). Permite ver si tu 0,01€
   * está atascado en AUTHORIZING (= webhook no llegó) o en AUTHORIZED (=
   * webhook OK pero UI no refresca).
   */
  @Public()
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
  @Public()
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
}
