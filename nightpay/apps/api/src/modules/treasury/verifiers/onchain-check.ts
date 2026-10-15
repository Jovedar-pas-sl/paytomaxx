import type { VerifyInput, VerifyResult } from './payout-verifier.interface';

/**
 * Margen del importe de un pago cripto: ±0,5 % y nunca más de 1 USDT
 * (antes ±2 %: en 500 € se aceptaban 10 USDT de diferencia).
 */
export const AMOUNT_TOLERANCE_BPS = 50;
export const AMOUNT_TOLERANCE_MAX_USDT = 1;

/**
 * Una transacción enviada antes de apuntar el pago vale si es de hasta 24 h
 * antes (se paga y luego se apunta); más vieja, no: así no se reutiliza una
 * transacción antigua del mismo importe para dar por pagado otro.
 */
export const TX_BEFORE_PAYOUT_SKEW_MS = 24 * 60 * 60 * 1000;

export function amountToleranceUsdt(expectedUsdt: number): number {
  return Math.min((expectedUsdt * AMOUNT_TOLERANCE_BPS) / 10_000, AMOUNT_TOLERANCE_MAX_USDT);
}

/** Lo esperado en USDT: la foto del tipo de cambio al crear el pago o, sin ella, el tipo actual. */
export async function expectedUsdtOf(input: VerifyInput, eurToUsdtRate: () => Promise<number>): Promise<number> {
  return typeof input.expectedAmountUsdt === 'number' && input.expectedAmountUsdt > 0
    ? input.expectedAmountUsdt
    : (input.expectedAmountCents / 100) * (await eurToUsdtRate());
}

/** Compara en USDT lo que llegó a su dirección (suma de transferencias) con lo esperado. */
export function amountVerdict(actualUsdt: number, expectedUsdt: number, occurredAt: Date | null): VerifyResult {
  const tolerance = amountToleranceUsdt(expectedUsdt);
  if (Math.abs(actualUsdt - expectedUsdt) > tolerance) {
    return {
      ...mismatch(
        `importe_distinto: llegaron ${usdt(actualUsdt)} y se esperaban ${usdt(expectedUsdt)} (margen ±${num(tolerance)})`,
      ),
      actualAmountUsdt: actualUsdt,
    };
  }
  return { matched: true, status: 'MATCHED', occurredAt, actualAmountCents: null, actualAmountUsdt: actualUsdt, reason: null };
}

/** Con la fecha de la transacción: no puede ser (mucho) anterior al pago. */
export function checkTxTime(result: VerifyResult, payoutCreatedAt: Date): VerifyResult {
  if (!result.matched) return result;
  if (!result.occurredAt) {
    return { ...notFound('sin_fecha: el explorador no da la fecha de la transacción; revísala a mano'), actualAmountUsdt: result.actualAmountUsdt };
  }
  if (result.occurredAt.getTime() < payoutCreatedAt.getTime() - TX_BEFORE_PAYOUT_SKEW_MS) {
    return {
      ...mismatch(
        `tx_anterior_al_pago: la transacción es del ${result.occurredAt.toISOString()} y el pago se apuntó el ${payoutCreatedAt.toISOString()}`,
      ),
      actualAmountUsdt: result.actualAmountUsdt,
    };
  }
  return result;
}

/** USDT → céntimos de euro con la foto del tipo del pago (USDT por EUR). Sin foto, null. */
export function usdtToEurCents(actualUsdt: number | null | undefined, payoutFxRate: string | null | undefined): number | null {
  const rate = payoutFxRate ? Number(payoutFxRate) : NaN;
  if (actualUsdt === null || actualUsdt === undefined || !Number.isFinite(rate) || rate <= 0) return null;
  return Math.round((actualUsdt / rate) * 100);
}

export function notFound(reason: string): VerifyResult {
  return { matched: false, status: 'UNRECONCILED', occurredAt: null, actualAmountCents: null, reason };
}

export function mismatch(reason: string): VerifyResult {
  return { matched: false, status: 'MISMATCH', occurredAt: null, actualAmountCents: null, reason };
}

/** Suma de importes en unidades mínimas del token (enteros) → unidades. */
export function sumTokenUnits(rawAmounts: ReadonlyArray<string | undefined>, decimals: number): number {
  const total = rawAmounts.reduce((sum, raw) => sum + BigInt(/^\d+$/.test(raw ?? '') ? (raw as string) : '0'), 0n);
  return Number(total) / 10 ** decimals;
}

function num(n: number): string {
  return n.toFixed(2).replace('.', ',');
}

function usdt(n: number): string {
  return `${num(n)} USDT`;
}
