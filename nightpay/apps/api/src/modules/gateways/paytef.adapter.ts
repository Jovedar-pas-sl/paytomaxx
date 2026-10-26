import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
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
import { gatewayFetch, gatewayHttpError } from './gateway-errors';
import { pickHeader } from './header-utils';
import { MetricsService } from '../metrics/metrics.service';
import { BRAND_NAME } from '../../common/brand';

const PROVIDER_LABEL = 'PAYTEF' as const;
function stateToNumber(s: 'closed' | 'halfOpen' | 'open'): number {
  return s === 'closed' ? 0 : s === 'halfOpen' ? 1 : 2;
}

const REPLAY_WINDOW_MS = 5 * 60 * 1000;

/**
 * Shape de la respuesta `GET /payment-link/get/{paymentID}` de Paytef.
 * H6: zod schema en vez de interface — narrowing real sobre webhook externo.
 */
const PaytefPaymentLinkSchema = z.object({
  id: z.string().optional(),
  isFinished: z.boolean().optional(),
  isVisible: z.boolean().optional(),
  isCanceled: z.boolean().optional(),
  isExpired: z.boolean().optional(),
  amountCents: z.number().optional(),
  currency: z.string().optional(),
  lastResult: z.object({
    txnKey: z.string().optional(),
    isApproved: z.boolean().optional(),
    resultCode: z.string().optional(),
    resultReason: z.string().optional(),
    paytefID: z.number().optional(),
    cardLastDigits: z.string().optional(),
    cardBrand: z.string().optional(),
  }).optional(),
  clientID: z.string().optional(),
});
type PaytefPaymentLink = z.infer<typeof PaytefPaymentLinkSchema>;

/**
 * Payload del webhook `notifyResultURL`. Paytef NO documenta el shape exacto;
 * asumimos GET /get + paymentID. Validamos con zod para reportar errores
 * en lugar de hacer cast ciego que rompe en runtime.
 */
const PaytefWebhookPayloadSchema = z.object({
  paymentID: z.string().optional(),
  data: PaytefPaymentLinkSchema.optional(),
});
type PaytefWebhookPayload = z.infer<typeof PaytefWebhookPayloadSchema>;

/** Respuesta de `GET /payment-link/get/{paymentID}`. */
const PaytefGetResponseSchema = z.object({ data: PaytefPaymentLinkSchema.optional() });

/**
 * ¿Modo test (sandbox) en Paytef? PAYTEF_FORCE_TEST=true|false manda. Sin la
 * variable: en producción NO (antes era test por defecto: los cobros reales
 * se quedaban en sandbox) y en desarrollo sí. `warn` = producción sin la
 * variable, para avisar en el log.
 */
export function paytefTestMode(
  forceTest: string | undefined,
  nodeEnv: string | undefined,
): { isTest: boolean; warn: boolean } {
  if (forceTest === 'true') return { isTest: true, warn: false };
  if (forceTest === 'false') return { isTest: false, warn: false };
  const production = nodeEnv === 'production';
  return { isTest: !production, warn: production };
}

/** Id del Payment LINK de un aviso: `data.id` o `paymentID` (si vienen los dos, iguales). */
function linkIdOf(p: PaytefWebhookPayload): string | null {
  const fromData = p.data?.id?.trim() || null;
  const fromRoot = p.paymentID?.trim() || null;
  if (fromData && fromRoot && fromData !== fromRoot) return null;
  return fromData ?? fromRoot;
}

/**
 * Estado del link en un aviso sin txnKey, para su id: lo que decide qué hace
 * el aviso (mapWebhookToFsmEvent) y nada más (ni importe ni tarjeta), así un
 * reintento idéntico de Paytef da el mismo id. «open»: sin nada de eso.
 */
