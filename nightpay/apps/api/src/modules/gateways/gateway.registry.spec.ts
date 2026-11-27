import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProviderSchema, type Provider } from '@nightpay/contracts';
import { GatewayRegistry } from './gateway.registry';
import { WipayAdapter } from './wipay.adapter';
import { PeanpeAdapter } from './peanpe.adapter';
import { PaytefAdapter } from './paytef.adapter';
import { RedsysAdapter } from './redsys.adapter';
import { BtcpayAdapter } from './btcpay.adapter';
import { YavinAdapter } from './yavin.adapter';

/** Adapters reales: solo se construyen (no llaman a ninguna pasarela). */
function realAdapters() {
  const config = { get: vi.fn((k: string) => (k === 'GATEWAY_TIMEOUT_MS' ? 5000 : undefined)) };
  const metrics = { gatewayDuration: { observe: vi.fn() }, circuitState: { set: vi.fn() } };
  const prisma = { asSystem: vi.fn() };
  return {
    wipay: new WipayAdapter(config as never, metrics as never),
    peanpe: new PeanpeAdapter(config as never, metrics as never, prisma as never),
    paytef: new PaytefAdapter(config as never, metrics as never),
    redsys: new RedsysAdapter(config as never, metrics as never),
    btcpay: new BtcpayAdapter(),
    yavin: new YavinAdapter(config as never, metrics as never, prisma as never),
  };
}

function makeRegistry() {
  const a = realAdapters();
  return { registry: new GatewayRegistry(a.wipay, a.peanpe, a.paytef, a.redsys, a.btcpay, a.yavin), ...a };
}

describe('GatewayRegistry.get — qué adapter atiende cada pasarela', () => {
  beforeEach(() => vi.stubEnv('YAVIN_ENABLED', 'true'));
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ['WIPAY', WipayAdapter],
    ['PEANPE', PeanpeAdapter],
    ['PAYTEF', PaytefAdapter],
    ['REDSYS', RedsysAdapter],
    ['BTCPAY', BtcpayAdapter],
    ['YAVIN', YavinAdapter],
  ] as const)('%s → su propio adapter', (provider, AdapterClass) => {
    const { registry } = makeRegistry();
    const adapter = registry.get(provider);
    expect(adapter).toBeInstanceOf(AdapterClass);
    expect(adapter.provider).toBe(provider);
  });

  it('devuelve la misma instancia inyectada (sin copias: comparte breakers y métricas)', () => {
    const { registry, wipay, peanpe, paytef, redsys } = makeRegistry();
    expect(registry.get('WIPAY')).toBe(wipay);
    expect(registry.get('PEANPE')).toBe(peanpe);
    expect(registry.get('PAYTEF')).toBe(paytef);
    expect(registry.get('REDSYS')).toBe(redsys);
    expect(registry.get('REDSYS')).toBe(registry.get('REDSYS'));
  });

  it('cubre todas las pasarelas del contrato (una nueva sin adapter rompe aquí)', () => {
    const { registry } = makeRegistry();
    for (const provider of ProviderSchema.options) {
      expect(registry.get(provider).provider).toBe(provider);
    }
  });

  it('cada pasarela resuelve a un adapter distinto', () => {
    const { registry } = makeRegistry();
    const adapters = new Set(ProviderSchema.options.map((p) => registry.get(p)));
    expect(adapters.size).toBe(ProviderSchema.options.length);
  });
});

describe('GatewayRegistry.get — Yavin con YAVIN_ENABLED apagado', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('el adapter de Yavin sigue ahí: los intentos ya guardados se comprueban, anulan y devuelven', () => {
    vi.stubEnv('YAVIN_ENABLED', 'false');
    const { registry, yavin } = makeRegistry();
    expect(registry.get('YAVIN')).toBe(yavin);
    expect(registry.get('REDSYS')).toBeInstanceOf(RedsysAdapter);
  });

  it('pero no abre enlaces nuevos', async () => {
    vi.stubEnv('YAVIN_ENABLED', 'false');
    const { registry } = makeRegistry();
    await expect(
      registry.get('YAVIN').authorize({ paymentId: 'p', attemptId: 'a', tenantId: 't', amountCents: 2_500, currency: 'EUR' } as never),
    ).rejects.toThrow(/YAVIN_ENABLED/);
  });
});

describe('GatewayRegistry.get — pasarela desconocida', () => {
  it.each(['STRIPE', 'redsys', '', 'REDSYS '])('%j → error que nombra la pasarela', (provider) => {
    const { registry } = makeRegistry();
    expect(() => registry.get(provider as Provider)).toThrow(Error);
    expect(() => registry.get(provider as Provider)).toThrow(`provider=${provider}`);
  });
});
