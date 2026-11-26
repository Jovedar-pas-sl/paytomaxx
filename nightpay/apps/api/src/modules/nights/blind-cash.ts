import type { MoneyMap } from '@nightpay/contracts';
import { CASH_TOP_UP_LABEL } from '../reports/export-summary';
import type { NightView } from './nights.service';

/**
 * Cierre a ciegas (decisión del dueño, 26-nov-2026): con la noche ABIERTA, a
 * la encargada (MANAGER) no le llegan el fondo, las recargas en efectivo, el
 * saldo devuelto en efectivo ni la caja esperada: con ellas se saca lo que
 * «debería haber» y se cuadra a ojo. El dueño (OWNER) lo ve todo; con la
 * noche cerrada, todos como siempre.
 */
export function blindsCash(role: string, open: boolean): boolean {
  return role === 'MANAGER' && open;
}

/** Noches → «En vivo» sin las cifras del efectivo (las demás, igual). */
export function blindNightView(v: NightView): NightView {
  const { walletCashTopUpsCount: _n, walletCashTopUpsCents: _c, serviceFeeCashCents: _f, ...summary } = v.z.summary;
  return {
    ...v,
    openingFloatCents: null,
    cashHidden: true,
    z: {
      ...v.z,
      summary: {
        ...summary,
        walletCashPayoutsCount: 0,
        walletCashPayoutsCents: 0,
        byType: summary.byType.filter((t) => t.label !== CASH_TOP_UP_LABEL),
      },
    },
  };
}

/** El mapa del dinero en directo sin la caja esperada ni lo que la forma (ni los totales de los que saldría restando). */
export function blindMoneyMap(m: MoneyMap): MoneyMap {
  const { inflow, where, outflow } = m;
  return {
    ...m,
    inflow: {
      ...inflow,
      cashCents: 0,
      topUps: { ...inflow.topUps, totalCents: inflow.topUps.totalCents - inflow.topUps.cashCents, cashCents: 0 },
    },
    where: {
      ...where,
      totalCents: where.totalCents - where.cashBoxCents,
      cashBoxCents: 0,
      cashBox: { openingFloatCents: null, inCents: 0, outCents: 0 },
      cashHidden: true,
    },
    outflow: { ...outflow, refunds: { ...outflow.refunds, cashCents: 0, cashCount: 0 } },
    ...(m.serviceFee ? { serviceFee: { ...m.serviceFee, cashCents: 0 } } : {}),
  };
}
