// Qué enseñar tras verificar un pago a una chica: antes el resultado se tiraba
// y el modal se cerraba como si todo hubiera ido bien.
import type { ReconciliationStatus } from './api';

export type Tone = 'success' | 'warning' | 'danger' | 'info';

export const RECONCILIATION_LABELS: Record<ReconciliationStatus, { label: string; tone: Tone }> = {
  UNRECONCILED: { label: 'Sin verificar', tone: 'warning' },
  MATCHED: { label: 'Verificado en la red', tone: 'success' },
  MANUAL_OK: { label: 'Confirmado a mano', tone: 'success' },
  MISMATCH: { label: 'No cuadra', tone: 'danger' },
};

export interface VerifyOutcome {
  tone: Tone;
  message: string;
}

/**
 * Motivo del verificador (códigos como "tron_amount_95.00_vs_100.00") → frase.
 * Un motivo que ya viene en frase (el API puede mandarlo así) se enseña tal cual.
 */
export function describeVerifyReason(reason: string | null): string | null {
  if (!reason) return null;
  const amount = /_amount_([\d.]+)_vs_([\d.]+)$/.exec(reason);
  if (amount) {
    return `Se enviaron ${amount[1]} y tocaban ${amount[2]} (USDT/USDC).`;
  }
  const to = /_to_mismatch_(.+)$/.exec(reason);
  if (to) return `La transacción fue a otra dirección (${to[1]}), no a la de la chica.`;
  if (/_unconfirmed$|_pending_or_unknown$/.test(reason)) {
    return 'La transacción aún no está confirmada en la red. Vuelve a verificar en unos minutos.';
  }
  if (/_not_found|_not_in_results$/.test(reason)) {
    return 'No aparece esa transacción en la red: revisa el hash.';
  }
  if (/_http_error$|_exception$/.test(reason)) {
    return 'El explorador de la red no responde ahora. Prueba otra vez más tarde.';
  }
  const status = /^tron_status_(.+)$/.exec(reason);
  if (status) return `La transacción falló en la red (${status[1]}).`;
  if (/_no_usdt_transfer$|_no_usdc_transfer_to_wallet$|_invalid_amount$/.test(reason)) {
    return 'Esa transacción no es un envío de USDT/USDC a la dirección de la chica.';
  }
  if (reason === 'manual_required') {
    return 'Este método no se verifica solo: queda apuntada la referencia.';
  }
  if (reason === 'already_reconciled') return 'Ya estaba verificado.';
  if (reason === 'manual_override') return 'Confirmado a mano.';
  return /\s/.test(reason) ? reason : `Motivo: ${reason}`;
}

/** Resultado de POST /treasury/payouts/:id/verify → aviso para quien paga. */
export function describeVerifyResult(result: {
  matched: boolean;
  status: ReconciliationStatus;
  reason: string | null;
}): VerifyOutcome {
  const reason = describeVerifyReason(result.reason);
  if (result.matched) {
    return {
      tone: 'success',
      message: result.status === 'MANUAL_OK' ? 'Pago confirmado.' : 'Pago verificado en la red: cuadra.',
    };
  }
  if (result.status === 'MISMATCH') {
    return { tone: 'danger', message: `El pago no cuadra. ${reason ?? ''}`.trim() };
  }
  if (result.reason === 'manual_required') {
    return { tone: 'info', message: reason ?? 'Referencia apuntada.' };
  }
  return { tone: 'warning', message: `Aún sin verificar. ${reason ?? ''}`.trim() };
}
