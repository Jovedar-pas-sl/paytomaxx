import { describe, it, expect, vi } from 'vitest';
import { hasOriginAuth, isOriginOpenPath, originAllowed, originAuthHook } from './origin-guard';
import { clientIp, isOriginVerified } from './client-ip';

const SECRET = 'cf-origin-secreto-2026-abcdefghijkl';

function hookReq(url: string, headers: Record<string, string | string[]>) {
  return {
    url,
    headers: { ...headers } as Record<string, string | string[] | undefined>,
    raw: { socket: { remoteAddress: '10.0.1.7' } },
  };
}

function hookReply() {
  const send = vi.fn().mockReturnValue('enviado');
  return { code: vi.fn().mockReturnValue({ send }), send };
}

describe('hasOriginAuth — comparación del secreto', () => {
  it('distinta longitud (también en bytes UTF-8) → false sin lanzar', () => {
    expect(hasOriginAuth({ 'x-origin-auth': SECRET.slice(0, -1) }, SECRET)).toBe(false);
    expect(hasOriginAuth({ 'x-origin-auth': 'ñ'.repeat(SECRET.length) }, SECRET)).toBe(false);
  });

  it('misma longitud pero distinto (un carácter, mayúsculas) → false', () => {
    expect(hasOriginAuth({ 'x-origin-auth': `${SECRET.slice(0, -1)}X` }, SECRET)).toBe(false);
    expect(hasOriginAuth({ 'x-origin-auth': SECRET.toUpperCase() }, SECRET)).toBe(false);
  });

  it('vacía o repetida (array) → false; exacta → true', () => {
    expect(hasOriginAuth({ 'x-origin-auth': '' }, SECRET)).toBe(false);
    expect(hasOriginAuth({ 'x-origin-auth': [SECRET] }, SECRET)).toBe(false);
    expect(hasOriginAuth({ 'x-origin-auth': SECRET }, SECRET)).toBe(true);
  });
});

describe('isOriginOpenPath — solo healthcheck exacto y avisos del banco', () => {
  it.each(['/v1/health', '/v1/health/live', '/v1/health/live?probe=docker', '/v1/webhooks/redsys', '/v1/webhooks/peanpe/notify'])(
    '%s → abierta',
    (url) => {
      expect(isOriginOpenPath(url)).toBe(true);
    },
  );

  it.each([
    '/v1/health/',
    '/v1/healthcheck',
    '/v1/webhooks',
    '/V1/WEBHOOKS/redsys',
    '/api/v1/webhooks/redsys',
    '/v1/auth/login?next=/v1/webhooks/x',
    '/v1/superadmin/venues',
  ])('%s → cerrada', (url) => {
    expect(isOriginOpenPath(url)).toBe(false);
  });
});

describe('originAuthHook — casos que faltaban', () => {
  it('cabecera repetida aunque una sea la buena → 403, se quita y no se marca', async () => {
    const req = hookReq('/v1/payments', { 'x-origin-auth': [SECRET, SECRET], 'cf-connecting-ip': '1.1.1.1' });
    const reply = hookReply();
    await originAuthHook(SECRET)(req, reply);
    expect(reply.code).toHaveBeenCalledWith(403);
    expect(req.headers['x-origin-auth']).toBeUndefined();
    expect(isOriginVerified(req)).toBe(false);
  });

  it('secreto de otra longitud → 403 (sin excepción de timingSafeEqual)', async () => {
    const reply = hookReply();
    await expect(originAuthHook(SECRET)(hookReq('/v1/auth/login', { 'x-origin-auth': 'corto' }), reply)).resolves.toBe(
      'enviado',
    );
    expect(reply.code).toHaveBeenCalledWith(403);
  });

  it('aviso del banco CON la cabecera buena: pasa y queda marcado (CF-Connecting-IP de fiar)', async () => {
    const req = hookReq('/v1/webhooks/redsys', {
      'x-origin-auth': SECRET,
      'cf-connecting-ip': '83.45.120.7',
      'x-forwarded-for': '203.0.113.9',
    });
    const reply = hookReply();
    await expect(originAuthHook(SECRET)(req, reply)).resolves.toBeUndefined();
    expect(isOriginVerified(req)).toBe(true);
    expect(clientIp(req)).toBe('83.45.120.7');
  });

  it('healthcheck con query sin cabecera: pasa sin marcar', async () => {
    const req = hookReq('/v1/health/live?probe=1', {});
    const reply = hookReply();
    await expect(originAuthHook(SECRET)(req, reply)).resolves.toBeUndefined();
    expect(reply.code).not.toHaveBeenCalled();
    expect(isOriginVerified(req)).toBe(false);
  });
});

describe('originAllowed', () => {
  it('secreto vacío equivale a sin configurar (el esquema de entorno exige >= 24)', () => {
    expect(originAllowed({}, '/v1/auth/login', '')).toBe(true);
  });

  it('con secreto, una ruta cerrada con cabecera buena pasa y con la de otro entorno no', () => {
    expect(originAllowed({ 'x-origin-auth': SECRET }, '/v1/superadmin/venues', SECRET)).toBe(true);
    expect(originAllowed({ 'x-origin-auth': 'cf-origin-secreto-STAGING-abcdefg' }, '/v1/superadmin/venues', SECRET)).toBe(
      false,
    );
  });
});
