import { describe, expect, it } from 'vitest';
import {
  checkCookieCsrf,
  clearedRefreshCookie,
  refreshCookie,
  refreshCookieName,
  wellFormedOrigin,
} from './session-cookie';

const PROD = { allowedOrigins: ['https://admin.paytomaxx.com', 'https://operator.paytomaxx.com'], isProd: true };
const ok = (origin: string) => ({ origin, 'x-oxiopay-client': '1' });

describe('cookie del refresh token', () => {
  it('producción: HttpOnly; Secure; SameSite=Strict; Path=/v1/auth; sin Domain; Max-Age de la sesión', () => {
    const c = refreshCookie('np_rt_admin.paytomaxx.com', 'jti.secreto', 2_592_000, true);
    expect(c).toBe(
      'np_rt_admin.paytomaxx.com=jti.secreto; Path=/v1/auth; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict',
    );
    expect(c).not.toMatch(/Domain/i);
  });

  it('en local (http) sin Secure: el navegador no la guardaría', () => {
    expect(refreshCookie('n', 't', 10, false)).toBe('n=t; Path=/v1/auth; Max-Age=10; HttpOnly; SameSite=Strict');
  });

  it('borrarla: mismo nombre y Path, Max-Age=0', () => {
    expect(clearedRefreshCookie('n', true)).toBe('n=; Path=/v1/auth; Max-Age=0; HttpOnly; Secure; SameSite=Strict');
  });

  it('una por app, sacada del Origin', () => {
    expect(refreshCookieName('https://admin.paytomaxx.com')).toBe('np_rt_admin.paytomaxx.com');
    expect(refreshCookieName('https://tpv.paytomaxx.com')).toBe('np_rt_tpv.paytomaxx.com');
    expect(refreshCookieName('http://localhost:4103')).toBe('np_rt_localhost_4103');
    expect(refreshCookieName('http://192.168.1.20:4104')).toBe('np_rt_192.168.1.20_4104');
  });
});

describe('checkCookieCsrf', () => {
  it('Origin exacto de la lista + cabecera → vale', () => {
    expect(checkCookieCsrf(ok('https://operator.paytomaxx.com'), PROD)).toEqual({
      ok: true,
      origin: 'https://operator.paytomaxx.com',
    });
  });

  it('sin la cabecera, o con otro valor → no', () => {
    expect(checkCookieCsrf({ origin: 'https://admin.paytomaxx.com' }, PROD)).toEqual({
      ok: false,
      reason: 'client-header',
    });
    expect(checkCookieCsrf({ origin: 'https://admin.paytomaxx.com', 'x-oxiopay-client': 'yes' }, PROD).ok).toBe(false);
    expect(
      checkCookieCsrf({ origin: 'https://admin.paytomaxx.com', 'x-oxiopay-client': ['1', '1'] }, PROD).ok,
    ).toBe(false);
  });

  it('Origin ausente, "null", ajeno, de un subdominio hermano o casi igual → no', () => {
    const bad = [
      undefined,
      'null',
      'https://evil.example',
      'https://pay.paytomaxx.com',
      'https://api.paytomaxx.com',
      'https://admin.paytomaxx.com/',
      'https://admin.paytomaxx.com:443',
      'http://admin.paytomaxx.com',
      'https://admin.paytomaxx.com.evil.example',
    ];
    for (const origin of bad) {
      const headers = { 'x-oxiopay-client': '1', ...(origin ? { origin } : {}) };
      expect(checkCookieCsrf(headers, PROD), String(origin)).toEqual({ ok: false, reason: 'origin' });
    }
  });

  it('producción sin CORS_ORIGINS: ninguno (como CORS)', () => {
    expect(checkCookieCsrf(ok('https://admin.paytomaxx.com'), { allowedOrigins: [], isProd: true }).ok).toBe(false);
  });

  it('en local sin lista: cualquier origen bien formado (la cabecera sigue haciendo falta)', () => {
    const dev = { allowedOrigins: [], isProd: false };
    expect(checkCookieCsrf(ok('http://localhost:4103'), dev).ok).toBe(true);
    expect(checkCookieCsrf(ok('http://192.168.1.20:4104'), dev).ok).toBe(true);
    expect(checkCookieCsrf({ origin: 'http://localhost:4103' }, dev).ok).toBe(false);
    expect(checkCookieCsrf(ok('file://x'), dev).ok).toBe(false);
  });

  it('en local con lista: la lista manda', () => {
    const dev = { allowedOrigins: ['http://localhost:4103'], isProd: false };
    expect(checkCookieCsrf(ok('http://localhost:9999'), dev).ok).toBe(false);
    expect(checkCookieCsrf(ok('http://localhost:4103'), dev).ok).toBe(true);
  });
});

describe('wellFormedOrigin', () => {
  it('solo esquema://host[:puerto], como lo manda el navegador', () => {
    expect(wellFormedOrigin('https://a.b')).toBe('https://a.b');
    expect(wellFormedOrigin('https://a.b/x')).toBeNull();
    expect(wellFormedOrigin('no es una url')).toBeNull();
    expect(wellFormedOrigin('')).toBeNull();
  });
});
