import { describe, it, expect } from 'vitest';
import { hashPin, pinProblem, verifyPin } from './wallet-pin';

const PEPPER = 'clave-del-servidor-que-no-esta-en-la-base-0123';

describe('PIN del saldo', () => {
  it('4 cifras; los obvios no valen', () => {
    expect(pinProblem('4827')).toBeNull();
    expect(pinProblem('482')).toBe('format');
    expect(pinProblem('48a7')).toBe('format');
    expect(pinProblem('48271')).toBe('format');
    expect(pinProblem('0000')).toBe('obvious');
    expect(pinProblem('7777')).toBe('obvious');
    expect(pinProblem('1234')).toBe('obvious');
  });

  it('nunca en claro, cada vez distinto; solo el PIN correcto con la clave del servidor', async () => {
    const a = await hashPin('4827', PEPPER);
    const b = await hashPin('4827', PEPPER);
    expect(a).not.toContain('4827');
    expect(a).not.toBe(b); // sal propia
    expect(await verifyPin('4827', a, PEPPER)).toBe(true);
    expect(await verifyPin('4828', a, PEPPER)).toBe(false);
    // Con la base robada pero sin la clave del servidor, no se comprueba nada.
    expect(await verifyPin('4827', a, 'otra-clave-cualquiera-0000000000000')).toBe(false);
    expect(await verifyPin('4827', 'basura', PEPPER)).toBe(false);
  });
});
