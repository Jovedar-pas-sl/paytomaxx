/**
 * «Resolver» un cobro con bitcoin atascado: en vez del código del banco, el id
 * de su factura de BTCPay (o un trozo). Quien lo resuelve lo copia de su BTCPay
 * (Facturas, buscando por importe y hora): así se sabe que ha mirado la factura
 * de este cobro y no otra. Función pura.
 */

/** Lo menos que hay que copiar del id de la factura. */
export const MIN_INVOICE_REF_LENGTH = 6;

/** Dónde se ve el id (el panel y el API dicen lo mismo). */
export const BTCPAY_INVOICE_WHERE =
  'En tu BTCPay, en Facturas (Invoices), busca la de este cobro por importe y hora: su id está arriba, en la factura y en su enlace.';

export type InvoiceMatch = { ok: true; invoiceId: string } | { ok: false; reason: 'short' | 'none' | 'many' };

/**
 * Lo que se pegó (el id, un trozo o el enlace de la factura), sin espacios; de
 * un enlace, su último trozo («…/i/Kd8sY5DN6jLHfQfqHkFBnQ»).
 */
export function invoiceRefOf(raw: string): string {
  const clean = raw.replace(/\s+/g, '');
  if (!clean.includes('/')) return clean;
  const path = clean.split(/[?#]/)[0] ?? '';
  return path.split('/').filter(Boolean).pop() ?? '';
}

/** La factura de este cobro que contiene lo que se pegó (sin mirar mayúsculas). Si casan varias, hay que poner más. */
export function matchInvoiceRef(raw: string, invoiceIds: ReadonlyArray<string | null | undefined>): InvoiceMatch {
  const ref = invoiceRefOf(raw).toLowerCase();
  if (ref.length < MIN_INVOICE_REF_LENGTH) return { ok: false, reason: 'short' };
  const ids = [...new Set(invoiceIds.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  const hits = ids.filter((id) => id.toLowerCase().includes(ref));
  if (hits.length === 0) return { ok: false, reason: 'none' };
  if (hits.length > 1) return { ok: false, reason: 'many' };
  return { ok: true, invoiceId: hits[0]! };
}

/** Por qué no vale lo que se pegó, para quien lo resuelve. */
export function invoiceRefProblem(reason: 'short' | 'none' | 'many'): string {
  if (reason === 'short') return `Pon el id de la factura de BTCPay (al menos ${MIN_INVOICE_REF_LENGTH} letras o números). ${BTCPAY_INVOICE_WHERE}`;
  if (reason === 'many') return 'Ese trozo vale para más de una factura de este cobro: pon más letras del id.';
  return `Esa no es la factura de bitcoin de este cobro. ${BTCPAY_INVOICE_WHERE}`;
}
