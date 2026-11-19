import React from 'react';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Incident } from '../lib/api';
import { AcceptAfterCancelModal } from './AcceptAfterCancelModal';

const late: Incident = {
  kind: 'approval_unbooked',
  refId: '901',
  title: 'Pagó después de cancelar: C-0012, 12,00 €',
  detail: 'El cliente terminó de pagar en su banco después de cancelar el cobro.',
  occurredAt: '2026-11-16T22:40:00.000Z',
  amountCents: 1200,
  paymentId: 'p1',
  ackable: true,
  noteRequired: true,
  acceptable: true,
};

describe('«Dar por bueno» un cobro pagado después de cancelar', () => {
  it('pide el porqué y la 2FA, y dice qué pasa (pagado, con su propina y comisión)', () => {
    const html = renderToStaticMarkup(<AcceptAfterCancelModal incident={late} onClose={() => undefined} onDone={() => undefined} />);
    expect(html).toContain('Pagó después de cancelar: C-0012, 12,00 €');
    expect(html).toContain('Por qué lo das por bueno');
    expect(html).toContain('Código de tu app de verificación (2FA)');
    expect(html).toContain('El cobro pasa a pagado con lo que cobró el banco');
    expect(html).toContain('Volver');
  });

  it('cerrado sin aviso: no pinta nada', () => {
    expect(renderToStaticMarkup(<AcceptAfterCancelModal incident={null} onClose={() => undefined} onDone={() => undefined} />)).toBe('');
  });

  it('en Avisos, el botón solo sale en los que se pueden dar por buenos; la llamada va al API con la nota y la 2FA', () => {
    const panel = readFileSync(new URL('./IncidentsPanel.tsx', import.meta.url), 'utf8');
    expect(panel).toContain('onAccept={i.acceptable && i.paymentId ? () => setAcceptFor(i) : undefined}');
    const api = readFileSync(new URL('../lib/endpoints/incidents.ts', import.meta.url), 'utf8');
    expect(api).toContain('/v1/admin/payments/${paymentId}/accept-after-cancel');
  });
});
