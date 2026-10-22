import { describe, expect, it, vi } from 'vitest';
vi.mock('./api', () => ({ authedFetch: vi.fn() }));
import { authedFetch } from './api';
import { activationLinkOf, fetchActivationLink } from './activation-link';

const NOW = Date.parse('2026-10-23T02:00:00Z');
const later = '2026-10-23T02:10:00Z';

describe('«Activar Face ID en su móvil»', () => {
  it('solo un enlace a la página del saldo que no ha caducado', () => {
    expect(activationLinkOf({ url: 'https://api.oxio.es/w/abc?activar=1', expiresAt: later }, NOW)).toEqual({ url: 'https://api.oxio.es/w/abc?activar=1', expiresAt: later });
    expect(activationLinkOf({ url: 'https://api.oxio.es/pay/abc', expiresAt: later }, NOW)).toBeNull();
    expect(activationLinkOf({ url: 'javascript:alert(1)', expiresAt: later }, NOW)).toBeNull();
    expect(activationLinkOf({ url: 'https://api.oxio.es/w/abc', expiresAt: '2026-10-23T01:59:00Z' }, NOW)).toBeNull();
    expect(activationLinkOf({ url: 'no es un enlace', expiresAt: later }, NOW)).toBeNull();
    expect(activationLinkOf(null, NOW)).toBeNull();
  });
  it('404 (ya tiene Face ID, no es reciente…) o un fallo: no sale nada', async () => {
    vi.mocked(authedFetch).mockResolvedValueOnce(new Response('{}', { status: 404 }));
    await expect(fetchActivationLink('w-1')).resolves.toBeNull();
    vi.mocked(authedFetch).mockRejectedValueOnce(new Error('red'));
    await expect(fetchActivationLink('w-1')).resolves.toBeNull();
    vi.mocked(authedFetch).mockResolvedValueOnce(new Response(JSON.stringify({ url: 'https://x.es/w/t', expiresAt: '2999-01-01T00:00:00Z' })));
    await expect(fetchActivationLink('w 1')).resolves.toMatchObject({ url: 'https://x.es/w/t' });
    expect(vi.mocked(authedFetch).mock.calls.at(-1)?.[0]).toBe('/v1/reception/wallets/w%201/activation-link');
  });
});
