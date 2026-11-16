'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { formatMoney } from '@nightpay/contracts';
import { encodeQr, qrSvgPath } from '../lib/qr';
import { ticketDateTime, type Ticket } from '../lib/ticket';

/**
 * Imprimir un ticket (papel de 58 mm) desde el navegador: la impresora del
 * datáfono sale en el diálogo de Android (su servicio de impresión o RawBT).
 * El ticket se pinta fuera de la pantalla en el <body>; al imprimir, la hoja
 * de estilos (styles.css, «Ticket impreso») esconde todo lo demás y la página
 * mide lo que mide el ticket (sin metros de papel en blanco).
 */

/** En <html> mientras se imprime: solo entonces se esconde la app. */
export const PRINTING_CLASS = 'np-printing';
const PAGE_STYLE_ID = 'np-ticket-page';
const PAPER_MM = 58;
const MM_PER_PX = 25.4 / 96;
/** Un poco de papel de más al final, para cortarlo sin llevarse la última línea. */
const TAIL_MM = 8;
// Margen blanco de 4 módulos (lo que pide la norma para que se lea bien).
const QR_QUIET_ZONE = 4;

/** El alto de la página en mm para un ticket de `heightPx` píxeles CSS. */
export function ticketPageHeightMm(heightPx: number): number {
  return Math.ceil(heightPx * MM_PER_PX) + TAIL_MM;
}

/** La regla @page del ticket: ancho del papel, alto del ticket, sin márgenes. */
export function ticketPageCss(heightPx: number): string {
  return `@page { size: ${PAPER_MM}mm ${ticketPageHeightMm(heightPx)}mm; margin: 0; }`;
}

function startPrint(heightPx: number): void {
  endPrint();
  const style = document.createElement('style');
  style.id = PAGE_STYLE_ID;
  style.textContent = `@media print { ${ticketPageCss(heightPx)} }`;
  document.head.appendChild(style);
  document.documentElement.classList.add(PRINTING_CLASS);
  window.addEventListener('afterprint', endPrint, { once: true });
}

function endPrint(): void {
  document.getElementById(PAGE_STYLE_ID)?.remove();
  document.documentElement.classList.remove(PRINTING_CLASS);
}

export interface PrintTicketApi {
  /** Pinta el ticket y abre el diálogo de imprimir (desde el toque del botón). */
  print: (ticket: Ticket) => void;
  /** El ticket fuera de la pantalla: va en el árbol de quien imprime. */
  ticketNode: ReactNode;
}

/** Para un botón «Imprimir»: `print(ticket)` en su onClick y `ticketNode` en la pantalla. */
export function usePrintTicket(): PrintTicketApi {
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setHost(document.body);
    return () => endPrint();
  }, []);

  const print = useCallback((next: Ticket) => {
    // Pintado ya (en el mismo toque): Chrome solo deja imprimir desde un gesto.
    flushSync(() => setTicket(next));
    const el = ref.current;
    if (!el) return;
    startPrint(el.getBoundingClientRect().height);
    window.print();
  }, []);

  const ticketNode = host
    ? createPortal(
        <div ref={ref} className="np-ticket-root" aria-hidden="true">
          {ticket ? <TicketPaper ticket={ticket} /> : null}
        </div>,
        host,
      )
    : null;
  return { print, ticketNode };
}

/** El ticket en papel: negro sobre blanco, letra de imprenta, el importe grande. */
export function TicketPaper({ ticket }: { ticket: Ticket }) {
  const qr = ticket.qrUrl ? encodeQr(ticket.qrUrl) : null;
  const side = qr ? qr.size + QR_QUIET_ZONE * 2 : 0;
  return (
    <div className="np-ticket">
      {ticket.venue ? <p className="np-ticket-venue">{ticket.venue}</p> : null}
      <p className="np-ticket-title">{ticket.title}</p>
      <p className="np-ticket-meta">
        <span>{ticketDateTime(ticket.at)}</span>
        {ticket.reference ? <span>{ticket.reference}</span> : null}
      </p>
      <hr className="np-ticket-rule" />
      {ticket.amountCents > 0 ? (
        <p className="np-ticket-amount">{formatMoney(ticket.amountCents, { currency: ticket.currency ?? 'EUR' })}</p>
      ) : null}
      {ticket.how ? <p className="np-ticket-how">{ticket.how}</p> : null}
      {(ticket.notes ?? []).map((note) => (
        <p key={note} className="np-ticket-note">
          {note}
        </p>
      ))}
      {qr ? (
        <svg className="np-ticket-qr" viewBox={`0 0 ${side} ${side}`} shapeRendering="crispEdges" role="img" aria-label="QR">
          <rect width={side} height={side} fill="#fff" />
          <path d={qrSvgPath(qr, QR_QUIET_ZONE)} fill="#000" />
        </svg>
      ) : null}
      {ticket.qrNote ? <p className="np-ticket-note">{ticket.qrNote}</p> : null}
      {ticket.rows.length > 0 ? (
        <>
          <hr className="np-ticket-rule" />
          <dl className="np-ticket-rows">
            {ticket.rows.map((row) => (
              <div key={row.label} className="np-ticket-row">
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        </>
      ) : null}
      <hr className="np-ticket-rule" />
      <div className="np-ticket-foot">
        {ticket.footer.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
    </div>
  );
}

/** El botón «Imprimir» (pequeño, con la impresora): debajo de los botones grandes. */
export function PrintButton({ label = 'Imprimir', onClick, className }: { label?: string; onClick: () => void; className?: string }) {
  return (
    <button type="button" className={['np-print-btn', className].filter(Boolean).join(' ')} onClick={onClick}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M7 9V3h10v6M7 17H4v-6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v6h-3M7 14h10v7H7z" />
      </svg>
      {label}
    </button>
  );
}
