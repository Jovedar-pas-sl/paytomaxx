// @vitest-environment jsdom
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot, type Root } from 'react-dom/client';
import { createOperatorPayout } from '@/lib/api';
import { PayoutConfirmModal } from './PayoutConfirmModal';

vi.mock('@/lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/api')>()), createOperatorPayout: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

describe('«Marcar pagado» durante la espera: ni se envía ni se gasta el código 2FA', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.body.appendChild(document.createElement('div'));
    root = createRoot(host);
    vi.mocked(createOperatorPayout).mockReset();
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  const button = (text: string) => Array.from(document.querySelectorAll('button')).find((b) => b.textContent === text)!;
  const click = (el: HTMLElement) => act(() => el.click());
  function typeCode(code: string) {
    const input = document.querySelector<HTMLInputElement>('.np-otp-input')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, code);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('a su cuenta, el botón sigue apagado y el sexto número no envía nada; en efectivo, sí se puede', () => {
    act(() => root.render(<PayoutConfirmModal {...base} payoutHoldUntil={inTwoDays} />));
    click(document.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    expect(button('Apuntar el pago').disabled).toBe(true);
    typeCode('123456');
    expect(createOperatorPayout).not.toHaveBeenCalled();
    click(button('Pagarle en efectivo'));
    expect(button('Apuntar el pago').disabled).toBe(false);
  });

  it('con el titular sin confirmar, igual: a su cuenta no se envía; en efectivo, sí', () => {
    act(() => root.render(<PayoutConfirmModal {...base} payoutHolderUnconfirmed />));
    click(document.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    expect(button('Apuntar el pago').disabled).toBe(true);
    typeCode('123456');
    expect(createOperatorPayout).not.toHaveBeenCalled();
    click(button('Pagarle en efectivo'));
    expect(button('Apuntar el pago').disabled).toBe(false);
  });
});
