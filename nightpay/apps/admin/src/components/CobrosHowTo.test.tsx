import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CobroRow } from '@nightpay/contracts';
import { COBRO_ACTION_TITLES, COBRO_STATES_HELP, COBROS_ACTIONS_HELP, COBROS_CASES_HELP, COBROS_COLUMNS_HELP } from '../lib/cobros-help';
import { CobrosHowTo } from './CobrosHowTo';
import { CobrosTable } from './fichas/CobrosTable';

// «Cómo leer esta tabla»: cerrado por defecto y con una entrada por cada
// columna que de verdad sale en Cobros (la tabla pintada, con referencias y
// acciones, como en PaymentsPanel).

const row = {
  kind: 'PAYMENT',
  id: '11111111-2222-4333-8444-555555555555',
  ref: 'C-0025',
  confirmationCode: '555',
  createdAt: '2026-11-09T23:10:00Z',
  amountCents: 4000,
  tipCents: 0,
  currency: 'EUR',
  status: 'AUTHORIZED',
  person: null,
  sections: [],
  isTopUp: false,
  method: 'CARD',
  methodLabel: 'Tarjeta ••4242',
  wallet: null,
  service: null,
  invited: null,
  lines: [],
  payment: null,
} as unknown as CobroRow;

const unescape = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

beforeEach(() => vi.stubGlobal('React', React));
afterEach(() => vi.unstubAllGlobals());

describe('«Cómo leer esta tabla»', () => {
  it('es un <details> cerrado por defecto, con su título', () => {
    const html = renderToStaticMarkup(<CobrosHowTo />);
    expect(html).toMatch(/^<details class="np-howto"><summary>Cómo leer esta tabla<\/summary>/);
    expect(html).not.toMatch(/<details[^>]*\sopen/);
  });

  it('las columnas de la ayuda son las que salen en Cobros, en su orden y ninguna más', () => {
    const table = renderToStaticMarkup(
      <CobrosTable rows={[]} showReferences empty="Sin cobros" onDetails={() => undefined} actions={() => null} />,
    );
    const headers = [...table.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => unescape(m[1]!));
    expect(headers).toEqual(COBROS_COLUMNS_HELP.map((c) => c.term));
  });

  it('«Ver detalle» lleva su title en la tabla', () => {
    const table = renderToStaticMarkup(
      <CobrosTable rows={[row]} showReferences empty="Sin cobros" onDetails={() => undefined} actions={() => null} />,
    );
    expect(table).toContain(`title="${COBRO_ACTION_TITLES.detail}"`);
    expect(table).toContain('Ver detalle');
  });

  it('pinta las cuatro partes: columnas, botones, estados (con su pastilla) y los casos', () => {
    const html = unescape(renderToStaticMarkup(<CobrosHowTo />));
    for (const h of ['Columnas', 'Botones de cada cobro', 'Estados', 'Si pasa esto → haz esto']) expect(html).toContain(`<h3>${h}</h3>`);
    for (const i of [...COBROS_COLUMNS_HELP, ...COBROS_ACTIONS_HELP, ...COBROS_CASES_HELP]) {
      expect(html).toContain(`<dt>${i.term}</dt>`);
      expect(html).toContain(i.text);
    }
    for (const s of COBRO_STATES_HELP) {
      expect(html).toContain(`>${s.label}</span></dt>`);
      expect(html).toContain(s.text);
    }
  });
});
