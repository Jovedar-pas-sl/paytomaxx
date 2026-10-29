import { describe, expect, it, vi } from 'vitest';
vi.mock('./api', () => ({ authedFetch: vi.fn() }));
import { authedFetch } from './api';
import { activationLinkOf, fetchActivationLink } from './activation-link';

const NOW = Date.parse('2026-10-23T02:00:00Z');
const later = '2026-10-23T02:10:00Z';
/** Como los del API: 24 bytes al azar en base64url (32 caracteres). */
const TOKEN = 'Ab3_kQ9-zXw2LmN8pR4tVy6uHs1oJe5c';

describe('QR de activación de un solo uso (CARGADO)', () => {
  it('solo un enlace de activación nuestro (/w/a/<token>) que no ha caducado', () => {
    const url = `https://api.oxio.es/w/a/${TOKEN}`;
    expect(activationLinkOf({ url, expiresAt: later }, NOW)).toEqual({ url, expiresAt: later });
    expect(activationLinkOf({ url: 'https://api.oxio.es/pay/abc', expiresAt: later }, NOW)).toBeNull();
    expect(activationLinkOf({ url: 'javascript:alert(1)', expiresAt: later }, NOW)).toBeNull();
    expect(activationLinkOf({ url, expiresAt: '2026-10-23T01:59:00Z' }, NOW)).toBeNull();
    expect(activationLinkOf({ url: 'no es un enlace', expiresAt: later }, NOW)).toBeNull();
    expect(activationLinkOf({ url: 'https://api.oxio.es/w/a/', expiresAt: later }, NOW)).toBeNull();
    expect(activationLinkOf({ url: `https://api.oxio.es/w/a/${TOKEN}/pin`, expiresAt: later }, NOW)).toBeNull();
    expect(activationLinkOf(null, NOW)).toBeNull();
  });

  it('nunca el enlace permanente del saldo (/w/<enlace>), aunque lo mande un API de antes (M-2)', () => {
    expect(activationLinkOf({ url: `https://api.oxio.es/w/${TOKEN}`, expiresAt: later }, NOW)).toBeNull();
    expect(activationLinkOf({ url: `https://api.oxio.es/w/${TOKEN}?activar=1`, expiresAt: later }, NOW)).toBeNull();
  });

  it('lo pide con POST (cada vez uno nuevo, que anula el anterior); 404 o un fallo: no sale nada', async () => {
    vi.mocked(authedFetch).mockResolvedValueOnce(new Response('{}', { status: 404 }));
    await expect(fetchActivationLink('w-1')).resolves.toBeNull();
    vi.mocked(authedFetch).mockRejectedValueOnce(new Error('red'));
    await expect(fetchActivationLink('w-1')).resolves.toBeNull();
    vi.mocked(authedFetch).mockResolvedValueOnce(new Response(JSON.stringify({ url: `https://x.es/w/a/${TOKEN}`, expiresAt: '2999-01-01T00:00:00Z' })));
    await expect(fetchActivationLink('w 1')).resolves.toMatchObject({ url: `https://x.es/w/a/${TOKEN}` });
    expect(vi.mocked(authedFetch).mock.calls.at(-1)).toEqual(['/v1/reception/wallets/w%201/activation-link', { method: 'POST' }]);
  });
});
