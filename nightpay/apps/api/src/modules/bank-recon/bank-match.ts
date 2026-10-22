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
  /**
   * Datáfono que lo cobró, tal como lo nombra el fichero (su identificador o
   * su número de serie); null si no se sabe o el fichero no lo trae.
   */
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
  /** Datáfono del cobro devuelto, como lo nombra el fichero (ver OurSale). */
  terminal?: string | null;
  amountCents: number;
  at: Date;
}

/** Cobro de aquí que el banco tiene como cobrado y aquí NO figura como pagado. */
export interface StrayPayment {
  paymentId: string;
  tenantId: string;
  references: string[];
  /** Datáfono, como lo nombra el fichero (ver OurSale). */
  terminal?: string | null;
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
   * Los nombres de datáfono del fichero que son de un datáfono nuestro (Paytef).
   * Un nombre que no está aquí es de un datáfono que no sabemos cuál es: solo
   * casa con lo nuestro cuyo datáfono no sale con nombre en el fichero.
   */
  knownTerminals?: ReadonlySet<string>;
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
  const known = input.knownTerminals ?? new Set<string>();
  const saleByRef = indexByReference(input.sales, (s) => s.references);
  const strayByRef = indexByReference(input.strays, (s) => s.references);
  const sameRefAndTerminal = <T extends { terminal?: string | null }>(row: BankRow, byRef: Map<string, T[]>): T[] => {
    const key = row.reference ? referenceKey(row.reference) : '';
    return key ? (byRef.get(key) ?? []).filter((x) => sameTerminal(row, x, known)) : [];
  };

  // 1) Por referencia (en Paytef, número de operación DENTRO de su datáfono:
  //    dos datáfonos repiten números). Si la referencia lleva a más de un cobro
  //    nuestro (pagado o no), no se elige ninguno: ni por orden ni por importe.
  const pending: BankRow[] = [];
  for (const row of saleRows) {
    const candidates = sameRefAndTerminal(row, saleByRef);
    const strayCandidates = sameRefAndTerminal(row, strayByRef);
    if (candidates.length + strayCandidates.length > 1) {
      items.push({ ...bankSide(row, 'SALE'), status: 'NOT_IN_OXIOPAY' });
      continue;
    }
    const sale = candidates[0];
    if (sale && !usedSales.has(sale)) {
      usedSales.add(sale);
      items.push(saleItem(row, sale));
      continue;
    }
    const stray = strayCandidates[0];
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
    // Su cobro ya lo casó otra línea (línea repetida): no se casa con otro por importe.
    if (sale) items.push({ ...bankSide(row, 'SALE'), status: 'NOT_IN_OXIOPAY' });
    else pending.push(row);
  }

