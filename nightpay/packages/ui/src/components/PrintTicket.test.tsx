// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paidTicket, payQrTicket } from '../lib/ticket';
import { cardHow } from '../lib/outcome-how';
import { PRINTING_CLASS, PrintButton, ticketPageCss, ticketPageHeightMm, usePrintTicket } from './PrintTicket';
import { PaymentOutcome } from './PaymentOutcome';
import type { Ticket } from '../lib/ticket';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const AT = new Date('2026-11-16T15:20:00Z');
const TICKET: Ticket = paidTicket({ venue: 'Sala Uno', amountCents: 3630, how: cardHow({ code: 'K7Q4', who: 'Carlos', at: AT }), at: AT });

let host: HTMLDivElement;
let root: Root;
let printSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  printSpy = vi.fn();
  window.print = printSpy as unknown as typeof window.print;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.documentElement.classList.remove(PRINTING_CLASS);
  document.getElementById('np-ticket-page')?.remove();
});

function Harness({ ticket }: { ticket: Ticket }) {
  const printer = usePrintTicket();
  return (
    <>
      <PrintButton label="Imprimir comprobante" onClick={() => printer.print(ticket)} />
      {printer.ticketNode}
    </>
  );
}

const buttonByText = (text: string) => Array.from(document.querySelectorAll('button')).find((b) => b.textContent === text) ?? null;

describe('imprimir un ticket', () => {
  it('la página mide lo que mide el ticket (58 mm de ancho, sin metros en blanco)', () => {
    // 377 px CSS = 99,7 mm → 100 mm de ticket + 8 mm para cortar.
    expect(ticketPageHeightMm(377)).toBe(108);
    expect(ticketPageCss(377)).toBe('@page { size: 58mm 108mm; margin: 0; }');
  });

  it('al tocar «Imprimir», pinta el ticket fuera de la pantalla y abre el diálogo', () => {
    act(() => root.render(<Harness ticket={TICKET} />));
    const root58 = document.querySelector('.np-ticket-root');
    expect(root58?.parentElement).toBe(document.body);
    expect(root58?.getAttribute('aria-hidden')).toBe('true');
    expect(document.querySelector('.np-ticket')).toBeNull();

    act(() => buttonByText('Imprimir comprobante')?.click());

    expect(printSpy).toHaveBeenCalledTimes(1);
    expect(document.documentElement.classList.contains(PRINTING_CLASS)).toBe(true);
    expect(document.getElementById('np-ticket-page')?.textContent).toContain('size: 58mm');
    const paper = document.querySelector('.np-ticket')?.textContent ?? '';
    expect(paper).toContain('Sala Uno');
    expect(paper).toContain('Comprobante de pago');
    expect(paper).toContain('36,30');
    expect(paper).toContain('K7Q4');
    expect(paper).not.toContain('Carlos');
  });

  it('al cerrar el diálogo, la app vuelve a verse', () => {
    act(() => root.render(<Harness ticket={TICKET} />));
    act(() => buttonByText('Imprimir comprobante')?.click());
    act(() => void window.dispatchEvent(new Event('afterprint')));
    expect(document.documentElement.classList.contains(PRINTING_CLASS)).toBe(false);
    expect(document.getElementById('np-ticket-page')).toBeNull();
  });

  it('el QR en papel sale dibujado', () => {
    const qr = payQrTicket({ amountCents: 2000, qrUrl: 'https://api.example/pay/abc', expiresAt: null, at: AT });
    act(() => root.render(<Harness ticket={qr} />));
    act(() => buttonByText('Imprimir comprobante')?.click());
    expect(document.querySelector('.np-ticket-qr path')?.getAttribute('d')).toBeTruthy();
  });

  it('PAGADO enseña «Imprimir comprobante» solo si hay ticket', () => {
    const primary = { label: 'Nuevo cobro', onClick: () => undefined };
    act(() => root.render(<PaymentOutcome kind="paid" amountCents={3630} primary={primary} />));
    expect(buttonByText('Imprimir comprobante')).toBeNull();
    act(() => root.render(<PaymentOutcome kind="paid" amountCents={3630} primary={primary} print={TICKET} />));
    act(() => buttonByText('Imprimir comprobante')?.click());
    expect(printSpy).toHaveBeenCalledTimes(1);
  });
});
