import { describe, expect, it } from 'vitest';
import {
  commissionText,
  absoluteApiUrl,
  formatSignedEur,
  holdDaysText,
  lastAccessText,
  movementStatusLabel,
  pauseLine,
  personName,
  venuePauseLabel,
  walletStatus,
} from './labels';

describe('pausas', () => {
  it('«En pausa desde … por …» en la hora del local', () => {
    expect(pauseLine('2026-10-16T19:30:00.000Z', 'Impago', 'Europe/Madrid')).toBe(
      'En pausa desde 16/10/2026, 21:30 por «Impago»',
    );
  });

  it('sin motivo o sin fecha', () => {
    expect(pauseLine('2026-10-16T19:30:00.000Z', null, 'Europe/Madrid')).toBe('En pausa desde 16/10/2026, 21:30');
    expect(pauseLine(null, '  ', 'Europe/Madrid')).toBe('En pausa');
  });

  it('la pausa del local o la de su negocio', () => {
    expect(venuePauseLabel({ paused: false, pausedBy: null })).toBeNull();
    expect(venuePauseLabel({ paused: true, pausedBy: 'venue' })).toBe('En pausa');
    expect(venuePauseLabel({ paused: true, pausedBy: 'business' })).toBe('En pausa (negocio)');
  });
});

describe('textos', () => {
  it('días de espera: 0 = al cerrar la noche', () => {
    expect(holdDaysText(0)).toBe('Se les paga al cerrar la noche');
    expect(holdDaysText(1)).toBe('1 día');
    expect(holdDaysText(7)).toBe('7 días');
  });

  it('importes con signo de verdad', () => {
    expect(formatSignedEur(2000)).toMatch(/^\+20,00\s€$/);
    expect(formatSignedEur(-500)).toMatch(/^−5,00\s€$/);
    expect(formatSignedEur(0)).toMatch(/^0,00\s€$/);
  });

  it('estado del saldo y nombre', () => {
    expect(walletStatus('ACTIVE')).toEqual({ label: 'Activo', tone: 'success' });
    expect(walletStatus('RARO')).toEqual({ label: 'RARO', tone: 'neutral' });
    expect(personName({ displayName: ' ', email: 'a@b.es' })).toBe('a@b.es');
    expect(personName({ displayName: 'Ana', email: 'a@b.es' })).toBe('Ana');
  });

  it('último acceso', () => {
    expect(lastAccessText(null)).toBe('Nunca');
    expect(lastAccessText('2026-10-16T19:30:00.000Z', 'Europe/Madrid')).toBe('16/10/2026, 21:30');
  });

  it('enlace completo del saldo', () => {
    expect(absoluteApiUrl('https://api.oxiopay.com/', '/w/abc')).toBe('https://api.oxiopay.com/w/abc');
    expect(absoluteApiUrl('http://localhost:4100', 'w/abc')).toBe('http://localhost:4100/w/abc');
  });
});

describe('movementStatusLabel', () => {
  it('estados de la recarga, el consumo y la devolución en llano', () => {
    expect(movementStatusLabel('AUTHORIZED')).toBe('Cobrada');
    expect(movementStatusLabel('REVERSED')).toBe('Devuelto');
    expect(movementStatusLabel('DONE')).toBe('Hecha');
    expect(movementStatusLabel('NUEVO')).toBe('NUEVO');
  });
});

describe('commissionText', () => {
  it('null es la general; si no, el porcentaje (también 0 %)', () => {
    expect(commissionText(null)).toBe('la general');
    expect(commissionText(800)).toMatch(/^8\s%$/);
    expect(commissionText(0)).toMatch(/^0\s%$/);
  });
});
