import { beforeEach, describe, expect, it, vi } from 'vitest';

const authedFetch = vi.fn();
vi.mock('../http', () => ({
  API_BASE: 'http://api.test',
  authedFetch: (path: string, init: RequestInit) => authedFetch(path, init),
  totpAwareError: async (res: Response) => new Error(`HTTP ${res.status}`),
}));

const {
  assignSaVenues,
  createSaBusiness,
  createSaVenue,
  stepUpBody,
  unassignSaVenue,
  updateSaBusiness,
} = await import('./superadmin');

/** Lo último que se mandó: ruta, método y cuerpo. */
function lastCall(): { path: string; method: string | undefined; body: unknown } {
  const [path, init] = authedFetch.mock.calls.at(-1) as [string, RequestInit];
  return { path, method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined };
}

describe('stepUpBody', () => {
  it('sin motivo (opcional, p. ej. «Reanudar») no se manda: el API lo rechazaba con 400', () => {
    expect(stepUpBody({ totpCode: '123456', reason: '' })).toEqual({ totpCode: '123456' });
    expect(stepUpBody({ totpCode: '123456', reason: '   ' })).toEqual({ totpCode: '123456' });
    expect(stepUpBody({ totpCode: '123456' })).toEqual({ totpCode: '123456' });
  });

  it('con motivo, recortado', () => {
    expect(stepUpBody({ totpCode: '123456', reason: '  ya pagó  ' })).toEqual({ totpCode: '123456', reason: 'ya pagó' });
  });
});

describe('acciones con 2FA de negocios y locales: mandan totpCode', () => {
  beforeEach(() => {
    authedFetch.mockReset();
    authedFetch.mockImplementation(async () => new Response('{}', { status: 200 }));
  });

  it('meter locales en un negocio', async () => {
    await assignSaVenues('b-1', ['v-1', 'v-2'], '123456');
    expect(lastCall()).toEqual({
      path: '/v1/superadmin/businesses/b-1/venues',
      method: 'POST',
      body: { venueIds: ['v-1', 'v-2'], totpCode: '123456' },
    });
  });

  it('sacar un local: cuerpo { totpCode }', async () => {
    await unassignSaVenue('b-1', 'v-1', '654321');
    expect(lastCall()).toEqual({
      path: '/v1/superadmin/businesses/b-1/venues/v-1/unassign',
      method: 'POST',
      body: { totpCode: '654321' },
    });
  });

  it('alta de local y de negocio, y cambio del negocio: con código si lo hay; sin él, el cuerpo tal cual', async () => {
    await createSaVenue({ name: 'Luna', slug: 'luna', walletGroup: 'g1' }, '111111');
    expect(lastCall().body).toEqual({ name: 'Luna', slug: 'luna', walletGroup: 'g1', totpCode: '111111' });
    await createSaVenue({ name: 'Luna', slug: 'luna' });
    expect(lastCall().body).toEqual({ name: 'Luna', slug: 'luna' });

    await createSaBusiness({ name: 'Sol Noche', defaultPlatformCommissionBps: 800 }, '222222');
    expect(lastCall()).toMatchObject({ path: '/v1/superadmin/businesses', body: { defaultPlatformCommissionBps: 800, totpCode: '222222' } });

    await updateSaBusiness('b-1', { defaultPlatformCommissionBps: 500 }, '333333');
    expect(lastCall()).toEqual({
      path: '/v1/superadmin/businesses/b-1',
      method: 'PATCH',
      body: { defaultPlatformCommissionBps: 500, totpCode: '333333' },
    });
    await updateSaBusiness('b-1', { name: 'Sol Noche SL' });
    expect(lastCall().body).toEqual({ name: 'Sol Noche SL' });
  });
});
