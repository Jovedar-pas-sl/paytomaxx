import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPendingResult,
  clearSaleToReview,
  flushPendingResults,
  flushPendingVoids,
  getPendingResults,
  getPendingVoids,
  getSalesToReview,
  hasPendingResults,
  isChargeOnHold,
  isResultForReference,
  saveSaleToReview,
  savePendingResult,
  sendVoid,
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

  it('envía las pendientes; un rechazo definitivo sale de la cola (a revisar); sin red, el resto espera a la siguiente vuelta', async () => {
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

  it('DUPLICATE / MISMATCH al reenviar: no se borra en silencio, queda para anular en el datáfono (A2-02)', async () => {
    savePendingResult('A', { ...approved('1'), requestedAmount: 3000 }, 3000);
    savePendingResult('B', { ...approved('2'), requestedAmount: 4000 }, 3000);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/charges/A/')) {
          return json(200, {
            status: 'DUPLICATE',
            operationNumber: '1',
            message: 'Este cobro ya estaba pagado: anula esta operación en el datáfono para no cobrar dos veces.',
          });
        }
        return json(200, { status: 'MISMATCH', operationNumber: '2', message: 'Se cobraron 40 € y el cobro era de 30 €: anula esta operación.' });
      }),
    );
    await flushPendingResults();
    expect(getPendingResults()).toEqual([]);
    const review = getSalesToReview();
    expect(review.map((r) => [r.paymentId, r.operationNumber])).toEqual([
      ['A', '1'],
      ['B', '2'],
    ]);
    expect(review.map((r) => r.kind)).toEqual(['void', 'void']);
    expect(review[0]!.title).toBe('Hay que anular esta operación');
    expect(review[0]!.message).toMatch(/ya estaba pagado/);
    // Para anularla en el lector: lo que cobró el lector (no el importe del cobro) y su referencia.
    expect(review[0]!.voidable).toEqual({ amountCents: 3000, reference: 'ref-1' });
    expect(review[1]!.voidable).toEqual({ amountCents: 4000, reference: 'ref-2' });
  });

  it('se anula por lo que cobró el lector: importe más la propina pedida en el datáfono', async () => {
    savePendingResult('A', { ...approved('1'), requestedAmount: 3000, tipAmount: 200 }, 3000);
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { status: 'DUPLICATE', operationNumber: '1', message: 'anula' })));
    await flushPendingResults();
    expect(getSalesToReview()[0]!.voidable).toEqual({ amountCents: 3200, reference: 'ref-1' });
  });

  it('un 4xx sobre una venta APROBADA no se olvida: «el cliente ya ha pagado», a revisar (A2-03)', async () => {
    savePendingResult('B', approved('2'), 2500);
    vi.stubGlobal('fetch', vi.fn(async () => json(400, { detail: 'Esta operación del datáfono no es de este cobro' })));
    await flushPendingResults();
    expect(getPendingResults()).toEqual([]);
    const [entry] = getSalesToReview();
    expect(entry?.paymentId).toBe('B');
    expect(entry?.kind).toBe('notAccepted');
    expect(entry?.title).toMatch(/ya ha pagado en el datáfono/);
    expect(entry?.message).toMatch(/no es de este cobro/);
    expect(entry?.voidable).toEqual({ amountCents: 2500, reference: 'ref-2' });
  });

  it('PENDING (recarga a confirmar por el encargado) y PAID ya llegaron: fuera de la cola y nada que revisar', async () => {
    savePendingResult('A', approved('1'));
    savePendingResult('B', approved('2'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('/charges/A/')
          ? json(200, { status: 'PENDING', operationNumber: '1', message: 'pendiente' })
          : json(200, { status: 'PAID', code: 'X', message: 'ok' }),
      ),
    );
    await flushPendingResults();
    expect(getPendingResults()).toEqual([]);
    expect(getSalesToReview()).toEqual([]);
  });

  it('sin el importe guardado (versión anterior), se anula por lo cobrado; sin operación, no se ofrece anular', async () => {
    savePendingResult('A', { ...approved('1'), requestedAmount: 1800 });
    savePendingResult('B', approved('2'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('/charges/A/')
          ? json(200, { status: 'MISMATCH', operationNumber: '1', message: 'anula' })
          : json(200, { status: 'MISMATCH', operationNumber: null, message: 'anula' }),
      ),
    );
    await flushPendingResults();
    const [a, b] = getSalesToReview();
    expect(a?.voidable).toEqual({ amountCents: 1800, reference: 'ref-1' });
    expect(b?.voidable).toBeNull();
  });
});

