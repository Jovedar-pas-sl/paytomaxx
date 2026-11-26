import { SERVICE_FEE_LABEL, evaluateCash, withServiceFee, type CashReason, type MoneyMap, type WalletsAdminStats, type NightCash, type NightCloseCheck, type NightCloseStep } from '@nightpay/contracts';
import { CASH_TOP_UP_LABEL } from '../reports/export-summary';
import type { NightView } from './nights.service';

/**
 * Cierre a ciegas (decisión del dueño, 26-nov-2026): con la noche ABIERTA, a
 * la encargada (MANAGER) no le llegan el fondo, las recargas en efectivo, el
 * saldo devuelto en efectivo ni la caja esperada: con ellas se saca lo que
 * «debería haber» y se cuadra a ojo. Tampoco los totales de los que saldrían
 * restando. El dueño (OWNER) lo ve todo; con la noche cerrada, todos como
 * siempre.
 */
export function blindsCash(role: string, open: boolean): boolean {
  return role === 'MANAGER' && open;
}

/**
 * ¿Unas fechas [from, to) tocan la noche abierta (que cuenta desde
 * `openFrom`, el cierre anterior)? Entonces también van a ciegas: si no, con
 * un periodo que acaba ahora se saca la caja de la noche.
 */
export function overlapsOpenNight(to: Date | string, openFrom: Date | null): boolean {
  return openFrom !== null && new Date(to).getTime() > openFrom.getTime();
}

/**
 * Noches → «En vivo» sin las cifras del efectivo, ni lo cobrado, el neto o la
 * comisión del servicio con ellas dentro (restando, se sacarían): todo va como
 * si en la noche no hubiera habido efectivo.
 */
export function blindNightView(v: NightView): NightView {
  const {
    walletCashTopUpsCount: _n,
    walletCashTopUpsCents: cashTopUps = 0,
    serviceFeeCashCents: cashFee = 0,
    serviceFeeCents,
    serviceFeeRefundedCents,
    serviceFeeNetCents,
    ...summary
  } = v.z.summary;
  const cashPayouts = summary.walletCashPayoutsCents;
  const cashIn = cashTopUps + cashFee;
  const fee =
    serviceFeeCents === undefined
      ? {}
      : withServiceFee({
          serviceFeeCents: serviceFeeCents - cashFee,
          serviceFeeRefundedCents: serviceFeeRefundedCents ?? 0,
          serviceFeeNetCents: (serviceFeeNetCents ?? 0) - cashFee,
        });
  return {
    ...v,
    openingFloatCents: null,
    cashHidden: true,
    z: {
      ...v.z,
      summary: {
        ...summary,
        chargedCents: summary.chargedCents - cashIn,
        netCents: summary.netCents - cashIn + cashPayouts,
        venueNetCents: summary.venueNetCents - cashTopUps + cashPayouts,
        ...fee,
        walletCashPayoutsCount: 0,
        walletCashPayoutsCents: 0,
        byType: summary.byType
          .filter((t) => t.label !== CASH_TOP_UP_LABEL)
          .map((t) => (t.label === SERVICE_FEE_LABEL ? { ...t, chargedCents: t.chargedCents - cashFee } : t))
          // La de la comisión, si solo era de recargas en efectivo, tampoco.
          .filter((t) => t.label !== SERVICE_FEE_LABEL || t.chargedCents !== 0),
      },
    },
  };
}

/**
 * El mapa del dinero sin la caja esperada ni lo que la forma, y sin nada de
 * lo que saldría restando: el total de «dónde está», las recargas, la
 * comisión del servicio y «de quién es» van como si no hubiera efectivo (y
 * siguen sumando lo mismo entre ellos). El saldo vivo del local, tampoco.
 */
export function blindMoneyMap(m: MoneyMap): MoneyMap {
  const { inflow, where, outflow } = m;
  const cashTopUps = inflow.topUps.cashCents;
  const cashFee = m.serviceFee?.cashCents ?? 0;
  const cashPayouts = outflow.refunds.cashCents;
  const totalCents = where.totalCents - where.cashBoxCents;
  const saldoCents = where.owners.saldoCents - cashTopUps + cashPayouts;
  const oxioPayCents = where.owners.oxioPayCents === undefined ? undefined : where.owners.oxioPayCents - cashFee;
  const venueCents =
    totalCents -
    where.owners.staffCents -
    saldoCents -
    (oxioPayCents ?? 0) -
    (where.owners.paidOutCents ?? 0) -
    (where.owners.commissionsCents ?? 0);
  return {
    ...m,
    inflow: {
      ...inflow,
      cashCents: 0,
      topUps: { ...inflow.topUps, totalCents: inflow.topUps.totalCents - cashTopUps, cashCents: 0 },
      ...(inflow.serviceFeeCents !== undefined ? { serviceFeeCents: inflow.serviceFeeCents - cashFee } : {}),
    },
    where: {
      ...where,
      totalCents,
      cashBoxCents: 0,
      cashBox: { openingFloatCents: null, inCents: 0, outCents: 0 },
      cashHidden: true,
      owners: {
        ...where.owners,
        venueCents,
        saldoCents,
        ...(oxioPayCents !== undefined ? { oxioPayCents } : {}),
      },
      liveSaldoCents: null,
    },
    outflow: {
      ...outflow,
      refunds: { ...outflow.refunds, cashCents: 0, cashCount: 0 },
      ...(outflow.serviceFeeCents !== undefined ? { serviceFeeCents: outflow.serviceFeeCents - cashFee } : {}),
    },
    ...(m.serviceFee
      ? {
          serviceFee: {
            ...m.serviceFee,
            topUpsCents: m.serviceFee.topUpsCents - cashFee,
            owedCents: m.serviceFee.owedCents - cashFee,
            cashCents: 0,
          },
        }
      : {}),
  };
}

