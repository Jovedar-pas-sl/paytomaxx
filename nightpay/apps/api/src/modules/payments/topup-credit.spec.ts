import { describe, it, expect, vi } from 'vitest';
import {
  MAX_MERGE_DEPTH,
  findCreditTarget,
  shortCodeOnCredit,
  skippedCreditDetail,
  type CreditWalletRow,
} from './topup-credit';

function wallet(o: Partial<CreditWalletRow> = {}): CreditWalletRow {
  return {
    id: 'w-1',
    tenantId: 'venue-a',
    walletGroup: 'grupo',
    balanceCents: 0,
    status: 'ACTIVE',
    mergedIntoId: null,
    shortCode: 'K7Q4M2',
    ...o,
  };
}

const lockFrom = (rows: CreditWalletRow[]) => vi.fn(async (id: string) => rows.find((w) => w.id === id) ?? null);

describe('findCreditTarget — a qué saldo va una recarga cobrada (#7)', () => {
  it('saldo activo o a cero → ese mismo', async () => {
    expect(await findCreditTarget(wallet(), lockFrom([]))).toMatchObject({ ok: true, mergedFrom: null });
    expect(await findCreditTarget(wallet({ status: 'DEPLETED' }), lockFrom([]))).toMatchObject({ ok: true });
  });

  it('ya sumado a otro (Face ID) → el saldo bueno, aunque sea de otro local del grupo', async () => {
    const target = wallet({ id: 'w-2', tenantId: 'venue-b', balanceCents: 4_000 });
    const lock = lockFrom([target]);
    const out = await findCreditTarget(wallet({ status: 'DEPLETED', mergedIntoId: 'w-2' }), lock);
    expect(out).toEqual({ ok: true, wallet: target, mergedFrom: 'w-1' });
    expect(lock).toHaveBeenCalledWith('w-2');
  });

  it('cadena de dos saltos → el último', async () => {
    const rows = [wallet({ id: 'w-2', status: 'DEPLETED', mergedIntoId: 'w-3' }), wallet({ id: 'w-3' })];
    const out = await findCreditTarget(wallet({ mergedIntoId: 'w-2', status: 'DEPLETED' }), lockFrom(rows));
    expect(out).toMatchObject({ ok: true, wallet: { id: 'w-3' }, mergedFrom: 'w-1' });
  });

  it('el saldo bueno es de otro grupo → no se suma', async () => {
    const out = await findCreditTarget(
      wallet({ mergedIntoId: 'w-2', status: 'DEPLETED' }),
      lockFrom([wallet({ id: 'w-2', tenantId: 'venue-x', walletGroup: 'otro' })]),
    );
    expect(out).toMatchObject({ ok: false, cause: 'other-group' });
  });

  it('vueltas o cadenas larguísimas → no se suma', async () => {
    const loop = await findCreditTarget(
      wallet({ mergedIntoId: 'w-2', status: 'DEPLETED' }),
      lockFrom([wallet({ id: 'w-2', status: 'DEPLETED', mergedIntoId: 'w-1' })]),
    );
    expect(loop).toMatchObject({ ok: false, cause: 'merge-loop' });

    const chain = Array.from({ length: MAX_MERGE_DEPTH + 2 }, (_, i) =>
      wallet({ id: `w-${i + 2}`, status: 'DEPLETED', mergedIntoId: `w-${i + 3}` }),
    );
    const lock = lockFrom(chain);
    const long = await findCreditTarget(wallet({ mergedIntoId: 'w-2', status: 'DEPLETED' }), lock);
    expect(long).toMatchObject({ ok: false, cause: 'merge-loop' });
    expect(lock.mock.calls.length).toBeLessThanOrEqual(MAX_MERGE_DEPTH);
  });

  it('devuelto, caducado o inexistente → no se suma (incidencia)', async () => {
    expect(await findCreditTarget(wallet({ status: 'REFUNDED' }), lockFrom([]))).toEqual({
      ok: false,
      cause: 'closed',
      walletStatus: 'REFUNDED',
    });
    expect(await findCreditTarget(wallet({ status: 'EXPIRED' }), lockFrom([]))).toMatchObject({ cause: 'closed' });
    expect(await findCreditTarget(null, lockFrom([]))).toMatchObject({ cause: 'missing' });
    expect(await findCreditTarget(wallet({ mergedIntoId: 'w-9', status: 'DEPLETED' }), lockFrom([]))).toMatchObject({
      cause: 'missing',
    });
  });
});

describe('shortCodeOnCredit — código al reactivar un saldo a cero (#56)', () => {
  const taken = (codes: string[]) => vi.fn(async (c: string) => codes.includes(c));

  it('saldo activo o sin código → no se toca', async () => {
    const isTaken = taken(['K7Q4M2']);
    expect(await shortCodeOnCredit({ status: 'ACTIVE', shortCode: 'K7Q4M2' }, isTaken, () => 'NUEVO1')).toBe('K7Q4M2');
    expect(await shortCodeOnCredit({ status: 'DEPLETED', shortCode: null }, isTaken, () => 'NUEVO1')).toBeNull();
    expect(isTaken).not.toHaveBeenCalled();
  });

  it('a cero y nadie cogió su código → lo conserva', async () => {
    expect(await shortCodeOnCredit({ status: 'DEPLETED', shortCode: 'K7Q4M2' }, taken([]), () => 'NUEVO1')).toBe('K7Q4M2');
  });

  it('otro saldo activo cogió su código → uno nuevo libre', async () => {
    const codes = ['NUEVO1', 'NUEVO2'];
    const out = await shortCodeOnCredit(
      { status: 'DEPLETED', shortCode: 'K7Q4M2' },
      taken(['K7Q4M2', 'NUEVO1']),
      () => codes.shift()!,
    );
    expect(out).toBe('NUEVO2');
  });

  it('sin código libre tras los intentos → sin código (la recarga se suma igual)', async () => {
    expect(await shortCodeOnCredit({ status: 'DEPLETED', shortCode: 'A' }, async () => true, () => 'B', 3)).toBeNull();
  });
});

describe('skippedCreditDetail', () => {
  it('dice el importe, el cobro y qué hacer', () => {
    const text = skippedCreditDetail({
      cause: 'closed',
      walletStatus: 'REFUNDED',
      amountCents: 1_250,
      paymentId: '11111111-2222-4333-8444-555555555555',
    });
    expect(text).toBe(
      'Recarga de 12,50 € cobrada (cobro 11111111) pero el saldo está cerrado (REFUNDED): devuélvela en el banco o reactiva el saldo y súmale el importe.',
    );
  });
});
