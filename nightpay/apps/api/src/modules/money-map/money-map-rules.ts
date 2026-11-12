import {
  LEGACY_SECTION,
  MONEY_MAP_TIPS,
  SECTION_CODES,
  isSectionCode,
  type MoneyMap,
  type MoneyMapPayoutGroup,
  type MoneyMapScope,
  type MoneyMapSection,
  type MoneyMapServiceFee,
  type SettlementConceptAmounts,
  withServiceFee,
} from '@nightpay/contracts';
import { chargeSections } from '../reports/charge-sections';
import type { TimeWindow } from '../reports/report-period';

/**
 * El mapa del dinero (lógica pura): de las filas del periodo (money-map.service)
 * a los cinco carriles. Por construcción, lo que entra (por canal) suma lo
 * mismo que lo vendido por sección, que lo repartido; y lo que hay en BBVA y
 * en la caja suma lo mismo que lo de cada dueño. Sin IVA.
 */

/** Cómo pagó un cobro (los del saldo, SALDO). */
export type SaleMethod = 'CARD' | 'MOBILE_WALLET' | 'POS' | 'CASH' | 'SALDO' | 'BITCOIN';

export interface SaleLineLike {
  category: string;
  amountCents: number;
}

/** Una venta del periodo: un cobro con tarjeta (sin las recargas) o un consumo del saldo. */
export interface SaleRow {
  amountCents: number;
  tipCents: number;
  /** Su sección principal (revenueCategory, o la del consumo): la de los cobros sin líneas y la de la propina. */
  category: string;
  method: SaleMethod;
  /** % de OxioPay (bps): el fijado en el cobro o el del local (0 con la «Comisión del servicio»). */
  platformBps: number;
  lines: readonly SaleLineLike[];
  /** «Comisión del servicio» que pagó el cliente encima (pagos directos; 0 en el saldo). */
  serviceFeeCents?: number;
  /**
   * Consumo del saldo: la parte del importe pagada con saldo cargado CON
   * comisión del servicio (ya la pagó el cliente): el % antiguo va solo sobre
   * el resto (wallet-fee-saldo.ts).
   */
  serviceFeeSaldoCents?: number;
}

/**
 * Lo del personal en el periodo: su parte de lo vendido (comisión + propinas)
 * menos lo descontado por las devoluciones del periodo, y lo que aún no se le
 * ha pagado.
 */
export interface StaffShare {
  grossCents: number;
  unpaidCents: number;
}

export interface MoneyMapInput {
  scope: MoneyMapScope;
  window: TimeWindow;
  now: Date;
  frozen: boolean;
  sales: readonly SaleRow[];
  /**
   * Recargas (el saldo) y su «Comisión del servicio» (con tarjeta, en efectivo y con bitcoin).
   * Las de bitcoin no entran en el banco: están en la cartera del local.
   */
  topUps: {
    cardCents: number;
    cardCount: number;
    cashCents: number;
    cashCount: number;
    cardFeeCents?: number;
    cashFeeCents?: number;
    bitcoinCents?: number;
    bitcoinCount?: number;
    bitcoinFeeCents?: number;
  };
  staff: { chicas: StaffShare; camareros: StaffShare };
  /**
   * Devoluciones hechas en el banco en el periodo (de cobros y de recargas), con
   * la comisión del servicio devuelta y, aparte, lo que era venta sin esa
   * comisión (salesNetCents): lo que el local deja de ganar.
   */
  cardRefunds: { cents: number; count: number; serviceFeeCents?: number; salesNetCents?: number };
  /** Devuelto fuera en bitcoin (desde la cartera del local): baja el bitcoin, no el banco. */
  bitcoinRefunds?: { cents: number; count: number };
  /** Saldo devuelto al cliente en el periodo (hechas). */
  walletPayouts: { cashCents: number; cashCount: number; cardCents: number };
  payouts: readonly MoneyMapPayoutGroup[];
  cashBox: { openingFloatCents: number | null; inCents: number; outCents: number; expectedCents: number };
  /** Tasa del banco (BANK_CARD_FEE_BPS); null = no se sabe. */
  bankFeeBps: number | null;
  liveSaldoCents: number | null;
  /** Por persona, sin compensar; la deuda por devoluciones tras pagar (debtCents) va aparte. */
  owed: { chicasCents: number; camarerosCents: number; debtCents?: number } | null;
}

