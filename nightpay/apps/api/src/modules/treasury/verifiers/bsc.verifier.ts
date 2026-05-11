import { Logger } from '@nestjs/common';
import type { PayoutVerifier, VerifyResult, VerifyInput } from './payout-verifier.interface';

/**
 * Verifier USDT-BEP20 (Binance Smart Chain) via BscScan API.
 * Endpoint: https://api.bscscan.com/api?module=transaction&action=getstatus&txhash=...
 * + module=proxy&action=eth_getTransactionByHash
 *
 * v1: implementación pragmática — verifica la tx existe + recuperación de
 * decode TRC20-style del transfer. Para iteración futura puede ampliarse a
 * inspección completa de logs.
 */
const USDT_BEP20_CONTRACT = '0x55d398326f99059ff775485246999027b3197955'; // USDT BEP20
const AMOUNT_TOLERANCE_BPS = 200;

export class BscVerifier implements PayoutVerifier {
  private readonly logger = new Logger(BscVerifier.name);
  private readonly apiKey?: string;
  private readonly eurToUsdtRate: () => Promise<number>;

  constructor(apiKey: string | undefined, eurToUsdtRate: () => Promise<number>) {
    this.apiKey = apiKey;
    this.eurToUsdtRate = eurToUsdtRate;
  }

  async verify(input: VerifyInput): Promise<VerifyResult> {
    try {
      const baseUrl = 'https://api.bscscan.com/api';
      const apiKey = this.apiKey ?? 'YourApiKeyToken'; // free tier sin auth funciona limitado
      const url = `${baseUrl}?module=account&action=tokentx&contractaddress=${USDT_BEP20_CONTRACT}&txhash=${encodeURIComponent(input.externalTxId)}&apikey=${apiKey}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return notFound('bsc_http_error');
      const body = (await res.json()) as BscscanResponse;

      if (body.status !== '1' || !Array.isArray(body.result) || body.result.length === 0) {
        return notFound('bsc_not_found');
      }
      const tx = body.result.find((r) => r.hash?.toLowerCase() === input.externalTxId.toLowerCase());
      if (!tx) return notFound('bsc_tx_not_in_results');

      if (tx.to?.toLowerCase() !== input.expectedToAddress.toLowerCase()) {
        return mismatch(`bsc_to_mismatch_${tx.to}`);
      }

      const decimals = Number(tx.tokenDecimal ?? '18');
      const actualUsdt = Number(tx.value) / Math.pow(10, decimals);
      const expectedUsdt = (input.expectedAmountCents / 100) * (await this.eurToUsdtRate());
      const tolerance = (expectedUsdt * AMOUNT_TOLERANCE_BPS) / 10_000;
      if (Math.abs(actualUsdt - expectedUsdt) > tolerance) {
        return mismatch(`bsc_amount_${actualUsdt.toFixed(2)}_vs_${expectedUsdt.toFixed(2)}`);
      }

      const confirmations = Number(tx.confirmations ?? '0');
      if (confirmations < 6) return notFound('bsc_unconfirmed');

      return {
        matched: true,
        status: 'MATCHED',
        occurredAt: tx.timeStamp ? new Date(Number(tx.timeStamp) * 1000) : null,
        actualAmountCents: Math.round(actualUsdt * 100),
        reason: null,
      };
    } catch (err) {
      this.logger.warn(`BscScan exception: ${(err as Error).message}`);
      return notFound('bsc_exception');
    }
  }
}

interface BscscanResponse {
  status?: string;
  result?: Array<{
    hash?: string;
    to?: string;
    value?: string;
    tokenDecimal?: string;
    timeStamp?: string;
    confirmations?: string;
  }>;
}

function notFound(reason: string): VerifyResult {
  return { matched: false, status: 'UNRECONCILED', occurredAt: null, actualAmountCents: null, reason };
}
function mismatch(reason: string): VerifyResult {
  return { matched: false, status: 'MISMATCH', occurredAt: null, actualAmountCents: null, reason };
}
