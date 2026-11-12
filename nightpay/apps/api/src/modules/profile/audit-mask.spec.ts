import { describe, expect, it } from 'vitest';
import { maskEmail, maskPhone } from './audit-mask';

describe('audit-mask', () => {
  it('el correo: primera letra y dominio', () => {
    expect(maskEmail('maria@dominio.com')).toBe('m***@dominio.com');
    expect(maskEmail('a.b+c@x.es')).toBe('a***@x.es');
    expect(maskEmail('sinarroba')).toBe('***');
    expect(maskEmail(null)).toBeNull();
    expect(maskEmail('')).toBeNull();
  });
  it('el teléfono: solo las 3 últimas cifras', () => {
    expect(maskPhone('+34600123456')).toBe('***456');
    expect(maskPhone('600 12 34 56')).toBe('***456');
    expect(maskPhone('abc')).toBe('***');
    expect(maskPhone(null)).toBeNull();
  });
  it('lo tapado no deja el original', () => {
    expect(maskEmail('maria@dominio.com')).not.toContain('maria');
    expect(maskPhone('+34600123456')).not.toContain('600123');
  });
});
