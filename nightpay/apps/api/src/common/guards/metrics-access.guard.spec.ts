import { describe, it, expect, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { MetricsAccessGuard } from './metrics-access.guard';

const TOKEN = 'metrics-token-de-prueba-0123456789';

function makeGuard(env: Record<string, string | undefined>) {
  const config = { get: vi.fn().mockImplementation((k: string) => env[k]) };
  return new MetricsAccessGuard(config as never);
}

function ctx(headers: Record<string, string>, peer = '10.0.1.7'): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers, url: '/v1/metrics', raw: { socket: { remoteAddress: peer } } }),
    }),
  } as unknown as ExecutionContext;
}

describe('MetricsAccessGuard', () => {
  it('fuera de producción siempre deja pasar', () => {
    const guard = makeGuard({ NODE_ENV: 'development' });
    expect(guard.canActivate(ctx({ 'cf-ray': 'abc' }))).toBe(true);
  });

  it('producción: sin token, ni siquiera la red interna (las cabeceras de proxy no prueban nada)', () => {
    const guard = makeGuard({ NODE_ENV: 'production', METRICS_TOKEN: TOKEN });
    expect(() => guard.canActivate(ctx({}))).toThrow(NotFoundException);
    expect(() => guard.canActivate(ctx({}, '127.0.0.1'))).toThrow(NotFoundException);
  });

  it('producción: petición de internet sin token → 404', () => {
    const guard = makeGuard({ NODE_ENV: 'production', METRICS_TOKEN: TOKEN });
    expect(() => guard.canActivate(ctx({ 'cf-ray': 'abc', 'x-forwarded-for': '1.2.3.4' }))).toThrow(
      NotFoundException,
    );
  });

  it('producción: con METRICS_TOKEN correcto pasa (scrape interno o desde internet)', () => {
    const guard = makeGuard({ NODE_ENV: 'production', METRICS_TOKEN: TOKEN });
    expect(guard.canActivate(ctx({ authorization: `Bearer ${TOKEN}` }))).toBe(true);
    expect(guard.canActivate(ctx({ 'cf-ray': 'abc', authorization: `Bearer ${TOKEN}` }))).toBe(true);
  });

  it('producción: token incorrecto o sin token configurado → 404', () => {
    const withToken = makeGuard({ NODE_ENV: 'production', METRICS_TOKEN: TOKEN });
    expect(() => withToken.canActivate(ctx({ authorization: 'Bearer otro-token' }))).toThrow(NotFoundException);

    const noToken = makeGuard({ NODE_ENV: 'production' });
    expect(() => noToken.canActivate(ctx({ authorization: 'Bearer ' }))).toThrow(NotFoundException);
    expect(() => noToken.canActivate(ctx({}))).toThrow(NotFoundException);
  });
});