  // 2) Sin referencia que case: importe + autorización + hora.
  for (const row of pending) {
    const sale = closestSale(row, input.sales, usedSales, known);
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
    const refund = matchRefund(row, input.refunds, usedRefunds, known);
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
    // De qué cobro es, solo si la referencia lleva a uno solo.
    const ofCandidates = [...sameRefAndTerminal(row, saleByRef), ...sameRefAndTerminal(row, strayByRef)];
    const of = ofCandidates.length === 1 ? ofCandidates[0] : undefined;
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
      terminal: refund.terminal ?? null,
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

function indexByReference<T>(list: T[], refs: (t: T) => string[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of list) {
    for (const ref of refs(item)) {
      const key = referenceKey(ref);
      if (key) {
        const items = map.get(key) ?? [];
        if (!items.includes(item)) items.push(item);
        map.set(key, items);
      }
    }
  }
  return map;
}

/**
 * ¿Puede ser lo nuestro (cobro, devolución) de este datáfono del fichero?
 * Sin datáfono en la línea, cualquiera (ficheros sin esa columna). Si lo
 * nuestro tiene nombre en el fichero, el mismo. Si no lo tiene (no se sabe su
 * datáfono, o el suyo no sale en el fichero), solo una línea de un datáfono
 * que no es ninguno de los conocidos.
 */
export function sameTerminal(row: BankRow, ours: { terminal?: string | null }, known: ReadonlySet<string>): boolean {
  const bank = row.terminal?.trim();
  if (!bank) return true;
  const mine = ours.terminal?.trim();
  return mine ? bank === mine : !known.has(bank);
}

/** Dos líneas del fichero del mismo datáfono (o sin él en alguna). */
function sameBankTerminal(a: BankRow, b: BankRow): boolean {
  const x = a.terminal?.trim();
  const y = b.terminal?.trim();
  return !x || !y || x === y;
}

/** La más cercana en el tiempo; un empate entre dos distintas, ninguna (ambiguo). */
function closest<T>(list: T[], gapOf: (t: T) => number, same: (a: T, b: T) => boolean = () => false): T | null {
  let best: T | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  let tied = false;
  for (const item of list) {
    const gap = gapOf(item);
    if (gap < bestGap) {
      best = item;
      bestGap = gap;
      tied = false;
    } else if (gap === bestGap && best !== null && !same(best, item)) {
      tied = true;
    }
  }
  return tied ? null : best;
}

function closestSale(row: BankRow, sales: OurSale[], used: Set<OurSale>, known: ReadonlySet<string>): OurSale | null {
  const fits = sales.filter((sale) => {
    if (used.has(sale) || sale.amountCents !== row.amountCents) return false;
    const sameAuth = Boolean(row.authCode && sale.authCode && row.authCode.trim() === sale.authCode.trim());
    if (row.reference && sale.references.length > 0 && !sameAuth) return false;
    if (row.authCode && sale.authCode && !sameAuth) return false;
    if (!sameTerminal(row, sale, known)) return false;
    return !row.at || Math.abs(row.at.getTime() - sale.at.getTime()) <= FALLBACK_WINDOW_MS;
  });
  return closest(fits, (sale) => (row.at ? Math.abs(row.at.getTime() - sale.at.getTime()) : 0));
}

/**
 * La devolución nuestra de una línea de devolución del banco: el mismo
 * importe y datáfono y, con referencia, del cobro de esa referencia. Dos
 * devoluciones iguales del MISMO cobro son intercambiables (dos parciales de
 * 5 €): se coge la más cercana. Si la referencia lleva a cobros distintos,
 * ninguna. Sin referencia, la más cercana en el tiempo (un empate, ninguna).
 */
function matchRefund(row: BankRow, refunds: OurRefund[], used: Set<OurRefund>, known: ReadonlySet<string>): OurRefund | null {
  const key = row.reference ? referenceKey(row.reference) : '';
  const fits = refunds.filter((r) => !used.has(r) && r.amountCents === row.amountCents && sameTerminal(row, r, known));
  const gap = (r: OurRefund) => (row.at ? Math.abs(row.at.getTime() - r.at.getTime()) : 0);
  const samePayment = (a: OurRefund, b: OurRefund) => a.paymentId === b.paymentId;
  if (key) {
    const byRef = fits.filter((r) => r.paymentReferences.some((p) => referenceKey(p) === key));
    if (byRef.length > 0) {
      return byRef.every((r) => r.paymentId === byRef[0]!.paymentId) ? closest(byRef, gap, () => true) : null;
    }
  }
  // Sin referencia que case: solo con devoluciones de aquí sin referencia (o
  // filas del banco sin ella), la misma cantidad y cerca en el tiempo.
  const loose = fits.filter(
    (r) => (!key || r.paymentReferences.length === 0) && (!row.at || gap(r) <= REFUND_FALLBACK_WINDOW_MS),
  );
  return closest(loose, gap, samePayment);
}

/**
 * Lo que anula una anulación (una venta o una devolución): misma referencia
 * e importe, del mismo datáfono; sin referencia, mismo importe y datáfono en
 * las horas anteriores. Si puede ser de más de una operación distinta (otro
 * datáfono, o una venta y una devolución), no anula ninguna.
 */
function findVoided(v: BankRow, rows: BankRow[], taken: Set<BankRow>): BankRow | null {
  const open = rows.filter((r) => (r.kind === 'SALE' || r.kind === 'REFUND') && !taken.has(r) && sameBankTerminal(v, r));
  if (v.reference) {
    const key = referenceKey(v.reference);
    const byRef = open.filter((r) => r.reference && referenceKey(r.reference) === key);
    // El mismo número en dos datáfonos y la anulación sin datáfono: no se elige por importe.
    if (new Set(byRef.map((r) => r.terminal?.trim() ?? '')).size > 1) return null;
    const sameAmount = byRef.filter((r) => r.amountCents === v.amountCents);
    return sameAmount.length > 0 ? onlyOperation(sameAmount) : onlyOperation(byRef);
  }
  const before = open.filter(
    (r) =>
      r.amountCents === v.amountCents &&
      (!v.at ||
        !r.at ||
        (r.at.getTime() <= v.at.getTime() && v.at.getTime() - r.at.getTime() <= VOID_FALLBACK_WINDOW_MS)),
  );
  return onlyOperation(before);
}

/**
 * Si todas son la misma operación repetida (tipo, importe y datáfono), la
 * última; si son operaciones distintas, ninguna.
 */
function onlyOperation(list: BankRow[]): BankRow | null {
  const last = list[list.length - 1];
  if (!last) return null;
  const terminal = (r: BankRow) => r.terminal?.trim() ?? '';
  const same = list.every((r) => r.kind === last.kind && r.amountCents === last.amountCents && terminal(r) === terminal(last));
  return same ? last : null;
}
