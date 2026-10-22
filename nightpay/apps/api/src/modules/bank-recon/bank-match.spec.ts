import { describe, it, expect } from 'vitest';
import { reconcile, referenceKey, type BankRow, type OurRefund, type OurSale } from './bank-match';

const at = (iso: string) => new Date(iso);

function row(o: Partial<BankRow>): BankRow {
  return {
    line: 1,
    at: at('2026-10-13T22:10:00Z'),
    kind: 'SALE',
    approved: true,
    amountCents: 5000,
    reference: null,
    terminal: null,
    authCode: null,
    ...o,
  };
}

function sale(o: Partial<OurSale>): OurSale {
  return {
    paymentId: 'p-1',
    tenantId: 'v-1',
    references: [],
    terminal: null,
    authCode: null,
    amountCents: 5000,
    at: at('2026-10-13T22:10:30Z'),
    ...o,
  };
}

function refund(o: Partial<OurRefund>): OurRefund {
  return {
    refundId: 'r-1',
    paymentId: 'p-1',
    tenantId: 'v-1',
    paymentReferences: ['0412ABCD1234'],
    amountCents: 2000,
    at: at('2026-10-13T23:00:00Z'),
    ...o,
  };
}

const statuses = (r: ReturnType<typeof reconcile>) => r.items.map((i) => i.status);

