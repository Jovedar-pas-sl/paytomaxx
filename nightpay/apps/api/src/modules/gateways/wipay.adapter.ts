import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
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
import { createBreaker, timedFire } from './circuit-breaker';
import { MetricsService } from '../metrics/metrics.service';

const PROVIDER_LABEL = 'WIPAY' as const;
function stateToNumber(s: 'closed' | 'halfOpen' | 'open'): number {
  return s === 'closed' ? 0 : s === 'halfOpen' ? 1 : 2;
}

/**
 * Forma esperada del POST de comunicación on-line de Cecabank.
 * Body llega form-urlencoded → Fastify lo parsea a Record<string,string>.
 * Ver "Manual TPV completo 8.25" sección 6 "Comunicación on-line".
 */
interface CecabankWebhook {
  MerchantID?: string;
  AcquirerBIN?: string;
  TerminalID?: string;
  Num_operacion?: string;
  Importe?: string;
  TipoMoneda?: string;
  Exponente?: string;
  Referencia?: string;
  Firma?: string;
  Codigo_pedido?: string;
  Codigo_cliente?: string;
  Codigo_comercio?: string;
  Num_aut?: string;
  BIN?: string;
  BIN8?: string;
  FinalPAN?: string;
  Cambio_moneda?: string;
  Idioma?: string;
  Pais?: string;
  Tipo_tarjeta?: string;
  Tipo_operacion?: string;
  Descripcion?: string;
  // En errores de pago Cecabank envía COD_AUT con código (190, 400, etc.)
  COD_AUT?: string;
}

/**
 * Adapter para el TPV Virtual de Cecabank (comercialmente Wipay = Global
 * Payment Systems sobre infraestructura Cecabank).
 *
 * Flujo:
 *  1. authorize() NO hace HTTP — solo genera el formulario firmado SHA-256
 *     que el navegador del cliente debe POSTear a la URL hosted de Cecabank.
 *  2. NightPay devuelve `checkoutForm: {action, fields}` en AuthorizeResult.
 *  3. El controller `/pay/:token` renderiza HTML con form auto-submit.
 *  4. Cliente paga en la página de Cecabank.
 *  5. Cecabank → POST webhook a `/v1/webhooks/wipay` con form-urlencoded.
 *  6. verifyWebhook() valida firma SHA-256 + idempotency por Num_operacion.
 *  7. NightPay responde texto plano `$*$OKY$*$` en <30s.
 *
 * Doc: Manual TPV Virtual 8.25 + Consulta estado 4.0 (Cecabank).
 */
@Injectable()
export class WipayAdapter implements GatewayAdapter {
  readonly provider = 'WIPAY' as const;
  private readonly logger = new Logger(WipayAdapter.name);

  private readonly config: ConfigService;
  private readonly metrics: MetricsService;
  private readonly authorizeBreaker: CircuitBreaker<[AuthorizeInput], AuthorizeResult>;
  private readonly statusBreaker: CircuitBreaker<[string, string], GatewayStatus>;
  private readonly refundBreaker: CircuitBreaker<[RefundInput], RefundResult>;
  private readonly timeoutMs: number;

