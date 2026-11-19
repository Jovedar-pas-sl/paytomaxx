// «Resolver» un cobro atascado (Hoy → Cobros): con qué se prueba que se cobró.
// Con el banco, su código de autorización (6 letras o números, del portal del
// banco); con bitcoin (BTCPay) no hay banco: el id de su factura de BTCPay (o
// un trozo, o su enlace), que el API compara con las facturas de este cobro.
// Lógica pura (resolve-stuck.test.ts).

/** Lo menos que hay que copiar del id de la factura (lo mismo que el API). */
export const MIN_INVOICE_REF_LENGTH = 6;

export interface ResolveProof {
  /** Lo que se manda al API con el código. */
  field: 'bankAuthCode' | 'btcpayInvoiceRef';
  label: string;
  placeholder: string;
  /** Dónde se mira (encima del formulario). */
  where: string;
  /** Ejemplo para «Cómo lo has comprobado». */
  reasonPlaceholder: string;
  maxLength: number;
}

const BANK: ResolveProof = {
  field: 'bankAuthCode',
  label: 'Código de autorización del banco',
  placeholder: 'ej: 047215',
  where: 'Búscalo en el portal del banco por importe, hora o número de pedido.',
  reasonPlaceholder: 'ej: aparece en el portal BBVA a las 09:50',
  maxLength: 8,
};

const BITCOIN: ResolveProof = {
  field: 'btcpayInvoiceRef',
  label: 'Id de la factura de BTCPay',
  placeholder: 'ej: Kd8sY5DN6jLHfQ (vale un trozo)',
  where:
    'Se pagó con bitcoin: no pasa por el banco. En tu BTCPay, en Facturas (Invoices), busca la de este cobro por importe y hora, y copia su id (está arriba en la factura y en su enlace). Vale un trozo de 6 letras o más.',
  reasonPlaceholder: 'ej: factura pagada en BTCPay a las 09:50',
  maxLength: 300,
};

export function resolveProofFor(provider: string | null | undefined): ResolveProof {
  return provider === 'BTCPAY' ? BITCOIN : BANK;
}

/** Lo tecleado, listo para mandar; o por qué no vale todavía. */
export function resolveProofValue(proof: ResolveProof, typed: string): { ok: true; value: string } | { ok: false; error: string } {
  if (proof.field === 'btcpayInvoiceRef') {
    const value = typed.trim();
    return value.replace(/\s+/g, '').length >= MIN_INVOICE_REF_LENGTH
      ? { ok: true, value }
      : { ok: false, error: `Pon el id de la factura de BTCPay: al menos ${MIN_INVOICE_REF_LENGTH} letras o números.` };
  }
  const code = typed.replace(/\s+/g, '').toUpperCase();
  return /^[A-Z0-9]{6}$/.test(code) ? { ok: true, value: code } : { ok: false, error: 'Pon el código de autorización del banco: 6 letras o números.' };
}
