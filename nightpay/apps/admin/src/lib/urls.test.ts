import { describe, expect, it } from 'vitest';
import { isPngDataUrl, safeHttpUrl } from './urls';

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

describe('isPngDataUrl', () => {
  it('solo PNG en base64', () => {
    expect(isPngDataUrl('data:image/png;base64,iVBORw0KGgo=')).toBe(true);
    expect(isPngDataUrl('data:image/svg+xml;base64,PHN2Zz4=')).toBe(false);
    expect(isPngDataUrl('https://ejemplo.com/qr.png')).toBe(false);
    expect(isPngDataUrl(undefined)).toBe(false);
  });
});
