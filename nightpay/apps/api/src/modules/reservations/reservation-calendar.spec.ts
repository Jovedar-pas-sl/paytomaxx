import { describe, expect, it } from 'vitest';
import { canSaveReservation, reservationIcs } from './reservation-calendar';

const base = {
  venueName: 'Sala Aurora',
  ref: 'K7Q4M2',
  nightDate: '2026-11-21',
  packageName: 'Mesa consumo',
  entries: 4,
  openMinute: 23 * 60,
};
const URL = 'https://api.prueba.es/reservas/TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT';
const NOW = new Date('2026-11-17T12:00:00Z');
/** Las líneas, ya desplegadas (una línea larga sigue en la siguiente con un espacio delante). */
const unfold = (ics: string) => ics.replace(/\r\n /g, '').split('\r\n');

describe('«Añadir a mi calendario»: el .ics del reservado', () => {
  it('un evento la noche del reservado a la hora de apertura del local (hora de Madrid, en UTC)', () => {
    const lines = unfold(reservationIcs(base, URL, NOW));
    expect(lines[0]).toBe('BEGIN:VCALENDAR');
    expect(lines).toContain('VERSION:2.0');
    expect(lines).toContain('BEGIN:VEVENT');
    // 23:00 de Madrid en noviembre (UTC+1) = 22:00 UTC; acaba con la noche (08:00 del día siguiente).
    expect(lines).toContain('DTSTART:20261121T220000Z');
    expect(lines).toContain('DTEND:20261122T070000Z');
    expect(lines).toContain('DTSTAMP:20261117T120000Z');
    expect(lines).toContain('SUMMARY:Reservado en Sala Aurora');
    expect(lines).toContain(`URL:${URL}`);
    expect(lines).toContain('UID:K7Q4M2-2026-11-21@oxiopay');
    expect(lines.at(-2)).toBe('END:VCALENDAR');
    expect(lines.at(-1)).toBe('');
  });

  it('abre de madrugada (01:30): es ya el día siguiente', () => {
    expect(unfold(reservationIcs({ ...base, openMinute: 90 }, URL, NOW))).toContain('DTSTART:20261122T003000Z');
  });

  it('lo que pone la página (paquete, personas, referencia y el enlace), y nada del cliente', () => {
    const ics = reservationIcs(base, URL, NOW);
    const desc = unfold(ics).find((l) => l.startsWith('DESCRIPTION:'));
    expect(desc).toBe(`DESCRIPTION:Mesa consumo · 4 personas · Referencia K7Q4M2\\n${URL}`);
    expect(ics).not.toMatch(/Laura|600112233|ATTENDEE|ORGANIZER/);
  });

  it('comas, puntos y comas y barras del nombre van escapados; líneas de 75 bytes como mucho, con CRLF', () => {
    const ics = reservationIcs({ ...base, venueName: 'Sala Aurora, Club; VIP \\ Ñandú Ático Señorial Muy Largo De Verdad' }, URL, NOW);
    expect(unfold(ics)).toContain('SUMMARY:Reservado en Sala Aurora\\, Club\\; VIP \\\\ Ñandú Ático Señorial Muy Largo De Verdad');
    for (const line of ics.split('\r\n')) expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    expect(ics.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('se guarda mientras el reservado está por llegar; ya en el local, anulado o «No vino», no', () => {
    for (const s of ['PENDING', 'DEPOSIT_PAID', 'PAID']) expect(canSaveReservation(s)).toBe(true);
    for (const s of ['ARRIVED', 'CANCELED', 'CLIENT_CANCELED', 'NO_SHOW']) expect(canSaveReservation(s)).toBe(false);
  });
});
