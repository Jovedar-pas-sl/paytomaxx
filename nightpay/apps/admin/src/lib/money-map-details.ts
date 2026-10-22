import type { MoneyMap } from '@nightpay/contracts';
import { moneyMapIsCurrent, railNote } from './money-map-view';

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

/** Desgloses del mismo periodo que las barras. null significa desconocido, nunca cero. */
export function moneyMapDetails(m: MoneyMap): Record<'inflow' | 'topUps' | 'split' | 'cash' | 'owed' | 'outflow', MoneyDetail> {
  const { inflow: i, split: s, where: w, outflow: o } = m;
  const when = moneyMapIsCurrent(m) ? 'ahora' : 'al corte';
  return {
    inflow: {
      title: 'Detalle de entradas',
      note: `${m.salesCount} cobros. Las ventas incluyen las propinas; las recargas se muestran aparte para no contar dos veces el mismo dinero.`,
      rows: [
        { label: 'Tarjeta', cents: i.cardCents },
        { label: 'Apple Pay / Google Pay', cents: i.mobileWalletCents },
        { label: 'Datáfono', cents: i.posCents },
        { label: 'Ventas en efectivo', cents: i.cashCents },
        { label: 'Consumos del saldo', cents: i.saldoCents },
      ],
    },
    topUps: {
      title: 'Detalle de recargas',
      note: 'Dinero que el cliente carga para gastar después. Es saldo del cliente, todavía no una venta.',
      rows: [
        { label: 'Total recargado', cents: i.topUps.totalCents, count: i.topUps.count },
        { label: 'Con tarjeta', cents: i.topUps.cardCents },
        { label: 'En efectivo', cents: i.topUps.cashCents },
      ],
    },
    split: {
      title: 'Detalle del reparto',
      note: 'Reparto de las ventas del periodo. La parte del local no es el saldo de caja ni el beneficio neto. La comisión bancaria solo se incluye cuando está configurada.',
      rows: [
        { label: 'Para el local', cents: s.venueCents },
        { label: 'Para las chicas', cents: s.chicasCents },
        { label: 'Para los camareros', cents: s.camarerosCents },
        { label: 'Comisión OxioPay', cents: s.commissions.platformCents },
        { label: 'Comisión bancaria', cents: s.commissions.bankCents },
      ],
    },
    cash: {
      title: 'Detalle de caja y banco',
      note: 'Caja esperada: fondo + entradas − salidas. No sustituye el arqueo. Banco: cobros y recargas con tarjeta menos devoluciones; la fecha de abono se confirma con el banco.',
      rows: [
        { label: 'Fondo inicial', cents: w.cashBox.openingFloatCents },
        { label: 'Entradas en efectivo', cents: w.cashBox.inCents },
        { label: 'Salidas en efectivo', cents: w.cashBox.outCents },
        { label: 'Caja esperada', cents: w.cashBoxCents },
        { label: 'Cobrado por banco, neto de devoluciones', cents: w.bbvaCents },
      ],
    },
    owed: {
      title: 'Saldo y deudas pendientes',
      note: m.frozen ? 'Datos conservados al cerrar la noche. El saldo y la deuda total pueden incluir operaciones de noches anteriores.' :
        m.scope.kind === 'period' ? 'La variación del periodo y los totales al corte son conceptos distintos. Si no hay una cifra histórica disponible, se indica.' :
        'La deuda total y el saldo real de clientes incluyen también noches anteriores. Se distinguen de lo generado en este periodo.',
      rows: [
        { label: 'Pendiente a chicas de este periodo', cents: o.pendingStaff.chicasCents },
        { label: 'Pendiente a camareros de este periodo', cents: o.pendingStaff.camarerosCents },
        { label: `Deuda total a chicas ${when}`, cents: w.owed?.chicasCents ?? null },
        { label: `Deuda total a camareros ${when}`, cents: w.owed?.camarerosCents ?? null },
        { label: 'Variación del saldo del periodo', cents: w.owners.saldoCents },
        { label: `Saldo real de clientes ${when}`, cents: w.liveSaldoCents },
      ],
    },
    outflow: {
      title: 'Pagos y devoluciones',
      note: 'Pagos al personal ya realizados y devoluciones del periodo. Los importes pendientes de pagar se muestran aparte. Las comisiones son las calculadas, no una confirmación de cargo bancario.',
      rows: [
        ...o.payouts.map((p) => ({ label: `${p.who === 'chicas' ? 'Pagado a chicas' : 'Pagado a camareros'} · ${railNote(p.rail)}`, cents: p.cents, count: p.count })),
        { label: 'Devuelto a tarjeta', cents: o.refunds.cardCents, count: o.refunds.cardCount },
        { label: 'Devuelto en efectivo', cents: o.refunds.cashCents, count: o.refunds.cashCount },
        { label: 'Comisiones calculadas', cents: o.commissionsCents },
      ],
    },
  };
}
