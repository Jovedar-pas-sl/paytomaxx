import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@nightpay/db';
import { emptyConceptAmounts, type SettlementConceptAmounts } from '@nightpay/contracts';
import { OxioPaySettlementsService } from './oxiopay-settlements.service';
import { nightsOf, weekStartingOn, type SettlementWeek } from './settlement-week';
import type { StoredBreakdown } from './settlement-rules';

const VENUE = '11111111-1111-4111-8111-111111111111';
const W44 = weekStartingOn('2026-10-26');
const W43 = weekStartingOn('2026-10-19');
const NOW = new Date('2026-11-02T10:00:00Z');
const c = (o: Partial<SettlementConceptAmounts>): SettlementConceptAmounts => ({ ...emptyConceptAmounts(), ...o });

interface StoredRow {
  id: string;
  status: 'ISSUED' | 'PARTIALLY_PAID' | 'PAID' | 'VOID';
  periodFrom: Date;
  reference: string;
  breakdown: StoredBreakdown;
}

function stored(week: SettlementWeek, perDay: Record<string, SettlementConceptAmounts>, platformBps = 1000): StoredBreakdown {
  return {
    version: 1,
    party: { venueName: 'Luna', venueSlug: 'luna', businessName: null, businessTaxId: null },
    platformBps,
    nights: nightsOf(week).map((n) => ({ day: n.day, from: n.from.toISOString(), to: n.to.toISOString(), concepts: perDay[n.day] ?? c({}) })),
    adjustments: [],
  };
}

/**
 * Lo del mapa del dinero por ventana: `owed[día]` por noche y la semana como
 * su suma (como el mapa de verdad). Lo demás, 0.
 */
function makeService(o: { rows?: StoredRow[]; owed?: Record<string, SettlementConceptAmounts>; createImpl?: () => unknown; activeAtInsert?: Array<() => string[]> } = {}) {
  const rows = o.rows ?? [];
  const owed = o.owed ?? {};
  const dayOf = (d: Date) => nightsOf(weekStartingOn('2026-10-12')).concat(nightsOf(W43), nightsOf(W44)).find((n) => n.from.getTime() === d.getTime())?.day;
  const moneyMap = {
    oxioPayOwed: vi.fn(async (_venue: string, w: { from: Date; to: Date }) => {
      const hours = (w.to.getTime() - w.from.getTime()) / 3_600_000;
      if (hours < 30) return owed[dayOf(w.from) ?? ''] ?? c({});
      // Una semana: la suma de sus noches.
      const week = [W44, W43].find((x) => x.from.getTime() === w.from.getTime());
      const days = week ? nightsOf(week).map((n) => n.day) : [];
      return days.reduce(
        (acc, d) => Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, v + (owed[d]?.[k as keyof SettlementConceptAmounts] ?? 0)])) as SettlementConceptAmounts,
        c({}),
      );
    }),
  };
  let insertCall = 0;
  const create = vi.fn(o.createImpl ?? (async ({ data }: { data: Record<string, unknown> }) => ({ id: 'new-id', ...data })));
  const tx = {
    $queryRaw: vi.fn(async () => [{ ok: 1 }]),
    venue: {
      findUnique: vi.fn(async () => ({ id: VENUE, name: 'Luna', slug: 'luna', platformCommissionBps: 1000, businessId: null, business: null })),
    },
    oxioPaySettlement: {
      findMany: vi.fn(async (args: { where: { status?: unknown }; select?: Record<string, boolean> }) => {
        if (args.where.status) {
          // La relectura dentro de la transacción, con el local bloqueado.
          const override = o.activeAtInsert?.[insertCall++];
          return (override ? override() : rows.filter((r) => r.status !== 'VOID').map((r) => r.id)).map((id) => ({ id }));
        }
        return rows;
      }),
      aggregate: vi.fn(async () => ({ _min: { periodFrom: rows.length > 0 ? rows.map((r) => r.periodFrom).sort((a, b) => a.getTime() - b.getTime())[0] : null } })),
      findFirst: vi.fn(async () => rows.find((r) => r.status !== 'VOID' && r.periodFrom.getTime() === W44.from.getTime()) ?? { id: 'other', reference: 'OXP-2026-S44-LUNA' }),
      create,
    },
  };
  const prisma = {
    acrossVenues: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    asSystem: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const audit = { log: vi.fn(async () => undefined) };
  return { svc: new OxioPaySettlementsService(prisma as never, moneyMap as never, audit as never), create, moneyMap, tx };
}

