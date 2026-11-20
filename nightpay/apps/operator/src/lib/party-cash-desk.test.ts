import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PartyCashDesk } from '@nightpay/contracts';
import { CashDeskLine } from '../components/party/CashDeskLine';
import { CASH_DESK_PATH, cashDeskLine, loadCashDesk } from './party-cash-desk';

// OxioParty · «Efectivo en esta caja» en la taquilla (GET /v1/party/cash-desk/me):
// si llega, la cifra; si no, nada (ni error ni aviso).

const nb = (text: string) => text.replace(/[\u00a0\u202f]/g, ' ');

const DESK: PartyCashDesk = {
  from: '2027-06-23T06:00:00.000Z',
  to: '2027-06-24T06:00:00.000Z',
  cashInCents: 128_000,
  topUpsCount: 41,
  cashOutCents: 4_000,
  payoutsCount: 2,
  cashCents: 124_000,
  alertCents: 200_000,
  overAlert: false,
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('la caja de la taquilla: pedirla', () => {
  it('pide /v1/party/cash-desk/me y devuelve la caja', async () => {
    const fetcher = vi.fn(async () => json(DESK));
    await expect(loadCashDesk(fetcher)).resolves.toEqual(DESK);
    expect(fetcher).toHaveBeenCalledWith(CASH_DESK_PATH, {});
  });

  it('pasa la señal para cancelarla', async () => {
    const ctrl = new AbortController();
    const fetcher = vi.fn(async () => json(DESK));
    await loadCashDesk(fetcher, ctrl.signal);
    expect(fetcher).toHaveBeenCalledWith(CASH_DESK_PATH, { signal: ctrl.signal });
  });

  it('si falla, null y sin lanzar: 404 (OxioPay o un API anterior), 403, 500, sin red o un cuerpo raro', async () => {
    for (const status of [404, 403, 500]) await expect(loadCashDesk(async () => json({ code: 'X' }, status))).resolves.toBeNull();
    await expect(
      loadCashDesk(async () => {
        throw new TypeError('Failed to fetch');
      }),
    ).resolves.toBeNull();
    await expect(loadCashDesk(async () => new Response('<html>', { status: 200 }))).resolves.toBeNull();
    await expect(loadCashDesk(async () => json({ cashCents: '12' }))).resolves.toBeNull();
    await expect(loadCashDesk(async () => json(null))).resolves.toBeNull();
  });
});

describe('la caja de la taquilla: enseñarla', () => {
  it('la cifra en euros y si pasa del aviso', () => {
    expect(nb(cashDeskLine(DESK)?.value ?? '')).toBe('1.240,00 €');
    expect(cashDeskLine(DESK)?.over).toBe(false);
    expect(cashDeskLine({ ...DESK, overAlert: true })?.over).toBe(true);
    expect(cashDeskLine(null)).toBeNull();
  });

  it('«Efectivo en esta caja» con su cifra; por encima del aviso, qué hacer', () => {
    const html = nb(renderToStaticMarkup(createElement(CashDeskLine, { desk: DESK })));
    expect(html).toContain('Efectivo en esta caja');
    expect(html).toContain('1.240,00 €');
    expect(html).not.toContain('avisa al encargado');
    const over = nb(renderToStaticMarkup(createElement(CashDeskLine, { desk: { ...DESK, cashCents: 210_000, overAlert: true } })));
    expect(over).toContain('2.100,00 €');
    expect(over).toContain('avisa al encargado');
  });

  it('sin la caja (no llegó o falló), no sale nada', () => {
    expect(renderToStaticMarkup(createElement(CashDeskLine, { desk: null }))).toBe('');
  });
});