describe('ventas por revisar en el datáfono', () => {
  const entry = {
    kind: 'void' as const,
    paymentId: 'A',
    operationNumber: '7',
    title: 'Hay que anular esta operación',
    message: 'anula',
    voidable: { amountCents: 1000, reference: 'r' },
  };

  it('mientras haya una por anular o revisar, ese cobro no se vuelve a cobrar; un aviso de anulación ya hecha, no lo frena', () => {
    expect(isChargeOnHold('A')).toBe(false);
    saveSaleToReview(entry);
    saveSaleToReview({ ...entry, kind: 'notAccepted', paymentId: 'B' });
    saveSaleToReview({ ...entry, kind: 'voidUnknown', paymentId: 'C', voidable: null });
    expect([isChargeOnHold('A'), isChargeOnHold('B'), isChargeOnHold('C'), isChargeOnHold('D')]).toEqual([true, true, false, false]);
  });

  it('se guardan una vez por cobro y operación, y se quitan solas', () => {
    saveSaleToReview(entry);
    saveSaleToReview({ ...entry, message: 'otra vez' });
    saveSaleToReview({ ...entry, paymentId: 'B' });
    expect(getSalesToReview().map((r) => [r.paymentId, r.message])).toEqual([
      ['A', 'otra vez'],
      ['B', 'anula'],
    ]);
    clearSaleToReview('A', '7');
    expect(getSalesToReview().map((r) => r.paymentId)).toEqual(['B']);
  });

  it('datos rotos en el almacenamiento: se ignoran', () => {
    store.set('np_pax_sales_to_review', '{roto');
    expect(getSalesToReview()).toEqual([]);
    store.set('np_pax_sales_to_review', JSON.stringify({ x: { nada: 1 } }));
    expect(getSalesToReview()).toEqual([]);
  });
});

describe('avisar a OxioPay de una anulación hecha en el lector (A2-07)', () => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const offline = () =>
    vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
  const body = { operationNumber: '9', approved: true };

  it('llega: enviada y nada en cola', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { ok: true })));
    expect(await sendVoid('A', body)).toBe('sent');
    expect(getPendingVoids()).toEqual([]);
  });

  it('sin red o con el servidor caído: se guarda para reenviarla (no se dice «avisada» sin más)', async () => {
    vi.stubGlobal('fetch', offline());
    expect(await sendVoid('A', body)).toBe('queued');
    vi.stubGlobal('fetch', vi.fn(async () => json(503, { detail: 'caído' })));
    expect(await sendVoid('B', body)).toBe('queued');
    expect(getPendingVoids().map((v) => [v.paymentId, v.operationNumber, v.approved])).toEqual([
      ['A', '9', true],
      ['B', '9', true],
    ]);
  });

  it('OxioPay no la admite (4xx): ni se reintenta ni se da por avisada', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(400, { detail: 'Esa operación no es de este cobro' })));
    expect(await sendVoid('A', body)).toBe('refused');
    expect(getPendingVoids()).toEqual([]);
  });

  it('la cola se reenvía en la vuelta del sondeo; lo que OxioPay ya no admite pasa a revisar', async () => {
    vi.stubGlobal('fetch', offline());
    await sendVoid('A', body);
    await sendVoid('B', { operationNumber: '8', approved: true });
    await sendVoid('C', body);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/charges/A/')) return json(200, { ok: true });
        if (url.includes('/charges/B/')) return json(400, { detail: 'Esa operación no es de este cobro' });
        throw new TypeError('Failed to fetch');
      }),
    );
    await flushPendingVoids();
    expect(getPendingVoids().map((v) => v.paymentId)).toEqual(['C']);
    const [notice] = getSalesToReview();
    expect(notice?.paymentId).toBe('B');
    expect(notice?.kind).toBe('voidUnknown');
    expect(notice?.title).toMatch(/OxioPay no la tiene/);
    expect(notice?.voidable).toBeNull();
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
