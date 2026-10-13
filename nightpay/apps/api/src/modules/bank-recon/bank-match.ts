/**
 * Cuadre con el banco — reglas puras.
 *
 * Cada operación del fichero del banco (BBVA/Redsys o Paytef) se casa con lo
 * apuntado aquí:
 *  1. por referencia: el número de pedido de Redsys (uno por intento de
 *     cobro) o el número de operación del datáfono;
 *  2. si no trae referencia, por importe + código de autorización + hora.
 * Las anulaciones quitan su venta del cuadre (en los dos lados no cuenta).
 */

export type BankSource = 'REDSYS' | 'PAYTEF';
export type BankRowKind = 'SALE' | 'REFUND' | 'VOID' | 'OTHER';

/** Una operación del fichero del banco, ya leída. */
export interface BankRow {
  line: number;
  at: Date | null;
  kind: BankRowKind;
  /** Autorizada por el banco (las denegadas no cuentan). */
  approved: boolean;
  amountCents: number;
  /** Pedido de Redsys o número de operación de Paytef. */
  reference: string | null;
  terminal: string | null;
  authCode: string | null;
}

/** Un cobro pagado aquí dentro del periodo del fichero. */
export interface OurSale {
  paymentId: string;
  tenantId: string;
  /** Pedidos Redsys de sus intentos aprobados, o su número de operación del datáfono. */
  references: string[];
  terminal: string | null;
  authCode: string | null;
  /** Lo cobrado al cliente (con propina). */
  amountCents: number;
  at: Date;
}

/** Una devolución apuntada aquí (hecha en el banco) dentro del periodo. */
export interface OurRefund {
  refundId: string;
  paymentId: string;
  tenantId: string;
  /** Referencias del cobro devuelto. */
  paymentReferences: string[];
  amountCents: number;
  at: Date;
}

/** Cobro de aquí que el banco tiene como cobrado y aquí NO figura como pagado. */
export interface StrayPayment {
  paymentId: string;
  tenantId: string;
  references: string[];
  amountCents: number;
}

export type ItemStatus =
  | 'MATCHED'
  | 'AMOUNT_MISMATCH'
  | 'NOT_PAID_HERE'
  | 'NOT_IN_OXIOPAY'
  | 'NOT_IN_BANK'
  | 'REFUND_MATCHED'
  | 'REFUND_NOT_IN_OXIOPAY'
  | 'REFUND_NOT_IN_BANK';

export const PROBLEM_STATUSES: ReadonlySet<ItemStatus> = new Set<ItemStatus>([
  'AMOUNT_MISMATCH',
  'NOT_PAID_HERE',
  'NOT_IN_OXIOPAY',
  'NOT_IN_BANK',
  'REFUND_NOT_IN_OXIOPAY',
  'REFUND_NOT_IN_BANK',
]);

export interface ReconItem {
  status: ItemStatus;
  kind: 'SALE' | 'REFUND';
  line: number | null;
  at: Date | null;
  bankAmountCents: number | null;
  oursAmountCents: number | null;
  reference: string | null;
  terminal: string | null;
  authCode: string | null;
  paymentId: string | null;
  refundId: string | null;
  /** Local al que se atribuye; null = el local que sube el fichero. */
  tenantId: string | null;
}

/** Sin referencia, una venta del banco y un cobro de aquí casan si están a menos de esto. */
export const FALLBACK_WINDOW_MS = 15 * 60_000;
/** Una devolución apuntada aquí puede llevar la fecha que se tecleó (sin hora). */
export const REFUND_FALLBACK_WINDOW_MS = 36 * 3_600_000;
/** Una anulación sin referencia solo anula una venta de las horas anteriores. */
export const VOID_FALLBACK_WINDOW_MS = 24 * 3_600_000;

/** "000123ABC" y "123abc" son el mismo pedido (Excel se come los ceros). */
export function referenceKey(ref: string): string {
  return ref.trim().toUpperCase().replace(/^0+/, '');
}

export interface ReconResult {
  items: ReconItem[];
  /** Neto del banco: ventas autorizadas (sin las anuladas) − devoluciones. */
  bankTotalCents: number;
  /** Neto de aquí: cobros pagados − devoluciones apuntadas, del mismo periodo. */
  oursTotalCents: number;
}

