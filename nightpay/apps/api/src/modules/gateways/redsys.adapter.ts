import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createHmac, timingSafeEqual } from 'node:crypto';
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
import type { ApprovalClaim, ApprovalProof, GatewayAdapter, WebhookFsmEvent } from './gateway.adapter';
import { createBreaker, timedFire } from './circuit-breaker';
import { parseFormUrlEncoded, parseWebhookBody } from './header-utils';
import { MetricsService } from '../metrics/metrics.service';
import { BRAND_NAME } from '../../common/brand';

const PROVIDER_LABEL = 'REDSYS' as const;
/** El aviso de que la consulta de Redsys no está disponible, como mucho una vez por hora. */
const QUERY_UNAVAILABLE_LOG_EVERY_MS = 60 * 60 * 1000;
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
  /** Último aviso de «consulta no disponible» (uno por hora como mucho). */
  private queryUnavailableLoggedAt = Number.NEGATIVE_INFINITY;

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

  private async doAuthorize(input: AuthorizeInput): Promise<AuthorizeResult> {
    const creds = this.requireCreds();
    const api = this.getApi();
    const dsOrder = randomTransactionId();

    const apiBase = this.config.get<string>('NEXT_PUBLIC_API_URL') ?? 'http://localhost:4100';
    // El cliente vuelve del banco en el idioma que eligió en la página de pago.
    const langQs = input.language && input.language !== 'es' ? `&lang=${input.language}` : '';
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
   * Consulta del estado de una operación en Redsys: HOY NO DISPONIBLE.
   *
   * Antes se mandaba `trataPeticion` con DS_MERCHANT_TRANSACTIONTYPE=44, pero
   * en Redsys el 44 es «Borrar Referencia» (redsys-easy lo llama
   * DELETE_REFERENCE), no una consulta: el banco contestaba SIS0105 y nunca
   * sirvió. La consulta de verdad es otro servicio (SOAP SerClsWSConsulta),
   * pendiente de que BBVA lo active.
   *
   * Mientras, no se llama al banco y se devuelve 'UNKNOWN': la conciliación
   * lo trata como «no se sabe» (reintenta y, agotada, deja el cobro ORPHAN
   * para resolverlo a mano), igual que con el SIS0105 de antes. Nunca da un
   * cobro por pagado ni por fallido.
   */
  private async doGetStatus(_tenantId: string, _providerTxId: string): Promise<GatewayStatus> {
    const now = Date.now();
    if (now - this.queryUnavailableLoggedAt >= QUERY_UNAVAILABLE_LOG_EVERY_MS) {
      this.queryUnavailableLoggedAt = now;
      this.logger.warn(
        'consulta de Redsys no disponible: falta el servicio de consulta de operaciones (pendiente de BBVA). Los cobros sin aviso quedan «sin confirmar».',
      );
    }
    return 'UNKNOWN';
  }

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
      // Firma comprobada en tiempo constante y después decodificada.
      const parsed = this.decodeSigned({
        Ds_SignatureVersion: dsSigVer,
        Ds_MerchantParameters: dsParams,
        Ds_Signature: dsSig,
      });
      if (!parsed) return { valid: false, reason: 'signature-mismatch' };

      // Defensa: el MerchantCode del callback debe coincidir con el nuestro.
      const merchantCode = str(parsed.Ds_MerchantCode);
      if (merchantCode && merchantCode !== creds.merchantCode) {
        return { valid: false, reason: 'merchant-code-mismatch' };
      }

      const order = str(parsed.Ds_Order);
      if (!order) {
        return { valid: false, reason: 'missing-ds-order' };
      }

      // Replay protection: si el webhook tiene Ds_Date + Ds_Hour, rechazamos
      // los que sean de hace más de 30 min. Si un atacante captura un webhook
      // legítimo y lo reenvía días después, este check lo bloquea aunque la
      // firma siga siendo válida.
      // Ventana 30 min: cubre delay de reintentos legítimos de Redsys + skew
      // de reloj. Demasiado corta = rechazaríamos webhooks lentos.
      const dsDate = str(parsed.Ds_Date) ?? '';
      const dsHour = str(parsed.Ds_Hour) ?? '';
      const replayCheck = checkRedsysReplayWindow(dsDate, dsHour, 30 * 60 * 1000);
      if (!replayCheck.ok) {
        this.logger.warn(
          `Redsys webhook fuera de ventana replay: ${replayCheck.reason} (Ds_Date=${dsDate} Ds_Hour=${dsHour})`,
        );
        return { valid: false, reason: replayCheck.reason };
      }

      // externalEventId = pedido + Ds_Response: Redsys deja reintentar en su
      // página con el mismo pedido, así que un KO y el OK posterior son avisos
      // distintos y no deben deduplicarse entre sí. Reenvíos del mismo aviso
      // sí comparten id.
      const dsResponse = str(parsed.Ds_Response) ?? '';
      return {
        valid: true,
        externalEventId: `${order}-${dsResponse}`,
        paymentRef: order,
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
    let parsed: Record<string, unknown> | null;
    try {
      parsed = this.decodeSigned({
        Ds_SignatureVersion: sigVer,
        Ds_MerchantParameters: params,
        Ds_Signature: sig,
      });
    } catch {
      return null;
    }
    if (!parsed) return null;
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
    const amount = str(parsed.Ds_Amount);
    return {
      order,
      response,
      transactionType,
      approved,
      // Importe y moneda van dentro de la firma: son lo que cobró el banco.
      amountCents: amount !== null && /^\d+$/.test(amount) ? Number(amount) : null,
      currency: redsysCodeToCurrency(str(parsed.Ds_Currency)),
      payMethodCode: str(parsed.Ds_ProcessedPayMethod),
      cardBrand: str(parsed.Ds_Card_Brand),
      cardType: str(parsed.Ds_Card_Type),
      cardCountry: str(parsed.Ds_Card_Country),
      cardLast4: cardNumber ? cardNumber.slice(-4) : null,
      authCode: str(parsed.Ds_AuthorisationCode),
      secure3ds: str(parsed.Ds_SecurePayment) === null ? null : str(parsed.Ds_SecurePayment) === '1',
    };
  }

  /**
   * Prueba de la aprobación: el propio aviso, firmado por el banco con la
   * clave del comercio (se vuelve a comprobar la firma aquí). Importe y moneda
   * salen de la parte firmada; Ds_Order tiene que ser el pedido del aviso.
   */
  proveApproval(claim: ApprovalClaim): Promise<ApprovalProof> {
    const n = this.parseNotification(claim.payload);
    if (!n) return Promise.resolve({ kind: 'rejected', reason: 'aviso-sin-firma-valida' });
    if (n.order !== claim.providerTxId) {
      return Promise.resolve({ kind: 'rejected', reason: 'pedido-distinto' });
    }
    if (!n.approved) return Promise.resolve({ kind: 'rejected', reason: 'no-aprobado' });
    if (n.amountCents === null) return Promise.resolve({ kind: 'rejected', reason: 'aviso-sin-importe' });
    return Promise.resolve({ kind: 'confirmed', amountCents: n.amountCents, currency: n.currency });
  }

  mapWebhookToFsmEvent(parsedPayload: unknown): WebhookFsmEvent | null {
    // Body tal cual lo mandó Redsys + `_paymentId` (Ds_Order ya resuelto al
    // cobro), que el controller añade al encontrar el cobro; sin él (no lo
    // encontró al llegar), el processor busca el cobro por el pedido (Ds_Order,
    // nuestro providerTxId).
    const p = parsedPayload as Record<string, unknown>;
    const n = this.parseNotification(p);
    if (!n) return null;

    this.logger.log(
      `Redsys aviso: order=${n.order} response=${n.response} payMethod=${n.payMethodCode ?? '-'} cardBrand=${n.cardBrand ?? '-'}`,
    );
    if (n.response === '') return null;

    if (n.approved) {
      return {
        paymentId: typeof p._paymentId === 'string' ? p._paymentId : '',
        event: { type: 'AUTHORIZED', providerTxId: n.order, provider: 'REDSYS' },
        card: {
          payMethodCode: n.payMethodCode,
          cardBrand: n.cardBrand,
          cardType: n.cardType,
          cardCountry: n.cardCountry,
          cardLast4: n.cardLast4,
          authCode: n.authCode,
          secure3ds: n.secure3ds,
        },
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
    let parsed: Record<string, unknown> | null;
    try {
      parsed = this.decodeSigned({
        Ds_SignatureVersion: parsedRaw.Ds_SignatureVersion,
        Ds_MerchantParameters: parsedRaw.Ds_MerchantParameters,
        Ds_Signature: parsedRaw.Ds_Signature,
      });
    } catch {
      return null;
    }
    if (!parsed) return null;

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
   * Comprueba la firma de un aviso en tiempo constante y, si vale, lo
   * decodifica con redsys-easy (que la vuelve a comparar, pero ya solo con
   * firmas buenas: su comparación no es de tiempo constante). null = firma
   * mala. Lanza si faltan las credenciales.
   */
  private decodeSigned(fields: {
    Ds_SignatureVersion: string;
    Ds_MerchantParameters: string;
    Ds_Signature: string;
  }): Record<string, unknown> | null {
    if (fields.Ds_SignatureVersion !== 'HMAC_SHA256_V1') return null;
    const { secretKey } = this.requireCreds();
    if (!redsysSignatureMatches(secretKey, fields.Ds_MerchantParameters, fields.Ds_Signature)) {
      return null;
    }
    return this.getApi().processRestNotification(fields) as unknown as Record<string, unknown>;
  }

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
 * Código numérico de Redsys (Ds_Currency) → ISO-4217. Un código que no
 * conocemos se devuelve tal cual: no coincidirá con la moneda del cobro y el
 * aviso no se dará por bueno. null si el aviso no trae moneda.
 */
export function redsysCodeToCurrency(code: string | null): string | null {
  if (code === null) return null;
  const map: Record<string, string> = { '978': 'EUR', '840': 'USD', '826': 'GBP', '392': 'JPY' };
  return map[code] ?? code;
}

/**
 * Firma HMAC_SHA256_V1 de Redsys comprobada en tiempo constante (la de
 * redsys-easy compara con Buffer.equals). Clave = 3DES(clave del comercio,
 * Ds_Order); firma = HMAC-SHA256(Ds_MerchantParameters tal cual llega).
 * Acepta la firma en base64 o base64url (Redsys usa la segunda).
 */
export function redsysSignatureMatches(
  secretKey: string,
  merchantParams: string,
  signature: string,
): boolean {
  let order: unknown;
  try {
    const params = JSON.parse(Buffer.from(merchantParams, 'base64').toString('utf8')) as Record<string, unknown>;
    order = params.Ds_Order ?? params.DS_ORDER;
  } catch {
    return false;
  }
  if (typeof order !== 'string' || order === '') return false;
  let expected: Buffer;
  try {
    expected = Buffer.from(redsysSign(secretKey, order, merchantParams), 'base64');
  } catch {
    return false; // clave del comercio mal formada
  }
  const received = Buffer.from(signature, 'base64');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/** HMAC_SHA256_V1: lo mismo que hace redsys-easy (y el SDK oficial). */
function redsysSign(secretKey: string, order: string, payload: string): string {
  const message = Buffer.from(order, 'utf8');
  const padded = Buffer.concat([message, Buffer.alloc((8 - (message.length % 8)) % 8, 0)]);
  const cipher = createCipheriv('des-ede3-cbc', Buffer.from(secretKey, 'base64'), Buffer.alloc(8, 0));
  cipher.setAutoPadding(false);
  const orderKey = Buffer.concat([cipher.update(padded), cipher.final()]).subarray(
    0,
    Math.ceil(message.length / 8) * 8,
  );
  return createHmac('sha256', orderKey).update(payload).digest('base64');
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
/** Ds_Merchant_ConsumerLanguage de Redsys: 001 castellano, 002 inglés, 004 francés, 009 portugués. */
const REDSYS_LANGUAGE: Record<'es' | 'en' | 'fr' | 'pt', string> = { es: '001', en: '002', fr: '004', pt: '009' };

export interface RedsysNotification {
  order: string;
  response: string;
  transactionType: string;
  /** Ds_Response 0-99 y TransactionType 0 (autorización). */
  approved: boolean;
  /** Ds_Amount (céntimos en EUR). null si el aviso no lo trae o no es un número. */
  amountCents: number | null;
  /** Ds_Currency en ISO-4217 (ver redsysCodeToCurrency). */
  currency: string | null;
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
