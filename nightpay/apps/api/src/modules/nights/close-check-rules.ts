import {
  cashMovesCount,
  evaluateCash,
  type NightCash,
  type NightChicaPay,
  type NightCloseItem,
  type NightCloseStatus,
  type NightCloseStep,
} from '@nightpay/contracts';
import type { Incident } from '../incidents/incident-rules';
import { availableCentsOf } from '../operators/payout-math';
import { SALDOS_TAB_PATH } from '../wallets/saldo-texts';
import { formatWalletCode } from '../wallets/wallet-rules';

/**
 * Cierre de la noche en pasos: reglas puras. El servicio (close-check.service)
 * lee la base de datos y construye los pasos con esto; el panel enseña los
 * pasos y el API no deja cerrar si alguno bloquea o hay avisos sin confirmar
 * (nightCloseRefusal, en @nightpay/contracts).
 */

/** Un cobro esperando al banco menos de esto puede estar pagándose ahora: se espera. */
export const AUTHORIZING_WAIT_MINUTES = 15;
/** Un datáfono que empezó a cobrar hace menos de esto puede estar cobrando ahora. */
export const POS_RESULT_WAIT_MINUTES = 15;
/** Un datáfono vinculado sin dar señal en este rato se da por apagado o sin conexión. */
export const DEVICE_SILENT_MINUTES = 30;

/** Cobro de la noche sin terminar (mismo criterio que pendingAtClose del Z). */
export interface UnresolvedPaymentRow {
  id: string;
  status: string;
  amountCents: number;
  captureMethod: string | null;
  createdAt: Date;
  /** Última vez que cambió (entrada en AUTHORIZING). */
  updatedAt: Date;
  /** Venta del datáfono apuntada (tiene operación de Paytef). */
  deviceSale?: boolean;
}

/** Devolución por la pasarela que sigue sin confirmar. */
export interface PendingRefundRow {
  id: string;
  amountCents: number;
  createdAt: Date;
}

/** Cobro que un datáfono empezó y del que no llegó el resultado. */
export interface PosStartedRow {
  id: string;
  amountCents: number;
  status: string;
  startedAt: Date;
  terminalLabel: string | null;
}

/** Datáfono con ventas desde el cierre anterior y sin «Cuadrar con el datáfono» después de la última. */
export interface PosUnreconciledRow {
  terminalId: string;
  label: string;
  sales: number;
  cents: number;
  lastSaleAt: Date;
  lastReportAt: Date | null;
  lastSeenAt: Date | null;
}

/** Saldo devuelto a la tarjeta a medias (PENDING). */
export interface WalletPayoutPendingRow {
  id: string;
  amountCents: number;
  createdAt: Date;
  shortCode: string | null;
}

/** Cliente que pulsó «Me voy» y espera su saldo. */
export interface WalletCloseRequestedRow {
  id: string;
  balanceCents: number;
  shortCode: string | null;
}

/** Sumas de una chica (operator_earnings, payouts y deudas). */
export interface ChicaBalanceRow {
  operatorId: string;
  name: string;
  payoutMethod: string | null;
  payoutAddress: string | null;
  payoutLabel: string | null;
  /** Todo lo no pagado (comisión + propinas − devuelto). */
  unpaidCents: number;
  /** De lo no pagado, lo que aún está en espera. */
  heldCents: number;
  earnedTonightCents: number;
  paidTonightCents: number;
  paidTonightCount: number;
  debtCents: number;
}

export interface CloseCheckInput {
  now: Date;
  holdDays: number;
  payments: ReadonlyArray<UnresolvedPaymentRow>;
  refunds: ReadonlyArray<PendingRefundRow>;
  posStarted: ReadonlyArray<PosStartedRow>;
  posUnreconciled: ReadonlyArray<PosUnreconciledRow>;
  pairedDevices: number;
  walletPayouts: ReadonlyArray<WalletPayoutPendingRow>;
  walletsToClose: ReadonlyArray<WalletCloseRequestedRow>;
  cash: NightCash;
  chicas: ReadonlyArray<NightChicaPay>;
  incidents: ReadonlyArray<Incident>;
}

/** Los siete pasos, en el orden en que se hacen. */
export function buildCloseSteps(i: CloseCheckInput): NightCloseStep[] {
  return [
    cobrosStep(i.payments, i.refunds, i.now),
    datafonosStep(i.posStarted, i.posUnreconciled, i.pairedDevices, i.now),
    saldoStep(i.walletPayouts, i.walletsToClose),
    efectivoStep(i.cash),
    chicasStep(i.chicas, i.holdDays),
    incidenciasStep(i.incidents),
    zStep(),
  ];
}

