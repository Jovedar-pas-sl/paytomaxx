import { describe, it, expect, vi } from 'vitest';
import { ProviderSchema, type Provider } from '@nightpay/contracts';
import { GatewayRegistry } from './gateway.registry';
import { WipayAdapter } from './wipay.adapter';
import { PeanpeAdapter } from './peanpe.adapter';
import { PaytefAdapter } from './paytef.adapter';
import { RedsysAdapter } from './redsys.adapter';

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
  };
}

function makeRegistry() {
  const a = realAdapters();
  return { registry: new GatewayRegistry(a.wipay, a.peanpe, a.paytef, a.redsys), ...a };
}

describe('GatewayRegistry.get — qué adapter atiende cada pasarela', () => {
  it.each([
    ['WIPAY', WipayAdapter],
    ['PEANPE', PeanpeAdapter],
    ['PAYTEF', PaytefAdapter],
    ['REDSYS', RedsysAdapter],
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

describe('GatewayRegistry.get — pasarela desconocida', () => {
  it.each(['STRIPE', 'redsys', '', 'REDSYS '])('%j → error que nombra la pasarela', (provider) => {
    const { registry } = makeRegistry();
    expect(() => registry.get(provider as Provider)).toThrow(Error);
    expect(() => registry.get(provider as Provider)).toThrow(`provider=${provider}`);
  });
});
