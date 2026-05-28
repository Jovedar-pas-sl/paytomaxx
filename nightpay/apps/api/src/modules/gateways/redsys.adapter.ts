import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type CircuitBreaker from 'opossum';
import {
  createRedsysAPI,
  SANDBOX_URLS,
  PRODUCTION_URLS,
  type RedsysAPI,
  type UrlsConfig,
  randomTransactionId,
} from 'redsys-easy';
import type {
  AuthorizeInput,
  AuthorizeResult,
  GatewayStatus,
  RefundInput,
  RefundResult,
  WebhookVerifyResult,
} from '@nightpay/contracts';
import type { GatewayAdapter, WebhookFsmEvent } from './gateway.adapter';
import { createBreaker, timedFire } from './circuit-breaker';
import { MetricsService } from '../metrics/metrics.service';

const PROVIDER_LABEL = 'REDSYS' as const;
function stateToNumber(s: 'closed' | 'halfOpen' | 'open'): number {
  return s === 'closed' ? 0 : s === 'halfOpen' ? 1 : 2;
}

/**
 * Adapter para Redsys SIS — el protocolo estándar de pasarelas bancarias
 * españolas (BBVA, Santander, CaixaBank, Sabadell, etc.).
 *
 * Implementación basada en `redsys-easy` (npm) — el SDK comunitario más
 * usado, battle-tested por cientos de comercios. Hace el HMAC-SHA256-3DES
 * de Redsys correctamente con todos los edge cases (zero padding, base64
 * url-safe en webhooks, etc.).
 *
 * Flow:
 *  1. authorize() NO hace HTTP. Genera el form firmado con
 *     `createRedirectForm()` que el navegador del cliente POSTea a la URL
 *     hosted de Redsys/banco.
 *  2. NightPay devuelve `checkoutForm: { action, fields }` con los 3
 *     campos estándar: `Ds_SignatureVersion`, `Ds_MerchantParameters`,
 *     `Ds_Signature`.
 *  3. Cliente paga en la página hosted del banco.
 *  4. Redsys → POST a `Ds_Merchant_MerchantURL` (nuestro /v1/webhooks/redsys)
 *     con el mismo shape (3 campos).
 *  5. NightPay responde `200 OK` JSON (Redsys no exige formato específico).
 *
 * Endpoints (configurable via env):
 *  - Sandbox: https://sis-t.redsys.es:25443/sis/realizarPago
 *  - Prod:    https://sis.redsys.es/sis/realizarPago
 *
 * Restricciones críticas:
 *  - `Ds_Merchant_Order` debe ser 4-12 chars, los 4 primeros NUMÉRICOS,
 *    restantes alfanuméricos. Usamos `randomTransactionId()` de redsys-easy
 *    que cumple este formato.
 */
@Injectable()
export class RedsysAdapter implements GatewayAdapter {
  readonly provider = 'REDSYS' as const;
  private readonly logger = new Logger(RedsysAdapter.name);

  private readonly config: ConfigService;
  private readonly metrics: MetricsService;
  private readonly authorizeBreaker: CircuitBreaker<[AuthorizeInput], AuthorizeResult>;
  private readonly statusBreaker: CircuitBreaker<[string, string], GatewayStatus>;
  private readonly refundBreaker: CircuitBreaker<[RefundInput], RefundResult>;
  private readonly timeoutMs: number;
  // API instance cacheado — se construye lazy en el primer authorize porque
  // el secret se lee de env vars y puede no estar al boot.
  private cachedApi: RedsysAPI | null = null;

