import { describe, it, expect, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ForbiddenException, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';
import { PARTNER_ERRORS } from '@nightpay/contracts';
import { ZodValidationPipe } from '../../../common/pipes/zod.pipe';
import { isPartnerPath, partnerError, renderPartnerProblem, toPartnerError } from './partner-problem';

const Body = z.strictObject({ amount: z.number().int().min(1), description: z.string().min(1) });
const pipeError = (value: unknown) => {
  try {
    new ZodValidationPipe(Body).transform(value);
  } catch (err) {
    return err;
  }
  throw new Error('el pipe no falló');
};
const fastifyError = (statusCode: number, code: string) => Object.assign(new Error('x'), { statusCode, code });

describe('toPartnerError: cada fallo a su código del catálogo', () => {
  it('cuerpo que no es un objeto ([]) o que se pasa de los topes: 400 invalid_request', () => {
    expect(toPartnerError(pipeError([])).code).toBe('invalid_request');
    expect(toPartnerError(pipeError(Array.from({ length: 3000 }, () => 1))).code).toBe('invalid_request');
  });

  it('un campo que incumple su regla: 422 validation_failed con param (primer segmento) y «param: mensaje»', () => {
    const p = toPartnerError(pipeError({ amount: 0, description: 'x' }));
    expect(p).toMatchObject({ code: 'validation_failed', extra: { param: 'amount' } });
    expect(p.detail).toMatch(/^amount: /);
  });

  it('se lee el primer fallo de Zod (los fallos crudos, no flatten): uno de un campo antes que el campo de más', () => {
    expect(toPartnerError(pipeError({ amount: 0, description: 'x', currency: 'EUR' }))).toMatchObject({
      code: 'validation_failed',
      extra: { param: 'amount' },
    });
    const Nested = z.strictObject({ customer: z.strictObject({ phone: z.string() }) });
    let err: unknown;
    try {
      new ZodValidationPipe(Nested).transform({ customer: { phone: '600', extra: 1 } });
    } catch (e) {
      err = e;
    }
    // Un campo de más (también dentro de otro): param = la primera clave desconocida.
    expect(toPartnerError(err)).toMatchObject({ code: 'validation_failed', extra: { param: 'extra' } });
  });

  it('un campo de más (cuerpo estricto): 422 validation_failed con ese campo', () => {
    expect(toPartnerError(pipeError({ amount: 5, description: 'x', currency: 'EUR' }))).toMatchObject({
      code: 'validation_failed',
      extra: { param: 'currency' },
    });
  });

  it('los 4xx de Fastify (JSON roto, 415) y otro 4xx sin código: 400 invalid_request', () => {
    expect(toPartnerError(fastifyError(415, 'FST_ERR_CTP_INVALID_MEDIA_TYPE')).code).toBe('invalid_request');
    expect(toPartnerError(fastifyError(400, 'FST_ERR_CTP_EMPTY_JSON_BODY')).code).toBe('invalid_request');
    expect(toPartnerError(new ForbiddenException('nope')).code).toBe('invalid_request');
  });

  it('404, 413 y 429 con su código', () => {
    expect(toPartnerError(new NotFoundException()).code).toBe('not_found');
    expect(toPartnerError(fastifyError(413, 'FST_ERR_CTP_BODY_TOO_LARGE')).code).toBe('body_too_large');
    expect(toPartnerError(fastifyError(429, 'FST_ERR_RATE_LIMIT')).code).toBe('rate_limited');
  });

  it('la base sin conexión libre: 503 try_later; lo demás, 500 internal_error', () => {
    const busy = Object.assign(new Error('pool'), { name: 'PrismaClientKnownRequestError', code: 'P2024' });
    expect(toPartnerError(busy).code).toBe('try_later');
    expect(toPartnerError(new Error('column does not exist')).code).toBe('internal_error');
    expect(toPartnerError(new ServiceUnavailableException()).code).toBe('internal_error');
    expect(toPartnerError('raro').code).toBe('internal_error');
  });

  it('un error de la API de socios, tal cual', () => {
    expect(toPartnerError(partnerError('scope_missing', { required_scope: 'wallet:load' }))).toMatchObject({
      code: 'scope_missing',
      extra: { required_scope: 'wallet:load' },
    });
  });
});

describe('renderPartnerProblem', () => {
  function reply() {
    const headers: Record<string, unknown> = {};
    const r = {
      headers,
      statusCode: 0,
      payload: undefined as unknown,
      getHeader: (k: string) => headers[k.toLowerCase()],
      header: vi.fn((k: string, v: unknown) => {
        headers[k.toLowerCase()] = v;
        return r;
      }),
      status: vi.fn((s: number) => {
        r.statusCode = s;
        return r;
      }),
      type: vi.fn((t: string) => {
        headers['content-type'] = t;
        return r;
      }),
      send: vi.fn((p: unknown) => {
        r.payload = p;
        return r;
      }),
    };
    return r;
  }

  it('problem+json con Request-Id, no-store, sin _filterVersion; detail en español con Accept-Language: es', () => {
    const res = reply();
    const req = { url: '/v1/partner/me', headers: { 'accept-language': 'es-ES,en;q=0.8', 'x-request-id': 'atm0042-1' } };
    renderPartnerProblem(partnerError('invalid_api_key'), req as never, res as never);
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toBe('application/problem+json');
    expect(res.headers['request-id']).toBe('atm0042-1');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.payload).toEqual({
      type: 'https://docs.oxiopay.example/errors/invalid_api_key',
      title: 'Invalid API key',
      status: 401,
      code: 'invalid_api_key',
      detail: PARTNER_ERRORS.invalid_api_key.es,
      request_id: 'atm0042-1',
    });
  });

  it('429 y 503 llevan Retry-After', () => {
    const res = reply();
    renderPartnerProblem(partnerError('try_later'), { url: '/v1/partner/me', headers: {} } as never, res as never);
    expect(res.statusCode).toBe(503);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    const limited = reply();
    renderPartnerProblem(partnerError('rate_limited', {}, 42), { url: '/v1/partner/me', headers: {} } as never, limited as never);
    expect(limited.headers['retry-after']).toBe(42);
    expect((limited.payload as { detail: string }).detail).toBe(PARTNER_ERRORS.rate_limited.en);
  });

  it('solo /v1/partner/… (también /v1/partner a secas)', () => {
    expect(isPartnerPath('/v1/partner/me')).toBe(true);
    expect(isPartnerPath('/v1/partner/openapi.json?x=1')).toBe(true);
    expect(isPartnerPath('/v1/partner')).toBe(true);
    expect(isPartnerPath('/v1/partners')).toBe(false);
    expect(isPartnerPath('/v1/admin/partner-connections')).toBe(false);
    expect(isPartnerPath('/partner-key/abc')).toBe(false);
  });
});