describe('cuadre con el banco', () => {
  it.each([[false, 2000], [true, 2000], [false, 5000], [true, 5000]] as const)('distingue operación 77 de dos terminales con CSV invertido=%s e importe=%i', (reverse, amountCents) => {
    const rows = [row({ reference: '77', terminal: 'A' }), row({ reference: '77', terminal: 'B', amountCents })];
    const result = reconcile({ rows: reverse ? rows.reverse() : rows,
      sales: [sale({ references: ['77'], terminal: 'A' }), sale({ paymentId: 'p-2', references: ['77'], terminal: 'B', amountCents })], refunds: [], strays: [] });
    expect(result.items).toHaveLength(2);
    expect(result.items.every((i) => i.status === 'MATCHED')).toBe(true);
    expect(result.items.find((i) => i.terminal === 'B')?.paymentId).toBe('p-2');
  });

  it('referencia ambigua sin terminal no se resuelve por orden ni por importe', () => {
    const result = reconcile({ rows: [row({ reference: '77' })], sales: [sale({ references: ['77'], terminal: 'A' }), sale({ paymentId: 'p-2', references: ['77'], terminal: 'B' })], refunds: [], strays: [] });
    expect(statuses(result)).toEqual(['NOT_IN_OXIOPAY', 'NOT_IN_BANK', 'NOT_IN_BANK']);
  });

  it('una referencia ambigua entre cobro pagado y cobro perdido no favorece al pagado', () => {
    const result = reconcile({ rows: [row({ reference: '77' })], sales: [sale({ references: ['77'], terminal: 'A' })], refunds: [], strays: [{ paymentId: 'stray-b', tenantId: 'v-1', references: ['77'], terminal: 'B', amountCents: 5000 }] });
    expect(statuses(result)).toEqual(['NOT_IN_OXIOPAY', 'NOT_IN_BANK']);
  });

  it('una anulación sin terminal no elige entre operaciones 77 usando solo el importe', () => {
    const result = reconcile({ rows: [row({ reference: '77', terminal: 'A' }), row({ reference: '77', terminal: 'B', amountCents: 2000 }), row({ reference: '77', kind: 'VOID' })], sales: [], refunds: [], strays: [] });
    expect(result.bankTotalCents).toBe(7000);
  });

  it('una anulación respeta el terminal cuando dos ventas comparten operación e importe', () => {
    const result = reconcile({ rows: [row({ reference: '77', terminal: 'A' }), row({ reference: '77', terminal: 'B' }), row({ reference: '77', terminal: 'A', kind: 'VOID' })], sales: [sale({ references: ['77'], terminal: 'B' })], refunds: [], strays: [] });
    expect(result.items).toEqual([expect.objectContaining({ status: 'MATCHED', terminal: 'B' })]);
  });

  it('una devolución respeta terminal+operación y deja ambigüedades sin casar', () => {
    const refunds = [refund({ refundId: 'r-a', paymentReferences: ['77'], terminal: 'A' }), refund({ refundId: 'r-b', paymentId: 'p-2', paymentReferences: ['77'], terminal: 'B' })];
    const result = reconcile({ rows: [row({ kind: 'REFUND', reference: '77', terminal: 'B', amountCents: 2000 })], sales: [], refunds, strays: [] });
    expect(result.items[0]).toMatchObject({ status: 'REFUND_MATCHED', refundId: 'r-b' });
    const ambiguous = reconcile({ rows: [row({ kind: 'REFUND', reference: '77', amountCents: 2000 })], sales: [], refunds, strays: [] });
    expect(ambiguous.items[0]?.status).toBe('REFUND_NOT_IN_OXIOPAY');
  });
  it('casa por el pedido de Redsys aunque Excel se haya comido los ceros', () => {
    expect(referenceKey('000412abcd')).toBe('412ABCD');
    const r = reconcile({
      rows: [row({ reference: '412ABCD1234' })],
      sales: [sale({ references: ['0412ABCD1234'] })],
      refunds: [],
      strays: [],
    });
    expect(statuses(r)).toEqual(['MATCHED']);
    expect(r.items[0]).toMatchObject({ paymentId: 'p-1', tenantId: 'v-1' });
    expect(r).toMatchObject({ bankTotalCents: 5000, oursTotalCents: 5000 });
  });

  it('mismo pedido con otro importe (p. ej. la propina) → importe distinto', () => {
    const r = reconcile({
      rows: [row({ reference: '0412ABCD1234', amountCents: 5500 })],
      sales: [sale({ references: ['0412ABCD1234'], amountCents: 5000 })],
      refunds: [],
      strays: [],
    });
    expect(r.items[0]).toMatchObject({ status: 'AMOUNT_MISMATCH', bankAmountCents: 5500, oursAmountCents: 5000 });
  });

  it('el banco lo cobró y aquí el cobro no está pagado (aviso perdido) → para resolverlo', () => {
    const r = reconcile({
      rows: [row({ reference: '0412ABCD1234' })],
      sales: [],
      refunds: [],
      strays: [{ paymentId: 'p-9', tenantId: 'v-2', references: ['0412ABCD1234'], amountCents: 5000 }],
    });
    expect(r.items[0]).toMatchObject({ status: 'NOT_PAID_HERE', paymentId: 'p-9', tenantId: 'v-2' });
  });

  it('venta del banco sin nada aquí, y cobro de aquí que el banco no tiene', () => {
    const r = reconcile({
      rows: [row({ reference: 'ZZZ', amountCents: 9900 })],
      sales: [sale({ references: ['0412ABCD1234'] })],
      refunds: [],
      strays: [],
    });
    expect(statuses(r)).toEqual(['NOT_IN_OXIOPAY', 'NOT_IN_BANK']);
    expect(r).toMatchObject({ bankTotalCents: 9900, oursTotalCents: 5000 });
  });

  it('sin referencia: mismo importe y autorización, a menos de 15 min', () => {
    const r = reconcile({
      rows: [row({ authCode: '123456', at: at('2026-10-13T22:10:00Z') })],
      sales: [
        sale({ paymentId: 'lejos', authCode: '123456', at: at('2026-10-13T23:30:00Z') }),
        sale({ paymentId: 'cerca', authCode: '123456', at: at('2026-10-13T22:12:00Z') }),
      ],
      refunds: [],
      strays: [],
    });
    expect(r.items[0]).toMatchObject({ status: 'MATCHED', paymentId: 'cerca' });
    expect(r.items[1]).toMatchObject({ status: 'NOT_IN_BANK', paymentId: 'lejos' });
  });

  it('otra autorización u otro datáfono no casan', () => {
    const r = reconcile({
      rows: [row({ authCode: '111111', terminal: 'T1' })],
      sales: [sale({ authCode: '222222' }), sale({ paymentId: 'p-2', terminal: 'T2' })],
      refunds: [],
      strays: [],
    });
    expect(statuses(r)).toEqual(['NOT_IN_OXIOPAY', 'NOT_IN_BANK', 'NOT_IN_BANK']);
  });

  it('datáfono: por número de operación', () => {
    const r = reconcile({
      rows: [row({ reference: '000077', terminal: 'TPV1' })],
      sales: [sale({ references: ['77'], terminal: 'TPV1' })],
      refunds: [],
      strays: [],
    });
    expect(statuses(r)).toEqual(['MATCHED']);
  });

  it('denegadas no cuentan; una anulación quita su venta', () => {
    const r = reconcile({
      rows: [
        row({ line: 1, approved: false, reference: 'A1' }),
        row({ line: 2, reference: 'B2', amountCents: 3000 }),
        row({ line: 3, kind: 'VOID', reference: 'B2', amountCents: 3000, at: at('2026-10-13T22:20:00Z') }),
      ],
      sales: [],
      refunds: [],
      strays: [],
    });
    expect(r.items).toEqual([]);
    expect(r.bankTotalCents).toBe(0);
  });

  it('devoluciones: hecha en el banco y apuntada; sin apuntar; apuntada y el banco no la tiene', () => {
    const matched = reconcile({
      rows: [row({ kind: 'REFUND', reference: '412ABCD1234', amountCents: 2000 })],
      sales: [],
      refunds: [refund({})],
      strays: [],
    });
    expect(matched.items[0]).toMatchObject({ status: 'REFUND_MATCHED', refundId: 'r-1' });
    expect(matched).toMatchObject({ bankTotalCents: -2000, oursTotalCents: -2000 });

    const missing = reconcile({
      rows: [row({ kind: 'REFUND', reference: '0412ABCD1234', amountCents: 1500 })],
      sales: [sale({ references: ['0412ABCD1234'], amountCents: 1500, at: at('2026-10-13T21:00:00Z') })],
      refunds: [refund({ amountCents: 700 })],
      strays: [],
    });
    expect(statuses(missing)).toEqual(['NOT_IN_BANK', 'REFUND_NOT_IN_OXIOPAY', 'REFUND_NOT_IN_BANK']);
    expect(missing.items[1]).toMatchObject({ paymentId: 'p-1', tenantId: 'v-1' });
  });
});

