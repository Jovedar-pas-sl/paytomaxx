import { describe, expect, it } from 'vitest';
import { CobrosQuerySchema, confirmationCode } from '@nightpay/contracts';
import { paymentCobroRow, type PaymentFeedRow } from './cobros-rows';

const payment: PaymentFeedRow = {
  id: '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b', ref: 1, createdAt: new Date(), updatedAt: new Date(),
  amountCents: 1000, tipCents: 0, availableAmountCents: 1000, currency: 'EUR', status: 'AUTHORIZED',
  provider: 'REDSYS', providerTxId: 'POSTERIOR', captureMethod: null, revenueCategory: 'VENUE_BAR',
  serviceName: null, walletId: null, posOperationNumber: null, authCode: '012345', cardLast4: '0001',
  cardBrand: null, payMethodCode: null, authorizedAt: new Date(), terminal: { externalId: 'T', label: 'Barra' },
  createdBy: null, wallet: null, lines: [], attempts: [
    { providerTxId: 'ACEPTADO', status: 'APPROVED', createdAt: new Date(), amountCents: 1000, tipCents: 0, payMethod: 'card' },
    { providerTxId: 'POSTERIOR', status: 'DENIED', createdAt: new Date(), amountCents: 1000, tipCents: 0, payMethod: 'card' },
  ],
};

describe('referencias de los cobros', () => {
  it('muestra el código del cliente y el intento aprobado, conservando todos los intentos', () => {
    const row = paymentCobroRow(payment);
    expect(row.confirmationCode).toBe(confirmationCode(payment.id));
    expect(row.payment?.providerTxId).toBe('ACEPTADO');
    expect(row.payment?.authCode).toBe('012345');
    expect(row.payment?.attempts.map((a) => a.status)).toEqual(['APPROVED', 'DENIED']);
  });
  it('acepta la búsqueda del código o referencia bancaria', () => {
    expect(CobrosQuerySchema.parse({ search: '  A6B  ' }).search).toBe('A6B');
  });
  it('pide al menos 3 caracteres: «1» encontraría casi todos los cobros del local', () => {
    expect(CobrosQuerySchema.safeParse({ search: '1' }).success).toBe(false);
    expect(CobrosQuerySchema.safeParse({ search: ' 12 ' }).success).toBe(false);
    expect(CobrosQuerySchema.safeParse({ search: '123' }).success).toBe(true);
  });
});
