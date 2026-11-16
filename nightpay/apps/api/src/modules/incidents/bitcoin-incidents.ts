import type { Incident, PaymentAnomalyRow } from './incident-rules';

/**
 * Incidencias del bitcoin (BTCPay) que llega sin un cobro que lo explique:
 * pagado de más (solo se apunta), tarde, dos veces o a medias. Lo que se
 * enseña es lo que LLEGÓ (paidCents de la factura), no el total del cobro.
 * Con el cobro ya cerrado, el bitcoin está en la cartera del local: se cierra
 * con una nota o se devuelve en efectivo (Fase C, si el local lo tiene
 * encendido); `cashReturn` dice la factura y lo máximo que se puede devolver.
 */

/** Los estados en los que el cobro aún espera esa factura (lo arregla «Resolver»). */
const WAITING = new Set(['AUTHORIZING', 'ORPHAN']);

const STATUS_WORD: Record<string, string> = {
  AUTHORIZED: 'pagado',
  PARTIALLY_REFUNDED: 'pagado',
  REFUNDED: 'devuelto',
  CANCELED: 'cancelado',
  EXPIRED: 'caducado',
  FAILED: 'dado por no cobrado',
  AWAITING_CAPTURE: 'abierto, esperando otro pago',
  CREATED: 'abierto, esperando otro pago',
};

/** Qué hacer con el bitcoin que está en la cartera sin cobro. */
const RETURN_TEXT =
  'Devuélveselo en euros con «Devolver en efectivo» (si el local lo tiene encendido; el bitcoin no se devuelve en bitcoin) y cierra el aviso con una nota.';

function eur(cents: number): string {
  return `${(cents / 100).toFixed(2).replace('.', ',')} €`;
}

function str(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const v = (payload as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : null;
}

function num(payload: unknown, key: string): number | null {
  if (!payload || typeof payload !== 'object') return null;
  const v = (payload as Record<string, unknown>)[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

const REASONS: Record<string, { title: string; what: string; returnable: boolean }> = {
  'btcpay-paid_partial': { title: 'Pago de bitcoin a medias', what: 'El cliente envió menos bitcoin de lo que costaba el cobro.', returnable: true },
  'btcpay-paid_late': { title: 'Pago de bitcoin fuera de plazo', what: 'El cliente pagó cuando la factura de bitcoin ya había caducado.', returnable: true },
  'btcpay-marked': { title: 'Factura de bitcoin marcada como pagada a mano', what: 'Marcada como pagada a mano en BTCPay: compruébalo antes de darla por buena.', returnable: false },
};

/** null: no es de bitcoin (o no la trata este fichero). */
export function bitcoinAnomalyIncident(r: PaymentAnomalyRow, base: { occurredAt: string; paymentId: string | null }): Incident | null {
  const invoiceId = str(r.payload, 'providerTxId');
  const invoiceText = invoiceId ? ` (factura ${invoiceId})` : '';
  const received = num(r.payload, 'paidCents');

  if (r.eventType === 'payment.bitcoin_overpaid') {
    const extra = num(r.payload, 'extraCents');
    const billed = num(r.payload, 'amountCents');
    return {
      ...base,
      kind: 'bitcoin_overpaid',
      refId: r.id,
      title: 'Pago de bitcoin de más',
      detail: `El cliente pagó ${received === null ? 'más' : eur(received)} con bitcoin por un cobro de ${billed === null ? '?' : eur(billed)}${extra === null ? '' : `: ${eur(extra)} de más`}${invoiceText}. El cobro está pagado. Lo de más se queda en la cartera del local y no se devuelve: queda apuntado para el cuadre. Ciérralo con una nota.`,
      amountCents: extra,
      ackable: true,
    };
  }

  if (r.eventType === 'payment.approval_unbooked') {
    // Llegó el bitcoin entero (la factura se pagó) con el cobro ya cerrado o pagado de otra forma.
    const got = received ?? num(r.payload, 'amountCents');
    const twice = str(r.payload, 'paidWith');
    const status = twice ? 'pagado de otra forma' : (STATUS_WORD[str(r.payload, 'fromStatus') ?? ''] ?? 'cerrado');
    return {
      ...base,
      kind: 'approval_unbooked',
      refId: r.id,
      title: twice ? 'El cliente pagó dos veces: también con bitcoin' : 'Bitcoin de un cobro ya cerrado',
      detail: `${got === null ? 'Llegó bitcoin' : `Llegaron ${eur(got)} en bitcoin`} cuando el cobro ya estaba ${status}${invoiceText}. Está en la cartera del local. ${RETURN_TEXT}`,
      amountCents: got,
      ackable: true,
      ...(invoiceId && got !== null && got > 0 ? { cashReturn: { invoiceId, maxCents: got } } : {}),
    };
  }

  if (r.eventType !== 'payment.approval_unverified' || str(r.payload, 'source') !== 'btcpay') return null;
  const reason = REASONS[str(r.payload, 'reason') ?? ''];
  const gotText = received === null ? '' : ` Llegaron ${eur(received)}.`;
  const canReturn = Boolean(reason?.returnable && invoiceId && received !== null && received > 0);
  const cashReturn = canReturn ? { cashReturn: { invoiceId: invoiceId!, maxCents: received! } } : {};
  const closed = r.paymentStatus !== undefined && !WAITING.has(r.paymentStatus);
  if (closed) {
    // El cobro ya no espera esta factura: no lo arregla «Resolver». Se cierra con una nota.
    const status = STATUS_WORD[r.paymentStatus ?? ''] ?? 'cerrado';
    return {
      ...base,
      kind: 'approval_unbooked',
      refId: r.id,
      title: reason?.title ?? 'Una factura de bitcoin no cuadra con el cobro',
      detail: `${reason?.what ?? 'BTCPay avisa de una factura que no coincide con el cobro.'}${gotText} El cobro ya estaba ${status}${invoiceText}: el bitcoin está en la cartera del local. ${RETURN_TEXT}`,
      amountCents: received ?? r.amountCents,
      ackable: true,
      ...cashReturn,
    };
  }
  return {
    ...base,
    kind: 'approval_unverified',
    refId: r.paymentId ?? r.id,
    title: reason?.title ?? 'Una factura de bitcoin no cuadra con el cobro',
    detail: `${reason?.what ?? 'BTCPay avisa de una factura cuyo importe, moneda o tienda no coinciden con el cobro.'}${gotText} NO se ha dado por pagado${received === null && r.amountCents !== null ? ` (${eur(r.amountCents)})` : ''}${invoiceText}. Míralo en tu BTCPay: devuelve el bitcoin recibido (en efectivo desde aquí, si el local lo tiene encendido, o desde la cartera) y márcalo «No se cobró» en Hoy → Cobros → Resolver; o, si ya está todo cobrado, márcalo «Sí, se cobró».`,
    amountCents: received ?? r.amountCents,
    ackable: false,
    ...cashReturn,
  };
}
