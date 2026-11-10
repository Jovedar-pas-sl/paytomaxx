import { afterEach, describe, expect, it, vi } from 'vitest';
import { detailMineTexts, type CobroDetailDevice } from '@nightpay/contracts';
import { fetchOwnCobroDetail, OWN_DETAIL_FAILED, OWN_DETAIL_NOT_FOUND, ownDetailStatus, ownDeviceText, ownWhereText } from './own-cobro-detail';

const authedFetch = vi.hoisted(() => vi.fn());
vi.mock('./api', () => ({ authedFetch }));

const eur = (c: number) => `${(c / 100).toFixed(2).replace('.', ',')} €`;

afterEach(() => authedFetch.mockReset());

describe('el detalle de uno de sus cobros', () => {
  it('lo pide a /staff/me (nunca al panel)', async () => {
    authedFetch.mockResolvedValue(new Response(JSON.stringify({ id: 'p-1' }), { status: 200 }));
    await expect(fetchOwnCobroDetail('PAYMENT', 'p-1')).resolves.toEqual({ id: 'p-1' });
    expect(authedFetch.mock.calls[0]![0]).toBe('/v1/staff/me/cobros/PAYMENT/p-1');
  });

  it('el de otra persona (404) se dice en llano', async () => {
    authedFetch.mockResolvedValue(new Response('{}', { status: 404 }));
    await expect(fetchOwnCobroDetail('SALDO', 'x')).rejects.toThrow(OWN_DETAIL_NOT_FOUND);
    authedFetch.mockResolvedValue(new Response('{}', { status: 500 }));
    await expect(fetchOwnCobroDetail('SALDO', 'x')).rejects.toThrow(OWN_DETAIL_FAILED);
  });
});

describe('textos', () => {
  it('palabras únicas: «Pagado», «Devuelto» y «Cancelado»', () => {
    expect(ownDetailStatus('AUTHORIZED')).toBe('Pagado');
    expect(ownDetailStatus('ACCEPTED')).toBe('Pagado');
    expect(ownDetailStatus('REVERSED')).toBe('Devuelto');
    expect(ownDetailStatus('CANCELED')).toBe('Cancelado');
  });

  it('«lo tuyo»: comisión, propina, invitación, lo descontado y el total para ti', () => {
    const rows = detailMineTexts({ commissionCents: 2000, tipCents: 500, invitationCents: 0, reversedCents: 300, totalCents: 2200 }, eur);
    expect(rows).toEqual([
      { label: 'Tu comisión', value: '20,00 €' },
      { label: 'Tu propina', value: '5,00 €' },
      { label: 'Descontado por devoluciones', value: '−3,00 €' },
      { label: 'Para ti', value: '22,00 €' },
    ]);
  });

  it('su móvil y dónde', () => {
    const d = { who: 'staff', step: 'create', at: '2026-11-08T01:00:00.000Z', label: 'iPhone · iOS 18.1 · Safari', ip: '203.0.113.7', ipErased: false, personName: 'Ana' } as CobroDetailDevice;
    expect(ownDeviceText(d)).toEqual({ step: 'Al crear el cobro', text: 'iPhone · iOS 18.1 · Safari · 203.0.113.7' });
    expect(ownWhereText({ venueName: 'Sala Bambú', service: '2× Copa', isTopUp: false })).toBe('Sala Bambú · 2× Copa');
    expect(ownWhereText({ venueName: 'Sala Bambú', service: null, isTopUp: true })).toBe('Sala Bambú · Recarga de saldo');
  });
});