describe('el log de un fallo inesperado', () => {
  it('no lleva la clave de socio ni en el mensaje ni en la traza (los redactores compartidos)', () => {
    const KEY = `oxp_live_${'0a1b'.repeat(12)}`;
    const spy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const err = new Error(`no se pudo con ${KEY} en /v1/partner/${KEY}/me`);
      err.stack = `Error: no se pudo con ${KEY}\n    at f (/app/x.js:1:1) ${KEY.replace(/_/g, '%5F')}`;
      const res = { header: () => res, getHeader: () => undefined, status: () => res, type: () => res, send: () => res };
      renderPartnerProblem(err, { url: '/v1/partner/me', headers: {} }, res as never);
      expect(spy).toHaveBeenCalled();
      const logged = JSON.stringify(spy.mock.calls);
      expect(logged).not.toContain(KEY);
      expect(logged).not.toContain(KEY.replace(/_/g, '%5F'));
      expect(logged).toContain('no se pudo con');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('catálogo', () => {
  it('todo partnerError(\'…\') del código está en el catálogo', () => {
    const src = join(__dirname, '..', '..', '..');
    const files = readdirSync(src, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'));
    const used = new Set<string>();
    for (const f of files) {
      for (const m of readFileSync(join(src, f), 'utf8').matchAll(/partnerError\(\s*'([a-z_]+)'/g)) used.add(m[1]!);
    }
    expect(used.size).toBeGreaterThan(10);
    expect([...used].filter((c) => !(c in PARTNER_ERRORS))).toEqual([]);
  });
});
