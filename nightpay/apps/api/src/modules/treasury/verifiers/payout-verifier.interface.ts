import type { PayoutMethod, ReconciliationStatus } from '@nightpay/contracts';

/**
 * Resultado de verificación de un payout contra el rail externo (blockchain o manual).
 * - matched=true → status=MATCHED, el caller debe persistir reconciledAt + reconciledByUserId.
 * - matched=false con motivo "mismatch" → status=MISMATCH, importe o destino no cuadra.
 * - matched=false con motivo "not_found" → quedar UNRECONCILED, reintentar más tarde (lag blockchain).
 * - matched=false con motivo "manual_required" → MANUAL_OK requiere admin confirmation.
 */
export interface VerifyResult {
  matched: boolean;
  status: ReconciliationStatus;
  occurredAt: Date | null;
  actualAmountCents: number | null;
  reason: string | null;
}

export interface VerifyInput {
  /** Hash on-chain, receipt ID, SEPA reference, etc. */
  externalTxId: string;
  /** Address/IBAN/email destino esperado (de User.payoutAddress). */
  expectedToAddress: string;
  /** Importe esperado en céntimos EUR. Para cripto se convierte a USDT al ratio actual. */
  expectedAmountCents: number;
}

export interface PayoutVerifier {
  /** Hace una llamada (al explorer/API) y devuelve si el txhash corresponde al payout. */
  verify(input: VerifyInput): Promise<VerifyResult>;
}

/** Métodos que tienen verificador automático on-chain. */
export const AUTO_VERIFY_METHODS: PayoutMethod[] = [
  'USDT_TRC20',
  'USDT_BEP20',
  'USDC_POLY',
  'USDC_SOL',
];

export function isAutoVerifiable(method: PayoutMethod | null | undefined): boolean {
  return method ? AUTO_VERIFY_METHODS.includes(method) : false;
}
