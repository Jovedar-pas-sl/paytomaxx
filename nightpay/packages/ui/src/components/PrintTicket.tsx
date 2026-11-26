'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { readPrintMode } from '../lib/print-mode';
import { canvasToEscPos, rawbtIntentUrl, renderTicketCanvas } from '../lib/ticket-raster';
import type { Ticket } from '../lib/ticket';
import { Icon } from './Icon';

/**
 * Imprimir un ticket (térmica de 58 mm). El ticket se dibuja punto a punto
 * (ticket-raster.ts) y sale:
 * - **Directo (RawBT)**: los bytes de la impresora a la app RawBT, sin
 *   diálogo, del largo justo. Es lo del datáfono (Menú → Este aparato).
 * - **Con Android**: la misma imagen, sola en la página, y el diálogo de
 *   imprimir del sistema (cualquier móvil, tablet u ordenador).
 */

/** En <html> mientras se imprime con el diálogo: solo entonces se esconde la app. */
export const PRINTING_CLASS = 'np-printing';
const PAGE_STYLE_ID = 'np-ticket-page';
/** Sin márgenes ni tamaño propio: el ticket empieza arriba del todo en el papel que diga la impresora. */
export const TICKET_PAGE_CSS = '@media print { @page { margin: 0; } }';

function startPrint(): void {
  endPrint();
  const style = document.createElement('style');
  style.id = PAGE_STYLE_ID;
  style.textContent = TICKET_PAGE_CSS;
  document.head.appendChild(style);
  document.documentElement.classList.add(PRINTING_CLASS);
  window.addEventListener('afterprint', endPrint, { once: true });
}

function endPrint(): void {
  document.getElementById(PAGE_STYLE_ID)?.remove();
  document.documentElement.classList.remove(PRINTING_CLASS);
}

/** Abrir el enlace de RawBT (aparte, para poder comprobarlo en las pruebas). */
export const printTarget = {
  open(url: string): void {
    window.location.href = url;
  },
};

export interface PrintTicketApi {
  /** Imprime el ticket (desde el toque del botón: el navegador solo deja imprimir tras un gesto). */
  print: (ticket: Ticket) => void;
  /** El ticket para el diálogo, fuera de la pantalla: va en el árbol de quien imprime. */
  ticketNode: ReactNode;
  /** Algo no salió (este navegador no dibuja, o no se pudo abrir RawBT). */
  error: string | null;
}

/** Para un botón «Imprimir»: `print(ticket)` en su onClick y `ticketNode` en la pantalla. */
export function usePrintTicket(): PrintTicketApi {
  const [image, setImage] = useState<string | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    setHost(document.body);
    return () => endPrint();
  }, []);

  const print = useCallback((ticket: Ticket) => {
    setError(null);
    let canvas: HTMLCanvasElement;
    try {
      canvas = renderTicketCanvas(ticket);
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    if (readPrintMode() === 'rawbt') {
      // RawBT recibe los bytes y los imprime; si no está instalada, Android abre su ficha en Play Store.
      printTarget.open(rawbtIntentUrl(canvasToEscPos(canvas)));
      return;
    }
    flushSync(() => setImage(canvas.toDataURL('image/png')));
    const img = imgRef.current;
    const go = () => {
      startPrint();
      window.print();
    };
    // La imagen, ya decodificada: si no, el diálogo podría salir con el papel en blanco.
    if (img && typeof img.decode === 'function') img.decode().then(go, go);
    else go();
  }, []);

  const ticketNode = host
    ? createPortal(
        <div className="np-ticket-root" aria-hidden="true">
          {image ? <img ref={imgRef} src={image} alt="" /> : null}
        </div>,
        host,
      )
    : null;
  return { print, ticketNode, error };
}

/** El botón «Imprimir» (pequeño, con la impresora): debajo de los botones grandes. */
export function PrintButton({ label = 'Imprimir', onClick, className }: { label?: string; onClick: () => void; className?: string }) {
  return (
    <button type="button" className={['np-print-btn', className].filter(Boolean).join(' ')} onClick={onClick}>
      <Icon name="printer" />
      {label}
    </button>
  );
}
