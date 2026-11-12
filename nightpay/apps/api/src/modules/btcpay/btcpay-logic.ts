import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/**
 * Lo puro de «Pagar con bitcoin»: dinero en texto decimal, firma del aviso,
 * qué dice de verdad una factura, el enlace del QR y los permisos de la clave.
 * Sin red ni base de datos: es lo que más se prueba.
 */

// ─── Dinero: céntimos ↔ texto decimal (nunca float) ───────────────────

/** 1250 → «12.50». BTCPay recibe el importe como texto decimal en euros. */
export function centsToDecimal(cents: number): string {
  if (!Number.isInteger(cents) || cents <= 0) throw new Error('El importe de la factura tiene que ser un entero de céntimos mayor que 0');
  const euros = Math.floor(cents / 100);
  return `${euros}.${String(cents % 100).padStart(2, '0')}`;
}

/** «12.5» / «12.50» / «12.500» → 1250; null si no es un importe exacto en céntimos (no se redondea). */
export function decimalToCents(text: unknown): number | null {
  if (typeof text !== 'string') return null;
  const m = /^(\d{1,9})(?:\.(\d{1,}))?$/.exec(text);
  if (!m) return null;
  const decimals = m[2] ?? '';
  if (/[^0]/.test(decimals.slice(2))) return null;
  const cents = Number(m[1]) * 100 + Number(decimals.padEnd(2, '0').slice(0, 2));
  return Number.isSafeInteger(cents) ? cents : null;
}

// ─── Firma del aviso ──────────────────────────────────────────────────

const SIGNATURE_RE = /^sha256=([0-9a-fA-F]{64})$/;

/**
 * `BTCPay-Sig: sha256=<HMAC-SHA256 del cuerpo EXACTO recibido>`. `rawBody` es el
 * Buffer original: el JSON leído y vuelto a escribir no vale.
 */