// ─── 1. Cobros sin terminar ─────────────────────────────────────────

export function cobrosStep(
  payments: ReadonlyArray<UnresolvedPaymentRow>,
  refunds: ReadonlyArray<PendingRefundRow>,
  now: Date,
): NightCloseStep {
  const items: NightCloseItem[] = [
    ...payments.map((p) => paymentItem(p, now)),
    ...refunds.map((r) => ({
      id: r.id,
      status: 'warn' as const,
      label: `Devolución de ${eur(r.amountCents)} sin confirmar por el banco (hace ${minutesAgo(r.createdAt, now)})`,
      amountCents: r.amountCents,
    })),
  ];
  const status = worst(items);
  const detail =
    status === 'block'
      ? 'Hay un cliente pagando ahora mismo: espera o resuélvelo en Pagos.'
      : status === 'warn'
        ? 'Resuélvelos en Pagos. Si cierras igual, explica por qué en la nota: quedan apuntados como pendientes.'
        : 'Todos los cobros y devoluciones de la noche están terminados.';
  return step('cobros', 'Cobros sin terminar', status, detail, items, 'payments');
}

function paymentItem(p: UnresolvedPaymentRow, now: Date): NightCloseItem {
  // Una recarga del datáfono sin la prueba de Paytef no espera a ningún aviso del banco.
  const unproven = p.deviceSale === true && p.status === 'AUTHORIZING';
  const fresh = !unproven && p.status === 'AUTHORIZING' && minutesBetween(p.updatedAt, now) < AUTHORIZING_WAIT_MINUTES;
  return {
    id: p.id,
    status: fresh ? 'block' : 'warn',
    label: `Cobro de ${eur(p.amountCents)} · ${unresolvedWhat(p, unproven, fresh)} (hace ${minutesAgo(p.status === 'AUTHORIZING' ? p.updatedAt : p.createdAt, now)})`,
    amountCents: p.amountCents,
  };
}

function unresolvedWhat(p: UnresolvedPaymentRow, unproven: boolean, fresh: boolean): string {
  if (p.captureMethod === 'POS_EXTERNAL') return 'datáfono sin confirmar';
  if (unproven) return 'recarga del datáfono sin comprobar con Paytef: resuélvela en Pagos';
  if (p.captureMethod === 'WALLET_TOPUP' && p.status === 'CREATED') return 'recarga a medio cobrar en el datáfono: mira el lector';
  if (p.status === 'ORPHAN') return 'el banco no lo confirmó: búscalo en BBVA';
  return fresh ? 'el cliente está pagando' : 'atascado esperando al banco';
}

// ─── 2. Datáfonos ───────────────────────────────────────────────────

export function datafonosStep(
  started: ReadonlyArray<PosStartedRow>,
  unreconciled: ReadonlyArray<PosUnreconciledRow>,
  pairedDevices: number,
  now: Date,
): NightCloseStep {
  const items: NightCloseItem[] = [
    ...started.map((s): NightCloseItem => {
      const fresh = minutesBetween(s.startedAt, now) < POS_RESULT_WAIT_MINUTES;
      const where = s.terminalLabel ? `${s.terminalLabel}: ` : '';
      return {
        id: s.id,
        status: fresh ? 'block' : 'warn',
        label: fresh
          ? `${where}cobrando ${eur(s.amountCents)} ahora mismo`
          : `${where}empezó a cobrar ${eur(s.amountCents)} y no mandó el resultado: mira en el datáfono si se cobró`,
        amountCents: s.amountCents,
      };
    }),
    ...unreconciled.map((u): NightCloseItem => {
      const silent = u.lastSeenAt === null || minutesBetween(u.lastSeenAt, now) >= DEVICE_SILENT_MINUTES;
      const sales = u.sales === 1 ? '1 venta' : `${u.sales} ventas`;
      return {
        id: u.terminalId,
        status: 'warn',
        label: `${u.label}: ${sales} (${eur(u.cents)}) sin cuadrar. Pulsa «Cuadrar con el datáfono» en el aparato${
          silent ? ` (sin señal ${u.lastSeenAt ? `desde hace ${minutesAgo(u.lastSeenAt, now)}` : 'nunca'})` : ''
        }`,
        amountCents: u.cents,
      };
    }),
  ];
  const status = worst(items);
  const detail =
    status === 'block'
      ? 'Un datáfono está cobrando: espera a que termine.'
      : status === 'warn'
        ? 'Hay resultados del datáfono sin mandar o datáfonos sin cuadrar con su cierre de jornada.'
        : pairedDevices === 0
          ? 'No hay datáfonos PAX vinculados en este local.'
          : 'Los datáfonos han mandado todo y están cuadrados.';
  return step('datafonos', 'Datáfonos', status, detail, items, 'terminals');
}

