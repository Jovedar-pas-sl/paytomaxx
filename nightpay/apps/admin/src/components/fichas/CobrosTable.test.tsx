import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CobroRow } from '@nightpay/contracts';
import { CobrosTable } from './CobrosTable';

// La tabla de Cobros (idea 15): seis columnas, sin «Acciones» ni «Ver detalle»;
// la fila entera abre el detalle. «Importe» es lo que pagó el cliente.

const NOW = Date.parse('2026-11-15T02:00:00Z');

const row = (over: Partial<CobroRow> = {}): CobroRow => ({
  kind: 'PAYMENT',
  id: '11111111-2222-4333-8444-555555555555',
  ref: 'C-0024',
  confirmationCode: '4EF',
  createdAt: '2026-11-15T01:14:00Z',
  amountCents: 4000,
  tipCents: 500,
  serviceFeeCents: 120,
  currency: 'EUR',
  status: 'AUTHORIZED',
  person: { id: 'o1', name: 'Marta', role: 'OPERATOR' },
  sections: [],
  isTopUp: true,
  method: 'CARD',
  methodLabel: 'Tarjeta ••4242',
  wallet: null,
  service: '2× Copa',
  invited: null,
  lines: [],
  payment: null,
  ...over,
});

const EMPTY = { title: 'Aún no hay cobros' };
const headers = (html: string) => [...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/\u00a0/g, ' ');

beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('tabla de Cobros', () => {
  it('seis cabeceras, sin «Acciones»', () => {
    const html = renderToStaticMarkup(<CobrosTable rows={[row()]} empty={EMPTY} onDetails={() => undefined} />);
    expect(headers(html)).toEqual(['Hora', 'Qué', 'Quién', 'Cómo pagó', 'Estado', 'Importe']);
    expect(html).not.toContain('Acciones');
    expect(html).not.toContain('Ver detalle');
  });

  it('`columns` añade las de más: «Referencia», «Código» y «Ref. del banco»', () => {
    const one = renderToStaticMarkup(<CobrosTable rows={[row()]} empty={EMPTY} columns={['ref']} />);
    expect(headers(one)).toEqual(['Hora', 'Referencia', 'Qué', 'Quién', 'Cómo pagó', 'Estado', 'Importe']);
    expect(one).toContain('C-0024');
    const all = renderToStaticMarkup(<CobrosTable rows={[row()]} empty={EMPTY} columns={['ref', 'codigo', 'banco']} />);
    expect(headers(all)).toEqual(['Hora', 'Referencia', 'Qué', 'Quién', 'Cómo pagó', 'Código', 'Ref. del banco', 'Estado', 'Importe']);
    // Sin pedirla, la referencia no sale en la fila (está en el detalle).
    expect(renderToStaticMarkup(<CobrosTable rows={[row()]} empty={EMPTY} />)).not.toContain('C-0024');
  });

  it('`hidePerson` quita «Quién» (la lista de cobros de una compañera)', () => {
    const html = renderToStaticMarkup(<CobrosTable rows={[row()]} empty={EMPTY} hidePerson columns={['ref']} />);
    expect(headers(html)).toEqual(['Hora', 'Referencia', 'Qué', 'Cómo pagó', 'Estado', 'Importe']);
    expect(html).not.toContain('Marta');
  });

  it('«Importe» es lo que pagó el cliente: con la propina y la comisión del servicio, y siempre con céntimos', () => {
    const html = renderToStaticMarkup(<CobrosTable rows={[row()]} empty={EMPTY} />);
    expect(text(html)).toContain('46,20 €');
    expect(text(html)).not.toContain('propina');
    const round = renderToStaticMarkup(<CobrosTable rows={[row({ tipCents: 0, serviceFeeCents: 0 })]} empty={EMPTY} />);
    expect(text(round)).toContain('40,00 €');
    expect(round).toContain('data-size="table"');
  });

  it('la hora sola; el estado, con su símbolo y pequeño; qué fue y el servicio', () => {
    const html = renderToStaticMarkup(<CobrosTable rows={[row({ invited: { id: 'o3', name: 'Nerea', role: 'OPERATOR' } })]} empty={EMPTY} />);
    expect(text(html)).toContain('02:14');
    expect(html).toMatch(/class="np-tag"[^>]*data-tone="success"[^>]*data-size="sm"/);
    expect(text(html)).toContain('Recarga de saldo');
    expect(text(html)).toContain('2× Copa');
    expect(html).toContain('title="Invitación a Nerea"');
  });

  it('con `onDetails`, la fila entera se abre con el teclado y la abierta va marcada', () => {
    const html = renderToStaticMarkup(<CobrosTable rows={[row(), row({ id: 'otro' })]} empty={EMPTY} onDetails={() => undefined} current={{ kind: 'PAYMENT', id: 'otro' }} />);
    expect(html.match(/<tr[^>]*tabindex="0"/g)).toHaveLength(2);
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
  });

  it('sin `onDetails`, sin `tabIndex`: la fila no es un botón', () => {
    const html = renderToStaticMarkup(<CobrosTable rows={[row()]} empty={EMPTY} />);
    expect(html).not.toContain('tabindex');
    expect(html).not.toContain('aria-current');
  });

  it('cargando, ocho siluetas; sin cobros, la frase y su botón', () => {
    const loading = renderToStaticMarkup(<CobrosTable rows={null} empty={EMPTY} />);
    expect(loading).toContain('aria-busy="true"');
    expect(loading.match(/<tr aria-hidden="true"/g)).toHaveLength(8);
    const empty = renderToStaticMarkup(
      <CobrosTable rows={[]} empty={{ title: 'No hay cobros con estos filtros', action: { label: 'Quitar todo', onClick: () => undefined } }} />,
    );
    expect(text(empty)).toContain('No hay cobros con estos filtros');
    expect(text(empty)).toContain('Quitar todo');
  });

  it('`compact` (los últimos del Resumen): hora, qué, estado e importe, sin cabecera; cargando, cinco siluetas', () => {
    const html = renderToStaticMarkup(<CobrosTable rows={[row()]} empty={EMPTY} compact columns={['ref']} onDetails={() => undefined} />);
    expect(html).not.toContain('<thead');
    expect([...html.matchAll(/<td data-card="([a-z]+)"/g)].map((m) => m[1])).toEqual(['hora', 'que', 'estado', 'importe']);
    expect(html).not.toContain('Marta');
    expect(html).toContain('tabindex="0"');
    expect(renderToStaticMarkup(<CobrosTable rows={null} empty={EMPTY} compact />).match(/<tr aria-hidden="true"/g)).toHaveLength(5);
  });
});