function noticeStateOf(data: PaytefPaymentLink | undefined): string {
  const r = data?.lastResult;
  const code = r?.resultCode?.replace(/[^A-Za-z0-9]/g, '').slice(0, 16);
  const result = !r ? null : r.isApproved === true ? 'approved' : r.isApproved === false ? 'denied' : 'result';
  const parts = [
    result && code && result !== 'approved' ? `${result}${code}` : result,
    data?.isCanceled ? 'canceled' : null,
    data?.isExpired ? 'expired' : null,
    data?.isFinished ? 'finished' : null,
  ].filter((x): x is string => x !== null);
  return parts.length > 0 ? parts.join('-') : 'open';
}

@Injectable()
export class PaytefAdapter implements GatewayAdapter {
  readonly provider = 'PAYTEF' as const;
  private readonly logger = new Logger(PaytefAdapter.name);

  private readonly config: ConfigService;
  private readonly metrics: MetricsService;
  private readonly authorizeBreaker: CircuitBreaker<[AuthorizeInput], AuthorizeResult>;
  private readonly statusBreaker: CircuitBreaker<[string, string], GatewayStatus>;
  private readonly refundBreaker: CircuitBreaker<[RefundInput], RefundResult>;
  private readonly timeoutMs: number;
  // Cache en memoria del companyID/branchID resueltos. Solo Paytef → 1 sola
  // companía + N branches; pickeamos la primera activa al primer authorize.
  private cachedBranch: { companyID: number; branchID: number } | null = null;
  // Cache de la respuesta cruda de /getBranches para debugging (qué IDs y
  // shape devolvió Paytef cuando auto-resolvimos).
  private cachedBranchRaw: string | null = null;
  // Aviso "producción sin PAYTEF_FORCE_TEST" una sola vez por proceso.
  private testModeWarned = false;

