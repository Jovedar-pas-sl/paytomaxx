import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CobroRow } from '@nightpay/contracts';
import { COBRO_ACTION_TITLES } from '../lib/cobros-help';
import { CobroRowActions } from './CobroRowActions';

// Los botones de una fila de Cobros: quién ve cada uno es lo que cuenta y
// con qué título. Si cambia aquí, el tutorial del «?» de Cobros (lib/tours.ts) miente.

const NOW = Date.parse('2026-11-09T23:30:00Z');
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

function card(over: { status?: string; provider?: string; available?: number; updatedAt?: string } = {}): CobroRow {
  return {
    kind: 'PAYMENT',
    id: '11111111-2222-4333-8444-555555555555',
    ref: 'C-0025',
    createdAt: minutesAgo(30),
    amountCents: 4000,
    tipCents: 0,
    currency: 'EUR',
    status: over.status ?? 'AUTHORIZED',
    person: null,
    sections: [],
    isTopUp: false,
    method: 'CARD',
    methodLabel: 'Tarjeta ••4242',
    wallet: null,
    service: null,
    invited: null,
    lines: [],
    payment: {
      availableAmountCents: over.available ?? 4000,
      provider: over.provider ?? 'REDSYS',
      providerTxId: 'BBVA123',
      captureMethod: null,
      updatedAt: over.updatedAt ?? minutesAgo(30),
      authCode: '047215',
      cardLast4: '4242',
      cardBrand: null,
      payMethodCode: null,
      authorizedAt: null,
      attempts: [],
      terminal: { externalId: 't1', label: 'Barra' },
    },
  };
}

const saldo: CobroRow = {
  ...card(),
  kind: 'SALDO',
  status: 'ACCEPTED',
  method: 'SALDO',
  methodLabel: 'Saldo K7Q-•••',
  wallet: { id: 'w1', codeHint: 'K7Q' },
  consumptionId: 'c1',
  payment: null,
};

const noop = () => undefined;
function buttons(row: CobroRow, role: string): Array<{ label: string; title: string | null }> {
  const html = renderToStaticMarkup(
    <CobroRowActions row={row} role={role} onReverse={noop} onResolve={noop} onRefund={noop} onRefunds={noop} />,
  );
  return [...html.matchAll(/<button([^>]*)>[\s\S]*?<span[^>]*>([^<]*)<\/span><\/button>/g)].map((m) => ({
    label: m[2]!,
    title: m[1]!.match(/title="([^"]*)"/)?.[1] ?? null,
  }));
}
const labels = (row: CobroRow, role: string) => buttons(row, role).map((b) => b.label);

beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('botones de una fila de Cobros', () => {
  it('cobro del saldo pagado: «Anular cobro» (dueño y encargado)', () => {
    expect(labels(saldo, 'OWNER')).toEqual(['Anular cobro']);
    expect(labels(saldo, 'MANAGER')).toEqual(['Anular cobro']);
    expect(labels({ ...saldo, status: 'REVERSED' }, 'OWNER')).toEqual([]);
  });

  it('con tarjeta de BBVA: «Devolución BBVA», solo el dueño', () => {
    expect(labels(card(), 'OWNER')).toEqual(['Devolución BBVA']);
    expect(labels(card({ status: 'PARTIALLY_REFUNDED', available: 1000 }), 'OWNER')).toEqual(['Devolución BBVA', 'Devoluciones']);
    expect(labels(card(), 'MANAGER')).toEqual([]);
  });

  it('con otra pasarela: «Reembolsar», dueño y encargado', () => {
    expect(labels(card({ provider: 'PAYTEF' }), 'OWNER')).toEqual(['Reembolsar']);
    expect(labels(card({ provider: 'PAYTEF' }), 'MANAGER')).toEqual(['Reembolsar']);
  });

  it('«Resolver»: solo el dueño, «Sin confirmar» o más de 15 minutos «Esperando pago»', () => {
    expect(labels(card({ status: 'ORPHAN' }), 'OWNER')).toEqual(['Resolver']);
    expect(labels(card({ status: 'ORPHAN' }), 'MANAGER')).toEqual([]);
    expect(labels(card({ status: 'AUTHORIZING', updatedAt: minutesAgo(16) }), 'OWNER')).toEqual(['Resolver']);
    expect(labels(card({ status: 'AUTHORIZING', updatedAt: minutesAgo(5) }), 'OWNER')).toEqual([]);
  });

  it('«Devoluciones» cuando ya hay algo devuelto o reservado; nada que devolver en uno devuelto entero', () => {
    expect(labels(card({ status: 'REFUNDED', available: 0 }), 'OWNER')).toEqual(['Devoluciones']);
    expect(labels(card({ status: 'REFUNDED', available: 0 }), 'MANAGER')).toEqual(['Devoluciones']);
  });

  it('cada botón con su title corto', () => {
    const all = [
      ...buttons(saldo, 'OWNER'),
      ...buttons(card({ status: 'ORPHAN' }), 'OWNER'),
      ...buttons(card({ status: 'PARTIALLY_REFUNDED', available: 1000 }), 'OWNER'),
      ...buttons(card({ provider: 'PAYTEF' }), 'OWNER'),
    ];
    expect(all.map((b) => b.label)).toEqual(['Anular cobro', 'Resolver', 'Devolución BBVA', 'Devoluciones', 'Reembolsar']);
    const byLabel = Object.fromEntries(all.map((b) => [b.label, b.title]));
    expect(byLabel['Anular cobro']).toBe(COBRO_ACTION_TITLES.reverse);
    expect(byLabel.Resolver).toBe(COBRO_ACTION_TITLES.resolve);
    expect(byLabel['Devolución BBVA']).toBe(COBRO_ACTION_TITLES.bankRefund);
    expect(byLabel.Devoluciones).toBe(COBRO_ACTION_TITLES.refunds);
    expect(byLabel.Reembolsar).toBe(COBRO_ACTION_TITLES.refund);
  });
});
