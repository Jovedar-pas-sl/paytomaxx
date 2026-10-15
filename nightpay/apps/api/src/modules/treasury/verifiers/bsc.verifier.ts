import { Logger } from '@nestjs/common';
import type { PayoutVerifier, VerifyResult, VerifyInput } from './payout-verifier.interface';
import { expectedUsdtOf, notFound } from './onchain-check';
import { evmTransfersVerdict, tokenTransfersOfTx } from './evm-explorer';

/**
 * Verifier USDT-BEP20 (Binance Smart Chain) via BscScan API
 * (module=account&action=tokentx con la dirección de la chica).
 * Suma todas las transferencias USDT de la transacción a su dirección y
 * compara en USDT (margen de onchain-check). 6 confirmaciones.
 */
const USDT_BEP20_CONTRACT = '0x55d398326f99059ff775485246999027b3197955'; // USDT BEP20
const MIN_CONFIRMATIONS = 6;

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
      const rows = await tokenTransfersOfTx({
        baseUrl: 'https://api.bscscan.com/api',
        contract: USDT_BEP20_CONTRACT,
        address: input.expectedToAddress,
        txId: input.externalTxId,
        apiKey: this.apiKey ?? 'YourApiKeyToken', // free tier sin auth funciona limitado
      });
      if (rows === null) return notFound('bsc_http_error');
      if (rows.length === 0) return notFound('bsc_not_found');
      return evmTransfersVerdict({
        rows,
        input,
        expectedUsdt: await expectedUsdtOf(input, this.eurToUsdtRate),
        minConfirmations: MIN_CONFIRMATIONS,
        chain: 'bsc',
        defaultDecimals: 18,
      });
    } catch (err) {
      this.logger.warn(`BscScan exception: ${(err as Error).message}`);
      return notFound('bsc_exception');
    }
  }
}
