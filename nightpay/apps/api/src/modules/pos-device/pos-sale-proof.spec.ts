import { describe, it, expect } from 'vitest';
import { PaytefDeviceSaleProver, judgeSaleProof } from './pos-sale-proof';

describe('prueba de una venta del PAX (seguridad #1)', () => {
  it('sin consulta servidor a servidor de Paytef, ninguna venta del PAX queda probada', async () => {
    await expect(new PaytefDeviceSaleProver().prove()).resolves.toEqual({
      kind: 'unverifiable',
      reason: 'paytef-device-sin-consulta-servidor',
    });
  });

  it('solo «confirmada por Paytef» y por el mismo importe da la venta por cobrada', () => {
    expect(judgeSaleProof({ kind: 'confirmed', amountCents: 5_000, currency: 'EUR' }, 5_000)).toEqual({ kind: 'proven' });
    expect(judgeSaleProof({ kind: 'confirmed', amountCents: 4_999, currency: null }, 5_000)).toEqual({
      kind: 'rejected',
      reason: 'paytef-otro-importe',
      chargedCents: 4_999,
    });
    expect(judgeSaleProof({ kind: 'rejected', reason: 'paytef-no-aprobado' }, 5_000)).toMatchObject({ kind: 'rejected' });
    expect(judgeSaleProof({ kind: 'unverifiable', reason: 'x' }, 5_000)).toEqual({ kind: 'unproven', reason: 'x' });
    expect(judgeSaleProof({ kind: 'unavailable', reason: 'paytef-http-503' }, 5_000)).toEqual({
      kind: 'unproven',
      reason: 'paytef-http-503',
    });
  });
});
