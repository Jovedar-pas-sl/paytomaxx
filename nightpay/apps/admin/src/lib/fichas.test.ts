import { describe, expect, it } from 'vitest';
import type { FichasNight, WalletCardRow } from '@nightpay/contracts';
import {
  FICHA_STATUS_FILTERS,
  FICHA_STATUS_TONE,
  fichaActions,
  fichaConfirmText,
  fichaQuery,
  fichaSince,
  fichaStatusLabel,
  formatUid,
  nightLosesFichas,
  nightStockText,
} from './fichas';

const row = (o: Partial<WalletCardRow> = {}): WalletCardRow => ({
  id: 'c-1',
  uid: '04A23B5C1D80',
  tokenHint: 'q3VbX9',
  status: 'ISSUED',
  walletCode: 'K7Q-4M2',
  stockedAt: '2026-10-20T20:00:00.000Z',
  linkedAt: '2026-10-20T23:00:00.000Z',
  returnedAt: null,
  lostAt: null,
  blockedAt: null,
  lastUsedAt: null,
  ...o,
});

describe('una ficha en la lista', () => {
  it('estado en palabras y con su color (nunca solo el color)', () => {
    expect(fichaStatusLabel('STOCK')).toBe('En stock');
    expect(fichaStatusLabel('ISSUED')).toBe('Entregada');
    expect(fichaStatusLabel('RETURNED')).toBe('Devuelta');
    expect(fichaStatusLabel('LOST')).toBe('Perdida');
    expect(fichaStatusLabel('BLOCKED')).toBe('Bloqueada');
    expect(FICHA_STATUS_TONE.LOST).toBe('warning');
    expect(FICHA_STATUS_TONE.BLOCKED).toBe('danger');
    expect(FICHA_STATUS_FILTERS.map((f) => f.value)).toEqual(['', 'STOCK', 'ISSUED', 'RETURNED', 'LOST', 'BLOCKED']);
  });

  it('número de serie de dos en dos; sin él, una raya', () => {
    expect(formatUid('04A23B5C1D80')).toBe('04:A2:3B:5C:1D:80');
    expect(formatUid('04A')).toBe('04:A');
    expect(formatUid(null)).toBe('—');
  });

  it('la búsqueda va sin espacios de más y recortada', () => {
    expect(fichaQuery('  k7q-4m2 ')).toBe('k7q-4m2');
    expect(fichaQuery('x'.repeat(80))).toHaveLength(64);
  });

  it('«Desde»: lo último que le pasó, según su estado', () => {
    expect(fichaSince(row())).toBe('2026-10-20T23:00:00.000Z');
    expect(fichaSince(row({ status: 'STOCK' }))).toBe('2026-10-20T20:00:00.000Z');
    expect(fichaSince(row({ status: 'RETURNED', returnedAt: 'r' }))).toBe('r');
    expect(fichaSince(row({ status: 'LOST', lostAt: 'l' }))).toBe('l');
    expect(fichaSince(row({ status: 'BLOCKED', blockedAt: 'b' }))).toBe('b');
  });

  it('botones: bloquear y marcar perdida mientras se pueda; ya perdida o bloqueada, nada', () => {
    expect(fichaActions(row())).toEqual({ block: true, lost: true });
    expect(fichaActions(row({ status: 'STOCK' }))).toEqual({ block: true, lost: true });
    expect(fichaActions(row({ status: 'LOST' }))).toEqual({ block: false, lost: false });
    expect(fichaActions(row({ status: 'BLOCKED' }))).toEqual({ block: false, lost: false });
  });

  it('la pregunta dice qué ficha, de qué saldo y que el saldo sigue', () => {
    expect(fichaConfirmText(row(), 'lost')).toBe(
      '¿Marcar la ficha 04:A2:3B:5C:1D:80 (del saldo K7Q-4M2) como perdida? Ya no servirá para pagar y sale del stock. El saldo sigue (código + PIN).',
    );
    expect(fichaConfirmText(row({ uid: null, walletCode: null, status: 'STOCK' }), 'block')).toBe(
      '¿Bloquear la ficha q3VbX9…? Ya no servirá para pagar. El saldo sigue (código + PIN).',
    );
  });
});

describe('una noche', () => {
  const night: FichasNight = {
    nightId: 'n', from: '2026-10-20T20:00:00.000Z', to: null, open: true, entregadas: 12, devueltas: 9, perdidas: 1, enStock: 40,
  };

  it('el stock, si se sabe (las noches de antes de las fichas no lo tienen)', () => {
    expect(nightStockText(night)).toBe('40');
    expect(nightStockText({ ...night, enStock: null })).toBe('—');
  });

  it('avisa si se perdió alguna', () => {
    expect(nightLosesFichas(night)).toBe(true);
    expect(nightLosesFichas({ ...night, perdidas: 0 })).toBe(false);
  });
});
