import { describe, it, expect, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { MetricsAccessGuard } from './metrics-access.guard';

const TOKEN = 'metrics-token-de-prueba-0123456789';

function makeGuard(env: Record<string, string | undefined>) {
  const config = { get: vi.fn().mockImplementation((k: string) => env[k]) };
  return new MetricsAccessGuard(config as any);
}

function ctx(headers: Record<string, string>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers, url: '/v1/metrics' }) }),
  } as unknown as ExecutionContext;
}

describe('MetricsAccessGuard', () => {
  it('fuera de producción siempre deja pasar', () => {
    const guard = makeGuard({ NODE_ENV: 'development' });
    expect(guard.canActivate(ctx({ 'cf-ray': 'abc' }))).toBe(true);
  });

  it('producción: scrape interno (sin cabeceras de proxy) pasa', () => {
    const guard = makeGuard({ NODE_ENV: 'production' });
    expect(guard.canActivate(ctx({}))).toBe(true);
  });

  it('producción: petición de internet (vía Cloudflare/Traefik) → 404', () => {
    const guard = makeGuard({ NODE_ENV: 'production' });
    expect(() => guard.canActivate(ctx({ 'cf-ray': 'abc', 'x-forwarded-for': '1.2.3.4' }))).toThrow(
      NotFoundException,
    );
    expect(() => guard.canActivate(ctx({ 'x-forwarded-for': '1.2.3.4' }))).toThrow(NotFoundException);
  });

  it('producción: desde internet con METRICS_TOKEN correcto pasa', () => {
    const guard = makeGuard({ NODE_ENV: 'production', METRICS_TOKEN: TOKEN });
    expect(
      guard.canActivate(ctx({ 'cf-ray': 'abc', authorization: `Bearer ${TOKEN}` })),
    ).toBe(true);
  });

  it('producción: token incorrecto o sin token configurado → 404', () => {
    const withToken = makeGuard({ NODE_ENV: 'production', METRICS_TOKEN: TOKEN });
    expect(() =>
      withToken.canActivate(ctx({ 'cf-ray': 'abc', authorization: 'Bearer otro-token' })),
    ).toThrow(NotFoundException);

    const noToken = makeGuard({ NODE_ENV: 'production' });
    expect(() =>
      noToken.canActivate(ctx({ 'cf-ray': 'abc', authorization: 'Bearer ' })),
    ).toThrow(NotFoundException);
  });
});
