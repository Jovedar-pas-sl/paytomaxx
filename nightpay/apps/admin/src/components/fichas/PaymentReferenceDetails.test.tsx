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
  it('manda la búsqueda al servidor', () => {
    expect(cobrosQuery({search:'A6B'})).toBe('search=A6B');
  });
});
