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
import { parseFormUrlEncoded, parseWebhookBody } from './header-utils';
import { MetricsService } from '../metrics/metrics.service';
import { BRAND_NAME } from '../../common/brand';

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
    // El cliente vuelve del banco en el idioma que eligió en la página de pago.
    const langQs = input.language === 'en' ? '&lang=en' : '';
    const urlOk = `${apiBase.replace(/\/+$/, '')}/pay/result?status=ok&op=${encodeURIComponent(dsOrder)}${langQs}`;
    const urlKo = `${apiBase.replace(/\/+$/, '')}/pay/result?status=ko&op=${encodeURIComponent(dsOrder)}${langQs}`;
    const merchantUrl = `${apiBase.replace(/\/+$/, '')}/v1/webhooks/redsys`;

    // Redsys exige TerminalID zero-padded a 3 dígitos ("001" no "1").
    // Si el usuario pone "1" en env, lo pad-eamos automáticamente.
    const terminal = creds.terminal.padStart(3, '0');

    // PRODUCTDESCRIPTION: solo alfanuméricos + espacios. Redsys SIS rechaza
    // caracteres especiales (acentos, símbolos) en este campo, lo que genera
    // SIS0042 (firma incorrecta) porque internamente normaliza distinto.
    const productDesc = `${BRAND_NAME} ${input.reference.slice(0, 8)}`
      .replace(/[^a-zA-Z0-9 ]/g, '')
      .slice(0, 125);

    // Wallets (Apple Pay + Google Pay) — solo se aplica si BBVA los tiene
    // activados en el TPV. Si no, Redsys responde SIS error.
    //   "xpay"  → solo Apple Pay / Google Pay (sin form tarjeta)
    //   "C"     → solo tarjeta
    //   (vacío) → Redsys enseña todo
    // Manda el botón que pulsó el cliente; sin él (cobros sin página de
    // pago), REDSYS_PAYMETHODS del entorno.
    // Nombre del comercio en la página de Redsys y en el justificante del
    // cliente. Sin la variable, Redsys usa el del contrato con BBVA. El del
    // EXTRACTO del banco no se cambia aquí: lo fija BBVA.
    const merchantName = (this.config.get<string>('REDSYS_MERCHANT_NAME') ?? '')
      .replace(/[^a-zA-Z0-9 ]/g, '')
      .trim()
      .slice(0, 25);

    const paymethods = input.payMethod
      ? REDSYS_PAYMETHOD[input.payMethod]
      : this.config.get<string>('REDSYS_PAYMETHODS');

    // Tokenización / Pago por Referencia (probe Etapa A): si env
    // REDSYS_REQUEST_TOKEN=true, le pedimos a Redsys que cree un token de
    // la tarjeta para usar en cobros recurrentes (PIN-flow). El primer
    // cobro funciona normal; en el callback Redsys nos devuelve
    // `Ds_Merchant_Identifier`. Si BBVA no tiene activado el servicio,
    // Redsys ignora el flag silenciosamente o responde SIS error.
    //
    // COF_INI=S + COF_TXNID son obligatorios para que el cobro quede como
    // "credentials on file initial" — necesario para que cobros MIT
    // recurrentes (COF_TYPE=Z) más adelante sean exentos de SCA por
    // transacción según PSD2.
    const requestToken =
      (this.config.get<string>('REDSYS_REQUEST_TOKEN') ?? '').toLowerCase() === 'true';

    // Doc Redsys "Pago por Referencia":
    //  - INI (primer cobro, crear token): mandar IDENTIFIER=REQUIRED +
    //    COF_INI=S + COF_TYPE (NO mandar COF_TXNID — eso es del MIT recurrente).
    //  - SUBSEQUENT (cobro al token): IDENTIFIER=<token> + COF_TYPE=Z +
    //    COF_TXNID=<id de la operación INI original>.
    // COF_TYPE valores:
    //   I = Installments (plazos fijos)
    //   R = Recurring (suscripción mensual fija)
    //   Z = Unscheduled credentials on file (cliente vuelve y comercio cobra)
    // Para nuestro caso (cliente vuelve al local, importe variable),
    // Z es el correcto. El SDK redsys-easy tiene tipado desactualizado que
    // no incluye Z — usamos un cast para forzar el valor estándar oficial.
    const baseParams = {
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
      ...(merchantName ? { DS_MERCHANT_MERCHANTNAME: merchantName } : {}),
      ...(paymethods ? { DS_MERCHANT_PAYMETHODS: paymethods } : {}),
      ...(input.language ? { DS_MERCHANT_CONSUMERLANGUAGE: REDSYS_LANGUAGE[input.language] } : {}),
    };
    const tokenParams = requestToken
      ? {
          DS_MERCHANT_IDENTIFIER: 'REQUIRED',
          DS_MERCHANT_COF_INI: 'S',
          DS_MERCHANT_COF_TYPE: 'Z',
        }
      : {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const form = api.createRedirectForm({ ...baseParams, ...tokenParams } as any);

    this.logger.log(
      `Redsys authorize: payment=${input.paymentId} dsOrder=${dsOrder} terminal=${terminal} amount=${input.amountCents}c paymethods=${paymethods ?? 'default'} requestToken=${requestToken} → form ${form.url}`,
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

      // Replay protection: si el webhook tiene Ds_Date + Ds_Hour, rechazamos
      // los que sean de hace más de 30 min. Si un atacante captura un webhook
      // legítimo y lo reenvía días después, este check lo bloquea aunque la
      // firma siga siendo válida.
      // Ventana 30 min: cubre delay de reintentos legítimos de Redsys + skew
      // de reloj. Demasiado corta = rechazaríamos webhooks lentos.
      const replayCheck = checkRedsysReplayWindow(
        (parsed.Ds_Date ?? '') as string,
        (parsed.Ds_Hour ?? '') as string,
        30 * 60 * 1000,
      );
      if (!replayCheck.ok) {
        this.logger.warn(
          `Redsys webhook fuera de ventana replay: ${replayCheck.reason} (Ds_Date=${parsed.Ds_Date ?? ''} Ds_Hour=${parsed.Ds_Hour ?? ''})`,
        );
        return { valid: false, reason: replayCheck.reason };
      }

      // externalEventId = pedido + Ds_Response: Redsys deja reintentar en su
      // página con el mismo pedido, así que un KO y el OK posterior son avisos
      // distintos y no deben deduplicarse entre sí. Reenvíos del mismo aviso
      // sí comparten id.
      const dsResponse = String(parsed.Ds_Response ?? '').trim();
      return {
        valid: true,
        externalEventId: `${parsed.Ds_Order}-${dsResponse}`,
        paymentRef: parsed.Ds_Order,
      };
    } catch (e) {
      this.logger.warn(`Redsys webhook signature invalid: ${(e as Error).message}`);
      return { valid: false, reason: 'signature-mismatch' };
    }
  }

  /**
   * Verifica la firma de un aviso Redsys (body ya parseado) y extrae lo que
   * NightPay guarda. null si falta algo o la firma no cuadra.
   */
  parseNotification(body: Record<string, unknown>): RedsysNotification | null {
    const sigVer = body.Ds_SignatureVersion;
    const params = body.Ds_MerchantParameters;
    const sig = body.Ds_Signature;
    if (typeof sigVer !== 'string' || typeof params !== 'string' || typeof sig !== 'string') {
      return null;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = this.getApi().processRestNotification({
        Ds_SignatureVersion: sigVer,
        Ds_MerchantParameters: params,
        Ds_Signature: sig,
      }) as unknown as Record<string, unknown>;
    } catch {
      return null;
    }
    const order = str(parsed.Ds_Order);
    if (!order) return null;

    const response = str(parsed.Ds_Response) ?? '';
    const transactionType = str(parsed.Ds_TransactionType) ?? '0';
    const responseNum = Number(response);
    // Ds_Response 0-99 = OK; >= 100 = denegación/error. Solo cuenta la
    // autorización (type 0): devoluciones/anulaciones del mismo pedido traen
    // 0900/0400, que están en el rango "OK" pero no son un cobro.
    const approved =
      response !== '' &&
      Number.isFinite(responseNum) &&
      responseNum >= 0 &&
      responseNum <= 99 &&
      transactionType === '0';
    const cardNumber = str(parsed.Ds_Card_Number);
    return {
      order,
      response,
      transactionType,
      approved,
      payMethodCode: str(parsed.Ds_ProcessedPayMethod),
      cardBrand: str(parsed.Ds_Card_Brand),
      cardType: str(parsed.Ds_Card_Type),
      cardCountry: str(parsed.Ds_Card_Country),
      cardLast4: cardNumber ? cardNumber.slice(-4) : null,
      authCode: str(parsed.Ds_AuthorisationCode),
      secure3ds: str(parsed.Ds_SecurePayment) === null ? null : str(parsed.Ds_SecurePayment) === '1',
    };
  }

  mapWebhookToFsmEvent(parsedPayload: unknown): WebhookFsmEvent | null {
    // Body tal cual lo mandó Redsys + `_paymentId`, que el controller añade
    // tras resolver Ds_Order (nuestro providerTxId) → payment UUID.
    const p = parsedPayload as Record<string, unknown>;
    const n = this.parseNotification(p);
    if (!n) return null;

    this.logger.log(
      `Redsys aviso: order=${n.order} response=${n.response} payMethod=${n.payMethodCode ?? '-'} cardBrand=${n.cardBrand ?? '-'}`,
    );
    if (n.response === '') return null;

    const paymentId = typeof p._paymentId === 'string' ? p._paymentId : '';
    if (!paymentId) {
      this.logger.warn(`Redsys aviso sin payment asociado (order=${n.order}) — ignorado`);
      return null;
    }
    if (n.approved) {
      return {
        paymentId,
        event: { type: 'AUTHORIZED', providerTxId: n.order, provider: 'REDSYS' },
      };
    }
    // Denegación: NO marcamos FAILED. FAILED es estado final y Redsys permite
    // reintentar; el intento queda DENIED (lo anota el controller) y el
    // cliente puede probar otra tarjeta con el mismo QR.
    return null;
  }

  /**
   * Extrae datos de tokenización del callback Redsys (si vino).
   * Cuando el authorize pidió `DS_MERCHANT_IDENTIFIER=REQUIRED`, Redsys
   * devuelve en el callback:
   *   Ds_Merchant_Identifier — el token reusable (string opaco)
   *   Ds_ExpiryDate          — caducidad tarjeta YYMM
   *   Ds_Card_Number         — PAN enmascarado tipo "454881******4444"
   *   Ds_Card_Brand          — "1" VISA, "2" MC, etc.
   *   Ds_Merchant_Cof_Txnid  — id de la txn original (para MIT recurrente)
   *
   * Si BBVA no tiene activado "Pago por Referencia", estos campos no
   * aparecen aunque el cobro normal sí funcione → devolvemos null.
   *
   * El caller (webhooks.controller) persistirá esto en payment.tokenizationData.
   */
  extractTokenizationData(rawBody: Buffer): TokenizationData | null {
    let parsedRaw: { Ds_MerchantParameters?: string; Ds_SignatureVersion?: string; Ds_Signature?: string };
    try {
      parsedRaw = parseWebhookBody(rawBody);
    } catch {
      return null;
    }
    if (!parsedRaw.Ds_MerchantParameters || !parsedRaw.Ds_SignatureVersion || !parsedRaw.Ds_Signature) {
      return null;
    }
    let parsed: Record<string, unknown>;
    try {
      const api = this.getApi();
      parsed = api.processRestNotification({
        Ds_SignatureVersion: parsedRaw.Ds_SignatureVersion,
        Ds_MerchantParameters: parsedRaw.Ds_MerchantParameters,
        Ds_Signature: parsedRaw.Ds_Signature,
      }) as unknown as Record<string, unknown>;
    } catch {
      return null;
    }

    const identifier =
      typeof parsed.Ds_Merchant_Identifier === 'string'
        ? parsed.Ds_Merchant_Identifier
        : null;
    if (!identifier) {
      // BBVA no devolvió token — no tiene Pago por Referencia activo, o el
      // authorize no pidió REQUIRED (en cuyo caso no estamos en flujo
      // tokenización).
      return null;
    }

    // Solo capturar tokenización para cobros AUTHORIZED. Si Redsys devolvió
    // un identifier pero la operación falló (caso improbable), no lo
    // persistimos como token utilizable.
    const dsResponse = String(parsed.Ds_Response ?? '').trim();
    const responseNum = Number(dsResponse);
    if (!Number.isFinite(responseNum) || responseNum < 0 || responseNum > 99) {
      return null;
    }

    const cardNumber = typeof parsed.Ds_Card_Number === 'string' ? parsed.Ds_Card_Number : '';
    const last4 = cardNumber.slice(-4);

    return {
      identifier,
      expiry: typeof parsed.Ds_ExpiryDate === 'string' ? parsed.Ds_ExpiryDate : '',
      cardLast4: last4,
      cardBrand: typeof parsed.Ds_Card_Brand === 'string' ? parsed.Ds_Card_Brand : '',
      cofTxnId:
        typeof parsed.Ds_Merchant_Cof_Txnid === 'string'
          ? parsed.Ds_Merchant_Cof_Txnid
          : (typeof parsed.Ds_Order === 'string' ? parsed.Ds_Order : ''),
      capturedAt: new Date().toISOString(),
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
   * (subdominio propio tipo `bbvaempresas.redsys.es`).
   *
   * IMPORTANTE: los REST endpoints (`restTrataPeticion`, `restIniciaPeticion`)
   * NO deben caer a sandbox si la URL principal es production-like. Eso
   * causaba que `doGetStatus` consultara sandbox aunque los pagos reales
   * fuesen en producción → siempre devolvía UNKNOWN → reconcile infinito.
   *
   * Heurística: si la URL principal NO contiene "sis-t" (sandbox marker),
   * asumimos producción.
   */
  private customUrls(): UrlsConfig {
    const baseUrl =
      this.config.get<string>('REDSYS_API_URL') ?? SANDBOX_URLS.redirect;
    const isSandbox = baseUrl.includes('sis-t.');
    const restSource = isSandbox ? SANDBOX_URLS : PRODUCTION_URLS;
    return {
      redirect: baseUrl,
      restIniciaPeticion: restSource.restIniciaPeticion,
      restTrataPeticion: restSource.restTrataPeticion,
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
 * Verifica que el timestamp del webhook Redsys (Ds_Date + Ds_Hour) caiga
 * dentro de una ventana razonable del momento actual. Sirve de defensa
 * contra replay attacks: si un atacante captura un webhook con firma
 * válida, no puede reenviarlo días después.
 *
 * Formato Redsys:
 *   Ds_Date  = "dd/MM/yyyy" (e.g. "28/05/2026") — Redsys lo URL-encodea.
 *   Ds_Hour  = "HH:mm"      (e.g. "10:25")
 *
 * Si faltan ambos (Redsys no siempre los manda), permitimos por compat —
 * la firma + idempotency vía webhookDelivery cubren el caso. Sólo si vienen
 * y son antiguos, rechazamos.
 *
 * `windowMs` = ventana permitida hacia el pasado. Hacia el futuro
 * permitimos hasta 5 min (skew de reloj).
 */
export function checkRedsysReplayWindow(
  dsDate: string,
  dsHour: string,
  windowMs: number,
  now: number = Date.now(),
): { ok: true } | { ok: false; reason: string } {
  if (!dsDate || !dsHour) {
    // Sin timestamp no podemos validar — confiamos en firma + idempotency
    return { ok: true };
  }
  // Redsys URL-encodea "/" → "%2F" en algunos casos
  const decodedDate = decodeURIComponent(dsDate);
  const decodedHour = decodeURIComponent(dsHour);
  const dateMatch = decodedDate.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  const hourMatch = decodedHour.match(/^(\d{2}):(\d{2})$/);
  if (!dateMatch || !hourMatch) {
    return { ok: false, reason: 'replay-timestamp-malformed' };
  }
  const [, d, m, y] = dateMatch;
  const [, hh, mm] = hourMatch;
  // Construimos Date en UTC asumiendo timezone del comercio (Europe/Madrid).
  // Sin tzdata fiable usamos UTC con offset +1/+2 implícito. Para una ventana
  // de 30 min el skew de DST (±1h) es irrelevante mientras la ventana sea >1h
  // — con 30 min podríamos rechazar webhooks legítimos en cambio DST.
  // Ampliamos: si el delta absoluto cabe en windowMs + 2h, lo aceptamos.
  const ts = Date.UTC(
    Number(y),
    Number(m) - 1,
    Number(d),
    Number(hh),
    Number(mm),
  );
  if (!Number.isFinite(ts)) {
    return { ok: false, reason: 'replay-timestamp-invalid' };
  }
  const delta = now - ts;
  const dstSkewMs = 2 * 60 * 60 * 1000; // 2h cubre cualquier DST/zona ES
  const futureToleranceMs = 5 * 60 * 1000 + dstSkewMs;
  if (delta < -futureToleranceMs) {
    return { ok: false, reason: 'replay-timestamp-future' };
  }
  if (delta > windowMs + dstSkewMs) {
    return { ok: false, reason: 'replay-timestamp-too-old' };
  }
  return { ok: true };
}

/**
 * Datos de tokenización capturados del callback Redsys cuando el authorize
 * pidió `DS_MERCHANT_IDENTIFIER=REQUIRED` y BBVA tiene el servicio activo.
 * Se persiste en payment.tokenizationData para reuso en cobros recurrentes MIT.
 */
/** Lo que NightPay extrae de un aviso Redsys verificado. */
/** DS_MERCHANT_PAYMETHODS según el botón que pulsa el cliente. */
const REDSYS_PAYMETHOD: Record<'wallet' | 'card', string> = { wallet: 'xpay', card: 'C' };

/** DS_MERCHANT_CONSUMERLANGUAGE: 001 castellano, 002 inglés. */
const REDSYS_LANGUAGE: Record<'es' | 'en', string> = { es: '001', en: '002' };

export interface RedsysNotification {
  order: string;
  response: string;
  transactionType: string;
  /** Ds_Response 0-99 y TransactionType 0 (autorización). */
  approved: boolean;
  payMethodCode: string | null;
  cardBrand: string | null;
  cardType: string | null;
  cardCountry: string | null;
  cardLast4: string | null;
  authCode: string | null;
  secure3ds: boolean | null;
}

function str(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

export interface TokenizationData {
  identifier: string; // token reusable (sin PAN)
  expiry: string; // YYMM
  cardLast4: string;
  cardBrand: string;
  cofTxnId: string; // id original (para DS_MERCHANT_COF_TXNID en MIT)
  capturedAt: string; // ISO
}

// Re-export: el parser vive en header-utils (compartido con el processor).
export { parseFormUrlEncoded };
