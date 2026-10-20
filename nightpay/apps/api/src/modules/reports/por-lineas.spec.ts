import { describe, it, expect, vi } from 'vitest';
import { Prisma } from '@nightpay/db';
import { chargeSections } from './charge-sections';
import { cobrosCsv, resumenCsv, summarize } from './export-csv';
import { cobroType, type CobroRow, type ConsumoRow } from './export-rows';
import { PeriodReportsService } from './period-reports.service';
import { parseReportPeriod } from './report-period';

// El Z y los informes suman POR LÍNEA de cobro (payment_lines, 24-oct-2026):
// cada sección con lo suyo; la propina, en la sección principal; los cobros de
// antes (sin líneas), en su revenueCategory. Uno de una sola sección, igual que antes.

const cobro = (o: Partial<CobroRow>): CobroRow => ({
  id: '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b',
  paidAt: new Date('2026-10-24T21:41:00Z'),
  status: 'AUTHORIZED',
  amountCents: 10_000,
  tipCents: 0,
  revenueCategory: 'CHICA_SERVICE',
  lines: null,
  captureMethod: 'QR',
  serviceName: null,
  payMethod: 'card',
  payMethodCode: null,
  cardBrand: null,
  cardType: null,
  cardCountry: null,
  authCode: null,
  providerTxId: null,
  walletId: null,
  creatorName: 'Lola',
  creatorEmail: 'lola@local.es',
  earningOperatorName: null,
  earningOperatorEmail: null,
  refundedCents: 0,
  commissionCents: null,
  earningTipCents: null,
  reversedCents: null,
  reversedAfterPayoutCents: 0,
  ...o,
});

const consumo = (o: Partial<ConsumoRow>): ConsumoRow => ({
  id: 'c-1',
  at: new Date('2026-10-24T22:00:00Z'),
  amountCents: 2_000,
  tipCents: 0,
  category: 'VENUE_BAR',
  lines: null,
  operatorName: null,
  operatorEmail: null,
  commissionCents: null,
  earningTipCents: null,
  ...o,
});

const PACK = [
  { category: 'CHICA_SERVICE', amountCents: 12_000 },
  { category: 'VENUE_ROOM', amountCents: 3_000 },
];

describe('lo de un cobro en cada sección', () => {
  it('sus líneas; lo que no cubren, en la principal; sin líneas, todo en la principal', () => {
    expect([...chargeSections({ amountCents: 15_000, category: 'CHICA_SERVICE', lines: PACK })]).toEqual([
      ['CHICA_SERVICE', 12_000],
      ['VENUE_ROOM', 3_000],
    ]);
    expect([...chargeSections({ amountCents: 16_000, category: 'VENUE_BAR', lines: PACK })]).toEqual([
      ['CHICA_SERVICE', 12_000],
      ['VENUE_ROOM', 3_000],
      ['VENUE_BAR', 1_000],
    ]);
    expect([...chargeSections({ amountCents: 900, category: 'EXTRA', lines: null })]).toEqual([['EXTRA', 900]]);
    expect([...chargeSections({ amountCents: 900, category: 'VENUE_FOOD', lines: [] })]).toEqual([['VENUE_FOOD', 900]]);
  });

  it('el tipo del cobro: el de su sección, o todas si tiene varias', () => {
    expect(cobroType(cobro({ amountCents: 15_000, lines: PACK }))).toBe('Servicio de chica + Habitación');
    expect(cobroType(cobro({ lines: [{ category: 'CHICA_SERVICE', amountCents: 10_000 }] }))).toBe('Servicio de chica');
    expect(cobroType(cobro({ revenueCategory: 'VENUE_ENTRY' }))).toBe('Entrada');
    expect(cobroType({ walletId: 'w-1', revenueCategory: 'EXTRA' })).toBe('Recarga de wallet');
    expect(cobroType({ walletId: null, revenueCategory: 'VENUE_BAR' })).toBe('Barra');
  });
});

