import { describe, expect, it } from 'vitest';
import { OTP_LENGTH, extractOtp, justCompleted, sanitizeOtp } from './otp';

describe('sanitizeOtp', () => {
  it('solo cifras y como mucho 6', () => {
    expect(OTP_LENGTH).toBe(6);
    expect(sanitizeOtp('12a3')).toBe('123');
    expect(sanitizeOtp('123 456')).toBe('123456');
    expect(sanitizeOtp('1234567')).toBe('123456');
    expect(sanitizeOtp('')).toBe('');
  });
});

describe('extractOtp (pegar el código entero)', () => {
  it('admite espacios o guion en medio', () => {
    expect(extractOtp('123 456')).toBe('123456');
    expect(extractOtp('123-456')).toBe('123456');
    expect(extractOtp(' 654321\n')).toBe('654321');
  });

  it('busca el grupo de 6 aunque haya otros números alrededor', () => {
    expect(extractOtp('Cambia en 30 s: 123456')).toBe('123456');
    expect(extractOtp('Tu código es 987 654.')).toBe('987654');
  });

  it('sin un grupo claro, las cifras en orden (hasta 6)', () => {
    expect(extractOtp('12')).toBe('12');
    expect(extractOtp('1a2b3c4d5e6f7')).toBe('123456');
  });
});

describe('justCompleted (enviar solo al completarlo)', () => {
  it('al llegar a 6 cifras', () => {
    expect(justCompleted('12345', '123456')).toBe(true);
    expect(justCompleted('', '123456')).toBe(true);
  });

  it('no mientras falta o si no cambió', () => {
    expect(justCompleted('1234', '12345')).toBe(false);
    expect(justCompleted('123456', '123456')).toBe(false);
    expect(justCompleted('123456', '12345')).toBe(false);
  });

  it('otro código completo pegado encima sí', () => {
    expect(justCompleted('123456', '654321')).toBe(true);
  });
});
