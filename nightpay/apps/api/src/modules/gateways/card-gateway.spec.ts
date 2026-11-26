import { describe, it, expect, afterEach, vi } from 'vitest';
import { cardGatewayChoices, cardGatewayFor, chooseCardGateway } from './card-gateway';
import { yavinEnabled } from './yavin-flag';

const T = '11111111-1111-4111-8111-111111111111';

function db(o: { selected?: boolean; yavinCredential?: boolean; base?: string | null }) {
  return {
    venue: { findUnique: vi.fn(async () => ({ yavinSelected: o.selected ?? false })) },
    gatewayCredential: {
      findFirst: vi.fn(async ({ where }: { where: { provider: unknown } }) => {
        if (where.provider === 'YAVIN') return o.yavinCredential ? { id: 'c' } : null;
        return o.base === null ? null : { provider: o.base ?? 'REDSYS' };
      }),
    },
  };
}

afterEach(() => vi.unstubAllEnvs());

describe('yavinEnabled: apagado por defecto', () => {
  it.each([undefined, '', 'false', '0', 'off'])('%s = apagado', (v) => expect(yavinEnabled({ YAVIN_ENABLED: v })).toBe(false));
  it.each(['true', '1', 'on', ' TRUE '])('%s = encendido', (v) => expect(yavinEnabled({ YAVIN_ENABLED: v })).toBe(true));
});

describe('cardGatewayFor: Yavin solo con servidor, super-admin y credencial', () => {
  const cobro = { tenantId: T, walletId: null };

  it('bandera apagada: la de siempre, aunque el local tenga todo de Yavin', async () => {
    vi.stubEnv('YAVIN_ENABLED', 'false');
    expect(await cardGatewayFor(db({ selected: true, yavinCredential: true }) as never, cobro)).toBe('REDSYS');
  });

  it('bandera encendida sin elegir o sin credencial: la de siempre', async () => {
    vi.stubEnv('YAVIN_ENABLED', 'true');
    expect(await cardGatewayFor(db({ selected: false, yavinCredential: true }) as never, cobro)).toBe('REDSYS');
    expect(await cardGatewayFor(db({ selected: true, yavinCredential: false }) as never, cobro)).toBe('REDSYS');
  });

  it('las dos: la que eligió el camarero; sin elegir, BBVA; las cargas de saldo, siempre BBVA', async () => {
    vi.stubEnv('YAVIN_ENABLED', 'true');
    const both = db({ selected: true, yavinCredential: true }) as never;
    expect(await cardGatewayFor(both, { ...cobro, cardGateway: 'YAVIN' })).toBe('YAVIN');
    expect(await cardGatewayFor(both, { ...cobro, cardGateway: 'REDSYS' })).toBe('REDSYS');
    expect(await cardGatewayFor(both, cobro)).toBe('REDSYS');
    expect(await cardGatewayFor(both, { tenantId: T, walletId: 'w', cardGateway: 'YAVIN' })).toBe('REDSYS');
  });

  it('solo Yavin: Yavin, elija lo que elija', async () => {
    vi.stubEnv('YAVIN_ENABLED', 'true');
    const only = db({ selected: true, yavinCredential: true, base: null }) as never;
    expect(await cardGatewayFor(only, cobro)).toBe('YAVIN');
    expect(await cardGatewayFor(only, { ...cobro, cardGateway: 'REDSYS' })).toBe('YAVIN');
  });

  it('Yavin elegido por el camarero pero apagado en el local: BBVA', async () => {
    vi.stubEnv('YAVIN_ENABLED', 'false');
    expect(await cardGatewayFor(db({ selected: true, yavinCredential: true }) as never, { ...cobro, cardGateway: 'YAVIN' })).toBe('REDSYS');
  });

  it('local sin pasarela: null (como hoy)', async () => {
    vi.stubEnv('YAVIN_ENABLED', 'false');
    expect(await cardGatewayFor(db({ base: null }) as never, cobro)).toBeNull();
  });

  it('chooseCardGateway y los botones del personal', () => {
    expect(chooseCardGateway({ base: 'REDSYS', yavin: false, requested: 'YAVIN' })).toBe('REDSYS');
    expect(chooseCardGateway({ base: null, yavin: true })).toBe('YAVIN');
    expect(chooseCardGateway({ base: 'REDSYS', yavin: true, requested: 'YAVIN' })).toBe('YAVIN');
    expect(chooseCardGateway({ base: 'REDSYS', yavin: true })).toBe('REDSYS');
    expect(cardGatewayChoices({ base: 'REDSYS', yavin: true })).toEqual(['REDSYS', 'YAVIN']);
    expect(cardGatewayChoices({ base: 'REDSYS', yavin: false })).toEqual([]);
    expect(cardGatewayChoices({ base: null, yavin: true })).toEqual([]);
  });
});
