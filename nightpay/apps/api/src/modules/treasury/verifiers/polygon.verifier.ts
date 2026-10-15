import { Logger } from '@nestjs/common';
import type { PayoutVerifier, VerifyResult, VerifyInput } from './payout-verifier.interface';
import { expectedUsdtOf, notFound } from './onchain-check';
import { evmTransfersVerdict, tokenTransfersOfTx } from './evm-explorer';

/**
 * Verifier USDC-Polygon (POS) via PolygonScan API.
 * USDC oficial Polygon: 0x3c499c542cef5e3811e1192ce70d8cc03d5c3359 (USDC nativo)
 *   o 0x2791bca1f2de4661ed88a30c99a7a9449aa84174 (USDC.e bridged).
 * Aceptamos ambos. Suma todas las transferencias a la dirección de la chica.
 */
const USDC_POLY_CONTRACTS = [
  '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', // USDC nativo
  '0x2791bca1f2de4661ed88a30c99a7a9449aa84174', // USDC.e bridged
];
// Binance considera USDC-POLY final a ~128 confirmaciones (~5 min).
// Alineamos para que el admin verificando en Binance UI y NightPay coincidan.
const MIN_CONFIRMATIONS = 128;

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
      for (const contract of USDC_POLY_CONTRACTS) {
        const rows = await tokenTransfersOfTx({
          baseUrl: 'https://api.polygonscan.com/api',
          contract,
          address: input.expectedToAddress,
          txId: input.externalTxId,
          apiKey: this.apiKey ?? 'YourApiKeyToken',
        });
        if (!rows || rows.length === 0) continue;
        return evmTransfersVerdict({
          rows,
          input,
          expectedUsdt: await expectedUsdtOf(input, this.eurToUsdtRate),
          minConfirmations: MIN_CONFIRMATIONS,
          chain: 'poly',
          defaultDecimals: 6,
        });
      }
      return notFound('poly_not_found_any_contract');
    } catch (err) {
      this.logger.warn(`Polygonscan exception: ${(err as Error).message}`);
      return notFound('poly_exception');
    }
  }
}
