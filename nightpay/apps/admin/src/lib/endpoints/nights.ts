// Noches e informe Z (Fase 1D), y el cierre en pasos con el arqueo de caja.

import type { CloseNightDto, NightCloseCheck, NightCloseStep } from '@nightpay/contracts';
import { ApiError, errorFromBody } from '../api-errors';
import { apiError, authedFetch } from '../http';
import { stepsFromBody } from '../night-close';

// ─── Noches (Fase 1D) ──────────────────────────────────────────────

export interface NightSummary {
  count: number;
  grossCents: number;
  tipsCents: number;
  chargedCents: number;
  refundsCount: number;
  refundsCents: number;
  netCents: number;
  byType: Array<{ label: string; count: number; chargedCents: number }>;
  chicaCommissionCents: number;
  chicaTipsCents: number;
  chicaReversalsCents: number;
  chicaNetCents: number;
  /**
   * La parte de los camareros (copas con invitación, si el local se la da; de
   * fábrica, nada). Los Z congelados antes del 2026-10-28 no lo traen (y su
   * «para el local» la incluía).
   */
  camareroNetCents?: number;
  venueTipsCents: number;
  /** Lo del local: sin lo de las chicas, los camareros ni la comisión del servicio (es de OxioPay). */
  venueNetCents: number;
  /**
   * «Comisión del servicio» (la paga el cliente encima; ya en «cobrado»): la
   * cobrada, la de las recargas en efectivo (en la caja), la devuelta y lo
   * que se debe a OxioPay. Sin ella (y en los Z de antes), no vienen.
   */
  serviceFeeCents?: number;
  serviceFeeCashCents?: number;
  serviceFeeRefundedCents?: number;
  serviceFeeNetCents?: number;
  payoutsCount: number;
  payoutsCents: number;
  perChica: Array<{
    name: string;
    count: number;
    chargedCents: number;
    commissionCents: number;
    tipsCents: number;
    reversalsCents: number;
    netCents: number;
    paidCents: number;
  }>;
  // API nuevo (los Z congelados antes no los traen):
  /** Saldo devuelto al cliente en efectivo: resta del neto. */
  walletCashPayoutsCents?: number;
  /** Recargas del saldo en efectivo (ya en «cobrado»; no son cobros del banco). */
  walletCashTopUpsCount?: number;
  walletCashTopUpsCents?: number;
  /** Recargas del saldo con tarjeta (ya en count y grossCents). Los Z de antes del 23-oct-2026 no lo traen. */
  walletCardTopUpsCount?: number;
  walletCardTopUpsCents?: number;
  /** Saldo devuelto a la tarjeta: ya está en las devoluciones (solo se informa). */
  walletCardPayoutsCents?: number;
  /** Consumos del saldo (ventas, no dinero nuevo). */
  consumptionsCount?: number;
  consumptionsCents?: number;
  saldoByType?: Array<{ label: string; count: number; chargedCents: number }>;
}

/** Lo apuntado tarde con fecha de noches ya cerradas: va en el Z siguiente. */
export interface NightAdjustments {
  since: string;
  before: string;
  count: number;
  summary: NightSummary;
  reversedConsumptionsCount: number;
  reversedConsumptionsCents: number;
  reversedConsumptionsChicaCents: number;
}

/** Caja de la noche congelada en el Z: fondo, salidas en efectivo, lo esperado, lo contado y la diferencia. */
export interface NightCaja {
  openingFloatCents: number | null;
  /** Lo que entró: las recargas del saldo en efectivo. */
  cashInCents: number;
  /** Los Z congelados antes del 21-oct-2026 no lo traen. */
  walletCashTopUpsCount?: number;
  walletCashTopUpsCents?: number;
  /** La comisión del servicio de esas recargas: en la caja (ya en cashInCents), se debe a OxioPay. Sin ella, no viene. */
  walletCashTopUpFeesCents?: number;
  walletCashPayoutsCount: number;
  walletCashPayoutsCents: number;
  chicaCashPayoutsCount: number;
  chicaCashPayoutsCents: number;
  /** Pagos en efectivo a los camareros. Los Z congelados antes del 28-oct-2026 no lo traen (sus pagos a las chicas son los de todo el personal). */
  camareroCashPayoutsCount?: number;
  camareroCashPayoutsCents?: number;
  cashOutCents: number;
  expectedCents: number;
  /** null = no se contó (cierre automático o sin efectivo). */
  countedCents: number | null;
  /** Contado − esperado (negativo = falta). */
  diffCents: number | null;
  note: string | null;
  frozenAt: string;
}

export interface NightZ {
  from: string;
  to: string;
  generatedAt: string;
  summary: NightSummary;
  pendingCount: number;
  /** API nuevo: ajustes de noches anteriores. */
  adjustments?: NightAdjustments;
  /** Caja (los Z de antes del cierre en pasos y los de una noche abierta no la traen). */
  caja?: NightCaja;
}

export interface NightView {
  id: string;
  openedAt: string;
  closedAt: string | null;
  autoClosed: boolean;
  pendingAtClose: number;
  closeNote: string | null;
  /** Fondo de caja con el que empezó (null = no se apuntó). */
  openingFloatCents?: number | null;
  z: NightZ;
  pending: Array<{ id: string; status: string; amountCents: number; createdAt: string; captureMethod: string | null }>;
}

export interface NightListItem {
  id: string;
  openedAt: string;
  closedAt: string | null;
  autoClosed: boolean;
  pendingAtClose: number;
  count: number | null;
  chargedCents: number | null;
  netCents: number | null;
  /** Diferencia de caja al cerrar; null si no se contó. */
  cashDiffCents?: number | null;
}

/** El API no dejó cerrar (409): trae los pasos tal como están ahora. */
export class NightCloseRefused extends ApiError {
  override name = 'NightCloseRefused';
  readonly steps: NightCloseStep[];

  constructor(message: string, status: number, code: string | null, steps: NightCloseStep[]) {
    super(message, status, code);
    this.steps = steps;
  }
}

export async function fetchCurrentNight(): Promise<NightView | null> {
  const res = await authedFetch('/v1/nights/current');
  if (!res.ok) throw await apiError(res);
  return ((await res.json()) as { night: NightView | null }).night;
}

export async function openNight(input: { openingFloatCents?: number } = {}): Promise<NightView> {
  const res = await authedFetch('/v1/nights/open', { method: 'POST', body: JSON.stringify(input) });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

/** Los pasos para cerrar la noche abierta. */
export async function fetchCloseCheck(): Promise<NightCloseCheck> {
  const res = await authedFetch('/v1/nights/current/close-check');
  if (!res.ok) throw await apiError(res);
  return res.json();
}

/** Cerrar: avisos confirmados, nota y arqueo. Un 409 con pasos → NightCloseRefused. */
export async function closeNight(id: string, input: Partial<CloseNightDto>): Promise<NightView> {
  const res = await authedFetch(`/v1/nights/${id}/close`, { method: 'POST', body: JSON.stringify(input) });
  if (res.ok) return res.json();
  const text = await res.text().catch(() => '');
  const { message, code } = errorFromBody(text, res.status);
  const steps = stepsFromBody(text);
  if (steps) throw new NightCloseRefused(message, res.status, code, steps);
  throw new ApiError(message, res.status, code);
}

export async function fetchNights(): Promise<NightListItem[]> {
  const res = await authedFetch('/v1/nights');
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export async function fetchNight(id: string): Promise<NightView> {
  const res = await authedFetch(`/v1/nights/${id}`);
  if (!res.ok) throw await apiError(res);
  return res.json();
}
