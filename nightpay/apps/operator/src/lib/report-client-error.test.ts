import { afterEach, describe, expect, it, vi } from 'vitest';
import { reportClientError } from '@nightpay/ui';

afterEach(() => vi.unstubAllGlobals());

describe('aviso de una pantalla rota (POST /v1/client-errors)', () => {
  it('manda la app, el mensaje, la huella y la ruta, sin sesión y sin esperar', () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('location', { pathname: '/' });
    reportClientError({ apiBase: 'https://api.x.es/', app: 'operator', error: Object.assign(new Error('boom'), { digest: 'abc' }) });
    expect(fetchMock).toHaveBeenCalledWith('https://api.x.es/v1/client-errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app: 'operator', message: 'boom', digest: 'abc', path: '/' }),
      keepalive: true,
    });
  });

  it('nunca lanza: sin red, la pantalla de fallo sigue', () => {
    vi.stubGlobal('fetch', () => {
      throw new Error('sin fetch');
    });
    expect(() => reportClientError({ apiBase: 'https://api.x.es', app: 'admin', error: new Error('x') })).not.toThrow();
  });
});
