import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PayoutMethod } from '@nightpay/contracts';
import type { PayoutVerifier } from './verifiers/payout-verifier.interface';
import { ManualVerifier } from './verifiers/manual.verifier';
import { TronVerifier } from './verifiers/tron.verifier';
import { BscVerifier } from './verifiers/bsc.verifier';
import { PolygonVerifier } from './verifiers/polygon.verifier';
import { SolanaVerifier } from './verifiers/solana.verifier';

const RATE_CACHE_TTL_MS = 60_000;
const RATE_STALE_TTL_MS = 6 * 60 * 60_000; // 6h — past this fallback is "degraded"
const RATE_FALLBACK = 1.07;

/**
 * Factory: resuelve qué verifier usar según el rail.
 * Cripto on-chain → verifier específico que llama al explorer.
 * Cualquier otro → ManualVerifier (admin confirma).
 *
 * Gestiona también el rate EUR→USDT (Binance) con caché + último-bueno persistido
 * en memoria como fallback graceful si Binance cae.
 */
@Injectable()
export class PayoutVerifierFactory implements OnModuleInit {
  private readonly logger = new Logger(PayoutVerifierFactory.name);
  private readonly verifiers = new Map<PayoutMethod, PayoutVerifier>();
  private readonly manual = new ManualVerifier();
  private readonly apiKeys: {
    tron?: string;
    bsc?: string;
    polygon?: string;
    helius?: string;
  };

  // Cache + último-bueno con timestamp para flag degraded
  private cachedRate: { value: number; at: number } | null = null;
  private lastGoodRate: { value: number; at: number } | null = null;

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.apiKeys = {
      tron: config.get<string>('TRONSCAN_API_KEY'),
      bsc: config.get<string>('BSCSCAN_API_KEY'),
      polygon: config.get<string>('POLYGONSCAN_API_KEY'),
      helius: config.get<string>('HELIUS_API_KEY'),
    };
    const rate = () => this.getEurToUsdtRate();
    this.verifiers.set('USDT_TRC20', new TronVerifier(this.apiKeys.tron, rate));
    this.verifiers.set('USDT_BEP20', new BscVerifier(this.apiKeys.bsc, rate));
    this.verifiers.set('USDC_POLY', new PolygonVerifier(this.apiKeys.polygon, rate));
    this.verifiers.set('USDC_SOL', new SolanaVerifier(this.apiKeys.helius, rate));
  }

  /**
   * Avisa al arrancar qué verifiers están en modo degraded (sin API key).
   * Sin key, los explorers públicos limitan a ~1 req/5s y devuelven results vacíos
   * silenciosamente — un payout legítimo se quedaría UNRECONCILED para siempre.
   */
  onModuleInit() {
    const missing: string[] = [];
    if (!this.apiKeys.tron) missing.push('TRONSCAN_API_KEY (USDT-TRC20)');
    if (!this.apiKeys.bsc) missing.push('BSCSCAN_API_KEY (USDT-BEP20)');
    if (!this.apiKeys.polygon) missing.push('POLYGONSCAN_API_KEY (USDC-POLY)');
    if (!this.apiKeys.helius) missing.push('HELIUS_API_KEY (USDC-SOL)');
    if (missing.length > 0) {
      this.logger.warn(
        `Verifiers en modo degraded (sin API key): ${missing.join(', ')}. ` +
          `Los explorers públicos rate-limitan a ~1 req/5s; payouts pueden quedar UNRECONCILED. ` +
          `Free tier: tronscan.org, bscscan.com, polygonscan.com, helius.dev.`,
      );
    } else {
      this.logger.log('Todos los verifiers cripto tienen API key configurada.');
    }
  }

  forMethod(method: PayoutMethod | null | undefined): PayoutVerifier {
    if (method && this.verifiers.has(method)) {
      return this.verifiers.get(method)!;
    }
    return this.manual;
  }

  /**
   * Devuelve el rate y si está degraded (usa fallback porque Binance no responde
   * y no hay último-bueno reciente). UI muestra warning si degraded.
   */
  async getEurToUsdtRateInfo(): Promise<{ rate: number; degraded: boolean }> {
    const now = Date.now();
    if (this.cachedRate && now - this.cachedRate.at < RATE_CACHE_TTL_MS) {
      return { rate: this.cachedRate.value, degraded: false };
    }
    try {
      const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=EURUSDT', {
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) throw new Error(`binance ${res.status}`);
      const body = (await res.json()) as { price?: string };
      const rate = Number(body.price);
      if (!Number.isFinite(rate) || rate <= 0) throw new Error('invalid_rate');
      this.cachedRate = { value: rate, at: now };
      this.lastGoodRate = { value: rate, at: now };
      return { rate, degraded: false };
    } catch (err) {
      this.logger.warn(`Binance EURUSDT down: ${(err as Error).message}`);
      // Fallback 1: último rate bueno si es reciente (<6h)
      if (this.lastGoodRate && now - this.lastGoodRate.at < RATE_STALE_TTL_MS) {
        return { rate: this.lastGoodRate.value, degraded: true };
      }
      // Fallback 2: hardcoded 1.07 (EUR ≈ 1.07 USDT 2026 baseline)
      return { rate: RATE_FALLBACK, degraded: true };
    }
  }

  private async getEurToUsdtRate(): Promise<number> {
    const info = await this.getEurToUsdtRateInfo();
    return info.rate;
  }
}
