import { describe, it, expect, afterEach, vi } from 'vitest';
import { cardGatewayFor, chooseCardGateway } from './card-gateway';
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

  it('todo encendido: Yavin en los cobros; las cargas de saldo, la de siempre', async () => {
    vi.stubEnv('YAVIN_ENABLED', 'true');
    expect(await cardGatewayFor(db({ selected: true, yavinCredential: true }) as never, cobro)).toBe('YAVIN');
    expect(await cardGatewayFor(db({ selected: true, yavinCredential: true }) as never, { tenantId: T, walletId: 'w' })).toBe('REDSYS');
  });

  it('local sin pasarela: null (como hoy)', async () => {
    vi.stubEnv('YAVIN_ENABLED', 'false');
    expect(await cardGatewayFor(db({ base: null }) as never, cobro)).toBeNull();
  });

  it('chooseCardGateway', () => {
    expect(chooseCardGateway({ base: 'REDSYS', yavin: false })).toBe('REDSYS');
    expect(chooseCardGateway({ base: null, yavin: true })).toBe('YAVIN');
  });
});
