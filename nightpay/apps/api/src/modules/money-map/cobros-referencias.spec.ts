import { describe, expect, it } from 'vitest';
import { CobrosQuerySchema, confirmationCode, formatChargeRef, parseChargeRef } from '@nightpay/contracts';
import { HOME_TOPUP_KEY_PREFIX, homeTopUpKey } from '../home-topup/home-topup-rules';
import { paymentCobroRow, saldoCobroRow, type PaymentFeedRow } from './cobros-rows';

const payment: PaymentFeedRow = {
  id: '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b', ref: 1, createdAt: new Date(), updatedAt: new Date(),
  amountCents: 1000, tipCents: 0, availableAmountCents: 1000, currency: 'EUR', status: 'AUTHORIZED',
  provider: 'REDSYS', providerTxId: 'POSTERIOR', captureMethod: null, revenueCategory: 'VENUE_BAR',
  serviceName: null, walletId: null, posOperationNumber: null, authCode: '012345', cardLast4: '0001',
  cardBrand: null, payMethodCode: null, authorizedAt: new Date(), terminal: { externalId: 'T', label: 'Barra' },
  createdBy: null, idempotencyKey: 'k-barra-0001', createdByUserId: null, wallet: null, lines: [], attempts: [
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
  it('la referencia se encuentra tal como se ve (C-0022), aunque se escriba de otra forma', () => {
    for (const text of ['C-0022', 'c-0022', 'C0022', 'c22', 'C 22', '  C-0022  ']) expect(parseChargeRef(text)).toBe(22);
    expect(parseChargeRef(formatChargeRef(12345)!)).toBe(12345);
  });
  it('lo que no es una referencia no se trata como tal (ni un pedido del banco que empiece por C)', () => {
    for (const text of ['0022', '22', 'B9F', 'C-0', 'C-', 'C-22A', 'CC22', '15170MMa8Srw', 'C-1234567890']) {
      expect(parseChargeRef(text)).toBeNull();
    }
  });
  it('un cobro del saldo lleva el consumo que hay que anular para devolverlo', () => {
    const row = saldoCobroRow({
      id: 'req-1', consumptionId: 'con-1', ref: 7, createdAt: new Date(), amountCents: 1200, category: 'VENUE_BAR',
      serviceName: null, status: 'ACCEPTED', person: null, wallet: { id: 'w-1', shortCode: 'K7Q4M2' }, reversed: false,
      tipCents: 0, lines: [],
    });
    expect(row).toMatchObject({ kind: 'SALDO', id: 'req-1', consumptionId: 'con-1', ref: 'C-0007' });
  });
});

describe('origen del cobro: «Desde casa»', () => {
  const HOME_KEY = homeTopUpKey('secreto', 'venue', 'k1234567890abcdef');
  const WALLET = 'b2a1c0d9-0000-4000-8000-000000000001';
  const RECEPCION = { id: '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d', displayName: 'Recepción', email: 'rec@local.es', role: 'WAITER' };
  /** La carga con el enlace del local: recarga de un saldo nuevo, sin nadie del local. */
  const casa: PaymentFeedRow = {
    ...payment,
    captureMethod: 'WALLET_TOPUP',
    revenueCategory: 'EXTRA',
    walletId: WALLET,
    wallet: { id: WALLET, shortCode: 'K7Q4M2' },
    idempotencyKey: HOME_KEY,
    createdByUserId: null,
  };

  it('la carga con el enlace del local (su clave, sin persona) sale «Desde casa», sin la clave ni quién la creó', () => {
    const row = paymentCobroRow(casa);
    expect(row).toMatchObject({ isTopUp: true, person: null, fromHome: true });
    expect(row).not.toHaveProperty('idempotencyKey');
    expect(row).not.toHaveProperty('createdByUserId');
    const json = JSON.stringify(row);
    expect(json).not.toContain(HOME_TOPUP_KEY_PREFIX);
    expect(json).not.toContain(HOME_KEY.slice(HOME_TOPUP_KEY_PREFIX.length));
  });

  it('esa clave con persona del local, otra clave o un cobro cualquiera: no (sin el campo)', () => {
    expect(paymentCobroRow({ ...casa, createdByUserId: RECEPCION.id, createdBy: RECEPCION })).not.toHaveProperty('fromHome');
    expect(paymentCobroRow({ ...casa, idempotencyKey: `wtopup:${'a'.repeat(64)}` })).not.toHaveProperty('fromHome');
    expect(paymentCobroRow(payment)).not.toHaveProperty('fromHome');
  });
});