describe('Z y resumen por línea', () => {
  it('REGRESIÓN: un cobro de una sola sección (con línea o de antes) suma igual que antes', () => {
    const before = summarize([cobro({ tipCents: 500 }), cobro({ revenueCategory: 'VENUE_BAR', amountCents: 3_000 })], [], []);
    const after = summarize(
      [
        cobro({ tipCents: 500, lines: [{ category: 'CHICA_SERVICE', amountCents: 10_000 }] }),
        cobro({ revenueCategory: 'VENUE_BAR', amountCents: 3_000, lines: [{ category: 'VENUE_BAR', amountCents: 3_000 }] }),
      ],
      [],
      [],
    );
    expect(after.byType).toEqual(before.byType);
    expect(after.byType).toEqual([
      { label: 'Servicio de chica', count: 1, chargedCents: 10_500 },
      { label: 'Barra', count: 1, chargedCents: 3_000 },
    ]);
  });

  it('un pack: cada sección con lo suyo y la propina en la principal; el total no cambia', () => {
    const s = summarize([cobro({ amountCents: 15_000, tipCents: 500, lines: PACK }), cobro({ walletId: 'w-1', amountCents: 5_000, revenueCategory: 'EXTRA' })], [], []);
    expect(s.byType).toEqual([
      { label: 'Servicio de chica', count: 1, chargedCents: 12_500 },
      { label: 'Habitación', count: 1, chargedCents: 3_000 },
      { label: 'Recarga de wallet', count: 1, chargedCents: 5_000 },
    ]);
    expect(s.byType.reduce((a, t) => a + t.chargedCents, 0)).toBe(s.chargedCents);
    expect(s.count).toBe(2);
  });

  it('los consumos del saldo, también por línea; una sección desconocida va al final', () => {
    const s = summarize(
      [],
      [],
      [],
      [
        consumo({ amountCents: 15_000, tipCents: 200, category: 'CHICA_SERVICE', lines: PACK }),
        consumo({ amountCents: 700, category: 'bar' }),
      ],
    );
    expect(s.saldoByType).toEqual([
      { label: 'Servicio de chica', count: 1, chargedCents: 12_200 },
      { label: 'Habitación', count: 1, chargedCents: 3_000 },
      { label: 'bar', count: 1, chargedCents: 700 },
    ]);
    expect(s.consumptionsCents).toBe(15_900);
  });

  it('el CSV: el tipo con todas sus secciones, el reparto por sección al final y el resumen por línea', () => {
    const rows = [cobro({ amountCents: 15_000, tipCents: 500, lines: PACK }), cobro({ walletId: 'w-1', amountCents: 5_000, revenueCategory: 'EXTRA' })];
    const csv = cobrosCsv(rows, 'Local').replace(/^\uFEFF/, '').trimEnd().split('\r\n');
    expect(csv[0]!.endsWith(';Por sección')).toBe(true);
    expect(csv[1]).toContain(';Servicio de chica + Habitación;Servicio de chica + Habitación;Lola;');
    expect(csv[1]!.endsWith(';Servicio de chica 120,00 · Habitación 30,00')).toBe(true);
    expect(csv[2]!.endsWith(';')).toBe(true);
    const period = parseReportPeriod('2026-10-24', '2026-10-24');
    if (!period.ok) throw new Error(period.error);
    const resumen = resumenCsv({ venueName: 'Local', period: period.period, generatedAt: new Date('2026-10-25T08:00:00Z'), summary: summarize(rows, [], []) });
    expect(resumen).toContain('Servicio de chica;125,00;1');
    expect(resumen).toContain('Habitación;30,00;1');
  });
});

describe('Z de un periodo por línea', () => {
  it('lee las líneas de los cobros y de los cobros del saldo, filtrado por el local', async () => {
    const TENANT = '11111111-1111-4111-8111-111111111111';
    const queries: Prisma.Sql[] = [];
    const prisma = {
      $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const q = Prisma.sql(strings, ...values);
        queries.push(q);
        if (q.text.includes('sale_lines')) {
          return [
            { source: 'CARD', category: 'CHICA_SERVICE', count: 1, grossCents: 12_000n, tipCents: 500n },
            { source: 'CARD', category: 'VENUE_ROOM', count: 1, grossCents: 3_000n, tipCents: 0n },
            { source: 'WALLET', category: 'VENUE_BAR', count: 2, grossCents: 4_000n, tipCents: 0n },
          ];
        }
        return [];
      }),
      withTenant: vi.fn(async (_t: string, fn: (tx: unknown) => unknown) => fn(prisma)),
    };
    const svc = new PeriodReportsService(prisma as never);
    const z = await svc.periodZ(TENANT, { from: new Date('2026-10-24T06:00:00Z'), to: new Date('2026-10-25T06:00:00Z') });
    const q = queries.find((x) => x.text.includes('sale_lines'))!;
    expect(q.text).toContain('FROM payment_lines l JOIN paid');
    expect(q.text).toContain('JOIN wallet_charge_requests wr ON wr."consumptionId" = consumed.id');
    expect(q.text).toContain('p."tenantId" = $');
    expect(q.text).toContain('c."tenantId" = $');
    expect(q.values).toContain(TENANT);
    expect(z.byRevenueCategory.map((c) => [c.category, c.grossCents, c.count])).toEqual([
      ['CHICA_SERVICE', 12_000, 1],
      ['VENUE_BAR', 4_000, 2],
      ['VENUE_ROOM', 3_000, 1],
    ]);
    expect(z.chicaRevenue).toEqual({ count: 1, grossCents: 12_000 });
    expect(z.venueRevenue).toEqual({ count: 3, grossCents: 7_000 });
  });
});
