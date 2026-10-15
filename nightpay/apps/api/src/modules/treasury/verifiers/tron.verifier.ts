import { Logger } from '@nestjs/common';
import type { PayoutVerifier, VerifyResult, VerifyInput } from './payout-verifier.interface';
import { amountVerdict, expectedUsdtOf, mismatch, notFound, sumTokenUnits } from './onchain-check';

/**
 * Verifier para USDT-TRC20 (Tron) via Tronscan free API.
 * Endpoint: https://apilist.tronscanapi.com/api/transaction-info?hash={txhash}
 * Free tier: 10k requests/día, suficiente para volumen Phase 1.
 *
 * El contrato USDT-TRC20 oficial es TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t.
 * Cuenta lo que llega a la dirección de la chica: la SUMA de todas las
 * transferencias USDT de la transacción a esa dirección (una transacción
 * puede pagar a varias), comparada en USDT con el margen de onchain-check.
 */
const USDT_TRC20_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const USDT_DECIMALS = 6;

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
      const body = await this.fetchTx(input.externalTxId);
      if (!body) return notFound('tron_http_error');

      // Tx no encontrada o aún sin confirmar
      if (!body.contractRet) return notFound('tron_pending_or_unknown');
      if (body.contractRet !== 'SUCCESS') {
        return mismatch(`tx_fallida: la transacción terminó en ${body.contractRet}`);
      }

      const usdtTransfers = (body.trc20TransferInfo ?? []).filter(
        (t) => t.contract_address?.toLowerCase() === USDT_TRC20_CONTRACT.toLowerCase(),
      );
      if (usdtTransfers.length === 0) return mismatch('sin_usdt: la transacción no mueve USDT-TRC20');

      const toOperator = usdtTransfers.filter(
        (t) => t.to_address?.toLowerCase() === input.expectedToAddress.toLowerCase(),
      );
      if (toOperator.length === 0) {
        return mismatch(
          `destino_distinto: ninguna transferencia USDT va a la dirección de la chica (${input.expectedToAddress})`,
        );
      }

      const actualUsdt = sumTokenUnits(toOperator.map((t) => t.amount_str), USDT_DECIMALS);
      const expectedUsdt = await expectedUsdtOf(input, this.eurToUsdtRate);
      const verdict = amountVerdict(actualUsdt, expectedUsdt, body.timestamp ? new Date(body.timestamp) : null);
      if (!verdict.matched) return verdict;

      // Confirmaciones suficientes — Tronscan body.confirmed booleano
      if (body.confirmed === false) return notFound('tron_unconfirmed');
      return verdict;
    } catch (err) {
      this.logger.warn(`Tronscan exception: ${(err as Error).message}`);
      return notFound('tron_exception');
    }
  }

  private async fetchTx(txId: string): Promise<TronscanTxInfo | null> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.apiKey) headers['TRON-PRO-API-KEY'] = this.apiKey;
    const url = `https://apilist.tronscanapi.com/api/transaction-info?hash=${encodeURIComponent(txId)}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      this.logger.warn(`Tronscan HTTP ${res.status} para tx=${txId}`);
      return null;
    }
    return (await res.json()) as TronscanTxInfo;
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
