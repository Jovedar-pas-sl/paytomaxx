import { describe, expect, it } from 'vitest';
import { safeHttpUrl } from './urls';

describe('safeHttpUrl', () => {
  it('http y https valen', () => {
    expect(safeHttpUrl('https://ejemplo.com/recibo.png')).toBe('https://ejemplo.com/recibo.png');
    expect(safeHttpUrl(' http://ejemplo.com ')).toBe('http://ejemplo.com/');
  });

  it('javascript:, data: o texto suelto no', () => {
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('data:text/html,<b>x</b>')).toBeNull();
    expect(safeHttpUrl('recibo 123')).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
  });
});
