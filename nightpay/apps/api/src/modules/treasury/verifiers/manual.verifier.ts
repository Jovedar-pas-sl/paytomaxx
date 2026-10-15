import type { PayoutVerifier, VerifyResult, VerifyInput } from './payout-verifier.interface';

/**
 * Verifier por defecto para rails sin API blockchain (e-wallets, wires,
 * wallets LatAm, cash). Siempre devuelve matched=false con status=UNRECONCILED
 * para forzar al admin a confirmar manualmente con el checkbox "Confirmo pagué".
 *
 * El admin marca MANUAL_OK desde la UI; este verifier nunca lo hace solo.
 */
export class ManualVerifier implements PayoutVerifier {
  async verify(_input: VerifyInput): Promise<VerifyResult> {
    return {
      matched: false,
      status: 'UNRECONCILED',
      occurredAt: null,
      actualAmountCents: null,
      reason: 'manual_required',
    };
  }
}
