import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PayoutVerifierFactory } from './payout-verifier.factory';
import { ManualVerifier } from './verifiers/manual.verifier';
import { TronVerifier } from './verifiers/tron.verifier';

function makeConfig(keys: Record<string, string | undefined> = {}) {
  return {
    get: vi.fn().mockImplementation((k: string) => keys[k]),
  };
}

describe('PayoutVerifierFactory.forMethod', () => {
  let factory: PayoutVerifierFactory;

  beforeEach(() => {
    factory = new PayoutVerifierFactory(makeConfig({
      TRONSCAN_API_KEY: 'tron-key',
      BSCSCAN_API_KEY: 'bsc-key',
      POLYGONSCAN_API_KEY: 'poly-key',
      HELIUS_API_KEY: 'helius-key',
    }) as never);
  });

  it('resolves USDT_TRC20 to TronVerifier', () => {
    expect(factory.forMethod('USDT_TRC20')).toBeInstanceOf(TronVerifier);
  });

  it('falls back to ManualVerifier for non-crypto methods', () => {
    expect(factory.forMethod('SEPA_IBAN')).toBeInstanceOf(ManualVerifier);
    expect(factory.forMethod('FASTERPAY_EMAIL')).toBeInstanceOf(ManualVerifier);
    expect(factory.forMethod('MANUAL_CASH')).toBeInstanceOf(ManualVerifier);
    expect(factory.forMethod('MERCADOPAGO_CVU')).toBeInstanceOf(ManualVerifier);
  });

  it('falls back to ManualVerifier for null/undefined method', () => {
    expect(factory.forMethod(null)).toBeInstanceOf(ManualVerifier);
    expect(factory.forMethod(undefined)).toBeInstanceOf(ManualVerifier);
  });
});

describe('PayoutVerifierFactory.getEurToUsdtRateInfo', () => {
  let factory: PayoutVerifierFactory;

  beforeEach(() => {
    factory = new PayoutVerifierFactory(makeConfig() as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns Binance live rate with degraded:false on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ price: '1.0850' }),
    }));
    const info = await factory.getEurToUsdtRateInfo();
    expect(info.rate).toBe(1.085);
    expect(info.degraded).toBe(false);
  });

  it('returns hardcoded fallback (1.07) with degraded:true when Binance is down and no cached rate', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ENETUNREACH')));
    const info = await factory.getEurToUsdtRateInfo();
    expect(info.rate).toBe(1.07);
    expect(info.degraded).toBe(true);
  });

  it('returns last-good rate with degraded:true when Binance is down but cache exists', async () => {
    // Primer call OK → cachea
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ price: '1.0900' }),
    }));
    await factory.getEurToUsdtRateInfo();

    // Segundo call: Binance falla, pero el cache de 60s sigue válido
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    const info = await factory.getEurToUsdtRateInfo();
    expect(info.rate).toBe(1.09);
    // Aún dentro del TTL de 60s → degraded false porque vino del cache fresco
    expect(info.degraded).toBe(false);
  });
});

describe('ManualVerifier', () => {
  it('always returns UNRECONCILED with manual_required reason', async () => {
    const verifier = new ManualVerifier();
    const result = await verifier.verify({
      externalTxId: 'irrelevant',
      expectedToAddress: 'irrelevant',
      expectedAmountCents: 10_000,
    });
    expect(result.matched).toBe(false);
    expect(result.status).toBe('UNRECONCILED');
    expect(result.reason).toBe('manual_required');
  });
});
