import { describe, expect, it } from 'vitest';
import { organizerShareCents, settlementStatusOf } from '@nightpay/contracts';
import type { StallTotals } from './party-live-rules';
import { partySettlementCsv, partySettlementFileName, percent } from './party-settlement-csv';
import { buildPartySettlement, settlementRowOf, settlementRowsOf, type SettlementStall } from './party-settlement-rules';

/** Las cuentas de la liquidación por caseta: redondeos, «barra propia», sin IBAN, sin caseta y el CSV. */

const IBAN = 'ES9121000418450200051332';
const NOW = new Date('2027-06-25T06:30:00Z');

function stall(extra: Partial<SettlementStall> = {}): SettlementStall {
  return { id: 's-1', name: 'Peña El Cántaro', managerName: 'Ana R.', organizerBps: 1000, iban: IBAN, active: true, sortOrder: 0, ...extra };
}

function totals(entries: Array<[string | null, number, number]>): Map<string | null, StallTotals> {
  return new Map(
    entries.map(([stallId, cents, count]) => [stallId, { stallId, cents, count, lastAt: null, refundedCents: 0, lastHourCents: 0 }]),
  );
}

describe('la parte del organizador: round(vendido · bps / 10000)', () => {
  it('redondea al céntimo más cercano (medio céntimo, hacia arriba)', () => {
    expect(organizerShareCents(792_000, 1000)).toBe(79_200);
    expect(organizerShareCents(333, 2500)).toBe(83); // 83,25
    expect(organizerShareCents(2, 2500)).toBe(1); // 0,5 → 1
    expect(organizerShareCents(1, 2500)).toBe(0); // 0,25 → 0
    expect(organizerShareCents(999, 1250)).toBe(125); // 124,875
    expect(organizerShareCents(10_001, 3333)).toBe(3333); // 3333,33
  });

  it('0 %, 100 % («barra propia») y lo negativo (más devuelto que vendido) simétrico, sin −0', () => {
    expect(organizerShareCents(5_000, 0)).toBe(0);
    expect(organizerShareCents(5_000, 10_000)).toBe(5_000);
    expect(organizerShareCents(-333, 2500)).toBe(-83);
    expect(Object.is(organizerShareCents(-1, 2500), -0)).toBe(false);
    expect(organizerShareCents(0, 2500)).toBe(0);
  });
});

describe('cada fila', () => {
  it('a pagar = vendido − parte; con IBAN, lista para el banco', () => {
    expect(settlementRowOf(stall(), 792_000, 1102)).toMatchObject({
      soldCents: 792_000,
      organizerCents: 79_200,
      toPayCents: 712_800,
      hasIban: true,
      ibanMasked: 'ES91 •••• •••• 1332',
      status: 'READY',
      ownBar: false,
    });
  });

  it('el redondeo nunca pierde un céntimo: parte + a pagar = vendido', () => {
    for (const [sold, bps] of [
      [333, 2500],
      [1, 5000],
      [999_999, 1234],
      [12_345, 10_000],
    ] as const) {
      const r = settlementRowOf(stall({ organizerBps: bps }), sold, 1);
      expect(r.organizerCents + r.toPayCents).toBe(sold);
    }
  });

  it('«barra propia»: todo para el organizador, no se paga aunque tenga IBAN', () => {
    expect(settlementRowOf(stall({ organizerBps: 10_000 }), 326_000, 512)).toMatchObject({
      organizerCents: 326_000,
      toPayCents: 0,
      ownBar: true,
      status: 'OWN_BAR',
    });
  });

  it('sin IBAN: se cuenta, pero no va al banco', () => {
    expect(settlementRowOf(stall({ iban: null, organizerBps: 800 }), 184_000, 233)).toMatchObject({
      organizerCents: 14_720,
      toPayCents: 169_280,
      hasIban: false,
      ibanMasked: null,
      status: 'NO_IBAN',
    });
  });

  it('sin nada que pagar (0 o más devuelto que vendido): NOTHING', () => {
    expect(settlementRowOf(stall(), 0, 0).status).toBe('NOTHING');
    expect(settlementRowOf(stall(), -1_000, 0)).toMatchObject({ organizerCents: -100, toPayCents: -900, status: 'NOTHING' });
    expect(settlementStatusOf({ ownBar: false, toPayCents: 1, hasIban: false, stallId: null })).toBe('OWN_BAR');
  });
});