  constructor(
    @Inject(ConfigService) config: ConfigService,
    @Inject(MetricsService) metrics: MetricsService,
  ) {
    this.config = config;
    this.metrics = metrics;
    this.timeoutMs = config.get<number>('GATEWAY_TIMEOUT_MS') ?? 5000;

    this.authorizeBreaker = createBreaker((input: AuthorizeInput) => this.doAuthorize(input), {
      name: 'redsys.authorize',
      timeoutMs: this.timeoutMs,
      onStateChange: (s) =>
        this.metrics.circuitState.set({ provider: PROVIDER_LABEL, op: 'authorize' }, stateToNumber(s)),
    });
    this.statusBreaker = createBreaker(
      (tenantId: string, providerTxId: string) => this.doGetStatus(tenantId, providerTxId),
      {
        name: 'redsys.getStatus',
        timeoutMs: this.timeoutMs,
        onStateChange: (s) =>
          this.metrics.circuitState.set({ provider: PROVIDER_LABEL, op: 'getStatus' }, stateToNumber(s)),
      },
    );
    this.refundBreaker = createBreaker((input: RefundInput) => this.doRefund(input), {
      name: 'redsys.refund',
      timeoutMs: this.timeoutMs,
      onStateChange: (s) =>
        this.metrics.circuitState.set({ provider: PROVIDER_LABEL, op: 'refund' }, stateToNumber(s)),
    });
  }