// ─── 3. Saldo devuelto pendiente ────────────────────────────────────

export function saldoStep(
  payouts: ReadonlyArray<WalletPayoutPendingRow>,
  toClose: ReadonlyArray<WalletCloseRequestedRow>,
): NightCloseStep {
  // El código como lo ve el cliente en su móvil: con guion (K7Q-4M2).
  const code = (c: string | null) => (c ? ` · código ${formatWalletCode(c)}` : '');
  const items: NightCloseItem[] = [
    ...payouts.map((p) => ({
      id: p.id,
      status: 'warn' as const,
      label: `Devolución a la tarjeta a medias: ${eur(p.amountCents)}${code(p.shortCode)}. Termínala en ${SALDOS_TAB_PATH}`,
      amountCents: p.amountCents,
    })),
    ...toClose.map((w) => ({
      id: w.id,
      status: 'warn' as const,
      label: `Cliente esperando su saldo: ${eur(w.balanceCents)}${code(w.shortCode)}`,
      amountCents: w.balanceCents,
    })),
  ];
  const status = worst(items);
  return step(
    'saldo',
    'Saldo devuelto pendiente',
    status,
    status === 'ok'
      ? 'No queda saldo por devolver.'
      : `Devuélvelo antes de contar la caja: en efectivo cuenta en el arqueo; a la tarjeta, en ${SALDOS_TAB_PATH}.`,
    items,
    'wallets',
  );
}

// ─── 4. Efectivo ────────────────────────────────────────────────────

/** Sin lo contado: bloquea si hay que contar (el panel y el cierre lo recalculan con withCashInput). */
export function efectivoStep(cash: NightCash): NightCloseStep {
  const outcome = evaluateCash(cash);
  const items: NightCloseItem[] = [];
  if ((cash.walletCashTopUpsCount ?? 0) > 0) {
    items.push({
      id: 'wallet-cash-topups',
      status: 'ok',
      label: `Recargas del saldo en efectivo: ${count(cash.walletCashTopUpsCount, 'recarga', 'recargas')}`,
      amountCents: cash.walletCashTopUpsCents,
    });
  }
  // La «Comisión del servicio» de esas recargas: está en la caja y se debe a OxioPay.
  if ((cash.walletCashTopUpFeesCents ?? 0) !== 0) {
    items.push({
      id: 'wallet-cash-topup-fees',
      status: 'ok',
      label: 'Comisión del servicio de esas recargas (se debe a OxioPay)',
      amountCents: cash.walletCashTopUpFeesCents ?? 0,
    });
  }
  if (cash.walletCashPayoutsCount > 0) {
    items.push({
      id: 'wallet-cash',
      status: 'ok',
      label: `Saldo devuelto en efectivo: ${count(cash.walletCashPayoutsCount, 'devolución', 'devoluciones')}`,
      amountCents: -cash.walletCashPayoutsCents,
    });
  }
  if (cash.chicaCashPayoutsCount > 0) {
    items.push({
      id: 'chica-cash',
      status: 'ok',
      label: `Pagos a las chicas en efectivo: ${count(cash.chicaCashPayoutsCount, 'pago', 'pagos')}`,
      amountCents: -cash.chicaCashPayoutsCents,
    });
  }
  const camareros = cash.camareroCashPayoutsCount ?? 0;
  if (camareros > 0) {
    items.push({
      id: 'camarero-cash',
      status: 'ok',
      label: `Pagos a los camareros en efectivo: ${count(camareros, 'pago', 'pagos')}`,
      amountCents: -(cash.camareroCashPayoutsCents ?? 0),
    });
  }
  return {
    key: 'efectivo',
    status: outcome.status,
    title: 'Efectivo',
    detail: outcome.detail,
    count: cashMovesCount(cash),
    link: null,
    items,
  };
}

// ─── 5. Pagar al personal (chicas y camareros) ──────────────────────

/** Lo que se le paga ya a una chica (como createPayout): lo liberado menos la deuda. */
export function chicaPay(r: ChicaBalanceRow): NightChicaPay {
  const available = availableCentsOf({ unpaidCents: r.unpaidCents, heldCents: r.heldCents, debtCents: r.debtCents });
  return {
    operatorId: r.operatorId,
    name: r.name,
    payoutMethod: r.payoutMethod,
    payoutAddress: r.payoutAddress,
    payoutLabel: r.payoutLabel,
    toPayCents: Math.max(0, available),
    heldCents: Math.max(0, r.heldCents),
    earnedTonightCents: r.earnedTonightCents,
    paidTonightCents: r.paidTonightCents,
    paidTonightCount: r.paidTonightCount,
    debtCents: r.debtCents,
  };
}

