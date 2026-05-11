import { Logger } from '@nestjs/common';
import type { PayoutVerifier, VerifyResult, VerifyInput } from './payout-verifier.interface';

/**
 * Verifier USDC-Solana via Helius RPC (free tier) o Solana mainnet RPC público.
 * USDC mint: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
 *
 * v1: implementación básica usando RPC público para getTransaction.
 * Para mayor robustez recomienda usar Helius con API key.
 */
const USDC_SOL_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const AMOUNT_TOLERANCE_BPS = 200;

export class SolanaVerifier implements PayoutVerifier {
  private readonly logger = new Logger(SolanaVerifier.name);
  private readonly rpcUrl: string;
  private readonly eurToUsdtRate: () => Promise<number>;

  constructor(apiKey: string | undefined, eurToUsdtRate: () => Promise<number>) {
    this.rpcUrl = apiKey
      ? `https://mainnet.helius-rpc.com/?api-key=${apiKey}`
      : 'https://api.mainnet-beta.solana.com';
    this.eurToUsdtRate = eurToUsdtRate;
  }

  async verify(input: VerifyInput): Promise<VerifyResult> {
    try {
      const body = {
        jsonrpc: '2.0',
        id: 1,
        method: 'getTransaction',
        params: [
          input.externalTxId,
          { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
        ],
      };
      const res = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return notFound('sol_http_error');
      const json = (await res.json()) as SolRpcResponse;
      if (!json.result) return notFound('sol_not_found');

      // Buscar instrucción SPL Token transfer hacia expectedToAddress con USDC mint
      const instructions = json.result?.transaction?.message?.instructions ?? [];
      for (const ix of instructions) {
        const parsed = ix.parsed;
        if (!parsed || parsed.type !== 'transferChecked') continue;
        if (parsed.info?.mint !== USDC_SOL_MINT) continue;
        if (parsed.info?.destination !== input.expectedToAddress) {
          // En SPL la 'destination' es la token account, no la wallet. Aún así
          // muchos clientes usan la wallet directamente; aceptamos match estricto.
          continue;
        }
        const actualUsdc = Number(parsed.info?.tokenAmount?.uiAmount ?? 0);
        const expectedUsdc = (input.expectedAmountCents / 100) * (await this.eurToUsdtRate());
        const tolerance = (expectedUsdc * AMOUNT_TOLERANCE_BPS) / 10_000;
        if (Math.abs(actualUsdc - expectedUsdc) > tolerance) {
          return mismatch(`sol_amount_${actualUsdc.toFixed(2)}_vs_${expectedUsdc.toFixed(2)}`);
        }
        const blockTime = json.result?.blockTime;
        return {
          matched: true,
          status: 'MATCHED',
          occurredAt: blockTime ? new Date(blockTime * 1000) : null,
          actualAmountCents: Math.round(actualUsdc * 100),
          reason: null,
        };
      }
      return mismatch('sol_no_usdc_transferchecked');
    } catch (err) {
      this.logger.warn(`Solana RPC exception: ${(err as Error).message}`);
      return notFound('sol_exception');
    }
  }
}

interface SolRpcResponse {
  result?: {
    blockTime?: number;
    transaction?: {
      message?: {
        instructions?: Array<{
          parsed?: {
            type?: string;
            info?: {
              mint?: string;
              destination?: string;
              tokenAmount?: { uiAmount?: number };
            };
          };
        }>;
      };
    };
  };
}

function notFound(reason: string): VerifyResult {
  return { matched: false, status: 'UNRECONCILED', occurredAt: null, actualAmountCents: null, reason };
}
function mismatch(reason: string): VerifyResult {
  return { matched: false, status: 'MISMATCH', occurredAt: null, actualAmountCents: null, reason };
}