describe('la liquidación entera', () => {
  const stalls: SettlementStall[] = [
    stall({ id: 'a', name: 'Peña El Cántaro', sortOrder: 1 }),
    stall({ id: 'b', name: 'Barra de la Comisión', organizerBps: 10_000, sortOrder: 2 }),
    stall({ id: 'c', name: 'Churrería San Juan', iban: null, organizerBps: 800, sortOrder: 3 }),
    stall({ id: 'd', name: 'Caseta cerrada', active: false, sortOrder: 4 }),
    stall({ id: 'e', name: 'Caseta cerrada que vendió', active: false, sortOrder: 5, organizerBps: 2500 }),
  ];
  const t = totals([
    ['a', 792_000, 1102],
    ['b', 326_000, 512],
    ['c', 184_000, 233],
    ['e', 1_001, 3],
    [null, 2_500, 2],
  ]);
  const s = buildPartySettlement({
    window: { from: null, to: NOW },
    fromNight: null,
    toNight: null,
    now: NOW,
    eventName: 'Fiestas de San Juan',
    stalls,
    totals: t,
    debtor: { name: 'Comisión de Fiestas', iban: IBAN },
    wristbands: { loadedCents: 1_500_000, refundedCents: 100_000, leftCents: 50_000 },
  });

  it('las activas y las desactivadas que vendieron, en su orden; «Sin caseta» al final y todo del organizador', () => {
    expect(s.rows.map((r) => r.name)).toEqual([
      'Peña El Cántaro',
      'Barra de la Comisión',
      'Churrería San Juan',
      'Caseta cerrada que vendió',
      'Sin caseta',
    ]);
    expect(s.rows.at(-1)).toMatchObject({ stallId: null, soldCents: 2_500, organizerCents: 2_500, toPayCents: 0, status: 'OWN_BAR' });
  });

  it('los totales: vendido = organizador + a pagar; transferencias solo con IBAN', () => {
    expect(s.totals.soldCents).toBe(792_000 + 326_000 + 184_000 + 1_001 + 2_500);
    expect(s.totals.organizerCents + s.totals.toPayCents).toBe(s.totals.soldCents);
    // a: 712.800; e: 1.001 − 250 = 751 (con IBAN). c sin IBAN no va.
    expect(s.totals).toMatchObject({ transfers: 2, transfersCents: 712_800 + 751, missingIban: 1 });
    expect(s.debtor).toEqual({ name: 'Comisión de Fiestas', ibanMasked: 'ES91 •••• •••• 1332' });
    expect(s.wristbands).toEqual({ loadedCents: 1_500_000, refundedCents: 100_000, leftCents: 50_000 });
    expect(s.from).toBeNull();
    expect(s.to).toBe(NOW.toISOString());
  });

  it('sin ventas sin caseta, no sale esa fila', () => {
    expect(settlementRowsOf(stalls, totals([['a', 100, 1]])).map((r) => r.stallId)).toEqual(['a', 'b', 'c']);
  });

  it('el CSV: cabecera, una fila por caseta, el total; IBAN tapado y «Barra propia»', () => {
    const csv = partySettlementCsv(s);
    expect(csv.startsWith('﻿Caseta;Responsable;Cobros;Vendido;% del organizador;Para el organizador;A pagar a la caseta;IBAN;Estado\r\n')).toBe(true);
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(1 + s.rows.length + 1);
    expect(lines[1]).toBe('Peña El Cántaro;Ana R.;1102;7920,00;10,00;792,00;7128,00;ES91 •••• •••• 1332;IBAN listo');
    expect(lines[2]).toContain(';Barra propia;3260,00;0,00;ES91 •••• •••• 1332;No se paga');
    expect(lines[3]).toContain(';Falta IBAN');
    expect(lines.at(-1)).toBe('Total;;1852;13055,01;;4226,70;8828,31;;2 transferencias');
    expect(csv).not.toContain(IBAN);
  });

  it('el nombre del archivo, con las noches o «fiesta»', () => {
    expect(partySettlementFileName({ fromNight: null, toNight: null }, 'csv')).toBe('oxioparty-liquidacion-fiesta.csv');
    expect(partySettlementFileName({ fromNight: '2027-06-23', toNight: '2027-06-23' }, 'xml')).toBe('oxioparty-transferencias-2027-06-23.xml');
    expect(partySettlementFileName({ fromNight: '2027-06-23', toNight: '2027-06-24' }, 'csv')).toBe(
      'oxioparty-liquidacion-2027-06-23_2027-06-24.csv',
    );
    expect(percent(2500)).toBe('25,00');
  });
});
