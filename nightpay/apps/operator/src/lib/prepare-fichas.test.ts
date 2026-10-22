import { describe, expect, it } from 'vitest';
import { deviceBackend, staffBackend } from './reception';
import { needsPrintedNumber } from './prepare-fichas';

describe('número impreso al preparar fichas', () => {
  it('se pide en las fichas listas que aún no lo tienen (móvil y datáfono)', () => {
    expect(needsPrintedNumber({ outcome: 'stocked' })).toBe(true);
    expect(needsPrintedNumber({ outcome: 'already' })).toBe(true);
    expect(needsPrintedNumber({ outcome: 'returned', codeHint: 'ABC' })).toBe(true);
    expect(needsPrintedNumber({ outcome: 'stocked', printedNumber: '000522' })).toBe(false);
    expect(needsPrintedNumber({ outcome: 'blocked' })).toBe(false);
    expect(needsPrintedNumber({ outcome: 'in-use', codeHint: 'K7Q-•••' })).toBe(false);
  });
  it('el datáfono también lo guarda (Preparar fichas del PAX)', () => {
    expect(typeof deviceBackend.labelStock).toBe('function');
    expect(typeof staffBackend.labelStock).toBe('function');
  });
});
