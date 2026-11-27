import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NightCaja } from '@/lib/api';
import { NightCajaBlock } from './NightCajaBlock';

// El bloque «Caja» de un Z congelado: con el efectivo de los cajeros de otras
// plataformas, «Fuera de este cajón» (PR 3 B); sin él, como siempre.

const CAJA: NightCaja = {
  openingFloatCents: 20_000,
  cashInCents: 8000,
  walletCashTopUpsCount: 2,
  walletCashTopUpsCents: 8000,
  walletCashPayoutsCount: 0,
  walletCashPayoutsCents: 0,
  chicaCashPayoutsCount: 0,
  chicaCashPayoutsCents: 0,
  cashOutCents: 0,
  expectedCents: 28_000,
  countedCents: 28_000,
  diffCents: 0,
  note: null,
  frozenAt: '2026-11-27T06:00:00.000Z',
};

const NBSP = new RegExp(String.fromCharCode(160), 'g');
const render = (caja: NightCaja) => renderToStaticMarkup(<NightCajaBlock caja={caja} />).replace(NBSP, ' ');

beforeEach(() => {
  vi.stubGlobal('React', React);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('NightCajaBlock: «Fuera de este cajón»', () => {
  it('con partnerCash: una línea por plataforma y la nota', () => {
    const html = render({
      ...CAJA,
      partnerCash: [
        { name: 'Cajeros Demo', count: 3, cents: 9000 },
        { name: 'Red <b>Dos</b>', count: -1, cents: -2500 },
      ],
    });
    expect(html).toContain('Fuera de este cajón');
    expect(html).toContain('Caja · Cajeros Demo (3)');
    expect(html).toContain('90,00 €');
    expect(html).toContain('−25,00 €');
    expect(html).toContain('Lo cobran sus cajeros: se cuenta aparte, contra «Movimientos».');
    // Lo que escribe la plataforma es texto, nunca HTML.
    expect(html).not.toContain('<b>Dos</b>');
    expect(html).toContain('Red &lt;b&gt;Dos&lt;/b&gt;');
  });

  it('sin partnerCash, como siempre', () => {
    expect(render(CAJA)).not.toContain('Fuera de este cajón');
  });
});
