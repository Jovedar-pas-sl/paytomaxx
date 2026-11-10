// Cómo se confirma una devolución en el panel (lógica pura, B10): desde 100 €
// no sale sola al poner el sexto número de la 2FA ni al confirmar con la
// llave; sale con el botón que dice el importe («Devolver 120,00 €»). Por
// debajo, como siempre: el sexto número la manda.

import type { StepUpProof } from '@nightpay/contracts';

/** Desde este importe (de una vez), la devolución sale solo con el botón. */
export const REFUND_BUTTON_FROM_CENTS = 100_00;

/** Se manda sola al completar la verificación (por debajo de 100 €). */
export function refundAutoSends(cents: number): boolean {
  return Number.isFinite(cents) && cents > 0 && cents < REFUND_BUTTON_FROM_CENTS;
}

/** El texto del botón: «Devolver 120,00 €» (o «Pedir al dueño» si va a él). */
export function refundButtonText(input: { asking: boolean; cents: number; valid: boolean }, eur: (cents: number) => string): string {
  if (input.asking) return 'Pedir al dueño';
  return input.valid ? `Devolver ${eur(input.cents)}` : 'Devolver';
}

/**
 * La prueba de la llave que vale para esta acción ahora (null si no hay, es
 * de otra acción, p. ej. otro importe, o ya caducó).
 */
export function proofFor(proof: StepUpProof | null, action: string | null, nowMs: number): StepUpProof | null {
  if (!proof || !action || proof.action !== action) return null;
  return Date.parse(proof.expiresAt) > nowMs ? proof : null;
}
