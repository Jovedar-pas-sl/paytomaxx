import { describe, it, expect } from 'vitest';
import { parseOperationsQuery, parseStatementQuery, type WalletLoadRequestBody } from '@nightpay/contracts';
import { PartnerHttpException } from '../http/partner-problem';
import {
  decodeLoadsCursor,
  encodeLoadsCursor,
  firstLimitHit,
  idempotencyKeyOf,
  loadRefusal,
  loadRequestHash,
  loadView,
  nightOf,
  unnamedWallet,
  type LoadCaps,
  type LoadWindowTotals,
} from './partner-load-rules';

/**
 * Reglas puras de las cargas (PR 3): los topes en el borde y el primero de
 * varios, el efectivo el último, la huella, las consultas de la lista y del
 * resumen (cada `param`, desfases, noches de 23 y 25 h) y el cursor.
 */

const CAPS: LoadCaps = { perOperationCents: 30000, walletDayCents: 60000, nightCents: 500000 };
const ZERO: LoadWindowTotals = { wallet24h: 0, wallet24hAllPartners: 0, wallet30dPartner: 0, connectionNight: 0 };
const NO_CASH = { inWindowCents: 0, inWindowPaidCents: 0 };

function problem(fn: () => unknown): { code: string; param?: string } {
  try {
    fn();
  } catch (err) {
    if (err instanceof PartnerHttpException) return { code: err.code, ...(err.extra.param ? { param: err.extra.param } : {}) };
    throw err;
  }
  throw new Error('no lanzó');
}

describe('topes de carga', () => {
  it('per_operation: el tope justo vale; un céntimo más no, y `remaining` es el tope', () => {
    expect(firstLimitHit(30000, CAPS, ZERO, false)).toBeNull();
    expect(firstLimitHit(30001, CAPS, ZERO, false)).toEqual({ limit: 'per_operation', remaining: 30000 });
  });

  it('wallet_24h: hasta el tope con lo de antes; `remaining` lo que queda (0 si ya no queda nada)', () => {
    expect(firstLimitHit(10000, CAPS, { ...ZERO, wallet24h: 50000 }, false)).toBeNull();
    expect(firstLimitHit(10001, CAPS, { ...ZERO, wallet24h: 50000 }, false)).toEqual({ limit: 'wallet_24h', remaining: 10000 });
    expect(firstLimitHit(1, CAPS, { ...ZERO, wallet24h: 60000 }, false)).toEqual({ limit: 'wallet_24h', remaining: 0 });
  });

  it('wallet_24h_all_partners: 999,99 € entre todos, sin `remaining`', () => {
    expect(firstLimitHit(9999, CAPS, { ...ZERO, wallet24hAllPartners: 90000 }, false)).toBeNull();
    expect(firstLimitHit(10000, CAPS, { ...ZERO, wallet24hAllPartners: 90000 }, false)).toEqual({ limit: 'wallet_24h_all_partners', remaining: null });
  });

  it('unnamed_wallet_30d: solo sin teléfono, 1.500 € en 30 días', () => {
    const totals = { ...ZERO, wallet30dPartner: 149000 };
    expect(firstLimitHit(1000, CAPS, totals, true)).toBeNull();
    expect(firstLimitHit(1001, CAPS, totals, true)).toEqual({ limit: 'unnamed_wallet_30d', remaining: 1000 });
    expect(firstLimitHit(1001, CAPS, totals, false)).toBeNull();
    expect(unnamedWallet(null)).toBe(true);
    expect(unnamedWallet('   ')).toBe(true);
    expect(unnamedWallet('+34612345678')).toBe(false);
  });

  it('connection_night: el tope de la noche de la conexión', () => {
    expect(firstLimitHit(20000, CAPS, { ...ZERO, connectionNight: 480000 }, false)).toBeNull();
    expect(firstLimitHit(20001, CAPS, { ...ZERO, connectionNight: 480000 }, false)).toEqual({ limit: 'connection_night', remaining: 20000 });
  });

  it('si saltan varios, el primero en el orden del contrato', () => {
    const all: LoadWindowTotals = { wallet24h: 60000, wallet24hAllPartners: 99999, wallet30dPartner: 150000, connectionNight: 500000 };
    expect(firstLimitHit(30001, CAPS, all, true)?.limit).toBe('per_operation');
    expect(firstLimitHit(100, CAPS, all, true)?.limit).toBe('wallet_24h');
    expect(firstLimitHit(100, CAPS, { ...all, wallet24h: 0 }, true)?.limit).toBe('wallet_24h_all_partners');
    expect(firstLimitHit(100, CAPS, { ...all, wallet24h: 0, wallet24hAllPartners: 0 }, true)?.limit).toBe('unnamed_wallet_30d');
    expect(firstLimitHit(100, CAPS, { ...all, wallet24h: 0, wallet24hAllPartners: 0 }, false)?.limit).toBe('connection_night');
  });

  it('el efectivo, el último: solo si ningún tope salta (y llegar a 1.000 € en 24 h no vale)', () => {
    const cashFull = { inWindowCents: 90000, inWindowPaidCents: 90000 };
    expect(loadRefusal(30001, CAPS, ZERO, false, cashFull)).toEqual({ limit: 'per_operation', remaining: 30000 });
    expect(loadRefusal(9999, CAPS, ZERO, false, cashFull)).toBeNull();
    expect(loadRefusal(10000, CAPS, ZERO, false, cashFull)).toEqual({ limit: 'cash' });
    expect(loadRefusal(10000, CAPS, ZERO, false, NO_CASH)).toBeNull();
  });
});

