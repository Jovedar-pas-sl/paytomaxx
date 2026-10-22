import { expect, it, vi } from 'vitest';
import type { MoneyMap } from '@nightpay/contracts';
import { createMoneyMapLoader, moneyMapPeriod, moneyMapStamp } from './money-map-loading';

const result = (generatedAt: string): MoneyMap => ({ generatedAt, frozen: false, scope: { kind: 'period' } } as MoneyMap);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

it('el último periodo solicitado gana aunque la respuesta antigua llegue después', async () => {
  const first = deferred<MoneyMap>(); const second = deferred<MoneyMap>();
  const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const loader = createMoneyMapLoader(load, () => undefined);
  const old = loader.load({ from: '2026-10-01', to: '2026-10-02' });
  const recent = loader.load({ from: '2026-10-10', to: '2026-10-11' });
  expect(load.mock.calls[0]?.[1].aborted).toBe(true);
  second.resolve(result('2026-10-21T17:00:00Z')); await recent;
  first.resolve(result('2026-10-21T16:00:00Z')); await old;
  expect(loader.snapshot().map?.generatedAt).toBe('2026-10-21T17:00:00Z');
  expect(loader.snapshot().shown).toEqual({ from: '2026-10-10', to: '2026-10-11' });
});

it('un error conserva datos y periodo anterior y distingue el solicitado que falló', async () => {
  const load = vi.fn().mockResolvedValueOnce(result('2026-10-21T17:00:00Z')).mockRejectedValueOnce(new Error('Sin conexión'));
  const loader = createMoneyMapLoader(load, () => undefined);
  await loader.load({ from: '2026-10-01', to: '2026-10-02' });
  expect(await loader.load({ from: '2026-10-10', to: '2026-10-11' })).toBe(false);
  expect(loader.snapshot()).toMatchObject({ error: 'Sin conexión', loading: false,
    shown: { from: '2026-10-01', to: '2026-10-02' }, requested: { from: '2026-10-10', to: '2026-10-11' } });
  expect(loader.snapshot().map?.generatedAt).toBe('2026-10-21T17:00:00Z');
});

it('desmontar cancela la red y no cambia el mapa con una respuesta tardía', async () => {
  const pending = deferred<MoneyMap>(); const publish = vi.fn();
  const load = vi.fn().mockReturnValue(pending.promise);
  const loader = createMoneyMapLoader(load, publish);
  const work = loader.load({}); loader.dispose(); publish.mockClear();
  pending.resolve(result('late')); await work;
  expect(load.mock.calls[0]?.[1].aborted).toBe(true);
  expect(publish).not.toHaveBeenCalled();
});

it('valida fechas reales e inclusivas antes de consultar el API', () => {
  expect(moneyMapPeriod('2026-10-01', '2026-10-01')).toEqual({ from: '2026-10-01', to: '2026-10-01' });
  for (const [from, to] of [['', '2026-10-01'], ['2026-10-12', '2026-10-01'], ['2026-02-31', '2026-03-01']]) {
    expect(() => moneyMapPeriod(from!, to!)).toThrow('Elige un periodo válido');
  }
});

it('la frescura usa generatedAt del API y el Z recalculado sigue siendo histórico', () => {
  const stamp = '2026-10-21T17:00:00Z';
  expect(moneyMapStamp({ ...result(stamp), scope: { kind: 'night', nightId: 'old', open: false } })).toEqual({ kind: 'frozen', label: 'Al corte del Z', generatedAt: stamp });
  expect(moneyMapStamp({ ...result(stamp), frozen: true })).toEqual({ kind: 'frozen', label: 'Congelado en el Z', generatedAt: stamp });
  expect(moneyMapStamp(result(stamp))).toEqual({ kind: 'hold', label: 'Periodo', generatedAt: stamp });
});
