import { describe, it, expect } from 'vitest';
import { sanitizeTraceId } from './trace-id';

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
