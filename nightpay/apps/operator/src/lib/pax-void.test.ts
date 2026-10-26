import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPendingVoids, getSalesToReview, saveSaleToReview } from './pax-api';
import type { BridgeResponse } from './pax-bridge';
import { voidNoticeOf, voidSaleOnReader } from './pax-void';

// «Anular en el datáfono» (en el cobro o desde la lista de /pax): el lector
// anula y OxioPay se entera; si no se entera, se dice y se reintenta (A2-07).

const store = new Map<string, string>();
const calls: Array<{ url: string; body: unknown }> = [];

function reader(response: BridgeResponse): void {
  const win: Record<string, unknown> = {};
  win.NightPayPax = {
    voidSale: (json: string) => {
      const { requestId } = JSON.parse(json) as { requestId: string };
      setTimeout(() => (win.nightpayPaxCallback as (id: string, r: string) => void)(requestId, JSON.stringify(response)), 0);
    },
  };
  vi.stubGlobal('window', win);
}

function api(handler: (url: string) => Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      return handler(url);
    }),
  );
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const sale = { paymentId: 'A', operationNumber: '7', amountCents: 3000, reference: 'ref-7' };

beforeEach(() => {
  store.clear();
  calls.length = 0;
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  } as Storage);
  saveSaleToReview({
    kind: 'void',
    paymentId: 'A',
    operationNumber: '7',
    title: 'Hay que anular esta operación',
    message: 'anula',
    voidable: { amountCents: 3000, reference: 'ref-7' },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('anular en el datáfono', () => {
  it('anulada y avisada: fuera de la lista y «anulada»', async () => {
    reader({ ok: true, result: { approved: true } });
    api(() => json(200, { ok: true }));
    const out = await voidSaleOnReader(sale);
    expect(out).toMatchObject({ approved: true, report: 'sent' });
    expect(out.message).toMatch(/^Operación anulada en el datáfono/);
    expect(calls[0]?.body).toEqual({ operationNumber: '7', approved: true });
    expect(getSalesToReview()).toEqual([]);
  });

  it('anulada sin red: se dice que falta avisar a OxioPay y queda en cola', async () => {
    reader({ ok: true, result: { approved: true } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const out = await voidSaleOnReader(sale);
    expect(out.report).toBe('queued');
    expect(out.message).toMatch(/falta avisar a OxioPay/);
    expect(getPendingVoids().map((v) => v.operationNumber)).toEqual(['7']);
    expect(getSalesToReview()).toEqual([]);
  });

  it('anulada y OxioPay no la tiene en el cobro: queda un aviso para el encargado (sin volver a anular)', async () => {
    reader({ ok: true, result: { approved: true } });
    api(() => json(400, { detail: 'Esa operación no es de este cobro' }));
    const out = await voidSaleOnReader(sale);
    expect(out.report).toBe('refused');
    const [notice] = getSalesToReview();
    expect(notice?.kind).toBe('voidUnknown');
    expect(notice?.voidable).toBeNull();
  });

  it('el lector no la anula: se avisa a OxioPay del fallo y sigue en la lista para anularla', async () => {
    reader({ ok: false, error: 'deviceError', message: 'Error del lector' });
    api(() => json(200, { ok: true }));
    const out = await voidSaleOnReader(sale);
    expect(out.approved).toBe(false);
    expect(out.message).toMatch(/^No se pudo anular/);
    expect(calls[0]?.body).toEqual({ operationNumber: '7', approved: false, resultText: 'Error del lector' });
    expect(getSalesToReview().map((r) => r.kind)).toEqual(['void']);
  });
});

describe('lo que se ve tras «Anular en el datáfono» desde ventas por revisar', () => {
  it('se queda en pantalla con su operación aunque la venta salga de la lista (antes desaparecía con ella)', async () => {
    reader({ ok: true, result: { approved: true } });
    api(() => json(200, { ok: true }));
    const out = await voidSaleOnReader(sale);
    const notice = voidNoticeOf(sale, out);
    expect(notice.ok).toBe(true);
    expect(notice.key).toBe(`${sale.paymentId}:7`);
    expect(notice.text).toMatch(/^Operación 7 · /);
    expect(notice.text).toContain('Operación anulada en el datáfono');
    // Y la venta ya no está en la lista (la tarjeta se va; el aviso se queda).
    expect(getSalesToReview()).toEqual([]);
  });

  it('si el lector no la anula, también se dice (y la venta sigue en la lista)', async () => {
    reader({ ok: false, error: 'deviceError', message: 'Error del lector' });
    api(() => json(200, { ok: true }));
    const notice = voidNoticeOf(sale, await voidSaleOnReader(sale));
    expect(notice.ok).toBe(false);
    expect(notice.text).toContain('No se pudo anular');
  });
});
