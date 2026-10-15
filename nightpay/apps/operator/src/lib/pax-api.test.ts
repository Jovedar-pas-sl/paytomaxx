import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPendingResult,
  flushPendingResults,
  getPendingResults,
  hasPendingResults,
  isResultForReference,
  savePendingResult,
} from './pax-api';
import type { PaytefResult } from './pax-bridge';

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  } as Storage);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const approved = (op: string): PaytefResult => ({
  approved: true,
  paytefOperationNumber: op,
  transactionReference: `ref-${op}`,
});
const ids = () => getPendingResults().map((p) => p.paymentId);

describe('ventas aprobadas que aún no han llegado a OxioPay', () => {
  it('dos cobros sin enviar no se pisan (antes la venta B borraba la A)', () => {
    savePendingResult('A', approved('1'));
    savePendingResult('B', approved('2'));
    expect(ids()).toEqual(['A', 'B']);
  });

  it('borrar una solo borra la suya', () => {
    savePendingResult('A', approved('1'));
    savePendingResult('B', approved('2'));
    clearPendingResult('A', approved('1'));
    expect(ids()).toEqual(['B']);
    expect(hasPendingResults()).toBe(true);
    clearPendingResult('B', approved('2'));
    expect(hasPendingResults()).toBe(false);
  });

  it('el mismo cobro con dos operaciones (cobrado dos veces): se guardan las dos', () => {
    savePendingResult('A', approved('1'));
    savePendingResult('A', approved('2'));
    savePendingResult('A', approved('2'));
    expect(getPendingResults()).toHaveLength(2);
    clearPendingResult('A', approved('1'));
    expect(getPendingResults().map((p) => p.result.paytefOperationNumber)).toEqual(['2']);
  });

  it('lo que dejó la versión anterior (un solo hueco) no se pierde', () => {
    const legacy = { paymentId: 'VIEJO', result: approved('9'), savedAt: '2020-01-01T00:00:00.000Z' };
    store.set('np_pax_pending_result', JSON.stringify(legacy));
    savePendingResult('A', approved('1'));
    expect(ids()).toEqual(['VIEJO', 'A']);
    expect(store.has('np_pax_pending_result')).toBe(false);
  });

  it('datos rotos en el almacenamiento: se ignoran sin romper la pantalla', () => {
    store.set('np_pax_pending_results', '{no es json');
    expect(getPendingResults()).toEqual([]);
    store.set('np_pax_pending_results', JSON.stringify({ x: { nada: true } }));
    expect(getPendingResults()).toEqual([]);
  });
});

describe('reenvío solo', () => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  it('envía las pendientes; un rechazo definitivo se olvida; sin red, el resto espera a la siguiente vuelta', async () => {
    savePendingResult('A', approved('1'));
    savePendingResult('B', approved('2'));
    savePendingResult('C', approved('3'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/charges/A/')) return json(200, { status: 'PAID', code: 'X1', message: 'ok' });
        if (url.includes('/charges/B/')) return json(409, { detail: 'Ese cobro ya está pagado' });
        throw new TypeError('Failed to fetch');
      }),
    );
    await flushPendingResults();
    expect(ids()).toEqual(['C']);
  });
});

describe('recuperar el resultado del lector tras un corte', () => {
  it('solo vale si es la operación de este cobro; si no se sabe, no se da por no cobrado', () => {
    expect(isResultForReference({ approved: true, transactionReference: 'R1' }, 'R1')).toBe(true);
    expect(isResultForReference({ approved: true, transactionReference: 'R2' }, 'R1')).toBe(false);
    expect(isResultForReference({ approved: true }, 'R1')).toBe(false);
    expect(isResultForReference({ approved: true, transactionReference: 'R1' }, null)).toBe(false);
  });
});