const BPS = 10_000;

function sum<T>(xs: readonly T[], f: (x: T) => number): number {
  return xs.reduce((a, x) => a + f(x), 0);
}

/** Una sección conocida, o «Otros» (EXTRA) para lo de antes sin sección. */
export function sectionCodeOf(category: string | null | undefined): string {
  return isSectionCode(category) ? category : LEGACY_SECTION;
}

/** Lo de un cobro en cada sección (reports/charge-sections), con «Otros» para lo de antes sin sección. */
export function saleSections(sale: Pick<SaleRow, 'amountCents' | 'category' | 'lines'>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [category, cents] of chargeSections(sale)) {
    const code = sectionCodeOf(category);
    out.set(code, (out.get(code) ?? 0) + cents);
  }
  return out;
}

/** Por sección, en el orden de las secciones; «Otros» solo si hay; las propinas al final. */
export function sectionsOf(sales: readonly SaleRow[]): MoneyMapSection[] {
  const totals = new Map<string, { amountCents: number; count: number }>();
  const add = (code: string, cents: number) => {
    const cur = totals.get(code) ?? { amountCents: 0, count: 0 };
    totals.set(code, { amountCents: cur.amountCents + cents, count: cur.count + 1 });
  };
  for (const s of sales) {
    for (const [code, cents] of saleSections(s)) add(code, cents);
    if (s.tipCents !== 0) add(MONEY_MAP_TIPS, s.tipCents);
  }
  const row = (code: string): MoneyMapSection => ({ code, ...(totals.get(code) ?? { amountCents: 0, count: 0 }) });
  const legacy = totals.has(LEGACY_SECTION) ? [row(LEGACY_SECTION)] : [];
  return [...SECTION_CODES.map(row), ...legacy, row(MONEY_MAP_TIPS)];
}

/** La comisión de plataforma de una venta: su % sobre el importe, sin la propina (ni lo pagado con saldo de la comisión del servicio). */
function salePlatformCents(s: SaleRow): number {
  return Math.round(((s.amountCents - Math.max(0, s.serviceFeeSaldoCents ?? 0)) * s.platformBps) / BPS);
}

/** La comisión de OxioPay: su % sobre lo vendido, sin las propinas (ni lo pagado con saldo de la comisión del servicio). */
export function platformCommissionCents(sales: readonly SaleRow[]): number {
  return sum(sales, salePlatformCents);
}

/**
 * La «Comisión del servicio» del periodo: la de las ventas pagadas con tarjeta
 * (las del saldo no la llevan), la de las recargas (tarjeta y efectivo), la
 * devuelta y lo que se debe a OxioPay. Sin ella, todo a 0.
 */
export function serviceFeeOf(
  i: Pick<MoneyMapInput, 'sales' | 'topUps' | 'cardRefunds'>,
): MoneyMapServiceFee & { cardCents: number; bitcoinCents: number } {
  const salesCents = sum(i.sales, (s) => s.serviceFeeCents ?? 0);
  // La de bitcoin se cobra en la cartera del local, no en el banco.
  const bitcoinSalesCents = sum(i.sales.filter((s) => s.method === 'BITCOIN'), (s) => s.serviceFeeCents ?? 0);
  const bitcoinTopUps = i.topUps.bitcoinFeeCents ?? 0;
  const cardTopUps = i.topUps.cardFeeCents ?? 0;
  const cashCents = i.topUps.cashFeeCents ?? 0;
  const refundedCents = i.cardRefunds.serviceFeeCents ?? 0;
  return {
    salesCents,
    topUpsCents: cardTopUps + cashCents + bitcoinTopUps,
    cashCents,
    refundedCents,
    owedCents: salesCents + cardTopUps + cashCents + bitcoinTopUps - refundedCents,
    // La que entró por el banco (ventas con tarjeta y recargas con tarjeta).
    cardCents: salesCents - bitcoinSalesCents + cardTopUps,
    // La que entró en la cartera de bitcoin (ventas y recargas).
    bitcoinCents: bitcoinSalesCents + bitcoinTopUps,
  };
}

