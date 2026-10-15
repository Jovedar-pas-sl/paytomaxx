import { Logger } from '@nestjs/common';
import type { PayoutVerifier, VerifyResult, VerifyInput } from './payout-verifier.interface';
import { amountVerdict, expectedUsdtOf, mismatch, notFound } from './onchain-check';

/**
 * Verifier USDC-Solana via Helius RPC (free tier) o Solana mainnet RPC público.
 * USDC mint: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
 *
 * Importante: en SPL Token, las transferencias van a la "Associated Token
 * Account" (ATA) derivada del wallet del receptor + mint del token, NO al
 * wallet base. Para matchear contra el wallet de la chica comparamos el
 * `owner` de la cuenta destino (postTokenBalances) o, si la chica dio la ATA,
 * la cuenta destino directamente.
 *
 * Se suman TODAS las transferencias USDC a su cuenta (instrucciones de primer
 * nivel e internas): una transacción puede pagar a varias o en varios trozos.
 */
const USDC_SOL_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_DECIMALS = 6;

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
      const json = await this.fetchTx(input.externalTxId);
      if (!json) return notFound('sol_http_error');
      if (!json.result) return notFound('sol_not_found');

      const usdcOwners = usdcAccountOwners(json.result);
      const amounts = allInstructions(json.result)
        .map((ix) => usdcAmountTo(ix, input.expectedToAddress, usdcOwners))
        .filter((a): a is number => a !== null);
      if (amounts.length === 0) {
        return mismatch(`destino_distinto: ninguna transferencia USDC va a la cuenta de la chica (${input.expectedToAddress})`);
      }
      if (amounts.some((a) => !Number.isFinite(a) || a <= 0)) return mismatch('sol_invalid_amount');

      const actualUsdc = amounts.reduce((sum, a) => sum + a, 0);
      const blockTime = json.result.blockTime;
      return amountVerdict(
        actualUsdc,
        await expectedUsdtOf(input, this.eurToUsdtRate),
        blockTime ? new Date(blockTime * 1000) : null,
      );
    } catch (err) {
      this.logger.warn(`Solana RPC exception: ${(err as Error).message}`);
      return notFound('sol_exception');
    }
  }

  private async fetchTx(signature: string): Promise<SolRpcResponse | null> {
    const res = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTransaction',
        params: [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok ? ((await res.json()) as SolRpcResponse) : null;
  }
}

type SolResult = NonNullable<SolRpcResponse['result']>;
type SolInstruction = { parsed?: { type?: string; info?: SolTransferInfo } };
interface SolTransferInfo {
  mint?: string;
  destination?: string;
  amount?: string;
  tokenAmount?: { uiAmount?: number };
}

/** Cuenta de token USDC → su dueño (wallet), desde postTokenBalances. */
function usdcAccountOwners(result: SolResult): Map<string, string> {
  const accountKeys = result.transaction?.message?.accountKeys ?? [];
  const owners = new Map<string, string>();
  for (const bal of result.meta?.postTokenBalances ?? []) {
    if (typeof bal.accountIndex !== 'number' || bal.mint !== USDC_SOL_MINT || !bal.owner) continue;
    const key = accountKeys[bal.accountIndex];
    const pubkey = typeof key === 'string' ? key : key?.pubkey;
    if (pubkey) owners.set(pubkey, bal.owner);
  }
  return owners;
}

function allInstructions(result: SolResult): SolInstruction[] {
  const top = result.transaction?.message?.instructions ?? [];
  const inner = (result.meta?.innerInstructions ?? []).flatMap((i) => i.instructions ?? []);
  return [...top, ...inner];
}

/** USDC que esta instrucción manda a la chica (null si no es una de esas). */
function usdcAmountTo(ix: SolInstruction, wallet: string, usdcOwners: Map<string, string>): number | null {
  const parsed = ix.parsed;
  const destination = parsed?.info?.destination;
  if (!parsed || !destination) return null;
  if (parsed.type === 'transferChecked') {
    if (parsed.info?.mint !== USDC_SOL_MINT) return null;
  } else if (parsed.type === 'transfer') {
    // Sin mint en la instrucción: solo vale si el destino es una cuenta de USDC.
    if (!usdcOwners.has(destination)) return null;
  } else {
    return null;
  }
  const isHers = usdcOwners.get(destination) === wallet || destination === wallet;
  if (!isHers) return null;
  return parsed.type === 'transferChecked'
    ? Number(parsed.info?.tokenAmount?.uiAmount ?? 0)
    : Number(parsed.info?.amount ?? '0') / 10 ** USDC_DECIMALS;
}

interface SolRpcResponse {
  result?: {
    blockTime?: number;
    transaction?: {
      message?: {
        accountKeys?: Array<string | { pubkey?: string }>;
        instructions?: SolInstruction[];
      };
    };
    meta?: {
      postTokenBalances?: Array<{
        accountIndex?: number;
        mint?: string;
        owner?: string;
      }>;
      innerInstructions?: Array<{ index?: number; instructions?: SolInstruction[] }>;
    };
  };
}
