import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { EXCEPTION_FILTERS_METADATA } from '@nestjs/common/constants';
import { PayPageFilter } from './pay-page.filter';
import { PublicPayController } from './public-pay.controller';

/** El 429 de las páginas GET de /pay: una página que espera y se recarga sola, en su idioma. */
function host(req: { url: string; query?: Record<string, string>; headers?: Record<string, string> }) {
  const sent: { status?: number; headers: Record<string, string>; body?: unknown; type?: string } = { headers: {} };
  const res = {
    status(code: number) {
      sent.status = code;
      return res;
    },
    header(k: string, v: string) {
      sent.headers[k] = v;
      return res;
    },
    type(t: string) {
      sent.type = t;
      return res;
    },
    send(body: unknown) {
      sent.body = body;
      return res;
    },
  };
  const request = { headers: {}, query: {}, ...req };
  return {
    host: { switchToHttp: () => ({ getRequest: () => request, getResponse: () => res }) } as never,
    sent,
  };
}

const tooMany = (retryAfter: number) =>
  new HttpException({ statusCode: 429, message: 'Demasiados intentos', code: 'RATE_LIMITED', retryAfter }, HttpStatus.TOO_MANY_REQUESTS);

describe('PayPageFilter — el 429 de las páginas de /pay', () => {
  it('HTML (no JSON) en el idioma de la página, que espera y vuelve a la misma página', () => {
    const { host: h, sent } = host({ url: '/pay/tok-1?lang=en', query: { lang: 'en' }, headers: { 'accept-language': 'es-ES' } });
    new PayPageFilter().catch(tooMany(12), h);
    expect(sent.status).toBe(429);
    expect(sent.headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(sent.headers['Retry-After']).toBe('12');
    expect(sent.body).toContain('<meta http-equiv="refresh" content="12;url=/pay/tok-1?lang=en">');
    expect(sent.body).toContain('Lots of people are paying at once');
    expect(sent.body).not.toContain('You have not been charged');
  });

  it('en castellano por el móvil; la espera entre 5 y 30 s', () => {
    const quick = host({ url: '/pay/result?op=ORD1', headers: { 'accept-language': 'es-ES,es;q=0.9' } });
    new PayPageFilter().catch(tooMany(1), quick.host);
    expect(quick.sent.body).toContain('content="5;url=/pay/result?op=ORD1"');
    expect(quick.sent.body).toContain('Hay mucha gente pagando a la vez');
    const slow = host({ url: '/pay/tok-1' });
    new PayPageFilter().catch(tooMany(59), slow.host);
    expect(slow.sent.headers['Retry-After']).toBe('30');
  });

  it('lo demás, como siempre (RFC 7807)', () => {
    const { host: h, sent } = host({ url: '/pay/tok-1' });
    new PayPageFilter().catch(new NotFoundException('Payment not found'), h);
    expect(sent.status).toBe(404);
    expect(sent.type).toBe('application/problem+json');
  });

  it('las cuatro páginas GET de /pay llevan su límite holgado y este filtro; los POST no', () => {
    const proto = PublicPayController.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const name of ['payPage', 'checkout', 'receipt', 'paymentResult']) {
      expect(Reflect.getMetadata('np:ip-rate-limit', proto[name]!)).toEqual({ max: 600, windowSec: 60, scope: 'pay-page', failOpen: true });
      const filters = Reflect.getMetadata(EXCEPTION_FILTERS_METADATA, proto[name]!) as unknown[];
      expect(filters.some((f) => f instanceof PayPageFilter)).toBe(true);
    }
    expect(Reflect.getMetadata(EXCEPTION_FILTERS_METADATA, proto.startCheckout!)).toBeUndefined();
  });
});