/**
 * Lo que el mapa pone como de OxioPay en el periodo, por concepto: la
 * «Comisión del servicio» cobrada (pagos directos, recargas con tarjeta y en
 * efectivo) menos la devuelta (serviceFeeOf → owedCents) y la comisión de
 * plataforma (platformCommissionCents), en los cobros y en los consumos del
 * saldo. La suma es owedCents + platformCents del mapa (oxioPayCentsOf): la
 * «Liquidación OxioPay» se calcula con esto, con las mismas filas.
 */
export function oxioPayOwedOf(i: Pick<MoneyMapInput, 'sales' | 'topUps' | 'cardRefunds'>): SettlementConceptAmounts {
  const fee = serviceFeeOf(i);
  return {
    serviceFeeSales: fee.salesCents,
    serviceFeeCardTopUps: fee.topUpsCents - fee.cashCents,
    serviceFeeCashTopUps: fee.cashCents,
    serviceFeeRefunded: -fee.refundedCents,
    platformSales: sum(i.sales.filter((s) => s.method !== 'SALDO'), salePlatformCents),
    platformSaldo: sum(i.sales.filter((s) => s.method === 'SALDO'), salePlatformCents),
  };
}

/** Lo de OxioPay de un mapa ya hecho: comisión del servicio que se le debe + comisión de plataforma. */
export function oxioPayCentsOf(map: Pick<MoneyMap, 'serviceFee' | 'split'>): number {
  return (map.serviceFee?.owedCents ?? 0) + map.split.commissions.platformCents;
}