  constructor(
    @Inject(ConfigService) config: ConfigService,
    @Inject(MetricsService) metrics: MetricsService,
  ) {
    this.config = config;
    this.metrics = metrics;
    this.timeoutMs = config.get<number>('GATEWAY_TIMEOUT_MS') ?? 5000;

    this.authorizeBreaker = createBreaker((input: AuthorizeInput) => this.doAuthorize(input), {
      name: 'paytef.authorize',
      timeoutMs: this.timeoutMs,
      onStateChange: (s) =>
        this.metrics.circuitState.set({ provider: PROVIDER_LABEL, op: 'authorize' }, stateToNumber(s)),
    });
    this.statusBreaker = createBreaker(
      (tenantId: string, providerTxId: string) => this.doGetStatus(tenantId, providerTxId),
      {
        name: 'paytef.getStatus',
        timeoutMs: this.timeoutMs,
        onStateChange: (s) =>
          this.metrics.circuitState.set({ provider: PROVIDER_LABEL, op: 'getStatus' }, stateToNumber(s)),
      },
    );
    this.refundBreaker = createBreaker((input: RefundInput) => this.doRefund(input), {
      name: 'paytef.refund',
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

  // ─── Implementaciones tras circuit breaker ───────────────────────

  /**
   * Crea + publica una solicitud de PaymentLINK en Paytef.
   * Devuelve el paymentID (Paytef) como providerTxId. La URL pública la
   * exponemos a través de extras para que NightPay la incluya en su QR.
   */
  private async doAuthorize(input: AuthorizeInput): Promise<AuthorizeResult> {
    const baseUrl = this.baseUrl();
    const authHeader = this.authHeader();

    // 1) Resolver companyID + branchID. Si están en env vars → usar.
    //    Si no → fetch /payment-link/getBranches de Paytef y cachear la
    //    primera branch activa. Una sola llamada por proceso.
    const { companyID, branchID } = await this.resolveBranchInfo();
    // Paytef requiere expiration o expirationHours. Lo ponemos en AMBOS sitios
    // (root y data{}) porque la doc no es clara sobre dónde lo espera, y
    // 24h porque algunas implementaciones rechazan valores <24.
    const saveBody = {
      expirationHours: 24,
      data: {
        opType: 'sale',
        customerAuthentication: 'strong',
        changeCard: false,
        companyID,
        branchID,
        amountCents: input.amountCents,
        currency: input.currency,
        description: `${BRAND_NAME} ${input.reference}`,
        clientID: input.reference, // nuestro UUID payment como clientID Paytef
        // Paytef requiere userFullName + userEmail no vacíos (422). El cliente
        // real no los introduce porque pagamos directo sin formulario previo —
        // son placeholders que Paytef requiere por API pero no son visibles al
        // cliente en el flujo Payment LINK.
        userFullName: 'Cliente',
        userEmail: 'cliente@nightpay.local',
        expirationHours: 24,
        language: 'ES',
        // Modo test (sandbox): ver paytefTestMode. PAYTEF_FORCE_TEST=true lo
        // fuerza (cuenta aún sin alta en producción).
        isTest: this.isTestMode(),
        notifyResultURL: this.webhookUrl(),
        notifyResultURLKo: this.webhookUrl(), // mismo endpoint, evento distingue
      },
    };

    // Sin respuesta o con 5xx/429: pasajero (gateway-errors.ts). El enlace que
    // Paytef pudiera haber creado no lo tiene nadie: no se puede cobrar.
    const saveRes = await gatewayFetch(
      () =>
        fetchWithTimeout(
          `${baseUrl}/payment-link/save`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: authHeader,
            },
            body: JSON.stringify(saveBody),
          },
          this.timeoutMs,
        ),
      'Paytef /save',
    );
    if (!saveRes.ok) {
      const text = await saveRes.text().catch(() => '');
      const sentBody = JSON.stringify(saveBody).slice(0, 800);
      const branchDump = this.cachedBranchRaw
        ? ` | branchesRaw: ${this.cachedBranchRaw.slice(0, 800)}`
        : '';
      throw gatewayHttpError(
        saveRes.status,
        `Paytef /save failed: ${saveRes.status} ${text.slice(0, 250)} | sent: ${sentBody}${branchDump}`,
      );
    }
    const SaveResponseSchema = z.object({
      success: z.boolean().optional(),
      paymentID: z.string().optional(),
      paymentURL: z.string().optional(),
    });
    const rawSave: unknown = await saveRes.json();
    const saveParsed = SaveResponseSchema.safeParse(rawSave);
    if (!saveParsed.success) {
      throw new Error(`Paytef /save returned malformed JSON: ${JSON.stringify(rawSave).slice(0, 200)}`);
    }
    const saveData = saveParsed.data;
    if (!saveData.success || !saveData.paymentID) {
      throw new Error(`Paytef /save returned no paymentID: ${JSON.stringify(saveData)}`);
    }

    // 2) Publicar para que sea visible al cliente (POST /payment-link/publish)
    const publishRes = await gatewayFetch(
      () =>
        fetchWithTimeout(
          `${baseUrl}/payment-link/publish`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: authHeader,
            },
            body: JSON.stringify({
              paymentID: saveData.paymentID,
              sendEmailNotification: false,
            }),
          },
          this.timeoutMs,
        ),
      'Paytef /publish',
    );
    if (!publishRes.ok) {
      const text = await publishRes.text().catch(() => '');
      throw gatewayHttpError(publishRes.status, `Paytef /publish failed: ${publishRes.status} ${text.slice(0, 200)}`);
    }

    this.logger.log(
      `Paytef authorized: paymentID=${saveData.paymentID} url=${saveData.paymentURL}`,
    );

