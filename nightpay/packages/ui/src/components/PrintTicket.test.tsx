// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paidTicket } from '../lib/ticket';
import { PRINT_MODE_KEY } from '../lib/print-mode';
import type { Ticket } from '../lib/ticket';

// jsdom no dibuja en <canvas>: un lienzo de mentira de 384 × 2 (negro arriba, blanco abajo).
vi.mock('../lib/ticket-raster', async (orig) => {
  const real = await orig<typeof import('../lib/ticket-raster')>();
  return {
    ...real,
    renderTicketCanvas: () => {
      const data = new Uint8ClampedArray(384 * 2 * 4).fill(255);
      for (let i = 0; i < 384 * 4; i += 4) data.set([0, 0, 0, 255], i);
      return {
        width: 384,
        height: 2,
        toDataURL: () => 'data:image/png;base64,AAAA',
        getContext: () => ({ getImageData: () => ({ data }) }),
      } as unknown as HTMLCanvasElement;
    },
  };
});

const { PRINTING_CLASS, PrintButton, printTarget, usePrintTicket } = await import('./PrintTicket');
const { PaymentOutcome } = await import('./PaymentOutcome');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TICKET: Ticket = paidTicket({ venue: 'Sala Uno', totalCents: 3630, at: new Date('2026-11-16T15:20:00Z') });

let host: HTMLDivElement;
let root: Root;
let printSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  printSpy = vi.fn();
  window.print = printSpy as unknown as typeof window.print;
  localStorage.clear();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.documentElement.classList.remove(PRINTING_CLASS);
  document.getElementById('np-ticket-page')?.remove();
  vi.restoreAllMocks();
});

function Harness({ ticket }: { ticket: Ticket }) {
  const printer = usePrintTicket();
  return (
    <>
      <PrintButton label="Imprimir ticket" onClick={() => printer.print(ticket)} />
      {printer.ticketNode}
    </>
  );
}

const buttonByText = (text: string) => Array.from(document.querySelectorAll('button')).find((b) => b.textContent === text) ?? null;
const flush = () => act(async () => void (await Promise.resolve()));

describe('imprimir un ticket', () => {
  it('con Android: la imagen del ticket sola en la página, sin tamaño propio, y el diálogo', async () => {
    act(() => root.render(<Harness ticket={TICKET} />));
    const ticketRoot = document.querySelector('.np-ticket-root');
    expect(ticketRoot?.parentElement).toBe(document.body);
    expect(ticketRoot?.querySelector('img')).toBeNull();

    act(() => buttonByText('Imprimir ticket')?.click());
    await flush();

    expect(ticketRoot?.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    expect(printSpy).toHaveBeenCalledTimes(1);
    expect(document.documentElement.classList.contains(PRINTING_CLASS)).toBe(true);
    const page = document.getElementById('np-ticket-page')?.textContent ?? '';
    expect(page).toContain('margin: 0');
    // Sin «size»: el papel lo pone la impresora y el ticket empieza arriba (antes salía centrado, con papel en blanco).
    expect(page).not.toContain('size');
  });

  it('al cerrar el diálogo, la app vuelve a verse', async () => {
    act(() => root.render(<Harness ticket={TICKET} />));
    act(() => buttonByText('Imprimir ticket')?.click());
    await flush();
    act(() => void window.dispatchEvent(new Event('afterprint')));
    expect(document.documentElement.classList.contains(PRINTING_CLASS)).toBe(false);
    expect(document.getElementById('np-ticket-page')).toBeNull();
  });

  it('directo (RawBT): un toque manda los bytes a RawBT, sin diálogo', () => {
    localStorage.setItem(PRINT_MODE_KEY, 'rawbt');
    const open = vi.spyOn(printTarget, 'open').mockImplementation(() => undefined);
    act(() => root.render(<Harness ticket={TICKET} />));
    act(() => buttonByText('Imprimir ticket')?.click());
    expect(printSpy).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
    const url = open.mock.calls[0]![0];
    expect(url).toMatch(/^intent:base64,[A-Za-z0-9+/=]+#Intent;scheme=rawbt;package=ru\.a402d\.rawbtprinter;end;$/);
    // Empieza por ESC @ (G0A = 1B 40 en base64).
    expect(url.startsWith('intent:base64,G0A')).toBe(true);
  });

  it('PAGADO enseña «Imprimir ticket» solo si hay ticket', async () => {
    const primary = { label: 'Nuevo cobro', onClick: () => undefined };
    act(() => root.render(<PaymentOutcome kind="paid" amountCents={3630} primary={primary} />));
    expect(buttonByText('Imprimir ticket')).toBeNull();
    act(() => root.render(<PaymentOutcome kind="paid" amountCents={3630} primary={primary} print={TICKET} />));
    act(() => buttonByText('Imprimir ticket')?.click());
    await flush();
    expect(printSpy).toHaveBeenCalledTimes(1);
  });
});
