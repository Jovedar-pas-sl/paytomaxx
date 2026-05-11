import { Logger } from '@nestjs/common';
import type { PayoutVerifier, VerifyResult, VerifyInput } from './payout-verifier.interface';

/**
 * Verifier para USDT-TRC20 (Tron) via Tronscan free API.
 * Endpoint: https://apilist.tronscanapi.com/api/transaction-info?hash={txhash}
 * Free tier: 10k requests/día, suficiente para volumen Phase 1.
 *
 * El contrato USDT-TRC20 oficial es TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t.
 * Para considerar match: tx.to === expectedToAddress AND
 * tx.amount (decimal 6) ~= expectedUsdtAmount (±2% tolerancia).
 */
const USDT_TRC20_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const AMOUNT_TOLERANCE_BPS = 200; // 2%

export class TronVerifier implements PayoutVerifier {
  private readonly logger = new Logger(TronVerifier.name);
  private readonly apiKey?: string;
  private readonly eurToUsdtRate: () => Promise<number>;

  constructor(apiKey: string | undefined, eurToUsdtRate: () => Promise<number>) {
    this.apiKey = apiKey;
    this.eurToUsdtRate = eurToUsdtRate;
  }

  async verify(input: VerifyInput): Promise<VerifyResult> {
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (this.apiKey) headers['TRON-PRO-API-KEY'] = this.apiKey;

      const url = `https://apilist.tronscanapi.com/api/transaction-info?hash=${encodeURIComponent(input.externalTxId)}`;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) {
        this.logger.warn(`Tronscan HTTP ${res.status} para tx=${input.externalTxId}`);
        return notFound('tron_http_error');
      }
      const body = (await res.json()) as TronscanTxInfo;

      // Tx no encontrada o aún sin confirmar
      if (!body.contractRet) return notFound('tron_pending_or_unknown');
      if (body.contractRet !== 'SUCCESS') {
        return mismatch(`tron_status_${body.contractRet}`);
      }

      // Find TRC20 USDT transfer en el log
      const trc20 = (body.trc20TransferInfo ?? []).find(
        (t) => t.contract_address?.toLowerCase() === USDT_TRC20_CONTRACT.toLowerCase(),
      );
      if (!trc20) return mismatch('tron_no_usdt_transfer');

      const actualTo = trc20.to_address?.toLowerCase();
      if (actualTo !== input.expectedToAddress.toLowerCase()) {
        return mismatch(`tron_to_mismatch_${actualTo}`);
      }

      // amount_str es decimal con 6 zeros (USDT TRC20 has 6 decimals)
      const actualUsdt = Number(trc20.amount_str) / 1_000_000;
      const expectedUsdt = (input.expectedAmountCents / 100) * (await this.eurToUsdtRate());
      const tolerance = (expectedUsdt * AMOUNT_TOLERANCE_BPS) / 10_000;
      if (Math.abs(actualUsdt - expectedUsdt) > tolerance) {
        return mismatch(`tron_amount_${actualUsdt.toFixed(2)}_vs_${expectedUsdt.toFixed(2)}`);
      }

      // Confirmaciones suficientes — Tronscan body.confirmed booleano
      if (body.confirmed === false) return notFound('tron_unconfirmed');

      return {
        matched: true,
        status: 'MATCHED',
        occurredAt: body.timestamp ? new Date(body.timestamp) : null,
        actualAmountCents: Math.round(actualUsdt * 100), // aprox EUR
        reason: null,
      };
    } catch (err) {
      this.logger.warn(`Tronscan exception: ${(err as Error).message}`);
      return notFound('tron_exception');
    }
  }
}

interface TronscanTxInfo {
  hash?: string;
  timestamp?: number;
  confirmed?: boolean;
  contractRet?: string;
  trc20TransferInfo?: Array<{
    contract_address?: string;
    from_address?: string;
    to_address?: string;
    amount_str?: string;
  }>;
}

function notFound(reason: string): VerifyResult {
  return { matched: false, status: 'UNRECONCILED', occurredAt: null, actualAmountCents: null, reason };
}
function mismatch(reason: string): VerifyResult {
  return { matched: false, status: 'MISMATCH', occurredAt: null, actualAmountCents: null, reason };
}
