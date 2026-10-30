import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CobroRow } from '@nightpay/contracts';
import { PaymentReferenceDetails } from './PaymentReferenceDetails';
import { cobrosQuery } from '../../lib/endpoints/money-map';

const row = { kind: 'PAYMENT', confirmationCode: 'A6B', payment: {
  providerTxId: 'BBVA123', authCode: '012345', attempts: [
    { providerTxId: 'BBVA123', status: 'APPROVED', createdAt:'2026-10-28T00:00:00Z' },
    { providerTxId: 'BBVA456', status: 'DENIED', createdAt:'2026-10-28T00:01:00Z' },
  ],
} } as unknown as CobroRow;
afterEach(() => vi.unstubAllGlobals());

describe('referencias visibles en el panel', () => {
  it('muestra código, pedido, autorización, botones de copiar y todos los intentos', () => {
    vi.stubGlobal('React', React);
    const html = renderToStaticMarkup(<PaymentReferenceDetails row={row} />);
    for (const text of ['A6B', 'BBVA123', '012345', 'BBVA456', 'Aprobado', 'Denegado', 'Copiar']) expect(html).toContain(text);
  });
  it('una carga con el enlace del local: su origen, «Desde casa»; los demás cobros, sin él', () => {
    vi.stubGlobal('React', React);
    const casa = renderToStaticMarkup(<PaymentReferenceDetails row={{ ...row, fromHome: true }} />);
    for (const text of ['Origen', 'Desde casa', 'enlace del local', 'A6B']) expect(casa).toContain(text);
    const otro = renderToStaticMarkup(<PaymentReferenceDetails row={row} />);
    expect(otro).not.toContain('Desde casa');
    expect(otro).not.toContain('Origen');
  });
  it('manda la búsqueda al servidor', () => {
    expect(cobrosQuery({search:'A6B'})).toBe('search=A6B');
  });
});
