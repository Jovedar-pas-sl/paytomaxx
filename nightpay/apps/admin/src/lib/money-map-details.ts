import type { MoneyMap } from '@nightpay/contracts';
import { PARTNER_CASH_LABEL, moneyMapIsCurrent, railNote } from './money-map-view';

export interface MoneyDetailRow {
  label: string;
  cents: number | null;
  count?: number;
}
export interface MoneyDetail {
  title: string;
  note: string;
  rows: MoneyDetailRow[];
}

type MoneyDetails = Record<'inflow' | 'topUps' | 'split' | 'cash' | 'owed' | 'outflow', MoneyDetail> & {
  /** La «Comisión del servicio» (null sin ella, o en un mapa de antes). */
  serviceFee: MoneyDetail | null;
};

/** Desgloses del mismo periodo que las barras. null significa desconocido, nunca cero. */
export function moneyMapDetails(m: MoneyMap): MoneyDetails {
  const { inflow: i, split: s, where: w, outflow: o } = m;
  const when = moneyMapIsCurrent(m) ? 'ahora' : 'al corte';
  // Cierre a ciegas: la encargada con la noche abierta no recibe el efectivo de la caja (no es 0: no se sabe aquí).
  const cash = (cents: number | null): number | null => (w.cashHidden ? null : cents);
  return {
    serviceFee: serviceFeeDetail(m),
    inflow: {
      title: 'Detalle de entradas',
      note: `${m.salesCount} cobros. Las ventas incluyen las propinas; las recargas se muestran aparte para no contar dos veces el mismo dinero.`,
      rows: [
        { label: 'Tarjeta', cents: i.cardCents },
        { label: 'Apple Pay / Google Pay', cents: i.mobileWalletCents },
        { label: 'Datáfono', cents: i.posCents },
        { label: 'Ventas en efectivo', cents: cash(i.cashCents) },
        { label: 'Consumos del saldo', cents: i.saldoCents },
      ],
    },
    topUps: {
      title: 'Detalle de recargas',
      note: 'Dinero que el cliente carga para gastar después. Es saldo del cliente, todavía no una venta.',
      rows: [
        { label: 'Total recargado', cents: cash(i.topUps.totalCents), count: i.topUps.count },
        { label: 'Con tarjeta', cents: i.topUps.cardCents },
        { label: 'En efectivo', cents: cash(i.topUps.cashCents) },
      ],
    },
    split: {
      title: 'Detalle del reparto',
      note: 'Reparto de las ventas del periodo, antes de devoluciones: «¿Cuánto he ganado?» es «Para el local» menos lo devuelto de ventas. La parte del local no es el saldo de caja. La comisión bancaria solo se incluye cuando está configurada.',
      rows: [
        { label: 'Para el local', cents: s.venueCents },
        { label: 'Para las compañeras', cents: s.chicasCents },
        { label: 'Para los camareros', cents: s.camarerosCents },
        { label: 'Comisión OxioPay', cents: s.commissions.platformCents },
        { label: 'Comisión bancaria', cents: s.commissions.bankCents },
      ],
    },
    cash: {
      title: 'Detalle de caja y banco',
      note: 'Caja esperada: fondo + entradas − salidas. No sustituye el arqueo. Banco: cobros y recargas con tarjeta menos devoluciones; la fecha de abono se confirma con el banco.',
      rows: [
        { label: 'Fondo inicial', cents: cash(w.cashBox.openingFloatCents) },
        { label: 'Entradas en efectivo', cents: cash(w.cashBox.inCents) },
        { label: 'Salidas en efectivo', cents: cash(w.cashBox.outCents) },
        { label: 'Caja esperada', cents: cash(w.cashBoxCents) },
        { label: 'Cobrado por banco, neto de devoluciones', cents: w.bbvaCents },
        ...(w.bitcoinCents ? [{ label: 'Bitcoin, en la cartera del local', cents: w.bitcoinCents }] : []),
        // Fuera de la caja esperada: se cuenta en sus cajeros, contra «Movimientos» (solo si viene).
        ...(typeof w.partnerCashCents === 'number' ? [{ label: PARTNER_CASH_LABEL, cents: w.partnerCashCents }] : []),
      ],
    },
    owed: {
      title: 'Saldo y deudas pendientes',
      note: m.frozen ? 'Datos conservados al cerrar la noche. El saldo y la deuda total pueden incluir operaciones de noches anteriores.' :
        m.scope.kind === 'period' ? 'La variación del periodo y los totales al corte son conceptos distintos. Si no hay una cifra histórica disponible, se indica.' :
        'La deuda total y el saldo real de clientes incluyen también noches anteriores. Se distinguen de lo generado en este periodo.',
      rows: [
        { label: 'Pendiente a compañeras de este periodo', cents: o.pendingStaff.chicasCents },
        { label: 'Pendiente a camareros de este periodo', cents: o.pendingStaff.camarerosCents },
        { label: `Deuda total a compañeras ${when}`, cents: w.owed?.chicasCents ?? null },
        { label: `Deuda total a camareros ${when}`, cents: w.owed?.camarerosCents ?? null },
        // De la deuda, la de ventas por datáfono sin cuadrar con el banco: no se paga hasta cuadrarlas (H-1).
        ...(w.owed?.bankHeldCents ? [{ label: `De ella, pendiente de cuadrar con el banco ${when}`, cents: w.owed.bankHeldCents }] : []),
        // Lo que deben las compañeras por devoluciones tras pagarles: aparte, no resta de la deuda con las demás.
        ...(w.owed?.debtCents ? [{ label: `Te deben las compañeras por devoluciones ${when} (se descuenta de su próximo pago)`, cents: w.owed.debtCents }] : []),
        { label: 'Saldo nuevo de clientes (estas fechas)', cents: w.owners.saldoCents },
        { label: `Saldo real de clientes ${when}`, cents: w.liveSaldoCents },
      ],
    },
    outflow: {
      title: 'Pagos y devoluciones',
      note: 'Pagos al personal ya realizados y devoluciones del periodo. Los importes pendientes de pagar se muestran aparte. Las comisiones son las calculadas, no una confirmación de cargo bancario.',
      rows: [
        ...o.payouts.map((p) => ({ label: `${p.who === 'chicas' ? 'Pagado a compañeras' : 'Pagado a camareros'} · ${railNote(p.rail)}`, cents: p.cents, count: p.count })),
        { label: 'Devuelto a tarjeta', cents: o.refunds.cardCents, count: o.refunds.cardCount },
        // De eso, lo que era venta (sin recargas ni comisión del servicio): lo que resta «¿Cuánto he ganado?».
        ...(o.refunds.salesCents ? [{ label: '…de ello, de ventas (se resta de lo ganado)', cents: o.refunds.salesCents }] : []),
        { label: 'Devuelto en efectivo', cents: cash(o.refunds.cashCents), ...(w.cashHidden ? {} : { count: o.refunds.cashCount }) },
        { label: 'Comisiones calculadas', cents: o.commissionsCents },
      ],
    },
  };
}

function serviceFeeDetail(m: MoneyMap): MoneyDetail | null {
  const fee = m.serviceFee;
  if (!fee) return null;
  return {
    title: 'Comisión del servicio',
    note: 'La paga el cliente encima del precio (no las propinas ni lo que se gasta del saldo). Entra con el resto del cobro, al banco o a la caja, pero se debe a OxioPay: no es del local.',
    rows: [
      { label: 'En cobros con tarjeta o datáfono', cents: fee.salesCents },
      { label: 'En recargas del saldo', cents: fee.topUpsCents },
      { label: '…de ellas, en efectivo (está en la caja)', cents: m.where.cashHidden ? null : fee.cashCents },
      { label: 'Devuelta con las devoluciones', cents: -fee.refundedCents },
      { label: 'Se debe a OxioPay', cents: fee.owedCents },
    ],
  };
}