    return {
      provider: 'PAYTEF',
      providerTxId: saveData.paymentID,
      status: 'PROCESSING',
      ...(saveData.paymentURL ? { paymentLinkUrl: saveData.paymentURL } : {}),
    };
  }

  private async doGetStatus(_tenantId: string, providerTxId: string): Promise<GatewayStatus> {
    const found = await this.fetchLink(providerTxId);
    return found.ok ? mapPaytefStatus(found.link) : 'UNKNOWN';
  }

  /**
   * El Payment LINK tal como lo tiene Paytef (fuente de verdad). ok=false si
   * no se pudo consultar (red, 5xx, respuesta rara): quien llama reintenta.
   */
  private async fetchLink(
    linkId: string,
  ): Promise<{ ok: true; link: PaytefPaymentLink | undefined } | { ok: false; reason: string }> {
    try {
      const res = await fetchWithTimeout(
        `${this.baseUrl()}/payment-link/get/${encodeURIComponent(linkId)}`,
        { headers: { Authorization: this.authHeader() } },
        this.timeoutMs,
      );
      if (!res.ok) return { ok: false, reason: `paytef-http-${res.status}` };
      const parsed = PaytefGetResponseSchema.safeParse(await res.json());
      if (!parsed.success) return { ok: false, reason: 'paytef-respuesta-rara' };
      return { ok: true, link: parsed.data.data };
    } catch (err) {
      return { ok: false, reason: `paytef-sin-respuesta: ${(err as Error).message}`.slice(0, 200) };
    }
  }

  /**
   * Paytef PaymentLINK NO expone refund vía API actualmente. El admin debe
   * refundear desde el panel my.paytef.es. Lanzamos NotImplemented claro para
   * que el flujo NightPay sepa que hay que avisar al admin.
   */
  private async doRefund(_input: RefundInput): Promise<RefundResult> {
    this.logger.warn(
      'Paytef refund vía API no soportado por el PSP. Refund manual desde my.paytef.es requerido.',
    );
    throw new Error(
      'paytef-refund-manual-required: Paytef PaymentLINK no expone refund via API. ' +
        `Refundea desde el panel my.paytef.es y marca el refund manualmente en ${BRAND_NAME}.`,
    );
  }

  // ─── Webhook handling ────────────────────────────────────────────
  //
  // Paytef NO firma webhooks con HMAC estándar. La doc oficial solo dice
  // "notifyResultURL será llamada cuando la transacción se cierre". Para
  // protegernos usamos un esquema híbrido:
  //
  // 1) URL secreta: el endpoint es /v1/webhooks/paytef/<PAYTEF_WEBHOOK_SECRET>
  //    Solo Paytef conoce esa URL (admin la configura en notifyResultURL).
  //    Eso ya filtra el 99% de tráfico atacante.
  //
  // 2) Validación cruzada: antes de dar un cobro por pagado, proveApproval
  //    relee el link contra Paytef (`GET /payment-link/get/{id}`): aprobado,
  //    del mismo cobro (clientID) y por el mismo importe. Quien conozca la
  //    URL no puede marcar nada como pagado: Paytef es la fuente de verdad.
  //
  // Cuando Paytef añada firma HMAC al webhook (PR pedido), actualizamos.
  //
  verifyWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
  ): WebhookVerifyResult {
    // Opción A — Si Paytef añade firma en el futuro: validar HMAC.
    const sig = pickHeader(headers, 'x-paytef-signature');
    const ts = pickHeader(headers, 'x-paytef-timestamp');

    if (sig && ts) {
      // Camino HMAC estándar (cuando Paytef lo implemente)
      const tsNum = Number(ts);
      if (!Number.isFinite(tsNum) || Math.abs(Date.now() - tsNum) > REPLAY_WINDOW_MS) {
        return { valid: false, reason: 'timestamp-out-of-window' };
      }
      const secret = this.config.get<string>('PAYTEF_WEBHOOK_SECRET');
      if (!secret) return { valid: false, reason: 'webhook-secret-not-configured' };
      const expected = createHmac('sha256', secret)
        .update(`${ts}.${rawBody.toString('utf8')}`)
        .digest('hex');
      try {
        const a = Buffer.from(sig, 'hex');
        const b = Buffer.from(expected, 'hex');
        if (a.length !== b.length || !timingSafeEqual(a, b)) {
          return { valid: false, reason: 'signature-mismatch' };
        }
      } catch {
        return { valid: false, reason: 'invalid-signature-encoding' };
      }
    }
    // Si no hay firma, confiamos en la URL secreta (validada por
    // webhooks.controller antes de llegar aquí). Parseamos body.

    let parsed: PaytefWebhookPayload;
    try {
      const raw: unknown = JSON.parse(rawBody.toString('utf8'));
      const result = PaytefWebhookPayloadSchema.safeParse(raw);
      if (!result.success) {
        return { valid: false, reason: 'invalid-payload-shape' };
      }
      parsed = result.data;
    } catch {
      return { valid: false, reason: 'invalid-json' };
    }

    // Id del link no vacío (y el mismo si viene dos veces): un providerTxId ''
    // dejaría el cobro sin pedido de Paytef y sin poder devolverlo.
    const paymentID = linkIdOf(parsed);
    const paymentRef = parsed.data?.clientID; // nuestro UUID interno
    if (!paymentID || !paymentRef) {
      return { valid: false, reason: 'missing-paymentID-or-clientID' };
    }

    // externalEventId = paymentID + last txnKey si está, para idempotency.
    // Sin txnKey, + el estado del link que trae: con solo el id del link, un
    // aviso de ciclo de vida dejaba ese id como procesado y uno posterior
    // distinto (aprobado, cancelado) se contestaba «duplicado» sin procesarlo.
    // El mismo aviso repetido trae el mismo estado: sigue siendo duplicado.
    const externalEventId = parsed.data?.lastResult?.txnKey
      ? `${paymentID}_${parsed.data.lastResult.txnKey}`
      : `${paymentID}_${noticeStateOf(parsed.data)}`;

    return { valid: true, externalEventId, paymentRef };
  }

  mapWebhookToFsmEvent(parsedPayload: unknown): WebhookFsmEvent | null {
    const result = PaytefWebhookPayloadSchema.safeParse(parsedPayload);
    if (!result.success) return null;
    const p = result.data;
    const data = p.data;
    if (!data || !data.clientID) return null;
    const linkId = linkIdOf(p);
    if (!linkId) return null;

    // Aprobado → AUTHORIZED (antes que caducado: un link pagado que luego
    // caduca sigue estando pagado). El procesador lo comprueba con Paytef
    // (proveApproval) antes de darlo por pagado.
    if (data.lastResult?.isApproved === true) {
      return {
        paymentId: data.clientID,
        event: { type: 'AUTHORIZED', providerTxId: linkId, provider: 'PAYTEF' },
      };
    }

    // Cancelado o caducado en Paytef: ya no se puede pagar ese link.
    if (data.isCanceled || data.isExpired) {
      return {
        paymentId: data.clientID,
        event: { type: 'FAILED', reason: data.isExpired ? 'expired' : 'canceled' },
      };
    }

    // Denegación (lastResult con isApproved=false): NO se marca FAILED. El
    // cliente puede reintentar con otra tarjeta en el mismo link.
    // Lo demás no es un evento terminal (lifecycle interno Paytef).
    return null;
  }

  /**
   * Prueba de la aprobación: el link tal como lo tiene Paytef. Tiene que estar
   * aprobado, ser de este cobro (clientID) y traer importe. El aviso solo lo
   * protege la URL secreta, así que de él no se usa nada más que el id.
   */
  async proveApproval(claim: ApprovalClaim): Promise<ApprovalProof> {
    const found = await this.fetchLink(claim.providerTxId);
    if (!found.ok) return { kind: 'unavailable', reason: found.reason };
    const link = found.link;
    if (!link) return { kind: 'rejected', reason: 'paytef-link-desconocido' };
    if (link.clientID !== claim.paymentId) return { kind: 'rejected', reason: 'paytef-link-de-otro-cobro' };
    if (link.lastResult?.isApproved !== true) return { kind: 'rejected', reason: 'paytef-no-aprobado' };
    if (typeof link.amountCents !== 'number') return { kind: 'rejected', reason: 'paytef-sin-importe' };
    return { kind: 'confirmed', amountCents: link.amountCents, currency: link.currency ?? null };
  }

  // ─── Helpers ─────────────────────────────────────────────────────

  /**
   * Resuelve {companyID, branchID} para el POST /payment-link/save.
   *
   *  1) Si PAYTEF_COMPANY_ID + PAYTEF_BRANCH_ID están en env → usarlos.
   *  2) Si no → llamar GET /payment-link/getBranches y elegir la primera
   *     branch activa. Cachear en memoria (1 vez por proceso).
   *
   * El usuario del token actual ("Rapido Sin Riesgos") tiene RSR5..RSR14.
   * Por defecto picamos la primera que Paytef devuelva — admin puede sobre-
   * escribir con env vars si quiere una en concreto.
   */
  private async resolveBranchInfo(): Promise<{ companyID: number; branchID: number }> {
    if (this.cachedBranch) return this.cachedBranch;

    const envCompany = this.config.get<number>('PAYTEF_COMPANY_ID');
    const envBranch = this.config.get<number>('PAYTEF_BRANCH_ID');
    if (envCompany && envBranch) {
      this.cachedBranch = { companyID: envCompany, branchID: envBranch };
      this.logger.log(
        `Paytef branch info from env: company=${envCompany} branch=${envBranch}`,
      );
      return this.cachedBranch;
    }

    // Fetch from Paytef API. Schema tolerante a variaciones porque la doc no
    // es 100% canónica — buscamos campos plausibles en la respuesta.
    const res = await gatewayFetch(
      () =>
        fetchWithTimeout(
          `${this.baseUrl()}/payment-link/getBranches`,
          { method: 'GET', headers: { Authorization: this.authHeader() } },
          this.timeoutMs,
        ),
      'Paytef /getBranches',
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw gatewayHttpError(
        res.status,
        `Paytef /getBranches failed: ${res.status} ${text.slice(0, 200)}. ` +
          `Define PAYTEF_COMPANY_ID y PAYTEF_BRANCH_ID en env vars manualmente.`,
      );
    }
    const raw: unknown = await res.json();
    // Cachea el dump para diagnosis si /save falla con "Branch not found"
    this.cachedBranchRaw = JSON.stringify(raw).slice(0, 1500);
    // Respuesta esperada: { data: { branches: [{ companyID, branchID, name, active }] } }
    // o variantes — intentamos varias formas.
    const BranchSchema = z.object({
      companyID: z.number().optional(),
      branchID: z.number().optional(),
      id: z.number().optional(),
      companyId: z.number().optional(),
      branchId: z.number().optional(),
      name: z.string().optional(),
      // Campo real que devuelve Paytef en /getBranches
      branchName: z.string().optional(),
      displayName: z.string().optional(),
      companyName: z.string().optional(),
      code: z.string().optional(),
      active: z.boolean().optional(),
      isActive: z.boolean().optional(),
    });
    const ListSchema = z.object({
      data: z.union([
        z.object({ branches: z.array(BranchSchema).optional() }).passthrough(),
        z.array(BranchSchema),
      ]).optional(),
      branches: z.array(BranchSchema).optional(),
      success: z.boolean().optional(),
    }).passthrough();
    const parsed = ListSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `Paytef /getBranches returned unexpected shape: ${JSON.stringify(raw).slice(0, 300)}`,
      );
    }
    // Extraer array de branches de la forma que sea
    let branches: z.infer<typeof BranchSchema>[] = [];
    if (parsed.data.branches) branches = parsed.data.branches;
    else if (Array.isArray(parsed.data.data)) branches = parsed.data.data;
    else if (parsed.data.data && 'branches' in parsed.data.data && parsed.data.data.branches) {
      branches = parsed.data.data.branches;
    }

    if (branches.length === 0) {
      throw new Error(
        `Paytef /getBranches devolvió cero branches. Verifica que tu cuenta esté activa. ` +
          `Raw: ${JSON.stringify(raw).slice(0, 300)}`,
      );
    }

    // Picar branch:
    //   1. Si env var PAYTEF_BRANCH_NAME está set (ej "RSR14"), busca por nombre.
    //   2. Si no, prefiere las "limpias" — branchName sin guión final ni
    //      espacio final (las activadas para Payment LINK en Paytef tienen
    //      nombres como "RSR14", las shells no-activadas vienen como "RSR5 -").
    //   3. Fallback: la última de la lista (típicamente la más nueva/activa).
    const preferredName = this.config.get<string>('PAYTEF_BRANCH_NAME');
    const branchNameOf = (b: z.infer<typeof BranchSchema>): string =>
      (b.branchName ?? b.name ?? b.code ?? '').trim();
    const isCleanName = (s: string): boolean =>
      Boolean(s && /^[A-Za-z0-9_]+$/.test(s) && !s.endsWith('-'));
    let chosen: z.infer<typeof BranchSchema> | undefined;
    if (preferredName) {
      const want = preferredName.trim().toLowerCase();
      chosen = branches.find((b) => branchNameOf(b).toLowerCase() === want);
    }
    if (!chosen) {
      chosen = branches.find((b) => isCleanName(branchNameOf(b)));
    }
    if (!chosen) {
      chosen = branches[branches.length - 1] ?? branches[0]!;
    }
    this.logger.log(
      `Paytef branch picked: ${branchNameOf(chosen)} (companyID=${chosen.companyID ?? chosen.companyId} branchID=${chosen.branchID ?? chosen.branchId ?? chosen.id}) from ${branches.length} options`,
    );
    const companyID = chosen.companyID ?? chosen.companyId;
    const branchID = chosen.branchID ?? chosen.branchId ?? chosen.id;

    if (!companyID || !branchID) {
      throw new Error(
        `Paytef branch sin companyID/branchID válidos: ${JSON.stringify(chosen).slice(0, 200)}`,
      );
    }

    this.cachedBranch = { companyID, branchID };
    return this.cachedBranch;
  }

  private baseUrl(): string {
    return this.config.get<string>('PAYTEF_API_URL') ?? 'https://api.paytef.es/gcf';
  }

  private isTestMode(): boolean {
    const mode = paytefTestMode(
      this.config.get<string>('PAYTEF_FORCE_TEST'),
      this.config.get<string>('NODE_ENV') ?? process.env.NODE_ENV,
    );
    if (mode.warn && !this.testModeWarned) {
      this.testModeWarned = true;
      this.logger.warn(
        'PAYTEF_FORCE_TEST sin definir en producción: los links de Paytef se crean en modo REAL (isTest=false). Pon PAYTEF_FORCE_TEST=true si la cuenta aún es de pruebas.',
      );
    }
    return mode.isTest;
  }

  /**
   * Construye el header Authorization. Acepta token con o sin prefijo
   * "PAYTEF-TOKEN " (algunos admins copian el header completo del panel).
   */
  private authHeader(): string {
    const raw = this.config.get<string>('PAYTEF_API_TOKEN');
    if (!raw) {
      throw new Error('PAYTEF_API_TOKEN not configured');
    }
    const trimmed = raw.trim();
    return trimmed.startsWith('PAYTEF-TOKEN ') ? trimmed : `PAYTEF-TOKEN ${trimmed}`;
  }

  private webhookUrl(): string | undefined {
    const url = this.config.get<string>('PAYTEF_WEBHOOK_URL');
    const secret = this.config.get<string>('PAYTEF_WEBHOOK_SECRET');
    if (!url) return undefined;
    // Si hay secret, lo incluimos en el path para URL secreta defensa-en-profundidad.
    return secret ? `${url}/${secret}` : url;
  }
}

/**
 * Mapea el estado de un PaymentLink Paytef al status interno NightPay.
 *  - lastResult.isApproved=true → AUTHORIZED (aunque luego haya caducado:
 *    un link pagado sigue pagado)
 *  - isCanceled/isExpired → FAILED
 *  - lastResult.isApproved=false → FAILED (denegado ahora; el cliente puede
 *    reintentar: la conciliación no cierra el cobro con esto)
 *  - isFinished sin lastResult → UNKNOWN (caso raro)
 *  - default (esperando pago) → PROCESSING
 */
function mapPaytefStatus(data: PaytefPaymentLink | undefined): GatewayStatus {
  if (!data) return 'UNKNOWN';
  if (data.lastResult?.isApproved === true) return 'AUTHORIZED';
  if (data.isCanceled || data.isExpired) return 'FAILED';
  if (data.lastResult && data.lastResult.isApproved === false) return 'FAILED';
  if (data.isFinished) return 'UNKNOWN';
  return 'PROCESSING';
}
