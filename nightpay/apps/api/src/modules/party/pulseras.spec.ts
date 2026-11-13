import { describe, it, expect } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { PreparePulserasSchema, ReplacePulseraSchema, parsePulseraNumber, pulseraLabel } from '@nightpay/contracts';
import { pulseraCounts, pulseraRow, sheetRange } from './pulseras.service';
import { renderPulseraSheet } from './pulsera-print-page';

const card = (o: Record<string, unknown> = {}) =>
  ({
    id: 'c-1',
    number: 412,
    status: 'ISSUED',
    walletId: 'w-1',
    venueId: 'v-1',
    uid: '04A23B5C1D80',
    token: 'secreto-que-no-sale-nunca',
    stockedAt: new Date('2027-06-20T10:00:00Z'),
    linkedAt: new Date('2027-06-23T20:00:00Z'),
    lastUsedAt: null,
    blockedAt: null,
    lostAt: null,
    wallet: { shortCode: 'K7Q4M2', balanceCents: 1300, status: 'ACTIVE' },
    ...o,
  }) as Parameters<typeof pulseraRow>[0];

describe('pulseras: el número', () => {
  it('«P-0412» con cuatro cifras como mínimo', () => {
    expect(pulseraLabel(412)).toBe('P-0412');
    expect(pulseraLabel(7)).toBe('P-0007');
    expect(pulseraLabel(12345)).toBe('P-12345');
  });

  it('se teclea como se quiera; lo demás no es un número de pulsera', () => {
    for (const v of ['P-0412', 'p-412', 'P0412', 'p 412', '0412', '412', ' 412 ']) expect(parsePulseraNumber(v)).toBe(412);
    for (const v of ['', 'P-', 'K7Q-4M2', '0', '-3', '4.12', null, undefined]) expect(parsePulseraNumber(v)).toBeNull();
  });

  it('el lote: de 1 a 500; la nueva, un número', () => {
    expect(PreparePulserasSchema.safeParse({ count: 500 }).success).toBe(true);
    expect(PreparePulserasSchema.safeParse({ count: 501 }).success).toBe(false);
    expect(PreparePulserasSchema.safeParse({ count: 0 }).success).toBe(false);
    expect(PreparePulserasSchema.safeParse({ count: 10, venueId: 'otro' }).success).toBe(false);
    expect(ReplacePulseraSchema.safeParse({ nueva: 'P-0413' }).success).toBe(true);
    expect(ReplacePulseraSchema.safeParse({ nueva: 'la de al lado' }).success).toBe(false);
  });
});

describe('pulseras en el panel', () => {
  it('una entregada: su saldo y su código, nunca el código grabado', () => {
    const row = pulseraRow(card());
    expect(row).toMatchObject({ label: 'P-0412', status: 'ISSUED', walletCode: 'K7Q-4M2', balanceCents: 1300, hasUid: true });
    expect(JSON.stringify(row)).not.toContain('secreto');
  });

  it('en el stock (o devuelta), sin saldo; una del API anterior (ACTIVE) según tenga saldo', () => {
    expect(pulseraRow(card({ status: 'STOCK', walletId: null, wallet: null }))).toMatchObject({ status: 'STOCK', walletCode: null, balanceCents: null });
    expect(pulseraRow(card({ status: 'RETURNED' }))).toMatchObject({ status: 'RETURNED', walletCode: null, balanceCents: null });
    expect(pulseraRow(card({ status: 'ACTIVE' })).status).toBe('ISSUED');
    expect(pulseraRow(card({ status: 'ACTIVE', walletId: null, wallet: null })).status).toBe('STOCK');
  });

  it('perdida o bloqueada sigue diciendo de qué saldo es (para pasarlo a otra); con el saldo cerrado, sin importe', () => {
    expect(pulseraRow(card({ status: 'BLOCKED' }))).toMatchObject({ walletCode: 'K7Q-4M2', balanceCents: 1300 });
    expect(pulseraRow(card({ status: 'LOST', wallet: { shortCode: 'K7Q4M2', balanceCents: 0, status: 'REFUNDED' } }))).toMatchObject({
      walletCode: 'K7Q-4M2',
      balanceCents: null,
    });
  });

  it('el recuento por estado y el total', () => {
    expect(pulseraCounts([{ status: 'STOCK', n: 90 }, { status: 'ISSUED', n: 8 }, { status: 'BLOCKED', n: 2 }])).toEqual({
      STOCK: 90,
      ISSUED: 8,
      RETURNED: 0,
      LOST: 0,
      BLOCKED: 2,
      total: 100,
    });
  });

  it('la hoja: de un número a otro, de menor a mayor y como mucho 500', () => {
    expect(sheetRange('P-0001', 'P-0100')).toEqual({ from: 1, to: 100 });
    expect(sheetRange('7', undefined)).toEqual({ from: 7, to: 7 });
    expect(() => sheetRange('100', '1')).toThrow(BadRequestException);
    expect(() => sheetRange('1', '501')).toThrow(/500/);
    expect(() => sheetRange(undefined, '3')).toThrow(BadRequestException);
  });
});

describe('la hoja para imprimir', () => {
  it('cada pulsera con su número y su QR; la fiesta escapada', () => {
    const html = renderPulseraSheet({
      brand: 'OxioParty',
      venueName: 'Peña <El Cántaro>',
      pulseras: [
        { label: 'P-0001', qrSvg: '<svg id="q1"></svg>' },
        { label: 'P-0002', qrSvg: '<svg id="q2"></svg>' },
      ],
    });
    expect(html).toContain('<title>Pulseras P-0001 a P-0002 · 2 pulseras</title>');
    expect(html).toContain('<span class="n">P-0001</span><div class="q" role="img" aria-label="QR de P-0001"><svg id="q1"></svg></div>');
    expect(html).toContain('Peña &lt;El Cántaro&gt;');
    expect(html).toContain('@page{size:A4;margin:10mm}');
    expect(html).not.toContain('<script');
  });
});
