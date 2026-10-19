import { describe, expect, it } from 'vitest';
import { stepUpBody } from './superadmin';

describe('stepUpBody', () => {
  it('sin motivo (opcional, p. ej. «Reanudar») no se manda: el API lo rechazaba con 400', () => {
    expect(stepUpBody({ totpCode: '123456', reason: '' })).toEqual({ totpCode: '123456' });
    expect(stepUpBody({ totpCode: '123456', reason: '   ' })).toEqual({ totpCode: '123456' });
    expect(stepUpBody({ totpCode: '123456' })).toEqual({ totpCode: '123456' });
  });

  it('con motivo, recortado', () => {
    expect(stepUpBody({ totpCode: '123456', reason: '  ya pagó  ' })).toEqual({ totpCode: '123456', reason: 'ya pagó' });
  });
});