export function verifyBtcpaySignature(secret: string, rawBody: Buffer | null | undefined, header: string | undefined): boolean {
  if (!secret || !Buffer.isBuffer(rawBody) || typeof header !== 'string') return false;
  const m = SIGNATURE_RE.exec(header.trim().replace(/^SHA256=/, 'sha256='));
  if (!m?.[1]) return false;
  const given = Buffer.from(m[1], 'hex');
  const wanted = createHmac('sha256', Buffer.from(secret, 'utf8')).update(rawBody).digest();
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

// ─── Lo que devuelve BTCPay ───────────────────────────────────────────

export const InvoiceStatusSchema = z.enum(['New', 'Processing', 'Expired', 'Invalid', 'Settled']);
export type InvoiceStatus = z.infer<typeof InvoiceStatusSchema>;

export const InvoiceDataSchema = z.object({
  id: z.string().min(1).max(100),
  storeId: z.string().min(1).max(100),
  amount: z.string().max(40),
  currency: z.string().max(10),
  status: InvoiceStatusSchema,
  additionalStatus: z.string().max(40).nullish(),
  metadata: z.record(z.string(), z.unknown()).nullish().default({}),
  expirationTime: z.number().int().nonnegative(),
  checkoutLink: z.string().max(2048),
});
export type InvoiceData = z.input<typeof InvoiceDataSchema> & { metadata?: Record<string, unknown> | null };

/** Un texto que BTCPay puede mandar vacío (null), como el destino de BTC-LNURL: se lee como ''. */
const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((v) => v ?? '');

export const PaymentMethodSchema = z.object({
  paymentMethodId: z.string().max(40),
  destination: optionalText(2000),
  paymentLink: optionalText(4000),
  amount: optionalText(40),
  rate: optionalText(40),
  activated: z.boolean().nullish().transform((v) => v ?? true),
});
export type InvoicePaymentMethod = z.input<typeof PaymentMethodSchema>;

// ─── ¿Qué dice la factura? ────────────────────────────────────────────

export interface ExpectedInvoice {
  storeId: string;
  /** El id del cobro (metadata.orderId). */
  orderId: string;
  amountCents: number;
}

export type InvoiceRejectReason = 'STORE_MISMATCH' | 'ORDER_MISMATCH' | 'CURRENCY_MISMATCH' | 'AMOUNT_MISMATCH';
export type InvoiceIncidentReason = 'PAID_PARTIAL' | 'PAID_LATE' | 'MARKED';

export type InvoiceVerdict =
  | { kind: 'PAID' }
  | { kind: 'OPEN' }
  | { kind: 'CLOSED'; status: 'Expired' | 'Invalid' }
  | { kind: 'INCIDENT'; reason: InvoiceIncidentReason }
  | { kind: 'REJECTED'; reason: InvoiceRejectReason };

/**
 * Las comprobaciones estrictas, las mismas para el aviso y para el respaldo:
 * tienda, cobro (metadata.orderId), euros e importe EXACTO. Solo `Settled` y
 * sin pago a medias ni tardío es «pagada». Caducada o invalidada con dinero
 * recibido es una incidencia, nunca un cobro pagado.
 */
export function judgeInvoice(invoice: InvoiceData, expected: ExpectedInvoice): InvoiceVerdict {
  if (invoice.storeId !== expected.storeId) return { kind: 'REJECTED', reason: 'STORE_MISMATCH' };
  const orderId = invoice.metadata?.orderId;
  if (typeof orderId !== 'string' || orderId !== expected.orderId) return { kind: 'REJECTED', reason: 'ORDER_MISMATCH' };
  if (invoice.currency !== 'EUR') return { kind: 'REJECTED', reason: 'CURRENCY_MISMATCH' };
  if (decimalToCents(invoice.amount) !== expected.amountCents) return { kind: 'REJECTED', reason: 'AMOUNT_MISMATCH' };

  const extra = invoice.additionalStatus ?? 'None';
  if (extra === 'PaidPartial') return { kind: 'INCIDENT', reason: 'PAID_PARTIAL' };
  if (extra === 'PaidLate') return { kind: 'INCIDENT', reason: 'PAID_LATE' };
  // Alguien la marcó como pagada a mano en BTCPay: no llegó dinero que lo pruebe.
  if (extra === 'Marked' && invoice.status === 'Settled') return { kind: 'INCIDENT', reason: 'MARKED' };
  switch (invoice.status) {
    case 'Settled':
      return { kind: 'PAID' };
    case 'New':
    case 'Processing':
      return { kind: 'OPEN' };
    case 'Expired':
    case 'Invalid':
      return { kind: 'CLOSED', status: invoice.status };
  }
}

// ─── El enlace del QR ─────────────────────────────────────────────────

export interface UnifiedLink {
  /** bitcoin:ADDR?amount=X[&lightning=BOLT11], o lightning:BOLT11 si solo hay Lightning. */
  link: string;
  chainAddress: string | null;
  amountBtc: string | null;
  rate: string | null;
}

const BOLT11_RE = /^ln[a-z0-9]{20,2000}$/i;

/**
 * BTCPay no da por API el enlace único (solo su página de pago): se monta con
 * el `paymentLink` de BTC-CHAIN + "&lightning=" + el BOLT11 de BTC-LN.
 * Solo se aceptan esquemas bitcoin: y lightning: (nunca http: ni javascript:).
 */
export function unifiedPaymentLink(methods: readonly InvoicePaymentMethod[]): UnifiedLink | null {
  const active = methods.filter((m) => m.activated !== false);
  const chain = active.find((m) => m.paymentMethodId === 'BTC-CHAIN' && /^bitcoin:[^\s]+$/i.test(m.paymentLink ?? ''));
  const ln = active.find((m) => m.paymentMethodId === 'BTC-LN');
  const bolt11 = (ln?.destination ?? '').replace(/^lightning:/i, '').trim();
  const lnValid = BOLT11_RE.test(bolt11);

  if (chain?.paymentLink) {
    const sep = chain.paymentLink.includes('?') ? '&' : '?';
    return {
      link: lnValid ? `${chain.paymentLink}${sep}lightning=${bolt11}` : chain.paymentLink,
      chainAddress: chain.destination || null,
      amountBtc: chain.amount || null,
      rate: chain.rate || ln?.rate || null,
    };
  }
  if (ln && lnValid) {
    return { link: `lightning:${bolt11}`, chainAddress: null, amountBtc: ln.amount || null, rate: ln.rate || null };
  }
  return null;
}

// ─── Permisos de la clave de API ──────────────────────────────────────

export const REQUIRED_PERMISSIONS = [
  'btcpay.store.cancreateinvoice',
  'btcpay.store.canviewinvoices',
  'btcpay.store.webhooks.canmodifywebhooks',
] as const;

export interface PermissionCheck {
  ok: boolean;
  missing: string[];
  extra: string[];
}

/** Cada permiso vale sin sufijo (toda la cuenta) o con «:id de ESTA tienda». */
export function checkKeyPermissions(permissions: readonly string[] | undefined, storeId: string): PermissionCheck {
  const list = Array.isArray(permissions) ? permissions.filter((p): p is string => typeof p === 'string') : [];
  const covers = (required: string): boolean => list.some((p) => p === required || p === `${required}:${storeId}`);
  const missing = REQUIRED_PERMISSIONS.filter((p) => !covers(p));
  const isRequired = (p: string): boolean => REQUIRED_PERMISSIONS.some((r) => p === r || p === `${r}:${storeId}`);
  const extra = list.filter((p) => !isRequired(p));
  return { ok: missing.length === 0, missing: [...missing], extra };
}

// ─── Errores de BTCPay, en castellano ─────────────────────────────────

export type BtcpayFailureCode =
  | 'BAD_KEY'
  | 'MISSING_PERMISSION'
  | 'STORE_NOT_FOUND'
  | 'NO_WALLET'
  | 'REJECTED'
  | 'UNAVAILABLE'
  | 'UNKNOWN';

export interface BtcpayFailure {
  code: BtcpayFailureCode;
  message: string;
  transient: boolean;
}

/** Del estado HTTP y el cuerpo de BTCPay a un mensaje para el dueño. Nunca copia el texto crudo de BTCPay. */
export function describeBtcpayFailure(status: number, body: unknown): BtcpayFailure {
  const obj = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const text = typeof obj.message === 'string' ? obj.message : '';
  if (status === 401) {
    return { code: 'BAD_KEY', transient: false, message: 'BTCPay no acepta la clave de API. Crea una nueva en BTCPay (tu cuenta, API Keys) y pégala aquí.' };
  }
  if (status === 403) {
    const missing = typeof obj.missingPermission === 'string' ? obj.missingPermission.replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 80) : '';
    return {
      code: 'MISSING_PERMISSION',
      transient: false,
      message: `A la clave de API le falta un permiso${missing ? ` (${missing})` : ''}. Crea la clave de nuevo marcando los tres permisos que se piden.`,
    };
  }
  if (status === 404) {
    return { code: 'STORE_NOT_FOUND', transient: false, message: 'BTCPay no encuentra esa tienda. Revisa el id de tienda (en BTCPay, Ajustes de la tienda, General).' };
  }
  if (status === 400 && /no wallet has been linked/i.test(text)) {
    return {
      code: 'NO_WALLET',
      transient: false,
      message: 'La tienda de BTCPay no tiene ninguna cartera vinculada. Conecta una cartera de bitcoin en el menú de carteras de tu BTCPay y vuelve a probar.',
    };
  }
  if (status === 422 || status === 400) {
    return { code: 'REJECTED', transient: false, message: 'BTCPay ha rechazado la petición. Revisa los datos de la tienda y de la clave.' };
  }
  if (status >= 500 || status === 429 || status === 408) {
    return { code: 'UNAVAILABLE', transient: true, message: 'BTCPay no responde ahora mismo. Prueba de nuevo en un momento.' };
  }
  return { code: 'UNKNOWN', transient: false, message: 'BTCPay ha contestado algo inesperado. Revisa la dirección, la tienda y la clave.' };
}

// ─── ¿Para qué usa el local el bitcoin? ───────────────────────────────

/** Cobros, recargas del saldo o los dos (Ajustes). Un valor desconocido no deja nada. */
export function purposeAllows(purpose: string | null | undefined, topUp: boolean): boolean {
  if (purpose === 'BOTH') return true;
  return topUp ? purpose === 'TOPUPS' : purpose === 'PAYMENTS';
}
