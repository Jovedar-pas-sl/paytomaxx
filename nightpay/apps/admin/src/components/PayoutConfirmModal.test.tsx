import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PayoutConfirmModal } from './PayoutConfirmModal';

const IBAN = 'ES7921000813610123456789';
const base = {
  operatorId: 'op-1',
  operatorName: 'Ana',
  balanceCents: 9000,
  payoutMethod: 'SEPA_IBAN' as const,
  payoutAddressMasked: 'ES79 •••• •••• 6789',
  payoutHolderMasked: 'A••• L•••',
  payoutLabel: null,
  onClose: () => undefined,
  onDone: () => undefined,
};
const inTwoDays = new Date(Date.now() + 47 * 60 * 60 * 1000).toISOString();
const render = (props: Partial<React.ComponentProps<typeof PayoutConfirmModal>> = {}) =>
  renderToStaticMarkup(<PayoutConfirmModal {...base} {...props} />);

describe('«Marcar pagado»: la cuenta de la compañera va tapada', () => {
  it('el dueño ve la cuenta tapada y «Ver cuenta para pagar»; nunca entera de entrada', () => {
    const html = render({ canReveal: true });
    expect(html).toContain('ES79 •••• •••• 6789');
    expect(html).toContain('Titular: A••• L•••');
    expect(html).toContain('Ver cuenta para pagar');
    expect(html).not.toContain(IBAN);
  });

  it('el encargado no puede verla entera', () => {
    const html = render({ mode: 'request' });
    expect(html).not.toContain('Ver cuenta para pagar');
    expect(html).toContain('Solo el dueño puede ver la cuenta entera.');
  });

  it('el titular que no se parece a su nombre se avisa (no bloquea)', () => {
    expect(render({ payoutHolderMismatch: true })).toContain('El titular no se parece al nombre de la compañera («Ana»)');
    expect(render()).not.toContain('El titular no se parece');
  });
});

describe('«Marcar pagado»: 48 h tras cambiar la cuenta', () => {
  it('con la espera puesta: se dice desde cuándo y se ofrece pagarle en efectivo (también al encargado que lo pide)', () => {
    for (const mode of ['pay', 'request'] as const) {
      const html = render({ payoutHoldUntil: inTwoDays, mode });
      expect(html).toContain('Su cuenta de cobro cambió hace menos de 48 h');
      expect(html).toContain('Pagarle en efectivo');
    }
  });

  it('sin espera (o ya pasada): ni aviso ni botón', () => {
    for (const payoutHoldUntil of [null, new Date(Date.now() - 1000).toISOString()]) {
      const html = render({ payoutHoldUntil });
      expect(html).not.toContain('cambió hace menos de 48 h');
      expect(html).not.toContain('Pagarle en efectivo');
    }
  });

  it('quien ya cobra en efectivo no tiene espera', () => {
    const html = render({ payoutMethod: 'MANUAL_CASH', payoutAddressMasked: null, payoutHolderMasked: null, payoutHoldUntil: inTwoDays });
    expect(html).not.toContain('cambió hace menos de 48 h');
  });
});