describe('lo que la revisión pidió', () => {
  it('un cargo desconocido (otra referencia) no se casa con otro cobro del mismo importe', () => {
    const r = reconcile({
      rows: [row({ reference: 'DESCONOCIDO', authCode: null })],
      sales: [sale({ references: ['0412ABCD1234'], authCode: '999999' })],
      refunds: [],
      strays: [],
    });
    expect(statuses(r)).toEqual(['NOT_IN_OXIOPAY', 'NOT_IN_BANK']);
  });

  it('…salvo que coincida la autorización', () => {
    const r = reconcile({
      rows: [row({ reference: 'OTRA', authCode: '999999' })],
      sales: [sale({ references: ['0412ABCD1234'], authCode: '999999' })],
      refunds: [],
      strays: [],
    });
    expect(statuses(r)).toEqual(['MATCHED']);
  });

  it('devolución sin referencia que case: solo cerca en el tiempo', () => {
    const lejos = reconcile({
      rows: [row({ kind: 'REFUND', reference: null, amountCents: 2000, at: at('2026-10-20T22:00:00Z') })],
      sales: [],
      refunds: [refund({ paymentReferences: [] })],
      strays: [],
    });
    expect(statuses(lejos)).toEqual(['REFUND_NOT_IN_OXIOPAY', 'REFUND_NOT_IN_BANK']);
    const otraRef = reconcile({
      rows: [row({ kind: 'REFUND', reference: 'OTRO', amountCents: 2000 })],
      sales: [],
      refunds: [refund({})],
      strays: [],
    });
    expect(statuses(otraRef)).toEqual(['REFUND_NOT_IN_OXIOPAY', 'REFUND_NOT_IN_BANK']);
  });

  it('una anulación puede anular una devolución', () => {
    const r = reconcile({
      rows: [
        row({ line: 1, kind: 'REFUND', reference: 'X1', amountCents: 500 }),
        row({ line: 2, kind: 'VOID', reference: 'X1', amountCents: 500, at: at('2026-10-13T22:30:00Z') }),
      ],
      sales: [],
      refunds: [],
      strays: [],
    });
    expect(r.items).toEqual([]);
  });

  it('lo de aquí fuera de los días del fichero sirve para casar pero no se avisa como falta', () => {
    const window = { from: at('2026-10-12T22:00:00Z'), to: at('2026-10-13T22:00:00Z') };
    const r = reconcile({
      rows: [row({ reference: 'R1', at: at('2026-10-13T21:59:50Z') })],
      sales: [
        sale({ paymentId: 'borde', references: ['R1'], at: at('2026-10-13T22:00:20Z') }),
        sale({ paymentId: 'fuera', references: ['R2'], at: at('2026-10-13T22:30:00Z') }),
      ],
      refunds: [],
      strays: [],
      window,
    });
    expect(statuses(r)).toEqual(['MATCHED']);
    expect(r.oursTotalCents).toBe(0);
  });
});
