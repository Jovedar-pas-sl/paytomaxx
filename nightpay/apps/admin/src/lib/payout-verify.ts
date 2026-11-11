// Qué enseñar tras verificar un pago a una chica: antes el resultado se tiraba
// y el modal se cerraba como si todo hubiera ido bien.
import type { ReconciliationStatus } from './api';
import { safeHttpUrl } from './urls';

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

/** Motivos del API nuevo: "codigo: detalle" (o solo el código). */
const REASON_LABELS: Record<string, string> = {
  importe_distinto: 'El importe no cuadra',
  destino_distinto: 'Fue a otra dirección, no a la de la compañera',
  sin_usdt: 'No es un envío de USDT/USDC',
  tx_fallida: 'La transacción falló en la red',
  tx_anterior_al_pago: 'La transacción es anterior al pago',
  sin_fecha: 'El explorador no da la fecha de la transacción: revísala a mano',
};

/**
 * Motivo del verificador → frase. API nuevo: "importe_distinto: llegaron …";
 * API antiguo: códigos como "tron_amount_95.00_vs_100.00". Un motivo que ya
 * viene en frase se enseña tal cual.
 */
export function describeVerifyReason(reason: string | null): string | null {
  if (!reason) return null;
  const coded = /^([a-z_]+)(?::\s*([\s\S]*))?$/.exec(reason);
  const label = coded?.[1] ? REASON_LABELS[coded[1]] : undefined;
  if (coded && label) return coded[2] ? `${label}: ${coded[2]}` : `${label}.`;
  const amount = /_amount_([\d.]+)_vs_([\d.]+)$/.exec(reason);
  if (amount) {
    return `Se enviaron ${amount[1]} y tocaban ${amount[2]} (USDT/USDC).`;
  }
  const to = /_to_mismatch_(.+)$/.exec(reason);
  if (to) return `La transacción fue a otra dirección (${to[1]}), no a la de la compañera.`;
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
    return 'Esa transacción no es un envío de USDT/USDC a la dirección de la compañera.';
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
  actualAmountUsdt?: number | null;
}): VerifyOutcome {
  const described = describeVerifyReason(result.reason);
  // Lo que llegó on-chain (API nuevo), si el motivo no lo dice ya.
  const arrived =
    typeof result.actualAmountUsdt === 'number' && !/llegaron/i.test(described ?? '')
      ? ` Llegaron ${result.actualAmountUsdt.toLocaleString('es-ES', { maximumFractionDigits: 2 })} USDT/USDC.`
      : '';
  const reason = described || arrived ? `${described ?? ''}${arrived}`.trim() : null;
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

/** Referencia y recibo de un pago: lo que el API rechazaría, avisado antes. */
export function payoutReferenceError(input: { externalTxId: string; receiptUrl: string }): string | null {
  const tx = input.externalTxId.trim();
  if (tx && tx.length < 4) return 'La referencia es muy corta (mínimo 4 caracteres).';
  if (tx.length > 200) return 'La referencia es muy larga (máximo 200 caracteres).';
  if (input.receiptUrl.trim() && !safeHttpUrl(input.receiptUrl)) {
    return 'El enlace del recibo tiene que ser una dirección web (https://…).';
  }
  return null;
}
