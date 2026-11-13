import { describe, expect, it } from 'vitest';
import { formatMoney, type PartyRefundRow, type PartyRefundTotals, type PulseraRow } from '@nightpay/contracts';
import {
  PULSERA_COUNT_LABEL,
  blockConfirmText,
  parseBatchCount,
  pulseraActions,
  pulseraFilters,
  pulseraNumberInput,
  pulseraStatusLabel,
  refundActions,
  refundCancelConfirm,
  refundDoneConfirm,
  refundTiles,
  replaceDoneText,
  sectionError,
  sheetFileName,
  sheetRangeProblem,
  transfersFileName,
} from './party-asistente';

/** El importe como lo escribe el panel (con su espacio fino antes del €). */
const E = (cents: number): string => formatMoney(cents);

const pulsera = (o: Partial<PulseraRow> = {}): PulseraRow => ({
  id: 'p-1',
  number: 412,
  label: 'P-0412',
  status: 'ISSUED',
  walletCode: 'K7Q-4M2',
  balanceCents: 1300,
  hasUid: true,
  stockedAt: '2027-06-20T10:00:00.000Z',
  linkedAt: '2027-06-23T20:00:00.000Z',
  lastUsedAt: null,
  blockedAt: null,
  lostAt: null,
  ...o,
});

const refund = (o: Partial<PartyRefundRow> = {}): PartyRefundRow => ({
  id: 'r-1',
  method: 'CARD',
  status: 'PENDING',
  amountCents: 1300,
  createdAt: '2027-06-25T09:00:00.000Z',
  doneAt: null,
  doneByName: null,
  pulsera: 'P-0412',
  walletCode: 'K7Q-4M2',
  ibanHint: null,
  email: null,
  ...o,
});

describe('pulseras en el panel', () => {
  it('cuántas preparar: de 1 a 500', () => {
    expect(parseBatchCount('100')).toBe(100);
    expect(parseBatchCount(' 500 ')).toBe(500);
    expect(parseBatchCount('0')).toBeNull();
    expect(parseBatchCount('501')).toBeNull();
    expect(parseBatchCount('10a')).toBeNull();
    expect(parseBatchCount('')).toBeNull();
  });

  it('el número de una pulsera como se teclee', () => {
    expect(pulseraNumberInput('P-0412')).toBe(412);
    expect(pulseraNumberInput('p0412')).toBe(412);
    expect(pulseraNumberInput('412')).toBe(412);
    expect(pulseraNumberInput('P-')).toBeNull();
    expect(pulseraNumberInput('K7Q-4M2')).toBeNull();
  });

  it('la hoja: de menor a mayor y como mucho 500', () => {
    expect(sheetRangeProblem(1, 100)).toBeNull();
    expect(sheetRangeProblem(100, 1)).toMatch(/menor/);
    expect(sheetRangeProblem(1, 501)).toMatch(/500/);
    expect(sheetRangeProblem(null, 3)).toMatch(/de qué número/);
    expect(sheetFileName(1, 100)).toBe('pulseras-P-0001-P-0100.html');
  });

  it('el recuento en plural y cada fila en singular', () => {
    expect(PULSERA_COUNT_LABEL.ISSUED).toBe('Entregadas');
    expect(pulseraStatusLabel('ISSUED')).toBe('Entregada');
    const filters = pulseraFilters({ STOCK: 3, ISSUED: 2, RETURNED: 0, LOST: 1, BLOCKED: 0, total: 6 });
    expect(filters[0]).toEqual({ value: '', label: 'Todas (6)' });
    expect(filters.find((f) => f.value === 'LOST')?.label).toBe('Perdidas (1)');
    expect(pulseraFilters(null)[1]).toEqual({ value: 'STOCK', label: 'En stock' });
  });

  it('bloquear una entregada; pasar el saldo a otra si es de un saldo (también ya bloqueada o perdida)', () => {
    expect(pulseraActions(pulsera())).toEqual({ block: true, replace: true });
    expect(pulseraActions(pulsera({ status: 'BLOCKED' }))).toEqual({ block: false, replace: true });
    expect(pulseraActions(pulsera({ status: 'LOST' }))).toEqual({ block: false, replace: true });
    expect(pulseraActions(pulsera({ status: 'STOCK', walletCode: null, balanceCents: null }))).toEqual({ block: false, replace: false });
    expect(pulseraActions(pulsera({ status: 'LOST', walletCode: null }))).toEqual({ block: false, replace: false });
  });

  it('lo que se dice al bloquear y al pasar el saldo', () => {
    expect(blockConfirmText(pulsera())).toContain('P-0412');
    expect(blockConfirmText(pulsera())).toContain('El saldo no se pierde');
    expect(replaceDoneText('P-0412', 'P-0413', 1300)).toBe(`P-0412 bloqueada. Su saldo (${E(1300)}) ya está en P-0413.`);
  });
});

