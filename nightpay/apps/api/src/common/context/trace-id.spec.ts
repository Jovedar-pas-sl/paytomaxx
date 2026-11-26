import { describe, it, expect } from 'vitest';
import { requestTraceId, sanitizeTraceId } from './trace-id';

describe('X-Trace-Id del cliente', () => {
  it('se acepta si es corto y solo letras, números y guiones', () => {
    expect(sanitizeTraceId('3f1c-ab12')).toBe('3f1c-ab12');
    expect(sanitizeTraceId(['abc', 'def'])).toBe('abc');
    expect(sanitizeTraceId('a'.repeat(64))).toBe('a'.repeat(64));
  });

  it('si no, se ignora (y se genera uno)', () => {
    expect(sanitizeTraceId('a'.repeat(65))).toBeUndefined();
    expect(sanitizeTraceId('<script>')).toBeUndefined();
    expect(sanitizeTraceId('id con espacios')).toBeUndefined();
    expect(sanitizeTraceId('')).toBeUndefined();
    expect(sanitizeTraceId(undefined)).toBeUndefined();
  });
});

describe('requestTraceId', () => {
  it('en la API de socios, X-Request-Id (también con la URL del middleware sin prefijo); fuera, X-Trace-Id', () => {
    const headers = { 'x-request-id': 'atm0042-req-1', 'x-trace-id': 'traza-1' };
    expect(requestTraceId({ url: '/v1/partner/me', headers }, 'nueva')).toBe('atm0042-req-1');
    expect(requestTraceId({ url: '/', originalUrl: '/v1/partner/me', headers }, 'nueva')).toBe('atm0042-req-1');
    expect(requestTraceId({ url: '/v1/admin/payments', headers }, 'nueva')).toBe('traza-1');
    expect(requestTraceId({ url: '/v1/partner/me', headers: { 'x-request-id': 'con espacios' } }, 'nueva')).toBe('nueva');
    expect(requestTraceId(undefined, 'nueva')).toBe('nueva');
  });
});
