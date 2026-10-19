import { describe, it, expect, vi } from 'vitest';
import { NotFoundException, type ExecutionContext } from '@nestjs/common';
import { MetricsAccessGuard } from './metrics-access.guard';

const TOKEN = 'prom-scrape-token-2026-0123456789abcdef';

function guard(env: Record<string, string | undefined>) {
  return new MetricsAccessGuard({ get: vi.fn((k: string) => env[k]) } as never);
}

function ctx(headers: Record<string, string | string[]>): ExecutionContext {
  const req = { headers, url: '/v1/metrics', raw: { socket: { remoteAddress: '10.0.1.7' } } };
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

const prod = guard({ NODE_ENV: 'production', METRICS_TOKEN: TOKEN });

describe('MetricsAccessGuard — formato del token en producción', () => {
  it.each([
    ['esquema en minúsculas', `bearer ${TOKEN}`],
    ['espacio de más al final', `Bearer ${TOKEN} `],
    ['dos espacios tras Bearer', `Bearer  ${TOKEN}`],
    ['prefijo del token', `Bearer ${TOKEN.slice(0, -1)}`],
    ['token con algo más', `Bearer ${TOKEN}x`],
    ['token en mayúsculas', `Bearer ${TOKEN.toUpperCase()}`],
    ['Basic con el token', `Basic ${TOKEN}`],
    ['solo el token, sin esquema', TOKEN],
  ])('%s → 404', (_caso, authorization) => {
    expect(() => prod.canActivate(ctx({ authorization }))).toThrow(NotFoundException);
  });

  it('cabecera repetida (array) aunque traiga el token bueno → 404', () => {
    expect(() => prod.canActivate(ctx({ authorization: [`Bearer ${TOKEN}`] }))).toThrow(NotFoundException);
  });

  it('el token en otra cabecera o en la query no cuenta', () => {
    expect(() => prod.canActivate(ctx({ 'x-metrics-token': TOKEN }))).toThrow(NotFoundException);
  });

  it('METRICS_TOKEN vacío: cerrado aunque se mande "Bearer " vacío', () => {
    const vacio = guard({ NODE_ENV: 'production', METRICS_TOKEN: '' });
    expect(() => vacio.canActivate(ctx({ authorization: 'Bearer ' }))).toThrow(NotFoundException);
  });

  it('petición sin IP conocida: sigue cerrando (el aviso no rompe)', () => {
    const req = { headers: {}, url: '/v1/metrics' };
    const sinIp = { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
    expect(() => prod.canActivate(sinIp)).toThrow(NotFoundException);
  });

  it('token exacto → pasa', () => {
    expect(prod.canActivate(ctx({ authorization: `Bearer ${TOKEN}` }))).toBe(true);
  });
});

describe('MetricsAccessGuard — entorno', () => {
  it('test y development: abierto sin token', () => {
    expect(guard({ NODE_ENV: 'test' }).canActivate(ctx({}))).toBe(true);
    expect(guard({ NODE_ENV: 'development', METRICS_TOKEN: TOKEN }).canActivate(ctx({}))).toBe(true);
  });
});
