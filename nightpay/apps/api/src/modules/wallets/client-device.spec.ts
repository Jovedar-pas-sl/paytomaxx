import { describe, it, expect } from 'vitest';
import {
  deviceCookieHeader,
  deviceTokenHash,
  newDeviceToken,
  readDeviceToken,
  relyingParty,
} from './client-device';

describe('llave del móvil (cookie np_dev)', () => {
  it('cada móvil una llave aleatoria; en la base, solo su huella', () => {
    const a = newDeviceToken();
    const b = newDeviceToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(deviceTokenHash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(deviceTokenHash(a)).not.toContain(a);
  });

  it('se lee de la cabecera Cookie; lo que no tiene forma de llave se ignora', () => {
    const t = newDeviceToken();
    expect(readDeviceToken(`otra=1; __Host-np_dev=${t}; x=2`, true)).toBe(t);
    expect(readDeviceToken('__Host-np_dev=corta', true)).toBeNull();
    expect(readDeviceToken(`__Host-np_dev=${t}"><script>`, true)).toBeNull();
    expect(readDeviceToken(undefined, true)).toBeNull();
    // En producción no vale la cookie sin prefijo (la podría poner otro subdominio).
    expect(readDeviceToken(`np_dev=${t}`, true)).toBeNull();
    expect(readDeviceToken(`np_dev=${t}`, false)).toBe(t);
  });

  it('cookie __Host- HttpOnly para todo el sitio en producción; sin prefijo ni Secure en http', () => {
    const t = newDeviceToken();
    expect(deviceCookieHeader(t, true)).toBe(
      `__Host-np_dev=${t}; Path=/; Max-Age=34560000; HttpOnly; Secure; SameSite=Lax`,
    );
    expect(deviceCookieHeader(t, false)).toBe(`np_dev=${t}; Path=/; Max-Age=34560000; HttpOnly; SameSite=Lax`);
  });
});

describe('dominio de Face ID / huella (rpID)', () => {
  const env = { apiUrl: 'https://api.paytomaxx.com', webClientUrl: 'https://pay.paytomaxx.com', production: true };

  it('el dominio de la página, si es uno de los nuestros', () => {
    expect(relyingParty('pay.paytomaxx.com', env)).toEqual({
      rpID: 'pay.paytomaxx.com',
      origins: ['https://api.paytomaxx.com', 'https://pay.paytomaxx.com'],
    });
    expect(relyingParty('API.paytomaxx.com', env).rpID).toBe('api.paytomaxx.com');
  });

  it('un Host ajeno no cambia nada: vale el del API', () => {
    expect(relyingParty('evil.example', env).rpID).toBe('api.paytomaxx.com');
    expect(relyingParty(undefined, env).rpID).toBe('api.paytomaxx.com');
  });

  it('sin web aparte y en desarrollo, también localhost', () => {
    const dev = relyingParty('localhost:4100', { apiUrl: 'api.paytomaxx.com', production: false });
    expect(dev.rpID).toBe('localhost');
    expect(dev.origins).toContain('http://localhost:4100');
    expect(relyingParty(undefined, { apiUrl: 'https://api.paytomaxx.com', production: true }).origins).toEqual([
      'https://api.paytomaxx.com',
    ]);
  });
});
