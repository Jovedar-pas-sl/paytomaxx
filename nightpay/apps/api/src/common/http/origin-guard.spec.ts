import { describe, it, expect, vi } from 'vitest';
import { originAllowed, originAuthHook } from './origin-guard';
import { clientIp, isOriginVerified } from './client-ip';

const SECRET = 'un-secreto-largo-de-cloudflare-123';

function hookReq(url: string, headers: Record<string, string>) {
  return { url, headers: { ...headers } as Record<string, string | undefined>, raw: { socket: { remoteAddress: '10.0.1.7' } } };
}
function hookReply() {
  const send = vi.fn().mockReturnValue('enviado');
  return { code: vi.fn().mockReturnValue({ send }), send };
}

describe('hook de origen (main.ts)', () => {
  it('con la cabecera buena: pasa, la marca como de Cloudflare y quita el secreto', async () => {
    const req = hookReq('/v1/auth/login', {
      'x-origin-auth': SECRET,
      'cf-connecting-ip': '81.0.0.7',
      'x-forwarded-for': '203.0.113.9',
    });
    const reply = hookReply();
    await originAuthHook(SECRET)(req, reply);
    expect(reply.code).not.toHaveBeenCalled();
    expect(req.headers['x-origin-auth']).toBeUndefined();
    expect(isOriginVerified(req)).toBe(true);
    expect(clientIp(req)).toBe('81.0.0.7');
  });

  it('sin cabecera: 403 salvo healthcheck y avisos del banco (que no quedan marcados)', async () => {
    const reply = hookReply();
    await originAuthHook(SECRET)(hookReq('/v1/auth/login', {}), reply);
    expect(reply.code).toHaveBeenCalledWith(403);

    const webhook = hookReq('/v1/webhooks/redsys', { 'x-origin-auth': 'otro', 'cf-connecting-ip': '1.1.1.1' });
    const ok = hookReply();
    await originAuthHook(SECRET)(webhook, ok);
    expect(ok.code).not.toHaveBeenCalled();
    expect(webhook.headers['x-origin-auth']).toBeUndefined();
    expect(isOriginVerified(webhook)).toBe(false);
  });
});

describe('solo a través de Cloudflare', () => {
  it('sin secreto configurado no cambia nada', () => {
    expect(originAllowed({}, '/v1/auth/login', undefined)).toBe(true);
  });

  it('con secreto: pasa lo que trae la cabecera de Cloudflare', () => {
    expect(originAllowed({ 'x-origin-auth': SECRET }, '/v1/auth/login', SECRET)).toBe(true);
  });

  it('con secreto: lo que llega directo (sin cabecera o con otra) no pasa', () => {
    expect(originAllowed({}, '/v1/auth/login', SECRET)).toBe(false);
    expect(originAllowed({ 'x-origin-auth': 'otro' }, '/pay/abc', SECRET)).toBe(false);
    expect(originAllowed({ 'x-origin-auth': [SECRET, SECRET] }, '/pay/abc', SECRET)).toBe(false);
  });

  it('el healthcheck del contenedor pasa siempre', () => {
    expect(originAllowed({}, '/v1/health', SECRET)).toBe(true);
    expect(originAllowed({}, '/v1/health?x=1', SECRET)).toBe(true);
    expect(originAllowed({}, '/v1/healthz', SECRET)).toBe(false);
  });

  it('los avisos del banco pasan sin la cabecera (llevan su propia firma)', () => {
    expect(originAllowed({}, '/v1/webhooks/redsys', SECRET)).toBe(true);
    expect(originAllowed({}, '/v1/webhooks/paytef/abc?x=1', SECRET)).toBe(true);
    expect(originAllowed({}, '/v1/webhooksx', SECRET)).toBe(false);
    expect(originAllowed({}, '/v1/auth/login', SECRET)).toBe(false);
  });
});
