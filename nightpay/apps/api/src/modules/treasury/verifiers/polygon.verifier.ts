import { Logger } from '@nestjs/common';
import type { PayoutVerifier, VerifyResult, VerifyInput } from './payout-verifier.interface';

/**
 * Verifier USDC-Polygon (POS) via PolygonScan API.
 * USDC oficial Polygon: 0x3c499c542cef5e3811e1192ce70d8cc03d5c3359 (USDC nativo)
 *   o 0x2791bca1f2de4661ed88a30c99a7a9449aa84174 (USDC.e bridged).
 * Aceptamos ambos.
 */
const USDC_POLY_CONTRACTS = [
  '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', // USDC nativo
  '0x2791bca1f2de4661ed88a30c99a7a9449aa84174', // USDC.e bridged
];
const AMOUNT_TOLERANCE_BPS = 200;

export class PolygonVerifier implements PayoutVerifier {
  private readonly logger = new Logger(PolygonVerifier.name);
  private readonly apiKey?: string;
  private readonly eurToUsdtRate: () => Promise<number>; // USDC ~ USDT ~ 1 USD

  constructor(apiKey: string | undefined, eurToUsdtRate: () => Promise<number>) {
    this.apiKey = apiKey;
    this.eurToUsdtRate = eurToUsdtRate;
  }

  async verify(input: VerifyInput): Promise<VerifyResult> {
    try {
      const baseUrl = 'https://api.polygonscan.com/api';
      const apiKey = this.apiKey ?? 'YourApiKeyToken';
      for (const contract of USDC_POLY_CONTRACTS) {
        const url = `${baseUrl}?module=account&action=tokentx&contractaddress=${contract}&txhash=${encodeURIComponent(input.externalTxId)}&apikey=${apiKey}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) continue;
        const body = (await res.json()) as PolygonResponse;
        if (body.status !== '1' || !Array.isArray(body.result) || body.result.length === 0) continue;
        const tx = body.result.find((r) => r.hash?.toLowerCase() === input.externalTxId.toLowerCase());
        if (!tx) continue;

        if (tx.to?.toLowerCase() !== input.expectedToAddress.toLowerCase()) {
          return mismatch(`poly_to_mismatch_${tx.to}`);
        }

        const decimals = Number(tx.tokenDecimal ?? '6');
        const actualUsdc = Number(tx.value) / Math.pow(10, decimals);
        // FX snapshot del payout (Sprint 2026-05-13 fix #15). Si null, fallback live.
        const expectedUsdc =
          typeof input.expectedAmountUsdt === 'number' && input.expectedAmountUsdt > 0
            ? input.expectedAmountUsdt
            : (input.expectedAmountCents / 100) * (await this.eurToUsdtRate());
        const tolerance = (expectedUsdc * AMOUNT_TOLERANCE_BPS) / 10_000;
        if (Math.abs(actualUsdc - expectedUsdc) > tolerance) {
          return mismatch(`poly_amount_${actualUsdc.toFixed(2)}_vs_${expectedUsdc.toFixed(2)}`);
        }

        // Binance considera USDC-POLY final a ~128 confirmaciones (~5 min).
        // Alineamos para que el admin verificando en Binance UI y NightPay coincidan.
        const confirmations = Number(tx.confirmations ?? '0');
        if (confirmations < 128) return notFound('poly_unconfirmed');

        return {
          matched: true,
          status: 'MATCHED',
          occurredAt: tx.timeStamp ? new Date(Number(tx.timeStamp) * 1000) : null,
          actualAmountCents: Math.round(actualUsdc * 100),
          reason: null,
        };
      }
      return notFound('poly_not_found_any_contract');
    } catch (err) {
      this.logger.warn(`Polygonscan exception: ${(err as Error).message}`);
      return notFound('poly_exception');
    }
  }
}

interface PolygonResponse {
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