export function chicasStep(chicas: ReadonlyArray<NightChicaPay>, holdDays: number): NightCloseStep {
  const toPay = chicas.filter((c) => c.toPayCents > 0);
  const toPayCents = toPay.reduce((sum, c) => sum + c.toPayCents, 0);
  const heldCents = chicas.reduce((sum, c) => sum + c.heldCents, 0);
  const items = chicas.map((c): NightCloseItem => ({
    id: c.operatorId,
    status: c.toPayCents > 0 ? 'warn' : 'ok',
    label: chicaLabel(c, holdDays),
    amountCents: c.toPayCents,
  }));
  const later =
    holdDays > 0 && heldCents > 0 ? ` ${eur(heldCents)} siguen en espera: se pagan pasados ${days(holdDays)}.` : '';
  const detail =
    toPay.length > 0
      ? `${toPay.length === 1 ? 'Queda 1 persona' : `Quedan ${toPay.length} personas`} por pagar: ${eur(toPayCents)}.${later}`
      : chicas.length === 0
        ? 'Nadie del personal tiene nada que cobrar.'
        : `Nada que pagar ya.${later || ' Todo pagado.'}`;
  return {
    key: 'chicas',
    status: toPay.length > 0 ? 'warn' : 'ok',
    // Las chicas y los camareros con parte de las invitaciones.
    title: 'Pagar al personal',
    detail,
    count: toPay.length,
    link: 'operators',
    items,
  };
}

function chicaLabel(c: NightChicaPay, holdDays: number): string {
  const parts = [c.toPayCents > 0 ? `Págale ${eur(c.toPayCents)}` : 'Nada que pagar ya'];
  if (c.paidTonightCents > 0) parts.push(`pagado esta noche ${eur(c.paidTonightCents)}`);
  if (c.heldCents > 0 && holdDays > 0) parts.push(`${eur(c.heldCents)} en espera`);
  if (c.debtCents > 0) parts.push(`debe ${eur(c.debtCents)} por devoluciones`);
  return `${c.name}: ${parts.join(' · ')}`;
}

// ─── 6. Incidencias abiertas ────────────────────────────────────────

export function incidenciasStep(incidents: ReadonlyArray<Incident>): NightCloseStep {
  const byKind = new Map<string, { title: string; count: number }>();
  for (const i of incidents) {
    const seen = byKind.get(i.kind);
    byKind.set(i.kind, { title: seen?.title ?? i.title, count: (seen?.count ?? 0) + 1 });
  }
  const items = [...byKind.entries()].map(([kind, k]): NightCloseItem => ({
    id: kind,
    status: 'warn',
    label: k.count > 1 ? `${k.title} (×${k.count})` : k.title,
    amountCents: null,
  }));
  return step(
    'incidencias',
    'Incidencias abiertas',
    incidents.length > 0 ? 'warn' : 'ok',
    incidents.length > 0
      ? `${count(incidents.length, 'incidencia por mirar', 'incidencias por mirar')}. Se puede cerrar: siguen en Incidencias.`
      : 'Sin incidencias abiertas.',
    items,
    'incidents',
    incidents.length,
  );
}

// ─── 7. Congelar el Z ───────────────────────────────────────────────

export function zStep(): NightCloseStep {
  return {
    key: 'z',
    status: 'ok',
    title: 'Congelar el Z',
    detail: 'Al congelarlo, el Z de la noche ya no cambia: lo que llegue después irá como ajuste del Z siguiente.',
    count: 0,
    link: null,
    items: [],
  };
}

// ─── Auxiliares ─────────────────────────────────────────────────────

function step(
  key: NightCloseStep['key'],
  title: string,
  status: NightCloseStatus,
  detail: string,
  items: NightCloseItem[],
  link: NightCloseStep['link'],
  total: number = items.length,
): NightCloseStep {
  return { key, status, title, detail, count: total, link, items };
}

/** El peor estado de la lista (block > warn > ok). */
export function worst(items: ReadonlyArray<{ status: NightCloseStatus }>): NightCloseStatus {
  if (items.some((i) => i.status === 'block')) return 'block';
  if (items.some((i) => i.status === 'warn')) return 'warn';
  return 'ok';
}

function minutesBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 60_000;
}

function minutesAgo(from: Date, now: Date): string {
  const minutes = Math.max(0, Math.floor(minutesBetween(from, now)));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} días`;
}

function count(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

function days(n: number): string {
  return n === 1 ? '1 día' : `${n} días`;
}

function eur(cents: number): string {
  return `${(cents / 100).toFixed(2).replace('.', ',')} €`;
}
