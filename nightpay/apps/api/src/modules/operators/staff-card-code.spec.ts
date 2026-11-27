import { describe, expect, it } from 'vitest';
import { isWalletCardToken } from '@nightpay/contracts';
import { isStaffCardCodeFor, mintStaffCardCode } from './staff-card-code';

const SECRET = 'clave-de-las-pruebas-de-la-api-0123456789';
const NEREA = { tenantId: '3c9d8e7f-6a5b-4c3d-8e2f-1a0b9c8d7e6f', userId: '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b' };
const LOLA = { ...NEREA, userId: '0b7a0c5e-1d2e-4f3a-9b8c-7d6e5f4a3b2c' };

describe('el código de la ficha de la compañera, dado por el servidor', () => {
  it('tiene el formato de las fichas y vale solo para ella, en su local y con esta clave', () => {
    const code = mintStaffCardCode(NEREA, SECRET);
    expect(code).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(isWalletCardToken(code)).toBe(true);
    expect(isStaffCardCodeFor(code, NEREA, SECRET)).toBe(true);
    expect(isStaffCardCodeFor(code, LOLA, SECRET)).toBe(false);
    expect(isStaffCardCodeFor(code, { ...NEREA, tenantId: LOLA.userId }, SECRET)).toBe(false);
    expect(isStaffCardCodeFor(code, NEREA, `${SECRET}-otra`)).toBe(false);
    expect(mintStaffCardCode(NEREA, SECRET)).not.toBe(code);
  });

  it('uno inventado o mal formado, no', () => {
    expect(isStaffCardCodeFor('AAAAAAAAAAAAAAAAAAAAAA', NEREA, SECRET)).toBe(false);
    expect(isStaffCardCodeFor('corto', NEREA, SECRET)).toBe(false);
    expect(isStaffCardCodeFor('', NEREA, SECRET)).toBe(false);
  });
});
