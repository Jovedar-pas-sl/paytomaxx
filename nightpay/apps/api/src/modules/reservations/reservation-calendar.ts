import { nightEnd, nightStart } from './reservation-rules';

/**
 * «Añadir a mi calendario» de la página del reservado: un .ics (RFC 5545) con
 * un evento la noche del reservado, desde la hora de apertura del local hasta
 * que acaba la noche (la reserva se guarda toda la noche). Solo lo que ya pone
 * la página: el local, el paquete, las personas, la referencia y su enlace;
 * nada del cliente (ni nombre ni teléfono).
 */

/**
 * Al calendario o a WhatsApp, solo pagado (la señal o todo) y por llegar: sin
 * pagar solo ocupa sitio un rato (PENDING_HOLD_MS) y en la puerta no entra.
 */
export function canSaveReservation(status: string): boolean {
  return status === 'DEPOSIT_PAID' || status === 'PAID';
}

export interface CalendarReservation {
  venueName: string;
  ref: string;
  nightDate: string;
  packageName: string;
  entries: number;
  openMinute: number;
}

/** Fecha y hora en UTC: 20261121T220000Z. */
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** Texto de una propiedad: barras, comas, puntos y comas y saltos, escapados. */
const text = (s: string) => s.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\r?\n/g, '\\n');

/** Líneas de 75 bytes como mucho: lo que sobra sigue en la siguiente, con un espacio delante (sin partir letras). */
function fold(line: string): string {
  const out: string[] = [];
  let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch, 'utf8') > (out.length === 0 ? 75 : 74)) {
      out.push(cur);
      cur = '';
    }
    cur += ch;
  }
  out.push(cur);
  return out.join('\r\n ');
}

export function reservationIcs(r: CalendarReservation, pageUrl: string, now: Date = new Date()): string {
  const people = `${r.entries} ${r.entries === 1 ? 'persona' : 'personas'}`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//OxioPay//Reservados//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${r.ref}-${r.nightDate}@oxiopay`,
    `DTSTAMP:${stamp(now)}`,
    `DTSTART:${stamp(nightStart(r.nightDate, r.openMinute))}`,
    `DTEND:${stamp(nightEnd(r.nightDate))}`,
    `SUMMARY:${text(`Reservado en ${r.venueName}`)}`,
    `LOCATION:${text(r.venueName)}`,
    `DESCRIPTION:${text(`${r.packageName} · ${people} · Referencia ${r.ref}\n${pageUrl}`)}`,
    `URL:${pageUrl}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