  constructor(
    @Inject(ConfigService) config: ConfigService,
    @Inject(MetricsService) metrics: MetricsService,
  ) {
    this.config = config;
    this.metrics = metrics;
    this.timeoutMs = config.get<number>('GATEWAY_TIMEOUT_MS') ?? 5000;

    this.authorizeBreaker = createBreaker((input: AuthorizeInput) => this.doAuthorize(input), {
      name: 'wipay.authorize',
      timeoutMs: this.timeoutMs,
      onStateChange: (s) =>
        this.metrics.circuitState.set({ provider: PROVIDER_LABEL, op: 'authorize' }, stateToNumber(s)),
    });
    this.statusBreaker = createBreaker(
      (tenantId: string, providerTxId: string) => this.doGetStatus(tenantId, providerTxId),
      {
        name: 'wipay.getStatus',
        timeoutMs: this.timeoutMs,
        onStateChange: (s) =>
          this.metrics.circuitState.set({ provider: PROVIDER_LABEL, op: 'getStatus' }, stateToNumber(s)),
      },
    );
    this.refundBreaker = createBreaker((input: RefundInput) => this.doRefund(input), {
      name: 'wipay.refund',
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

  /**
   * authorize() en Cecabank no hace HTTP — genera los campos firmados
   * del formulario que el navegador del cliente debe enviar por POST.
   */
  private async doAuthorize(input: AuthorizeInput): Promise<AuthorizeResult> {
    const creds = this.requireCreds();
    const numOp = numOperacionFromPaymentId(input.paymentId);
    const importe = String(input.amountCents); // sin formatear, céntimos
    const tipoMoneda = currencyToCecabankCode(input.currency);
    const exponente = '2';
    const referencia = ''; // vacío en compras nuevas
    const cifrado = 'SHA2';
    const urlOk = this.urlOk(numOp);
    const urlNok = this.urlNok(numOp);

    // Firma: SHA-256(clave + MerchantID + AcquirerBIN + TerminalID +
    //                Num_operacion + Importe + TipoMoneda + Exponente +
    //                Referencia + Cifrado + URL_OK + URL_NOK)
    const firma = signRequest({
      claveEncriptacion: creds.claveEncriptacion,
      merchantId: creds.merchantId,
      acquirerBin: creds.acquirerBin,
      terminalId: creds.terminalId,
      numOperacion: numOp,
      importe,
      tipoMoneda,
      exponente,
      referencia,
      cifrado,
      urlOk,
      urlNok,
    });

    const fields: Record<string, string> = {
      MerchantID: creds.merchantId,
      AcquirerBIN: creds.acquirerBin,
      TerminalID: creds.terminalId,
      Num_operacion: numOp,
      Importe: importe,
      TipoMoneda: tipoMoneda,
      Exponente: exponente,
      URL_OK: urlOk,
      URL_NOK: urlNok,
      Pago_soportado: 'SSL',
      Cifrado: cifrado,
      Idioma: '1', // español
      Firma: firma,
    };

    this.logger.log(
      `Cecabank authorize: payment=${input.paymentId} numOp=${numOp} amount=${importe}c → form ${this.baseUrl()}`,
    );

    return {
      provider: 'WIPAY',
      providerTxId: numOp, // usamos Num_operacion como ID en NightPay
      status: 'PROCESSING',
      checkoutForm: {
        action: this.baseUrl(),
        method: 'POST',
        fields,
      },
    };
  }

  /**
   * Consulta estado vía endpoint /webapp/ConsTpvVirtWeb/ConsTpvVirtS — sin
   * usar en flujo normal (webhook entrega el estado). Implementación
   * mínima: devuelve UNKNOWN si no hay datos persistidos.
   */
  private async doGetStatus(_tenantId: string, _providerTxId: string): Promise<GatewayStatus> {
    // TODO: implementar consulta vía /webapp/ConsTpvVirtWeb/ConsTpvVirtS si
    //   se necesita para reconciliación. Por ahora la fuente de verdad
    //   es el webhook que llega <30s tras pagar.
    return 'UNKNOWN';
  }

  /**
   * Refund vía Cecabank: enviar otra operación con `Referencia` no vacía
   * apuntando a la operación original. Fuera de scope del sprint inicial —
   * los refunds se hacen desde el panel de Cecabank manualmente.
   */
  private async doRefund(_input: RefundInput): Promise<RefundResult> {
    throw new Error(
      'Cecabank refund vía API no implementado en este sprint. Refundea manualmente desde https://comercios.ceca.es',
    );
  }

  /**
   * Valida la firma SHA-256 del webhook de comunicación on-line.
   * Cecabank firma con: SHA256(clave + MerchantID + AcquirerBIN + TerminalID +
   *                            Num_operacion + Importe + TipoMoneda +
   *                            Exponente + Referencia)
   */
  verifyWebhook(
    _headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
  ): WebhookVerifyResult {
    let parsed: CecabankWebhook;
    try {
      // El controller pasa rawBody siempre como Buffer. Soportamos los 2
      // formatos que puede usar Cecabank: form-urlencoded o JSON (algunos
      // partners lo proxean a JSON). En el flujo normal Fastify ya parseó
      // form-urlencoded en req.body — pero por consistencia con la
      // interface GatewayAdapter parseamos del rawBody.
      const text = rawBody.toString('utf8');
      if (text.startsWith('{')) {
        parsed = JSON.parse(text) as CecabankWebhook;
      } else {
        parsed = parseFormUrlEncoded(text) as CecabankWebhook;
      }
    } catch {
      return { valid: false, reason: 'cannot-parse-body' };
    }

    if (!parsed.MerchantID || !parsed.Num_operacion || !parsed.Firma) {
      return { valid: false, reason: 'missing-required-fields' };
    }

    let creds;
    try {
      creds = this.requireCreds();
    } catch (e) {
      this.logger.error(`Cecabank webhook recibido sin creds configuradas: ${(e as Error).message}`);
      return { valid: false, reason: 'creds-not-configured' };
    }

    // Defensa: el MerchantID del webhook debe coincidir con el nuestro.
    if (parsed.MerchantID !== creds.merchantId) {
      return { valid: false, reason: 'merchant-id-mismatch' };
    }

    const signature = checkWebhookSignature(parsed, creds.claveEncriptacion);
    if (signature === 'invalid-encoding') return { valid: false, reason: 'invalid-signature-encoding' };
    if (signature === 'mismatch') return { valid: false, reason: 'signature-mismatch' };

    return {
      valid: true,
      // externalEventId = Num_operacion (nuestro Payment.id en formato corto)
      // + lo que dice el aviso: Cecabank deja reintentar con la misma
      // operación, así que una denegación y el OK posterior son avisos
      // distintos. Reenvíos del mismo aviso sí se deduplican.
      externalEventId: `${parsed.Num_operacion}-${wipayOutcome(parsed)}`,
      paymentRef: parsed.Num_operacion,
    };
  }

  mapWebhookToFsmEvent(parsedPayload: unknown): WebhookFsmEvent | null {
    const p = parsedPayload as CecabankWebhook;
    if (!p.Num_operacion) return null;

    const paymentId = paymentIdFromNumOperacion(p.Num_operacion);
    const outcome = wipayOutcome(p);
    if (outcome === 'approved') {
      return {
        paymentId,
        event: { type: 'AUTHORIZED', providerTxId: p.Num_operacion, provider: 'WIPAY' },
      };
    }
    // Denegación (COD_AUT >= 100): NO se marca FAILED. Cecabank deja
    // reintentar con la misma operación; si el cliente acaba pagando, el
    // aviso OK tiene que poder apuntarse. Sin datos claros, tampoco se toca.
    if (outcome === 'denied') {
      this.logger.log(`Cecabank aviso denegado: op=${p.Num_operacion} COD_AUT=${(p.COD_AUT ?? '').trim()}`);
    }
    return null;
  }

  /**
   * Prueba de la aprobación: el aviso firmado por Cecabank (se vuelve a
   * comprobar la firma). Importe, moneda y operación salen de la parte
   * firmada. Num_aut / COD_AUT NO van en la firma: solo sirven para saber si
   * el aviso dice "aprobado"; no se guardan como autorización ni deciden el
   * importe. Riesgo que queda (solo con un aviso firmado capturado en el
   * camino Cecabank → API): convertir una denegación en aprobado. Cerrarlo
   * del todo pide la consulta de estado de Cecabank (sin implementar).
   */
  proveApproval(claim: ApprovalClaim): Promise<ApprovalProof> {
    return Promise.resolve(this.proofFrom(claim));
  }

  private proofFrom(claim: ApprovalClaim): ApprovalProof {
    const p = claim.payload as CecabankWebhook;
    let clave: string;
    try {
      clave = this.requireCreds().claveEncriptacion;
    } catch (e) {
      return { kind: 'unavailable', reason: (e as Error).message };
    }
    if (checkWebhookSignature(p, clave) !== 'ok') return { kind: 'rejected', reason: 'aviso-sin-firma-valida' };
    if (p.Num_operacion !== claim.providerTxId) return { kind: 'rejected', reason: 'operacion-distinta' };
    // Exponente 2 = Importe en céntimos (el único que mandamos).
    if ((p.Exponente ?? '').trim() !== '2') return { kind: 'rejected', reason: 'exponente-no-soportado' };
    const importe = (p.Importe ?? '').trim();
    if (!/^\d+$/.test(importe)) return { kind: 'rejected', reason: 'aviso-sin-importe' };
    return {
      kind: 'confirmed',
      amountCents: Number(importe),
      currency: cecabankCodeToCurrency((p.TipoMoneda ?? '').trim()),
    };
  }

  // ─── helpers ─────────────────────────────────────────────────────

  /**
   * URL del endpoint POST. Sandbox: `tpv.ceca.es`. Prod: `pgw.ceca.es`.
   * Configurable vía env var WIPAY_API_URL.
   */
  private baseUrl(): string {
    return (
      this.config.get<string>('WIPAY_API_URL') ??
      'https://tpv.ceca.es/tpvweb/tpv/compra.action'
    );
  }

  /**
   * URL_OK que Cecabank rellama tras pago exitoso. Apuntamos a un endpoint
   * propio del API que renderiza un "Gracias" y queda la operación en
   * AUTHORIZED por el webhook (no por este redirect).
   */
  private urlOk(numOp: string): string {
    const apiBase = this.config.get<string>('NEXT_PUBLIC_API_URL') ?? 'http://localhost:4100';
    return `${apiBase.replace(/\/+$/, '')}/pay/result?status=ok&op=${encodeURIComponent(numOp)}`;
  }

  private urlNok(numOp: string): string {
    const apiBase = this.config.get<string>('NEXT_PUBLIC_API_URL') ?? 'http://localhost:4100';
    return `${apiBase.replace(/\/+$/, '')}/pay/result?status=ko&op=${encodeURIComponent(numOp)}`;
  }

  private requireCreds(): {
    merchantId: string;
    acquirerBin: string;
    terminalId: string;
    claveEncriptacion: string;
  } {
    const merchantId = this.config.get<string>('WIPAY_MERCHANT_ID');
    const acquirerBin = this.config.get<string>('WIPAY_ACQUIRER_BIN');
    const terminalId = this.config.get<string>('WIPAY_TERMINAL_ID');
    const claveEncriptacion = this.config.get<string>('WIPAY_CLAVE_ENCRIPTACION');
    if (!merchantId || !acquirerBin || !terminalId || !claveEncriptacion) {
      throw new Error(
        'Wipay/Cecabank credentials no configuradas. Define WIPAY_MERCHANT_ID, WIPAY_ACQUIRER_BIN, WIPAY_TERMINAL_ID y WIPAY_CLAVE_ENCRIPTACION en env vars.',
      );
    }
    return { merchantId, acquirerBin, terminalId, claveEncriptacion };
  }
}

// ─── funciones puras (testeables sin Nest/DI) ───────────────────────

/**
 * Genera el `Num_operacion` Cecabank a partir del Payment.id UUID.
 * Cecabank limita Num_operacion a 50 chars alfanuméricos. UUIDs caben sin
 * problema pero los guiones a veces dan ruido — los quitamos.
 */
export function numOperacionFromPaymentId(paymentId: string): string {
  return paymentId.replace(/-/g, '').slice(0, 50);
}

export function paymentIdFromNumOperacion(numOp: string): string {
  // Reconstruimos el UUID con guiones a las posiciones canónicas
  // (8-4-4-4-12). Si no es de 32 hex, devolvemos el string crudo y dejamos
  // que el lookup falle limpiamente en payments.service.
  const clean = numOp.replace(/-/g, '');
  if (clean.length !== 32 || !/^[a-f0-9]+$/i.test(clean)) return numOp;
  return [
    clean.slice(0, 8),
    clean.slice(8, 12),
    clean.slice(12, 16),
    clean.slice(16, 20),
    clean.slice(20, 32),
  ].join('-');
}

/** Manual sección 10: ISO-4217 → código numérico Cecabank. */
const CECABANK_CURRENCY: Readonly<Record<string, string>> = {
  EUR: '978',
  USD: '840',
  GBP: '826',
  AUD: '036',
  MXN: '484',
  CHF: '756',
  JPY: '392',
  DKK: '208',
  SEK: '752',
  NOK: '578',
};

/**
 * ISO-4217 → código numérico Cecabank.
 * Manual sección 10: EUR=978, USD=840, GBP=826, etc.
 */
export function currencyToCecabankCode(currency: string): string {
  return CECABANK_CURRENCY[currency.toUpperCase()] ?? '978';
}

/**
 * Código numérico Cecabank (TipoMoneda) → ISO-4217. Uno desconocido se
 * devuelve tal cual: no coincidirá con la moneda del cobro.
 */
export function cecabankCodeToCurrency(code: string): string {
  const hit = Object.entries(CECABANK_CURRENCY).find(([, num]) => num === code);
  return hit ? hit[0] : code;
}

/**
 * Qué dice un aviso de Cecabank. Num_aut y COD_AUT van FUERA de la firma:
 * esto solo clasifica el aviso (para deduplicar y para saber si dice
 * "aprobado"); la prueba del cobro es la parte firmada (proveApproval).
 */
export function wipayOutcome(p: {
  Num_aut?: string;
  COD_AUT?: string;
}): 'approved' | 'denied' | 'unknown' {
  // Códigos de error >= 100 (ej 190, 400) vienen en COD_AUT.
  const codAut = (p.COD_AUT ?? '').trim();
  if (codAut && codAut !== '000' && codAut !== '0' && Number(codAut) >= 100) return 'denied';
  // En operaciones OK Cecabank envía Num_aut (autorización de la emisora).
  return (p.Num_aut ?? '').trim() ? 'approved' : 'unknown';
}

/** Firma del aviso de Cecabank comparada en tiempo constante. */
export function checkWebhookSignature(
  p: {
    MerchantID?: string;
    AcquirerBIN?: string;
    TerminalID?: string;
    Num_operacion?: string;
    Importe?: string;
    TipoMoneda?: string;
    Exponente?: string;
    Referencia?: string;
    Firma?: string;
  },
  claveEncriptacion: string,
): 'ok' | 'mismatch' | 'invalid-encoding' {
  // La firma del aviso es la del formulario de pago sin Cifrado + URL_OK +
  // URL_NOK al final (y sin separadores): con Referencia = "SHA2" + URL_OK +
  // URL_NOK, la Firma del formulario, que ve el cliente, pasaría por la de un
  // aviso de pago. Una referencia de Cecabank no lleva nada de una URL.
  if (/[/?&=]/.test(p.Referencia ?? '')) return 'mismatch';
  const expected = signWebhook({
    claveEncriptacion,
    merchantId: p.MerchantID ?? '',
    acquirerBin: p.AcquirerBIN ?? '',
    terminalId: p.TerminalID ?? '',
    numOperacion: p.Num_operacion ?? '',
    importe: p.Importe ?? '',
    tipoMoneda: p.TipoMoneda ?? '',
    exponente: p.Exponente ?? '',
    referencia: p.Referencia ?? '',
  });
  try {
    const a = Buffer.from(p.Firma ?? '', 'hex');
    const b = Buffer.from(expected, 'hex');
    return a.length === b.length && timingSafeEqual(a, b) ? 'ok' : 'mismatch';
  } catch {
    return 'invalid-encoding';
  }
}

/**
 * Firma del formulario de cobro (cliente POST a Cecabank).
 * SHA256(clave + MerchantID + AcquirerBIN + TerminalID + Num_operacion +
 *        Importe + TipoMoneda + Exponente + Referencia + Cifrado +
 *        URL_OK + URL_NOK)
 *
 * Verificable contra el ejemplo del manual sección 5 cifrado=SHA2.
 */
export function signRequest(args: {
  claveEncriptacion: string;
  merchantId: string;
  acquirerBin: string;
  terminalId: string;
  numOperacion: string;
  importe: string;
  tipoMoneda: string;
  exponente: string;
  referencia: string;
  cifrado: string;
  urlOk: string;
  urlNok: string;
}): string {
  const concat =
    args.claveEncriptacion +
    args.merchantId +
    args.acquirerBin +
    args.terminalId +
    args.numOperacion +
    args.importe +
    args.tipoMoneda +
    args.exponente +
    args.referencia +
    args.cifrado +
    args.urlOk +
    args.urlNok;
  return createHash('sha256').update(concat, 'utf8').digest('hex');
}

/**
 * Firma de la comunicación on-line (Cecabank → NightPay).
 * SHA256(clave + MerchantID + AcquirerBIN + TerminalID + Num_operacion +
 *        Importe + TipoMoneda + Exponente + Referencia)
 *
 * Nota: NO incluye Cifrado/URL_OK/URL_NOK (sólo el request las incluye).
 */
export function signWebhook(args: {
  claveEncriptacion: string;
  merchantId: string;
  acquirerBin: string;
  terminalId: string;
  numOperacion: string;
  importe: string;
  tipoMoneda: string;
  exponente: string;
  referencia: string;
}): string {
  const concat =
    args.claveEncriptacion +
    args.merchantId +
    args.acquirerBin +
    args.terminalId +
    args.numOperacion +
    args.importe +
    args.tipoMoneda +
    args.exponente +
    args.referencia;
  return createHash('sha256').update(concat, 'utf8').digest('hex');
}

/**
 * Parser mínimo de form-urlencoded → Record<string,string>.
 * No usamos `URLSearchParams` directo porque Fastify a veces entrega el
 * body como objeto, pero la interface del adapter recibe Buffer del rawBody.
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
