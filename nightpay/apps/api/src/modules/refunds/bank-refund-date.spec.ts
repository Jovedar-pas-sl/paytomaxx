import { describe, it, expect } from 'vitest';
import { adjustedReason, bankRefundDate } from './bank-refund-date';

// Hoy: 19-oct-2026 en Madrid. El trimestre abierto (Q4) empieza el 1-oct a las 00:00 de Madrid (22:00 UTC del 30-sep).
const NOW = new Date('2026-10-19T12:00:00Z');
const paidOn = (iso: string) => new Date(iso);

describe('día con el que cuenta una devolución apuntada del banco', () => {
  it('hoy, o un día del trimestre abierto posterior al cobro: el que dice el dueño', () => {
    expect(bankRefundDate(NOW, paidOn('2026-10-18T22:00:00Z'), NOW)).toEqual({ at: NOW, adjusted: null });
    const oct5 = new Date('2026-10-05T12:00:00Z');
    expect(bankRefundDate(oct5, paidOn('2026-10-03T21:00:00Z'), NOW)).toEqual({ at: oct5, adjusted: null });
  });

  it('de un trimestre ya cerrado (303 quizá presentado): ajuste con fecha de hoy', () => {
    const sep28 = new Date('2026-09-28T12:00:00Z');
    expect(bankRefundDate(sep28, paidOn('2026-09-20T21:00:00Z'), NOW)).toEqual({ at: NOW, adjusted: 'closed_period' });
  });

  it('el borde del trimestre va por la hora de Madrid', () => {
    const firstMinute = new Date('2026-09-30T22:00:00Z'); // 1-oct 00:00 en Madrid
    expect(bankRefundDate(firstMinute, paidOn('2026-09-29T20:00:00Z'), NOW)).toEqual({ at: firstMinute, adjusted: null });
    const lastMinute = new Date('2026-09-30T21:59:00Z'); // 30-sep 23:59 en Madrid
    expect(bankRefundDate(lastMinute, paidOn('2026-09-29T20:00:00Z'), NOW).adjusted).toBe('closed_period');
  });

  it('un día anterior al del cobro → hoy (error de fecha)', () => {
    const oct2 = new Date('2026-10-02T12:00:00Z');
    expect(bankRefundDate(oct2, paidOn('2026-10-04T20:00:00Z'), NOW)).toEqual({ at: NOW, adjusted: 'before_payment' });
  });

  it('el mismo día del cobro pero antes de su hora → la hora del cobro (no se resta antes de cobrarlo)', () => {
    const paid = paidOn('2026-10-11T21:30:00Z'); // 23:30 en Madrid
    expect(bankRefundDate(new Date('2026-10-11T12:00:00Z'), paid, NOW)).toEqual({ at: paid, adjusted: null });
  });

  it('el motivo lleva el día real del banco y por qué', () => {
    expect(adjustedReason('Cargo duplicado', new Date('2026-09-28T12:00:00Z'), 'closed_period')).toBe(
      'Cargo duplicado · en el banco el 28/09/2026; apuntada con fecha de hoy porque su trimestre ya está cerrado',
    );
    expect(adjustedReason('x', new Date('2026-10-02T12:00:00Z'), 'before_payment')).toMatch(/02\/10\/2026.*anterior al cobro/);
  });
});
