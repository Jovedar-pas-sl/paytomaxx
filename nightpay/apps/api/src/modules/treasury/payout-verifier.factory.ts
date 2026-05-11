import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PayoutMethod } from '@nightpay/contracts';
import type { PayoutVerifier } from './verifiers/payout-verifier.interface';
import { ManualVerifier } from './verifiers/manual.verifier';
import { TronVerifier } from './verifiers/tron.verifier';
import { BscVerifier } from './verifiers/bsc.verifier';
import { PolygonVerifier } from './verifiers/polygon.verifier';
import { SolanaVerifier } from './verifiers/solana.verifier';

/**
 * Factory: resuelve qué verifier usar según el rail.
 * Cripto on-chain → verifier específico que llama al explorer.
 * Cualquier otro → ManualVerifier (admin confirma).
 */
@Injectable()
export class PayoutVerifierFactory {
  private readonly logger = new Logger(PayoutVerifierFactory.name);
  private readonly verifiers = new Map<PayoutMethod, PayoutVerifier>();
  private readonly manual = new ManualVerifier();

  constructor(@Inject(ConfigService) config: ConfigService) {
    const rate = () => this.getEurToUsdtRate();
    this.verifiers.set('USDT_TRC20', new TronVerifier(config.get<string>('TRONSCAN_API_KEY'), rate));
    this.verifiers.set('USDT_BEP20', new BscVerifier(config.get<string>('BSCSCAN_API_KEY'), rate));
    this.verifiers.set('USDC_POLY', new PolygonVerifier(config.get<string>('POLYGONSCAN_API_KEY'), rate));
    this.verifiers.set('USDC_SOL', new SolanaVerifier(config.get<string>('HELIUS_API_KEY'), rate));
  }

  forMethod(method: PayoutMethod | null | undefined): PayoutVerifier {
    if (method && this.verifiers.has(method)) {
      return this.verifiers.get(method)!;
    }
    return this.manual;
  }

  /**
   * Conversión EUR → USDT vía Binance API público (free).
   * Se cachea 60s para evitar pegar a Binance en cada verify.
   */
  private cachedRate: { value: number; at: number } | null = null;
  private async getEurToUsdtRate(): Promise<number> {
    const now = Date.now();
    if (this.cachedRate && now - this.cachedRate.at < 60_000) return this.cachedRate.value;
    try {
      const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=EURUSDT', {
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) throw new Error(`binance ${res.status}`);
      const body = (await res.json()) as { price?: string };
      const rate = Number(body.price);
      if (!Number.isFinite(rate) || rate <= 0) throw new Error('invalid_rate');
      this.cachedRate = { value: rate, at: now };
      return rate;
    } catch (err) {
      this.logger.warn(`Binance EURUSDT rate fallback 1.07: ${(err as Error).message}`);
      // Fallback razonable (EUR ≈ 1.07 USDT en 2026)
      return 1.07;
    }
  }
}
