import { describe, expect, it } from 'vitest';
import { ChangePasswordSchema, normalizePhone, UpdateEmailSchema, UpdatePhoneSchema } from '@nightpay/contracts';

describe('teléfono', () => {
  it('acepta español con adornos y lo guarda compacto con +34', () => {
    expect(normalizePhone('600 123 456')).toBe('+34600123456');
    expect(normalizePhone('+34 600-123-456')).toBe('+34600123456');
    expect(normalizePhone('0034 912 345 678')).toBe('+34912345678');
    expect(normalizePhone('(600) 12.34.56')).toBe('+34600123456');
  });
  it('acepta internacional con + (y 00)', () => {
    expect(normalizePhone('+44 7911 123456')).toBe('+447911123456');
    expect(normalizePhone('0033 6 12 34 56 78')).toBe('+33612345678');
  });
  it('rechaza lo que no es un teléfono', () => {
    for (const bad of ['abc', '12345', '500123456', '+34 500123456', '+0123456789', '+1234567', '6001234567', '600 12 34 5x']) {
      expect(normalizePhone(bad), bad).toBeNull();
    }
  });
  it('el esquema devuelve el normalizado, null para vacío y error para inválido', () => {
    expect(UpdatePhoneSchema.parse({ phone: '600 123 456' }).phone).toBe('+34600123456');
    expect(UpdatePhoneSchema.parse({ phone: '  ' }).phone).toBeNull();
    expect(UpdatePhoneSchema.safeParse({ phone: '123' }).success).toBe(false);
    expect(UpdatePhoneSchema.safeParse({ phone: 'x'.repeat(41) }).success).toBe(false);
    expect(UpdatePhoneSchema.safeParse({}).success).toBe(false);
  });
});

describe('correo', () => {
  it('lo pasa a minúsculas y sin espacios', () => {
    expect(UpdateEmailSchema.parse({ email: '  Ana@Club.ES ', currentPassword: 'x' }).email).toBe('ana@club.es');
  });
  it('rechaza uno mal escrito, uno demasiado largo y la falta de contraseña', () => {
    expect(UpdateEmailSchema.safeParse({ email: 'ana', currentPassword: 'x' }).success).toBe(false);
    expect(UpdateEmailSchema.safeParse({ email: `${'a'.repeat(250)}@x.es`, currentPassword: 'x' }).success).toBe(false);
    expect(UpdateEmailSchema.safeParse({ email: 'ana@club.es', currentPassword: '' }).success).toBe(false);
    expect(UpdateEmailSchema.safeParse({ email: 'ana@club.es' }).success).toBe(false);
  });
});

describe('cambiar contraseña', () => {
  const ok = { currentPassword: 'vieja-1234', newPassword: 'nueva-5678', newPasswordRepeat: 'nueva-5678' };
  it('vale con la actual y la nueva dos veces', () => {
    expect(ChangePasswordSchema.safeParse(ok).success).toBe(true);
  });
  it('rechaza corta, larga, que no coincida y que sea igual a la actual', () => {
    expect(ChangePasswordSchema.safeParse({ ...ok, newPassword: 'corta', newPasswordRepeat: 'corta' }).success).toBe(false);
    const long = 'a'.repeat(201);
    expect(ChangePasswordSchema.safeParse({ ...ok, newPassword: long, newPasswordRepeat: long }).success).toBe(false);
    expect(ChangePasswordSchema.safeParse({ ...ok, newPasswordRepeat: 'otra-98765' }).success).toBe(false);
    expect(ChangePasswordSchema.safeParse({ ...ok, newPassword: 'vieja-1234', newPasswordRepeat: 'vieja-1234' }).success).toBe(false);
    expect(ChangePasswordSchema.safeParse({ ...ok, currentPassword: '' }).success).toBe(false);
  });
});