export function buildMoneyMap(i: MoneyMapInput): MoneyMap {
  const byMethod = (m: SaleMethod) => sum(i.sales.filter((s) => s.method === m), (s) => s.amountCents + s.tipCents);
  const cardCents = byMethod('CARD');
  const mobileWalletCents = byMethod('MOBILE_WALLET');
  const posCents = byMethod('POS');
  const cardRailCents = cardCents + mobileWalletCents + posCents;
  const cashCents = byMethod('CASH');
  const saldoCents = byMethod('SALDO');
  const bitcoinCents = byMethod('BITCOIN');
  const salesCents = cardRailCents + cashCents + saldoCents + bitcoinCents;
  const { cardCents: feeCardCents, bitcoinCents: feeBitcoinCents, ...serviceFee } = serviceFeeOf(i);
  // Bitcoin (BTCPay): vendido y recargado con bitcoin + su comisión del servicio - lo devuelto fuera. No pasa por el banco.
  const bitcoinTopUpCents = i.topUps.bitcoinCents ?? 0;
  const bitcoinRefundedCents = i.bitcoinRefunds?.cents ?? 0;
  const bitcoinWalletCents = bitcoinCents + bitcoinTopUpCents + feeBitcoinCents - bitcoinRefundedCents;
  const hasBitcoin =
    bitcoinCents !== 0 || bitcoinTopUpCents !== 0 || feeBitcoinCents !== 0 || bitcoinRefundedCents !== 0 || (i.topUps.bitcoinCount ?? 0) > 0;

  const platformCents = platformCommissionCents(i.sales);
  // El banco cobra sobre todo lo que pasa por él: ventas con tarjeta, recargas
  // y la comisión del servicio que va con ellas.
  const bankCents =
    i.bankFeeBps === null ? null : Math.round(((cardRailCents + i.topUps.cardCents + feeCardCents) * i.bankFeeBps) / BPS);
  const commissionsCents = platformCents + (bankCents ?? 0);
  const chicasCents = i.staff.chicas.grossCents;
  const camarerosCents = i.staff.camareros.grossCents;

  // El dinero entra entero (también la comisión del servicio): al banco, la de tarjeta.
  const bbvaCents = cardRailCents + i.topUps.cardCents + feeCardCents - i.cardRefunds.cents;
  const cashBoxCents = i.cashBox.expectedCents;
  const totalCents = bbvaCents + cashBoxCents + bitcoinWalletCents;
  const staffCents = i.staff.chicas.unpaidCents + i.staff.camareros.unpaidCents;
  const topUpsCents = i.topUps.cardCents + i.topUps.cashCents + bitcoinTopUpCents;
  const saldoLeftCents = topUpsCents - saldoCents - i.walletPayouts.cashCents - i.walletPayouts.cardCents;
  // …pero la comisión del servicio no es del local: se debe a OxioPay.
  const oxioPayCents = serviceFee.owedCents;
  // Lo pagado al personal por banco o transferencia no resta de BBVA (se cuenta lo cobrado): tampoco es del local.
  const paidOutCents = i.payouts.reduce((sum, p) => (p.rail === 'MANUAL_CASH' ? sum : sum + p.cents), 0);

  return {
    scope: i.scope,
    from: i.window.from.toISOString(),
    to: i.window.to.toISOString(),
    generatedAt: i.now.toISOString(),
    frozen: i.frozen,
    salesCents,
    salesCount: i.sales.length,
    inflow: {
      cardRailCents,
      cardCents,
      mobileWalletCents,
      posCents,
      cashCents,
      saldoCents,
      ...(hasBitcoin ? { bitcoinCents } : {}),
      topUps: {
        totalCents: topUpsCents,
        cardCents: i.topUps.cardCents,
        cashCents: i.topUps.cashCents,
        ...(hasBitcoin ? { bitcoinCents: bitcoinTopUpCents } : {}),
        count: i.topUps.cardCount + i.topUps.cashCount + (i.topUps.bitcoinCount ?? 0),
      },
      ...withServiceFee({ serviceFeeCents: serviceFee.salesCents + serviceFee.topUpsCents }),
    },
    sections: sectionsOf(i.sales),
    split: {
      venueCents: salesCents - chicasCents - camarerosCents - commissionsCents,
      chicasCents,
      camarerosCents,
      commissions: { platformCents, bankCents, totalCents: commissionsCents },
    },
    where: {
      bbvaCents,
      ...(hasBitcoin ? { bitcoinCents: bitcoinWalletCents } : {}),
      cashBoxCents,
      cashBox: { openingFloatCents: i.cashBox.openingFloatCents, inCents: i.cashBox.inCents, outCents: i.cashBox.outCents },
      totalCents,
      owners: {
        venueCents: totalCents - staffCents - saldoLeftCents - oxioPayCents - paidOutCents - commissionsCents,
        staffCents,
        saldoCents: saldoLeftCents,
        paidOutCents,
        commissionsCents,
        ...withServiceFee({ oxioPayCents }),
      },
      liveSaldoCents: i.liveSaldoCents,
      owed: i.owed,
    },
    outflow: {
      payouts: [...i.payouts].sort((a, b) => b.cents - a.cents),
      pendingStaff: { chicasCents: i.staff.chicas.unpaidCents, camarerosCents: i.staff.camareros.unpaidCents },
      refunds: {
        cardCents: i.cardRefunds.cents,
        cardCount: i.cardRefunds.count,
        cashCents: i.walletPayouts.cashCents,
        cashCount: i.walletPayouts.cashCount,
        ...(i.cardRefunds.salesNetCents !== undefined ? { salesCents: i.cardRefunds.salesNetCents } : {}),
      },
      commissionsCents,
      ...withServiceFee({ serviceFeeCents: oxioPayCents }),
    },
    // Sin comisión del servicio, el mapa es el de siempre.
    ...(Object.keys(withServiceFee(serviceFee)).length > 0 ? { serviceFee } : {}),
  };
}

/** Cómo pagó un cobro con tarjeta (como la lista de cobros: cobros-rows.paymentMethodOf). */
export function saleMethodOf(p: {
  captureMethod: string | null;
  posOperationNumber: string | null;
  approvedPayMethod: string | null;
  /** El proveedor del cobro: BTCPAY = pagado con bitcoin (no pasa por el banco). */
  provider?: string | null;
}): SaleMethod {
  if (p.provider === 'BTCPAY' || p.approvedPayMethod === 'bitcoin') return 'BITCOIN';
  if (p.captureMethod === 'CASH') return 'CASH';
  if (p.captureMethod === 'POS_EXTERNAL' || p.posOperationNumber) return 'POS';
  if (p.approvedPayMethod === 'wallet') return 'MOBILE_WALLET';
  return 'CARD';
}

/** El mapa congelado en un Z (los Z de antes del 24-oct-2026 no lo traen). */
export function frozenMoneyMapOf(z: unknown): MoneyMap | null {
  if (!z || typeof z !== 'object') return null;
  const m = (z as { moneyMap?: unknown }).moneyMap;
  if (!m || typeof m !== 'object' || typeof (m as MoneyMap).salesCents !== 'number') return null;
  return { ...(m as MoneyMap), frozen: true };
}