export function reconcile(input: {
  rows: BankRow[];
  sales: OurSale[];
  refunds: OurRefund[];
  strays: StrayPayment[];
  /**
   * Los días que cubre el fichero. Lo de aquí se carga con margen (para casar
   * un cobro de las 23:59 que el banco apunta a las 00:00), pero solo se
   * avisa de "falta en el banco" de lo que cae dentro.
   */
  window?: { from: Date; to: Date };
}): ReconResult {
  const approved = input.rows.filter((r) => r.approved);
  const voids = approved.filter((r) => r.kind === 'VOID');
  const voided = new Set<BankRow>();
  for (const v of voids) {
    const target = findVoided(v, approved, voided);
    if (target) voided.add(target);
  }
  const saleRows = approved.filter((r) => r.kind === 'SALE' && !voided.has(r));
  const refundRows = approved.filter((r) => r.kind === 'REFUND' && !voided.has(r));
  const inWindow = (at: Date) => !input.window || (at >= input.window.from && at < input.window.to);

  const items: ReconItem[] = [];
  const usedSales = new Set<OurSale>();
  const saleByRef = indexByReference(input.sales, (s) => s.references);
  const strayByRef = indexByReference(input.strays, (s) => s.references);

  // 1) Por referencia.
  const pending: BankRow[] = [];
  for (const row of saleRows) {
    const key = row.reference ? referenceKey(row.reference) : '';
    const sale = key ? saleByRef.get(key) : undefined;
    if (sale && !usedSales.has(sale)) {
      usedSales.add(sale);
      items.push(saleItem(row, sale));
      continue;
    }
    const stray = key ? strayByRef.get(key) : undefined;
    if (stray) {
      items.push({
        ...bankSide(row, 'SALE'),
        status: 'NOT_PAID_HERE',
        oursAmountCents: stray.amountCents,
        paymentId: stray.paymentId,
        tenantId: stray.tenantId,
      });
      continue;
    }
    pending.push(row);
  }

  // 2) Sin referencia que case: importe + autorización + hora.
  for (const row of pending) {
    const sale = closestSale(row, input.sales, usedSales);
    if (sale) {
      usedSales.add(sale);
      items.push(saleItem(row, sale));
    } else {
      items.push({ ...bankSide(row, 'SALE'), status: 'NOT_IN_OXIOPAY' });
    }
  }

  // 3) Pagado aquí y el banco no lo tiene.
  for (const sale of input.sales) {
    if (usedSales.has(sale) || !inWindow(sale.at)) continue;
    items.push({
      status: 'NOT_IN_BANK',
      kind: 'SALE',
      line: null,
      at: sale.at,
      bankAmountCents: null,
      oursAmountCents: sale.amountCents,
      reference: sale.references[0] ?? null,
      terminal: sale.terminal,
      authCode: sale.authCode,
      paymentId: sale.paymentId,
      refundId: null,
      tenantId: sale.tenantId,
    });
  }

  // 4) Devoluciones.
  const usedRefunds = new Set<OurRefund>();
  for (const row of refundRows) {
    const refund = matchRefund(row, input.refunds, usedRefunds);
    if (refund) {
      usedRefunds.add(refund);
      items.push({
        ...bankSide(row, 'REFUND'),
        status: 'REFUND_MATCHED',
        oursAmountCents: refund.amountCents,
        paymentId: refund.paymentId,
        refundId: refund.refundId,
        tenantId: refund.tenantId,
      });
      continue;
    }
    const key = row.reference ? referenceKey(row.reference) : '';
    const of = key ? (saleByRef.get(key) ?? strayByRef.get(key)) : undefined;
    items.push({
      ...bankSide(row, 'REFUND'),
      status: 'REFUND_NOT_IN_OXIOPAY',
      paymentId: of?.paymentId ?? null,
      tenantId: of?.tenantId ?? null,
    });
  }
  for (const refund of input.refunds) {
    if (usedRefunds.has(refund) || !inWindow(refund.at)) continue;
    items.push({
      status: 'REFUND_NOT_IN_BANK',
      kind: 'REFUND',
      line: null,
      at: refund.at,
      bankAmountCents: null,
      oursAmountCents: refund.amountCents,
      reference: refund.paymentReferences[0] ?? null,
      terminal: null,
      authCode: null,
      paymentId: refund.paymentId,
      refundId: refund.refundId,
      tenantId: refund.tenantId,
    });
  }
  return {
    items,
    bankTotalCents: sum(saleRows) - sum(refundRows),
    oursTotalCents:
      sum(input.sales.filter((x) => inWindow(x.at))) - sum(input.refunds.filter((x) => inWindow(x.at))),
  };
}