/** Lo que dice el paso «Efectivo» a ciegas, sin cifras (el fondo, lo esperado o lo que se movió). */
export const BLIND_CASH_STEP_DETAIL: Record<'count' | 'float-missing' | 'float-changed' | 'negative' | 'not-needed', string> = {
  count: 'Cuenta el efectivo de la caja, escríbelo y pulsa «Ver si cuadra»: el API te dice si cuadra o la diferencia.',
  'float-missing': 'Apunta con cuánto empezó la caja (el fondo) y cuéntala.',
  'float-changed': 'El fondo no es el que se apuntó al abrir: cambiarlo lo aprueba el dueño con su 2FA. Deja el que se apuntó o pídeselo.',
  negative: 'Lo que debería haber sale negativo: revisa el fondo y los pagos en efectivo de la noche, o avisa al dueño.',
  'not-needed': 'Sin efectivo esta noche: no hace falta contar la caja.',
};

/** Al cerrar a ciegas, lo contado ya se vio en «Ver si cuadra»: el 409 no repite si cuadra ni la diferencia. */
export const BLIND_CLOSE_COUNTED_DETAIL =
  'Lo contado ya pasó por «Ver si cuadra»: si no cuadraba, confírmalo y explica la diferencia en la nota.';

/** El efectivo de la noche sin ninguna cifra: solo si hay que contar y si se apuntó el fondo. */
export function blindNightCash(cash: NightCash): NightCash {
  const required = cash.cashInCents > 0 || cash.cashOutCents > 0 || (cash.openingFloatCents ?? 0) > 0;
  return {
    openingFloatCents: null,
    cashInCents: 0,
    walletCashTopUpsCount: 0,
    walletCashTopUpsCents: 0,
    walletCashPayoutsCount: 0,
    walletCashPayoutsCents: 0,
    chicaCashPayoutsCount: 0,
    chicaCashPayoutsCents: 0,
    cashOutCents: 0,
    expectedCents: 0,
    cashHidden: true,
    floatRecorded: cash.openingFloatCents !== null,
    countRequired: required,
  };
}

/** El paso «Efectivo» sin cifras: sin los importes de sus apuntes y con un texto que no las lleva. */
export function blindCashStep(step: NightCloseStep, detail?: string): NightCloseStep {
  if (step.key !== 'efectivo') return step;
  return {
    ...step,
    count: 0,
    detail: detail ?? step.detail,
    items: [],
  };
}

/** El texto a ciegas para cada resultado del arqueo (null: el suyo no lleva cifras que no se sepan ya). */
export function blindCashDetail(reason: CashReason): string | null {
  switch (reason) {
    case 'count-missing':
      return BLIND_CASH_STEP_DETAIL.count;
    case 'float-missing':
    case 'float-changed':
    case 'negative':
    case 'not-needed':
      return BLIND_CASH_STEP_DETAIL[reason];
    // «Faltan / Sobran X» y «Cuadra»: al contar, eso sí se dice.
    case 'short':
    case 'over':
    case 'matches':
      return null;
  }
}

/**
 * El texto del paso «Efectivo» en el 409 del cierre a ciegas: nunca la
 * diferencia (si no, se prueba una cifra al cerrar y se corrige).
 */
export function blindCloseRefusalDetail(reason: CashReason): string {
  return blindCashDetail(reason) ?? BLIND_CLOSE_COUNTED_DETAIL;
}

/** Los pasos del cierre para la encargada: el de «Efectivo», a ciegas. */
export function blindCloseCheck(c: NightCloseCheck): NightCloseCheck {
  const detail = blindCashDetail(evaluateCash(c.cash).reason) ?? BLIND_CASH_STEP_DETAIL.count;
  return { ...c, cash: blindNightCash(c.cash), steps: c.steps.map((s) => blindCashStep(s, detail)) };
}

/** Saldos → las cifras de la noche sin el efectivo: recargas y lo devuelto, solo con tarjeta. */
export function blindWalletStats(s: WalletsAdminStats): WalletsAdminStats {
  const { todayCashTopUpsCents = 0, todayCashRefundsCents = 0, ...rest } = s;
  return {
    ...rest,
    todayTopUpsCents: Math.max(0, s.todayTopUpsCents - todayCashTopUpsCents),
    todayRefundsCents: Math.max(0, s.todayRefundsCents - todayCashRefundsCents),
    cashHidden: true,
  };
}