describe('generar la liquidación de una semana', () => {
  it('la primera vez: las 7 noches con la cuenta del mapa (y la semana entera como comprobación), sin ajustes', async () => {
    const { svc, create } = makeService({ owed: { '2026-10-30': c({ serviceFeeSales: 330, serviceFeeRefunded: -95 }), '2026-10-31': c({ platformSaldo: 200 }) } });
    const out = await svc.generate(VENUE, W44, { now: NOW, auto: true });
    expect(out).toMatchObject({ kind: 'created', reference: 'OXP-2026-S44-LUNA', totalCents: 435, replacesId: null });
    const data = create.mock.calls[0]![0].data as Record<string, unknown> & { breakdown: StoredBreakdown };
    expect(data).toMatchObject({ periodCents: 435, adjustmentsCents: 0, totalCents: 435, moneyMapCents: 435, isoWeek: 44, auto: true, generatedById: null });
    expect(data.breakdown.nights).toHaveLength(7);
    expect(data.breakdown.platformBps).toBe(1000);
    expect(data.breakdown.adjustments).toEqual([]);
  });

  it('se repasa desde la primera semana liquidada de ESE local (las de otros locales no cuentan)', async () => {
    const { svc, tx } = makeService({ owed: { '2026-10-27': c({ platformSales: 300 }) } });
    await svc.generate(VENUE, W44, { now: NOW, auto: true });
    expect(tx.oxioPaySettlement.aggregate).toHaveBeenCalledWith({ where: { tenantId: VENUE }, _min: { periodFrom: true } });
  });

  it('ya hay una activa de esa semana: esa (no se duplica); a 0: no se crea', async () => {
    const existing: StoredRow = { id: 's44', status: 'ISSUED', periodFrom: W44.from, reference: 'OXP-2026-S44-LUNA', breakdown: stored(W44, {}) };
    const a = makeService({ rows: [existing] });
    expect(await a.svc.generate(VENUE, W44, { now: NOW, auto: true })).toEqual({ kind: 'exists', id: 's44', reference: 'OXP-2026-S44-LUNA' });
    expect(a.create).not.toHaveBeenCalled();
    const b = makeService();
    expect(await b.svc.generate(VENUE, W44, { now: NOW, auto: true })).toEqual({ kind: 'nothing', totalCents: 0 });
    expect(b.create).not.toHaveBeenCalled();
  });

  it('lo apuntado tarde en la semana 43 ya liquidada entra como ajuste, con su noche', async () => {
    const s43: StoredRow = {
      id: 's43',
      status: 'PAID',
      periodFrom: W43.from,
      reference: 'OXP-2026-S43-LUNA',
      breakdown: stored(W43, { '2026-10-23': c({ serviceFeeSales: 1_000 }) }),
    };
    const { svc, create } = makeService({
      rows: [s43],
      owed: { '2026-10-23': c({ serviceFeeSales: 1_000, serviceFeeRefunded: -95 }), '2026-10-27': c({ serviceFeeSales: 500 }) },
    });
    const out = await svc.generate(VENUE, W44, { now: NOW, auto: true });
    expect(out).toMatchObject({ kind: 'created', totalCents: 405 });
    const data = create.mock.calls[0]![0].data as { breakdown: StoredBreakdown; periodCents: number; adjustmentsCents: number };
    expect(data.periodCents).toBe(500);
    expect(data.adjustmentsCents).toBe(-95);
    expect(data.breakdown.adjustments).toEqual([
      { weekFrom: '2026-10-19', isoYear: 2026, isoWeek: 43, reference: 'OXP-2026-S43-LUNA', day: '2026-10-23', concept: 'serviceFeeRefunded', amountCents: -95 },
    ]);
  });

  it('el repaso no regenera una semana que el super-admin anuló (solo a mano)', async () => {
    const voided: StoredRow = { id: 'void44', status: 'VOID', periodFrom: W44.from, reference: 'OXP-2026-S44-LUNA', breakdown: stored(W44, {}) };
    const { svc, create } = makeService({ rows: [voided], owed: { '2026-10-27': c({ platformSales: 300 }) } });
    expect(await svc.generate(VENUE, W44, { now: NOW, auto: true })).toEqual({ kind: 'voided', id: 'void44', reference: 'OXP-2026-S44-LUNA' });
    expect(create).not.toHaveBeenCalled();
  });

  it('regenerada tras anularla: -2 y a cuál sustituye', async () => {
    const voided: StoredRow = { id: 'void44', status: 'VOID', periodFrom: W44.from, reference: 'OXP-2026-S44-LUNA', breakdown: stored(W44, { '2026-10-27': c({ platformSales: 300 }) }) };
    const { svc } = makeService({ rows: [voided], owed: { '2026-10-27': c({ platformSales: 300 }) } });
    expect(await svc.generate(VENUE, W44, { now: NOW, auto: false, actor: { id: 'sa', email: 'sa@x.es' } })).toMatchObject({
      kind: 'created',
      reference: 'OXP-2026-S44-LUNA-2',
      totalCents: 300,
      replacesId: 'void44',
    });
  });

  it('si otra liquidación del local cambia mientras se calcula, se vuelve a calcular', async () => {
    const { svc, create } = makeService({ owed: { '2026-10-27': c({ platformSales: 300 }) }, activeAtInsert: [() => ['otra'], () => []] });
    expect(await svc.generate(VENUE, W44, { now: NOW, auto: true })).toMatchObject({ kind: 'created' });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('la base no deja dos activas (otra réplica ganó): la de la otra', async () => {
    const dup = new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: '5.22.0' });
    const { svc } = makeService({ owed: { '2026-10-27': c({ platformSales: 300 }) }, createImpl: async () => Promise.reject(dup) });
    expect(await svc.generate(VENUE, W44, { now: NOW, auto: true })).toEqual({ kind: 'exists', id: 'other', reference: 'OXP-2026-S44-LUNA' });
  });

  it('una semana que aún no ha terminado: 400', async () => {
    const { svc } = makeService();
    await expect(svc.generate(VENUE, W44, { now: new Date('2026-11-02T06:59:00Z'), auto: true })).rejects.toBeInstanceOf(BadRequestException);
  });
});