describe('la huella de una carga', () => {
  const base: WalletLoadRequestBody = {
    qr: 'https://demo-operator.oxiopay.example/?ficha=demo-ficha-uid-0000001',
    nfc_uid: '04A1B2C3D4E5F6',
    amount: 2000,
    description: 'Recarga en cajero 0042',
    reference: 'ATM0042-20261205-000731-K7QM',
    funding: 'cash',
    device: 'ATM0042',
  };

  it('no depende del orden de los campos, de los espacios del texto ni de los separadores del UID', () => {
    const h = loadRequestHash(base);
    const reordered = JSON.parse(JSON.stringify({ device: 'ATM0042', funding: 'cash', ...base })) as WalletLoadRequestBody;
    expect(loadRequestHash(reordered)).toBe(h);
    expect(loadRequestHash({ ...base, description: '  Recarga   en cajero 0042 ' })).toBe(h);
    expect(loadRequestHash({ ...base, qr: `  ${base.qr}  ` })).toBe(h);
    expect(loadRequestHash({ ...base, nfc_uid: '04:a1:b2:c3:d4:e5:f6' })).toBe(h);
    expect(loadRequestHash({ ...base, nfc_uid: '04-A1-B2-C3-D4-E5-F6' })).toBe(h);
  });

  it('cambia con el importe, la forma de pago, la referencia, el cajero, el `qr` y el UID', () => {
    const h = loadRequestHash(base);
    for (const other of [
      { ...base, amount: 2001 },
      { ...base, funding: 'card' as const },
      { ...base, reference: 'ATM0042-20261205-000732-K7QM' },
      { ...base, reference: undefined },
      { ...base, device: 'ATM0043' },
      { ...base, device: undefined },
      { ...base, qr: 'https://demo-operator.oxiopay.example/?ficha=demo-ficha-uid-0000002' },
      { ...base, nfc_uid: undefined },
      { ...base, nfc_uid: '04A1B2C3D4E5F7' },
    ]) {
      expect(loadRequestHash(other)).not.toBe(h);
    }
  });

  it('nunca lleva el `qr` ni el UID en claro (64 hex)', () => {
    expect(loadRequestHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('Idempotency-Key: sin ella 400 idempotency_key_missing; mal formada 400 invalid_request (`Idempotency-Key`)', () => {
    expect(idempotencyKeyOf({ 'idempotency-key': 'ATM0042-20261205-000731-K7QM' })).toBe('ATM0042-20261205-000731-K7QM');
    expect(problem(() => idempotencyKeyOf({}))).toEqual({ code: 'idempotency_key_missing' });
    for (const bad of ['corta', 'con espacio 1234', 'a'.repeat(201), ['ATM0042-1', 'ATM0042-2']]) {
      expect(problem(() => idempotencyKeyOf({ 'idempotency-key': bad }))).toEqual({ code: 'invalid_request', param: 'Idempotency-Key' });
    }
  });
});

describe('GET /wallet/operations: la consulta', () => {
  const ok = (q: Record<string, unknown>) => {
    const r = parseOperationsQuery(q, nightOf);
    if (!r.ok) throw new Error(`no vale: ${r.param}`);
    return r;
  };
  const fault = (q: Record<string, unknown>) => {
    const r = parseOperationsQuery(q, nightOf);
    return r.ok ? null : { code: r.code, param: r.param };
  };

  it('business_date: la noche de 08:00 a 08:00 de Madrid (invierno y verano)', () => {
    expect(ok({ business_date: '2026-12-05' })).toMatchObject({ from: new Date('2026-12-05T07:00:00Z'), to: new Date('2026-12-06T07:00:00Z') });
    expect(ok({ business_date: '2026-07-05' })).toMatchObject({ from: new Date('2026-07-05T06:00:00Z'), to: new Date('2026-07-06T06:00:00Z') });
  });

  it('las noches del cambio de hora duran 23 y 25 horas', () => {
    const spring = ok({ business_date: '2026-03-28' });
    expect(spring.to.getTime() - spring.from.getTime()).toBe(23 * 3_600_000);
    const autumn = ok({ business_date: '2026-10-24' });
    expect(autumn.to.getTime() - autumn.from.getTime()).toBe(25 * 3_600_000);
  });

  it('from y to con `Z` o con desfase (+01:00), y fracciones de segundo', () => {
    const r = ok({ from: '2026-12-05T23:30:00+01:00', to: '2026-12-05T22:45:00.250Z' });
    expect(r.from.toISOString()).toBe('2026-12-05T22:30:00.000Z');
    expect(r.to.toISOString()).toBe('2026-12-05T22:45:00.250Z');
  });

  it('cada `param`: ninguno → business_date; los dos → from (o to); uno solo → el que falta; to ≤ from → to', () => {
    expect(fault({})).toEqual({ code: 'validation_failed', param: 'business_date' });
    expect(fault({ business_date: '2026-12-05', from: '2026-12-05T22:30:00Z' })).toEqual({ code: 'validation_failed', param: 'from' });
    expect(fault({ business_date: '2026-12-05', to: '2026-12-05T22:30:00Z' })).toEqual({ code: 'validation_failed', param: 'to' });
    expect(fault({ from: '2026-12-05T22:30:00Z' })).toEqual({ code: 'validation_failed', param: 'to' });
    expect(fault({ to: '2026-12-05T22:30:00Z' })).toEqual({ code: 'validation_failed', param: 'from' });
    expect(fault({ from: '2026-12-05T22:30:00Z', to: '2026-12-05T22:30:00Z' })).toEqual({ code: 'validation_failed', param: 'to' });
    expect(fault({ from: '2026-12-05T22:30:00Z', to: '2026-12-05T22:00:00Z' })).toEqual({ code: 'validation_failed', param: 'to' });
    expect(fault({ business_date: '2026-02-30' })).toEqual({ code: 'validation_failed', param: 'business_date' });
    expect(fault({ business_date: '5-12-2026' })).toEqual({ code: 'validation_failed', param: 'business_date' });
    expect(fault({ from: 'ayer', to: '2026-12-05T22:00:00Z' })).toEqual({ code: 'validation_failed', param: 'from' });
    expect(fault({ from: '2026-12-05T22:00:00', to: '2026-12-05T23:00:00Z' })).toEqual({ code: 'validation_failed', param: 'from' });
    expect(fault({ business_date: '2026-12-05', reference: 'con espacio' })).toEqual({ code: 'validation_failed', param: 'reference' });
    expect(fault({ business_date: '2026-12-05', type: 'payment' })).toEqual({ code: 'validation_failed', param: 'type' });
    for (const limit of ['0', '101', '2.5', 'diez']) {
      expect(fault({ business_date: '2026-12-05', limit }), limit).toEqual({ code: 'validation_failed', param: 'limit' });
    }
    expect(fault({ business_date: ['2026-12-05', '2026-12-06'] })).toEqual({ code: 'validation_failed', param: 'business_date' });
  });

  it('31 días como mucho (range_too_long); `to` puede ser futuro', () => {
    expect(ok({ from: '2026-11-01T00:00:00Z', to: '2026-12-02T00:00:00Z' }).limit).toBe(25);
    expect(fault({ from: '2026-11-01T00:00:00Z', to: '2026-12-02T00:00:01Z' })).toEqual({ code: 'range_too_long', param: undefined });
    expect(ok({ from: '2099-01-01T00:00:00Z', to: '2099-01-02T00:00:00Z' }).from.getUTCFullYear()).toBe(2099);
  });

  it('`limit` de 1 a 100 (25 de serie), `type=load` y `reference` exacta', () => {
    expect(ok({ business_date: '2026-12-05', limit: '100', type: 'load', reference: 'ATM0042-20261205-000731-K7QM' })).toMatchObject({
      limit: 100,
      reference: 'ATM0042-20261205-000731-K7QM',
    });
  });
});

describe('GET /statement: la consulta', () => {
  const fault = (q: Record<string, unknown>) => {
    const r = parseStatementQuery(q);
    return r.ok ? null : { code: r.code, param: r.param };
  };

  it('from y to obligatorios: sin uno, su `param`; to ≤ from → to; hasta 92 días', () => {
    expect(fault({})).toEqual({ code: 'validation_failed', param: 'from' });
    expect(fault({ to: '2026-12-06T07:00:00Z' })).toEqual({ code: 'validation_failed', param: 'from' });
    expect(fault({ from: '2026-12-05T07:00:00Z' })).toEqual({ code: 'validation_failed', param: 'to' });
    expect(fault({ from: '2026-12-05T07:00:00Z', to: '2026-12-05T07:00:00Z' })).toEqual({ code: 'validation_failed', param: 'to' });
    expect(fault({ from: '2026-09-01T00:00:00Z', to: '2026-12-02T00:00:00Z' })).toBeNull();
    expect(fault({ from: '2026-09-01T00:00:00Z', to: '2026-12-02T00:00:01Z' })).toEqual({ code: 'range_too_long', param: undefined });
    expect(fault({ from: '2026-12-05T08:00:00+01:00', to: '2026-12-06T08:00:00+01:00' })).toBeNull();
  });
});

describe('el cursor de la lista', () => {
  const filters = { from: new Date('2026-12-05T07:00:00Z'), to: new Date('2026-12-06T07:00:00Z'), reference: null };
  const last = { createdAt: new Date('2026-12-05T22:41:07.123Z'), id: '8b2e6f1a-9c3d-4e5f-8a7b-6c5d4e3f2a1b' };

  it('vuelve con los mismos filtros', () => {
    expect(decodeLoadsCursor(encodeLoadsCursor(last, filters), filters)).toEqual(last);
  });

  it('con otros filtros, ilegible o retocado: validation_failed (`cursor`)', () => {
    const cursor = encodeLoadsCursor(last, filters);
    const bad = { code: 'validation_failed', param: 'cursor' };
    expect(problem(() => decodeLoadsCursor(cursor, { ...filters, reference: 'ATM0042-1' }))).toEqual(bad);
    expect(problem(() => decodeLoadsCursor(cursor, { ...filters, to: new Date('2026-12-07T07:00:00Z') }))).toEqual(bad);
    expect(problem(() => decodeLoadsCursor('esto no es un cursor', filters))).toEqual(bad);
    expect(problem(() => decodeLoadsCursor(Buffer.from('x|y|z').toString('base64url'), filters))).toEqual(bad);
    const forged = Buffer.from(`${last.createdAt.toISOString()}|not-a-uuid|${Buffer.from(cursor, 'base64url').toString().split('|')[2]}`).toString('base64url');
    expect(problem(() => decodeLoadsCursor(forged, filters))).toEqual(bad);
  });
});

describe('la carga como se enseña', () => {
  const response = {
    object: 'wallet_load',
    id: 'wl_8b2e6f1a9c3d4e5f8a7b6c5d4e3f2a1b',
    status: 'succeeded',
    amount: 2000,
    balance_after: 7000,
    livemode: false,
  };

  it('sin `balance_after` sin wallet:balance; con él, el de la columna; el estado y `voided_at` de ahora', () => {
    expect(loadView({ response, balanceAfterCents: 7000, voidedAt: null }, false)).toEqual({
      object: 'wallet_load',
      id: response.id,
      status: 'succeeded',
      amount: 2000,
      livemode: false,
      voided_at: null,
    });
    expect(loadView({ response, balanceAfterCents: 7000, voidedAt: new Date('2026-12-05T23:04:50Z') }, true)).toMatchObject({
      status: 'voided',
      balance_after: 7000,
      voided_at: '2026-12-05T23:04:50.000Z',
    });
  });
});
