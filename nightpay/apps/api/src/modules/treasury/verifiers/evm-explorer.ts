import type { VerifyInput, VerifyResult } from './payout-verifier.interface';
import { amountVerdict, mismatch, notFound, sumTokenUnits } from './onchain-check';

/** Fila de `module=account&action=tokentx` (BscScan / PolygonScan, formato Etherscan). */
export interface EvmTokenTx {
  hash?: string;
  to?: string;
  value?: string;
  tokenDecimal?: string;
  timeStamp?: string;
  confirmations?: string;
}

interface ExplorerResponse {
  status?: string;
  result?: EvmTokenTx[] | string;
}

/**
 * Transferencias del token con la dirección de la chica (documentado:
 * contractaddress + address), filtradas por el hash de la transacción.
 * null si el explorador no contesta bien.
 */
export async function tokenTransfersOfTx(args: {
  baseUrl: string;
  contract: string;
  address: string;
  txId: string;
  apiKey: string;
}): Promise<EvmTokenTx[] | null> {
  const qs = new URLSearchParams({
    module: 'account',
    action: 'tokentx',
    contractaddress: args.contract,
    address: args.address,
    txhash: args.txId,
    page: '1',
    offset: '1000',
    sort: 'desc',
    apikey: args.apiKey,
  });
  const res = await fetch(`${args.baseUrl}?${qs.toString()}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return null;
  const body = (await res.json()) as ExplorerResponse;
  if (body.status !== '1' || !Array.isArray(body.result)) return [];
  const tx = args.txId.toLowerCase();
  return body.result.filter((r) => r.hash?.toLowerCase() === tx);
}

/**
 * Veredicto con las transferencias de la transacción: suma lo que llegó a la
 * dirección de la chica (todas, no solo la primera) y lo compara en USDT.
 */
export function evmTransfersVerdict(args: {
  rows: EvmTokenTx[];
  input: VerifyInput;
  expectedUsdt: number;
  minConfirmations: number;
  chain: string;
  defaultDecimals: number;
}): VerifyResult {
  const to = args.input.expectedToAddress.toLowerCase();
  const toOperator = args.rows.filter((r) => r.to?.toLowerCase() === to);
  if (toOperator.length === 0) {
    return mismatch(`destino_distinto: la transacción no envía el token a la dirección de la chica (${args.input.expectedToAddress})`);
  }
  const decimals = Number(toOperator[0]!.tokenDecimal ?? String(args.defaultDecimals));
  const actual = sumTokenUnits(toOperator.map((r) => r.value), decimals);
  const ts = toOperator[0]!.timeStamp;
  const verdict = amountVerdict(actual, args.expectedUsdt, ts ? new Date(Number(ts) * 1000) : null);
  if (!verdict.matched) return verdict;
  const confirmations = Math.min(...toOperator.map((r) => Number(r.confirmations ?? '0')));
  return confirmations < args.minConfirmations ? notFound(`${args.chain}_unconfirmed`) : verdict;
}
