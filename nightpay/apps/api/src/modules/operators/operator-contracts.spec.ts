import { describe, it, expect } from 'vitest';
import { ResetOperatorPasswordSchema } from '@nightpay/contracts';

describe('ResetOperatorPasswordSchema — cuerpo de /admin/operators/:id/reset-password', () => {
  it('sin cuerpo, vacío o sin contraseña → se generará una (password undefined o "")', () => {
    expect(ResetOperatorPasswordSchema.parse(undefined)).toEqual({});
    expect(ResetOperatorPasswordSchema.parse({})).toEqual({});
    expect(ResetOperatorPasswordSchema.parse({ password: '' })).toEqual({ password: '' });
  });

  it('contraseña puesta por el dueño: 8 a 128 caracteres', () => {
    expect(ResetOperatorPasswordSchema.parse({ password: 'Abcdefg1' })).toEqual({ password: 'Abcdefg1' });
    expect(ResetOperatorPasswordSchema.safeParse({ password: 'corta' }).success).toBe(false);
    expect(ResetOperatorPasswordSchema.safeParse({ password: 'x'.repeat(129) }).success).toBe(false);
    expect(ResetOperatorPasswordSchema.safeParse({ password: 12345678 }).success).toBe(false);
  });
});