  async authorize(input: AuthorizeInput): Promise<AuthorizeResult> {
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

  // ─── implementaciones tras el circuit breaker ─────────────────────

  // eslint-disable-next-line @typescript-eslint/require-await
  private async doAuthorize(input: AuthorizeInput): Promise<AuthorizeResult> {
    const creds = this.requireCreds();
    const api = this.getApi();
    const dsOrder = randomTransactionId();

    const apiBase = this.config.get<string>('NEXT_PUBLIC_API_URL') ?? 'http://localhost:4100';
    const urlOk = `${apiBase.replace(/\/+$/, '')}/pay/result?status=ok&op=${encodeURIComponent(dsOrder)}`;
    const urlKo = `${apiBase.replace(/\/+$/, '')}/pay/result?status=ko&op=${encodeURIComponent(dsOrder)}`;
    const merchantUrl = `${apiBase.replace(/\/+$/, '')}/v1/webhooks/redsys`;

    // Redsys exige TerminalID zero-padded a 3 dígitos ("001" no "1").
    // Si el usuario pone "1" en env, lo pad-eamos automáticamente.
    const terminal = creds.terminal.padStart(3, '0');

    // PRODUCTDESCRIPTION: solo alfanuméricos + espacios. Redsys SIS rechaza
    // caracteres especiales (acentos, símbolos) en este campo, lo que genera
    // SIS0042 (firma incorrecta) porque internamente normaliza distinto.
    const productDesc = `NightPay ${input.reference.slice(0, 8)}`
      .replace(/[^a-zA-Z0-9 ]/g, '')
      .slice(0, 125);

    const form = api.createRedirectForm({
      DS_MERCHANT_AMOUNT: String(input.amountCents),
      DS_MERCHANT_ORDER: dsOrder,
      DS_MERCHANT_MERCHANTCODE: creds.merchantCode,
      DS_MERCHANT_CURRENCY: currencyToRedsysCode(input.currency),
      DS_MERCHANT_TRANSACTIONTYPE: '0', // 0 = autorización
      DS_MERCHANT_TERMINAL: terminal,
      DS_MERCHANT_MERCHANTURL: merchantUrl,
      DS_MERCHANT_URLOK: urlOk,
      DS_MERCHANT_URLKO: urlKo,
      DS_MERCHANT_PRODUCTDESCRIPTION: productDesc,
    });

    this.logger.log(
      `Redsys authorize: payment=${input.paymentId} dsOrder=${dsOrder} terminal=${terminal} amount=${input.amountCents}c → form ${form.url}`,
    );

    return {
      provider: 'REDSYS',
      providerTxId: dsOrder,
      status: 'PROCESSING',
      checkoutForm: {
        action: form.url,
        method: 'POST',
        fields: form.body as unknown as Record<string, string>,
      },
    };
  }

  /**
   * Consulta el estado real de una operación en Redsys vía REST trataPeticion
   * con TransactionType=44 (consulta).
   *
   * Returns:
   *  - 'AUTHORIZED' si Ds_Response 0000-0099
   *  - 'FAILED' si Ds_Response >= 100 (denegación/error)
   *  - 'UNKNOWN' en cualquier otro caso (sin respuesta, red caída, etc.)
   *    → el caller (orphan-reconcile) reintentará más tarde.
   */
  private async doGetStatus(
    _tenantId: string,
    providerTxId: string,
  ): Promise<GatewayStatus> {
    try {
      const creds = this.requireCreds();
      const api = this.getApi();
      const terminal = creds.terminal.padStart(3, '0');

      const result = await api.restTrataPeticion({
        DS_MERCHANT_AMOUNT: '1',
        DS_MERCHANT_ORDER: providerTxId,
        DS_MERCHANT_MERCHANTCODE: creds.merchantCode,
        DS_MERCHANT_CURRENCY: '978',
        DS_MERCHANT_TRANSACTIONTYPE: '44',
        DS_MERCHANT_TERMINAL: terminal,
      });

      const dsResponse = (result.Ds_Response ?? '').toString().trim();
      this.logger.log(
        `Redsys consult ${providerTxId} → Ds_Response=${dsResponse || '<empty>'}`,
      );

      if (dsResponse === '') return 'UNKNOWN';
      const responseNum = Number(dsResponse);
      if (!Number.isFinite(responseNum)) return 'UNKNOWN';
      if (responseNum >= 0 && responseNum <= 99) return 'AUTHORIZED';
      return 'FAILED';
    } catch (err) {
      this.logger.warn(
        `Redsys consult failed for ${providerTxId}: ${(err as Error).message}`,
      );
      return 'UNKNOWN';
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  private async doRefund(_input: RefundInput): Promise<RefundResult> {
    throw new Error(
      'Redsys refund vía API no implementado. Refundea manualmente desde el panel del banco.',
    );
  }

  /**
   * Valida el callback de Redsys.
   * Body: form-urlencoded con 3 campos:
   *   Ds_SignatureVersion=HMAC_SHA256_V1
   *   Ds_MerchantParameters=<base64 JSON>
   *   Ds_Signature=<base64 HMAC>
   */
  verifyWebhook(
    _headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
  ): WebhookVerifyResult {
    let body: Record<string, string>;
    try {
      const text = rawBody.toString('utf8');
      if (text.startsWith('{')) {
        body = JSON.parse(text) as Record<string, string>;
      } else {
        body = parseFormUrlEncoded(text);
      }
    } catch {
      return { valid: false, reason: 'cannot-parse-body' };
    }

    const dsSigVer = body.Ds_SignatureVersion ?? body.ds_signatureversion;
    const dsParams = body.Ds_MerchantParameters ?? body.ds_merchantparameters;
    const dsSig = body.Ds_Signature ?? body.ds_signature;
    if (!dsSigVer || !dsParams || !dsSig) {
      return { valid: false, reason: 'missing-required-fields' };
    }

    let creds;
    try {
      creds = this.requireCreds();
    } catch (e) {
      this.logger.error(`Redsys webhook recibido sin creds: ${(e as Error).message}`);
      return { valid: false, reason: 'creds-not-configured' };
    }

    try {
      const api = this.getApi();
      // processRestNotification valida la firma + decodifica los params.
      // Si la firma es incorrecta, throw → caemos al catch.
      const parsed = api.processRestNotification({
        Ds_SignatureVersion: dsSigVer,
        Ds_MerchantParameters: dsParams,
        Ds_Signature: dsSig,
      });

      // Defensa: el MerchantCode del callback debe coincidir con el nuestro.
      if (parsed.Ds_MerchantCode && parsed.Ds_MerchantCode !== creds.merchantCode) {
        return { valid: false, reason: 'merchant-code-mismatch' };
      }

      if (!parsed.Ds_Order) {
        return { valid: false, reason: 'missing-ds-order' };
      }

      return {
        valid: true,
        externalEventId: parsed.Ds_Order,
        paymentRef: parsed.Ds_Order,
      };
    } catch (e) {
      this.logger.warn(`Redsys webhook signature invalid: ${(e as Error).message}`);
      return { valid: false, reason: 'signature-mismatch' };
    }
  }

  mapWebhookToFsmEvent(parsedPayload: unknown): WebhookFsmEvent | null {
    // El controller pasa el body raw del webhook. Lo re-procesamos.
    const p = parsedPayload as {
      Ds_MerchantParameters?: string;
      Ds_SignatureVersion?: string;
      Ds_Signature?: string;
    };
    if (!p.Ds_MerchantParameters || !p.Ds_SignatureVersion || !p.Ds_Signature) {
      return null;
    }

    let parsed;
    try {
      const api = this.getApi();
      parsed = api.processRestNotification({
        Ds_SignatureVersion: p.Ds_SignatureVersion,
        Ds_MerchantParameters: p.Ds_MerchantParameters,
        Ds_Signature: p.Ds_Signature,
      });
    } catch {
      return null;
    }

    if (!parsed.Ds_Order) return null;

    // Ds_Response 0-99 = OK; >= 100 = denegación/error.
    const dsResponse = (parsed.Ds_Response ?? '').toString().trim();
    if (dsResponse === '') return null;

    const responseNum = Number(dsResponse);
    if (Number.isFinite(responseNum) && responseNum >= 0 && responseNum <= 99) {
      return {
        paymentId: parsed.Ds_Order,
        event: { type: 'AUTHORIZED', providerTxId: parsed.Ds_Order, provider: 'REDSYS' },
      };
    }
    return {
      paymentId: parsed.Ds_Order,
      event: { type: 'FAILED', reason: `redsys-response-${dsResponse}` },
    };
  }

  // ─── helpers ─────────────────────────────────────────────────────

  /**
   * Lazy-construye el cliente redsys-easy con las URLs adecuadas (sandbox
   * o prod) según env. El secret y URLs se leen en el primer uso.
   */
  private getApi(): RedsysAPI {
    if (this.cachedApi) return this.cachedApi;
    const creds = this.requireCreds();
    const urls = this.config.get<string>('REDSYS_API_URL')?.includes('sis-t.redsys.es')
      ? SANDBOX_URLS
      : this.config.get<string>('REDSYS_API_URL')?.includes('sis.redsys.es')
        ? PRODUCTION_URLS
        : this.customUrls();
    this.cachedApi = createRedsysAPI({ secretKey: creds.secretKey, urls });
    return this.cachedApi;
  }

  /**
   * URLs custom si el banco usa un endpoint distinto al estándar Redsys
   * (algunos bancos ofrecen subdominio propio tipo `bbvaempresas.redsys.es`).
   * Por defecto cae en sandbox.
   */
  private customUrls(): UrlsConfig {
    const baseUrl =
      this.config.get<string>('REDSYS_API_URL') ?? SANDBOX_URLS.redirect;
    return {
      redirect: baseUrl,
      // REST endpoints — no los usamos pero deben ser válidos para el
      // constructor de redsys-easy. Apuntamos a sandbox por defecto.
      restIniciaPeticion: SANDBOX_URLS.restIniciaPeticion,
      restTrataPeticion: SANDBOX_URLS.restTrataPeticion,
    };
  }

  private requireCreds(): {
    merchantCode: string;
    terminal: string;
    secretKey: string;
  } {
    const merchantCode = this.config.get<string>('REDSYS_MERCHANT_CODE');
    const terminal = this.config.get<string>('REDSYS_TERMINAL');
    const secretKey = this.config.get<string>('REDSYS_SECRET_KEY');
    if (!merchantCode || !terminal || !secretKey) {
      throw new Error(
        'Redsys credentials no configuradas. Define REDSYS_MERCHANT_CODE, REDSYS_TERMINAL y REDSYS_SECRET_KEY en env vars.',
      );
    }
    return { merchantCode, terminal, secretKey };
  }
}

// ─── funciones puras (testeables sin Nest/DI) ───────────────────────

/**
 * ISO-4217 → código numérico Redsys (igual que el estándar).
 */
export function currencyToRedsysCode(
  currency: string,
): '978' | '840' | '826' | '392' {
  const map: Record<string, '978' | '840' | '826' | '392'> = {
    EUR: '978',
    USD: '840',
    GBP: '826',
    JPY: '392',
  };
  return map[currency.toUpperCase()] ?? '978';
}

/**
 * Parser mínimo de form-urlencoded → Record<string,string>.
 */
export function parseFormUrlEncoded(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of text.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq < 0) {
      out[decodeURIComponent(pair)] = '';
    } else {
      out[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(
        pair.slice(eq + 1).replace(/\+/g, ' '),
      );
    }
  }
  return out;
}
