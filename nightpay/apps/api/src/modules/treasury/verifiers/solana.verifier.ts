import { Logger } from '@nestjs/common';
import type { PayoutVerifier, VerifyResult, VerifyInput } from './payout-verifier.interface';

/**
 * Verifier USDC-Solana via Helius RPC (free tier) o Solana mainnet RPC público.
 * USDC mint: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
 *
 * Importante: en SPL Token, las transferencias van a la "Associated Token
 * Account" (ATA) derivada del wallet del receptor + mint del token, NO al
 * wallet base. Pero el `parsed` instruction nos da el `authority` (owner del
 * source) y el `destination` (token account). Para matchear contra el wallet
 * de la chica (que es lo que ella nos dió), necesitamos comparar el `owner`
 * del destination token account.
 *
 * Estrategia:
 *  1. Buscar instrucción `transferChecked` con mint == USDC.
 *  2. Leer postTokenBalances del result.meta: cada entry tiene `owner` y
 *     `accountIndex`. Cruzar con `destination` para encontrar el wallet real.
 *  3. Si owner del destination ATA === expectedToAddress → MATCH.
 *  4. Fallback: si `destination` raw match (cliente puso la ATA directamente)
 *     también vale.
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

      // Construir índice account-index → wallet owner desde postTokenBalances
      const accountKeys = json.result?.transaction?.message?.accountKeys ?? [];
      const postBalances = json.result?.meta?.postTokenBalances ?? [];
      const ataOwnerByPubkey = new Map<string, string>();
      for (const bal of postBalances) {
        if (typeof bal.accountIndex !== 'number') continue;
        const key = accountKeys[bal.accountIndex];
        const pubkey = typeof key === 'string' ? key : key?.pubkey;
        if (pubkey && bal.owner && bal.mint === USDC_SOL_MINT) {
          ataOwnerByPubkey.set(pubkey, bal.owner);
        }
      }

      const expectedWallet = input.expectedToAddress;
      const instructions = json.result?.transaction?.message?.instructions ?? [];
      for (const ix of instructions) {
        const parsed = ix.parsed;
        if (!parsed) continue;
        // SPL Token transfer puede ser `transfer` o `transferChecked`
        if (parsed.type !== 'transferChecked' && parsed.type !== 'transfer') continue;
        const destination = parsed.info?.destination;
        if (!destination) continue;

        // Para transferChecked sabemos el mint directamente; para transfer
        // no, pero verificamos via balance entry.
        if (parsed.type === 'transferChecked' && parsed.info?.mint !== USDC_SOL_MINT) {
          continue;
        }

        // Match si destination es ATA propiedad del wallet, o si el cliente
        // pasó la ATA directamente.
        const ataOwner = ataOwnerByPubkey.get(destination);
        const isOwnerMatch = ataOwner === expectedWallet;
        const isDirectMatch = destination === expectedWallet;
        if (!isOwnerMatch && !isDirectMatch) {
          continue;
        }

        // Importe — transferChecked trae tokenAmount.uiAmount,
        // transfer trae lamports en parsed.info.amount (string).
        let actualUsdc: number;
        if (parsed.type === 'transferChecked') {
          actualUsdc = Number(parsed.info?.tokenAmount?.uiAmount ?? 0);
        } else {
          // USDC tiene 6 decimales
          actualUsdc = Number(parsed.info?.amount ?? '0') / 1_000_000;
        }
        if (!Number.isFinite(actualUsdc) || actualUsdc <= 0) {
          return mismatch('sol_invalid_amount');
        }

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
      return mismatch('sol_no_usdc_transfer_to_wallet');
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
        accountKeys?: Array<string | { pubkey?: string }>;
        instructions?: Array<{
          parsed?: {
            type?: string;
            info?: {
              mint?: string;
              destination?: string;
              amount?: string;
              tokenAmount?: { uiAmount?: number };
            };
          };
        }>;
      };
    };
    meta?: {
      postTokenBalances?: Array<{
        accountIndex?: number;
        mint?: string;
        owner?: string;
      }>;
    };
  };
}

function notFound(reason: string): VerifyResult {
  return { matched: false, status: 'UNRECONCILED', occurredAt: null, actualAmountCents: null, reason };
}
function mismatch(reason: string): VerifyResult {
  return { matched: false, status: 'MISMATCH', occurredAt: null, actualAmountCents: null, reason };
}
