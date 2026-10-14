import { describe, it, expect } from 'vitest';
import { originAllowed } from './origin-guard';

const SECRET = 'un-secreto-largo-de-cloudflare-123';

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
