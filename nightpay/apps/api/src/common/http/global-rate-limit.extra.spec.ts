import { describe, it, expect } from 'vitest';
import { anonymousRateLimitKey, isGlobalRateLimitExempt } from './global-rate-limit';

const TRAEFIK = '10.0.1.7';

function viaRaw(url: string, peer: string, headers: Record<string, string> = {}, method = 'GET') {
  return { method, url, headers, raw: { socket: { remoteAddress: peer } } };
}

describe('exención del límite global — bordes', () => {
  it('healthcheck por loopback también con el socket de Fastify (sin raw) y con query', () => {
    expect(isGlobalRateLimitExempt({ method: 'GET', url: '/v1/health', headers: {}, socket: { remoteAddress: '::1' } })).toBe(
      true,
    );
    expect(isGlobalRateLimitExempt(viaRaw('/v1/health/live?probe=docker', '127.0.0.1'))).toBe(true);
  });

  it('rutas parecidas al health por loopback no quedan exentas', () => {
    for (const url of ['/v1/health/', '/v1/healthz', '/v1/health/live/x', '/v1/health/../auth/login']) {
      expect(isGlobalRateLimitExempt(viaRaw(url, '127.0.0.1'))).toBe(false);
    }
  });

  it('otra IP de loopback (127.0.0.2) o sin socket: no exenta', () => {
    expect(isGlobalRateLimitExempt(viaRaw('/v1/health', '127.0.0.2'))).toBe(false);
    expect(isGlobalRateLimitExempt({ method: 'GET', url: '/v1/health', headers: {} })).toBe(false);
  });

  it('health desde Traefik con cabeceras de loopback inventadas: cuenta', () => {
    const r = viaRaw('/v1/health', TRAEFIK, { 'x-forwarded-for': '127.0.0.1', 'cf-connecting-ip': '127.0.0.1' });
    expect(isGlobalRateLimitExempt(r)).toBe(false);
  });

  it.each(['/w//state', '/w/tok/state/extra', '/w/a/b/state', '/w/tok/statex', '/api/w/tok/state', '/w/tok/state#x'])(
    'sondeo del saldo: %s no es el sondeo → cuenta',
    (url) => {
      expect(isGlobalRateLimitExempt(viaRaw(url, TRAEFIK))).toBe(false);
    },
  );

  it('sondeo del saldo solo con GET (HEAD tampoco)', () => {
    expect(isGlobalRateLimitExempt(viaRaw('/w/AbC123_x/state', TRAEFIK))).toBe(true);
    expect(isGlobalRateLimitExempt(viaRaw('/w/AbC123_x/state', TRAEFIK, {}, 'HEAD'))).toBe(false);
  });
});

describe('clave del límite global', () => {
  it('cliente IPv6 detrás de Cloudflare → su IPv6', () => {
    const r = viaRaw('/v1/x', TRAEFIK, { 'cf-connecting-ip': '2a0c:5a80:1f02::1d', 'x-forwarded-for': '2606:4700:10::1' });
    expect(anonymousRateLimitKey(r)).toBe('ip:2a0c:5a80:1f02::1d');
  });

  it('sin socket: la IP de Fastify; sin nada → "desconocida" (un único cubo compartido)', () => {
    expect(anonymousRateLimitKey({ method: 'GET', url: '/v1/x', headers: {}, ip: '83.45.120.7' })).toBe('ip:83.45.120.7');
    expect(anonymousRateLimitKey({ method: 'GET', url: '/v1/x', headers: {} })).toBe('ip:desconocida');
  });
});