function sum(list: Array<{ amountCents: number }>): number {
  return list.reduce((acc, x) => acc + x.amountCents, 0);
}

function saleItem(row: BankRow, sale: OurSale): ReconItem {
  return {
    ...bankSide(row, 'SALE'),
    status: row.amountCents === sale.amountCents ? 'MATCHED' : 'AMOUNT_MISMATCH',
    oursAmountCents: sale.amountCents,
    reference: row.reference ?? sale.references[0] ?? null,
    paymentId: sale.paymentId,
    tenantId: sale.tenantId,
  };
}

function bankSide(row: BankRow, kind: 'SALE' | 'REFUND'): Omit<ReconItem, 'status'> {
  return {
    kind,
    line: row.line,
    at: row.at,
    bankAmountCents: row.amountCents,
    oursAmountCents: null,
    reference: row.reference,
    terminal: row.terminal,
    authCode: row.authCode,
    paymentId: null,
    refundId: null,
    tenantId: null,
  };
}

function indexByReference<T>(list: T[], refs: (t: T) => string[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of list) {
    for (const ref of refs(item)) {
      const key = referenceKey(ref);
      if (key && !map.has(key)) map.set(key, item);
    }
  }
  return map;
}

function closestSale(row: BankRow, sales: OurSale[], used: Set<OurSale>): OurSale | null {
  let best: OurSale | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const sale of sales) {
    if (used.has(sale) || sale.amountCents !== row.amountCents) continue;
    const sameAuth = Boolean(row.authCode && sale.authCode && row.authCode.trim() === sale.authCode.trim());
    if (row.reference && sale.references.length > 0 && !sameAuth) continue;
    if (row.authCode && sale.authCode && !sameAuth) continue;
    if (row.terminal && sale.terminal && row.terminal.trim() !== sale.terminal.trim()) continue;
    const gap = row.at ? Math.abs(row.at.getTime() - sale.at.getTime()) : 0;
    if (row.at && gap > FALLBACK_WINDOW_MS) continue;
    if (gap < bestGap) {
      best = sale;
      bestGap = gap;
    }
  }
  return best;
}

function matchRefund(row: BankRow, refunds: OurRefund[], used: Set<OurRefund>): OurRefund | null {
  const key = row.reference ? referenceKey(row.reference) : '';
  const candidates = refunds.filter((r) => !used.has(r) && r.amountCents === row.amountCents);
  if (key) {
    const byRef = candidates.find((r) => r.paymentReferences.some((p) => referenceKey(p) === key));
    if (byRef) return byRef;
  }
  // Sin referencia que case: solo con devoluciones de aquí sin referencia (o
  // filas del banco sin ella), la misma cantidad y cerca en el tiempo.
  const loose = candidates.filter((r) => !key || r.paymentReferences.length === 0);
  if (!row.at) return loose[0] ?? null;
  let best: OurRefund | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const r of loose) {
    const gap = Math.abs(row.at.getTime() - r.at.getTime());
    if (gap > REFUND_FALLBACK_WINDOW_MS) continue;
    if (gap < bestGap) {
      best = r;
      bestGap = gap;
    }
  }
  return best;
}

/**
 * Lo que anula una anulación (una venta o una devolución): misma referencia
 * e importe; sin referencia, mismo importe y datáfono en las horas anteriores.
 */
function findVoided(v: BankRow, rows: BankRow[], taken: Set<BankRow>): BankRow | null {
  const open = rows.filter((r) => (r.kind === 'SALE' || r.kind === 'REFUND') && !taken.has(r));
  if (v.reference) {
    const key = referenceKey(v.reference);
    const byRef = open.filter((r) => r.reference && referenceKey(r.reference) === key);
    const sameAmount = byRef.filter((r) => r.amountCents === v.amountCents);
    return sameAmount[sameAmount.length - 1] ?? byRef[byRef.length - 1] ?? null;
  }
  const before = open.filter(
    (r) =>
      r.amountCents === v.amountCents &&
      (!v.terminal || !r.terminal || r.terminal === v.terminal) &&
      (!v.at ||
        !r.at ||
        (r.at.getTime() <= v.at.getTime() && v.at.getTime() - r.at.getTime() <= VOID_FALLBACK_WINDOW_MS)),
  );
  return before.length > 0 ? before[before.length - 1]! : null;
}
