import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Incident } from '@/lib/api';
import { visibleTabs } from '@/lib/roles';
import { IncidentsContext, type IncidentsFeed } from '@/lib/use-incidents';
import { IncidentsPanel } from './IncidentsPanel';

// B11: los avisos de dinero se cierran con nota y cualquier «Resolver» se
// puede deshacer durante 10 s (sale «Deshacer» en su sitio).

const NOW = Date.parse('2026-11-10T01:00:00Z');

const money: Incident = {
  kind: 'duplicate_charge',
  refId: '7',
  title: 'El cliente pagó dos veces',
  detail: 'Dos cobros de 40,00 €.',
  occurredAt: '2026-11-10T00:30:00Z',
  amountCents: 4000,
  paymentId: 'p-1',
  ackable: true,
  noteRequired: true,
};
const lost: Incident = {
  kind: 'wallet_card_lost',
  refId: '12',
  title: 'Un cliente ha bloqueado su NFC',
  detail: 'Ya no paga.',
  occurredAt: '2026-11-10T00:40:00Z',
  amountCents: null,
  paymentId: null,
  ackable: true,
  noteRequired: false,
};

function render(feed: Partial<IncidentsFeed>): string {
  const full: IncidentsFeed = {
    open: [money, lost],
    telegram: false,
    error: null,
    resolved: [],
    refresh: () => undefined,
    resolve: () => undefined,
    pending: [],
    undo: () => undefined,
    failed: {},
    ...feed,
  };
  return renderToStaticMarkup(
    <IncidentsContext.Provider value={full}>
      <IncidentsPanel isOwner tabs={visibleTabs({ role: 'OWNER' })} onNavigate={() => undefined} onOpenPayment={() => undefined} />
    </IncidentsContext.Provider>,
  );
}

const buttons = (html: string) => [...html.matchAll(/<button[^>]*>(?:<[^>]+>)*([^<]+)</g)].map((m) => m[1]);

beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('bandeja de avisos', () => {
  it('un aviso de dinero se resuelve con nota; los demás, de un toque o con nota', () => {
    const labels = buttons(render({}));
    expect(labels).toContain('Resolver con nota…');
    expect(labels.filter((l) => l === 'Resolver')).toHaveLength(1);
    expect(labels).toContain('Con nota…');
  });

  it('recién resuelto: «Deshacer» en su sitio, con la cuenta atrás, y no cuenta como abierto', () => {
    const html = render({ pending: [{ key: 'duplicate_charge:7', until: NOW + 10_000 }] });
    expect(buttons(html)).toContain('Deshacer');
    expect(html).toContain('Se quita de la bandeja en 10 s.');
    expect(buttons(html)).not.toContain('Resolver con nota…');
    expect(html).toMatch(/Abiertas <span class="np-inbox-count">1<\/span>/);
  });

  it('si el API no lo aceptó, vuelve a la bandeja con el porqué', () => {
    const html = render({ failed: { 'duplicate_charge:7': 'Es un aviso de dinero: escribe qué has hecho para cerrarlo.' } });
    expect(html).toContain('No se marcó como resuelta: Es un aviso de dinero');
    expect(buttons(html)).toContain('Resolver con nota…');
  });
});