describe('devoluciones en el panel', () => {
  it('«Hecha» solo en las de tarjeta y transferencia pendientes; «Anular», en las pendientes', () => {
    expect(refundActions(refund())).toEqual({ done: true, cancel: true });
    expect(refundActions(refund({ method: 'TRANSFER' }))).toEqual({ done: true, cancel: true });
    expect(refundActions(refund({ method: 'DONATE', status: 'DONE' }))).toEqual({ done: false, cancel: false });
    expect(refundActions(refund({ status: 'DONE' }))).toEqual({ done: false, cancel: false });
    expect(refundActions(refund({ status: 'CANCELED' }))).toEqual({ done: false, cancel: false });
  });

  it('lo que se pregunta antes: a la tarjeta, en el portal del banco; la transferencia, ya enviada', () => {
    expect(refundDoneConfirm(refund())).toContain(`${E(1300)} a la tarjeta de P-0412 en el portal del banco`);
    expect(refundDoneConfirm(refund({ method: 'TRANSFER', ibanHint: 'ES91 •••• •••• 1332' }))).toContain(`transferencia de ${E(1300)} a ES91 •••• •••• 1332`);
    expect(refundCancelConfirm(refund())).toContain('su saldo vuelve a poder gastarse');
  });

  it('las cifras de arriba, con el total donado', () => {
    const zero = { count: 0, cents: 0 };
    const totals: PartyRefundTotals = {
      pending: { CARD: { count: 2, cents: 2100 }, TRANSFER: { count: 1, cents: 500 }, DONATE: zero },
      done: { CARD: { count: 1, cents: 800 }, TRANSFER: { count: 1, cents: 300 }, DONATE: { count: 3, cents: 1700 } },
      canceled: zero,
      donatedCents: 1700,
    };
    const tiles = refundTiles(totals);
    expect(tiles.map((t) => [t.label, t.value])).toEqual([
      ['Pendiente a la tarjeta', E(2100)],
      ['Pendiente por transferencia', E(500)],
      ['Ya devuelto', E(1100)],
      ['Donado a la comisión', E(1700)],
    ]);
    expect(tiles[0]?.strong).toBe(true);
    expect(tiles[3]?.hint).toBe('3 asistentes');
  });
});

describe('las transferencias para el banco', () => {
  it('el CSV y el fichero SEPA (XML), con el día', () => {
    expect(transfersFileName('2027-06-30')).toBe('transferencias-pendientes-2027-06-30.csv');
    expect(transfersFileName('2027-06-30', 'csv')).toBe('transferencias-pendientes-2027-06-30.csv');
    expect(transfersFileName('2027-06-30', 'sepa')).toBe('transferencias-pendientes-2027-06-30.xml');
  });
});

describe('si no se puede cargar', () => {
  it('403: solo el dueño y el encargado; 404: el panel no es de una fiesta; el resto, su mensaje', () => {
    expect(sectionError({ status: 403, message: 'Forbidden' }, 'pulseras')).toBe('Las pulseras las ven el dueño y el encargado.');
    expect(sectionError({ status: 404 }, 'devoluciones')).toMatch(/no es el de una fiesta/);
    expect(sectionError(new Error('Sin conexión'), 'pulseras')).toBe('Sin conexión');
  });
});
