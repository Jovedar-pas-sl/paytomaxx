import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { emptyConceptAmounts } from '@nightpay/contracts';
import { OxioPaySettlementsService } from './oxiopay-settlements.service';
import { nightsOf, weekStartingOn } from './settlement-week';

/**
 * Lecturas y escrituras del servicio con la base de mentira (la de verdad, en
 * test/integration/liquidacion-oxiopay.int.spec.ts): qué se pide, con qué
 * local y qué reglas se aplican antes de escribir.
 */
const V = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';
const SA = { id: '33333333-3333-4333-8333-333333333333', email: 'jefe@x.es' };
const W = weekStartingOn('2026-10-26');
const NOW = new Date('2026-11-12T10:00:00Z');

const breakdown = {
  version: 1,
  party: { venueName: 'Luna', venueSlug: 'luna', businessName: 'Noches Luna S.L.', businessTaxId: 'B12345678' },
  platformBps: 1000,
  nights: nightsOf(W).map((n) => ({
    day: n.day,
    from: n.from.toISOString(),
    to: n.to.toISOString(),
    concepts: n.day === '2026-10-30' ? { ...emptyConceptAmounts(), serviceFeeSales: 2_235 } : emptyConceptAmounts(),
  })),
  adjustments: [],
};

function row(o: Record<string, unknown> = {}) {
  return {
    id: ID,
    tenantId: V,
    businessId: 'b1',
    periodFrom: W.from,
    periodTo: W.to,
    isoYear: 2026,
    isoWeek: 44,
    reference: 'OXP-2026-S44-LUNA',
    status: 'ISSUED',
    periodCents: 2_235,
    adjustmentsCents: 0,
    totalCents: 2_235,
    paidCents: 0,
    moneyMapCents: 2_235,
    breakdown,
    auto: true,
    generatedAt: new Date('2026-11-02T09:05:00Z'),
    generatedById: null,
    replacesId: null,
    paidAt: null,
    voidedAt: null,
    voidedById: null,
    voidReason: null,
    updatedAt: new Date(),
    payments: [] as Array<Record<string, unknown>>,
    ...o,
  };
}

function make(
  o: {
    rows?: Array<ReturnType<typeof row>>;
    locked?: boolean;
    payee?: Record<string, unknown> | null;
    venues?: Array<{ id: string; name?: string }>;
    payments?: Array<{ bankReference: string; amountCents: number; paidOn: Date }>;
  } = {},
) {
  const rows = o.rows ?? [row()];
  const payee = o.payee === undefined ? { id: 1, name: 'OxioPay', iban: 'ES9121000418450200051332', holder: 'OxioPay SL', updatedAt: new Date('2026-10-27T10:00:00Z') } : o.payee;
  const tx = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => (strings.join('?').includes('FOR UPDATE') ? (o.locked === false ? [] : [{ id: ID }]) : [{ ok: 1 }])),
    oxioPaySettlement: {
      findMany: vi.fn(async () => rows),
      findFirst: vi.fn(async () => rows[0] ?? null),
      findUnique: vi.fn(async () => rows[0] ?? null),
      findUniqueOrThrow: vi.fn(async () => rows[0]),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...rows[0], ...data })),
    },
    oxioPaySettlementPayment: { create: vi.fn(async () => ({ id: 'p1' })), findMany: vi.fn(async () => o.payments ?? []) },
    oxioPaySettlementSettings: {
      findUnique: vi.fn(async () => ({ id: 1, startWeek: new Date('2026-01-05T00:00:00.000Z') })),
      upsert: vi.fn(async () => ({})),
    },
    oxioPayPayee: {
      findUnique: vi.fn(async () => payee),
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => ({ ...create, updatedAt: new Date('2026-11-01T00:00:00Z') })),
    },
    user: { findMany: vi.fn(async () => [{ id: SA.id, email: SA.email }]) },
    venue: { findMany: vi.fn(async () => o.venues ?? []) },
  };
  const run = vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx));
  const prisma = {
    acrossVenues: run,
    asSystem: run,
    withTenant: vi.fn(async (tenantId: string, fn: (t: typeof tx) => unknown) => {
      expect(tenantId).toBe(V);
      return fn(tx);
    }),
  };
  const svc = new OxioPaySettlementsService(prisma as never, {} as never, { log: vi.fn(), logInTx: vi.fn() } as never);
  return { svc, tx, prisma };
}

describe('el dueño: solo su local, con RLS (withTenant) y el local explícito', () => {
  it('lista con la cuenta de OxioPay y lo pendiente; ficha sin quién apuntó los pagos; aviso de 7 días', async () => {
    const { svc, tx } = make();
    const page = await svc.listForOwner(V, NOW);
    expect(tx.oxioPaySettlement.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: V } }));
    expect(page).toMatchObject({ pendingCents: 2_235, payee: { iban: 'ES9121000418450200051332' } });
    expect(page.items[0]).toMatchObject({ reference: 'OXP-2026-S44-LUNA', overdue: true, daysOpen: 10, business: { id: 'b1', name: 'Noches Luna S.L.' } });
    const withPayment = make({
      rows: [row({ status: 'PARTIALLY_PAID', paidCents: 1_000, payments: [{ id: 'p', amountCents: 1_000, paidOn: new Date('2026-11-03T00:00:00Z'), bankReference: 'T', reason: 'A cuenta', recordedById: SA.id, recordedAt: NOW }] })],
    });
    const detail = await withPayment.svc.detailForOwner(V, ID, NOW);
    expect(withPayment.tx.oxioPaySettlement.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: ID, tenantId: V } }));
    // Las notas internas y quién las apuntó son de OxioPay: el dueño no las ve.
    expect(detail.payments).toEqual([expect.objectContaining({ paidOn: '2026-11-03', reason: null, recordedByEmail: null })]);
    expect(detail.byConcept.serviceFeeSales).toBe(2_235);
    const voided = make({ rows: [row({ status: 'VOID', voidedAt: NOW, voidedById: SA.id, voidReason: 'Faltaba un cobro' })] });
    expect((await voided.svc.detailForOwner(V, ID, NOW)).voidReason).toBeNull();
    expect((await voided.svc.detailForSuperAdmin(ID, NOW)).voidReason).toBe('Faltaba un cobro');
    expect(await svc.noticeForOwner(V, NOW)).toEqual({ overdue: [{ id: ID, reference: 'OXP-2026-S44-LUNA', pendingCents: 2_235, daysOpen: 10 }], overdueCents: 2_235 });
  });

  it('una que no es suya (o no existe): 404', async () => {
    await expect(make({ rows: [] }).svc.detailForOwner(V, ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('un desglose ilegible no tumba la lista (sale con la referencia)', async () => {
    const page = await make({ rows: [row({ breakdown: { roto: true } })] }).svc.listForOwner(V, NOW);
    expect(page.items[0]?.venue.name).toBe('OXP-2026-S44-LUNA');
  });
});

describe('la consola', () => {
  it('filtros → la consulta (estado OPEN, días de Madrid, referencia en mayúsculas) y lo pendiente de todas', async () => {
    const { svc, tx } = make();
    const page = await svc.listForSuperAdmin({ venueId: V, businessId: 'b1', status: 'OPEN', from: '2026-10-26', to: '2026-11-01', q: 's44' }, NOW);
    const where = tx.oxioPaySettlement.findMany.mock.calls[0]![0].where;
    expect(where).toEqual({
      tenantId: V,
      businessId: 'b1',
      status: { in: ['ISSUED', 'PARTIALLY_PAID'] },
      periodFrom: { gte: new Date('2026-10-25T23:00:00Z'), lt: new Date('2026-11-01T23:00:00Z') },
      reference: { contains: 'S44' },
    });
    expect(page).toMatchObject({ totals: { pendingCents: 2_235, pendingCount: 1, overdueCents: 2_235, overdueCount: 1 }, payeeMissing: false, startWeek: '2026-01-05' });
    await svc.listForSuperAdmin({ status: 'PAID' }, NOW);
    expect(tx.oxioPaySettlement.findMany.mock.calls[2]![0].where).toEqual({ status: 'PAID' });
    expect((await make({ payee: null }).svc.listForSuperAdmin({}, NOW)).payeeMissing).toBe(true);
  });

  it('la ficha dice quién apuntó cada pago; las de más de 7 días para Telegram', async () => {
    const { svc } = make({
      rows: [row({ status: 'PARTIALLY_PAID', paidCents: 1_000, payments: [{ id: 'p', amountCents: 1_000, paidOn: new Date('2026-11-03T00:00:00Z'), bankReference: 'T', reason: 'x', recordedById: SA.id, recordedAt: NOW }] })],
    });
    const detail = await svc.detailForSuperAdmin(ID, NOW);
    expect(detail.payments[0]).toMatchObject({ recordedByEmail: SA.email, reason: 'x' });
    expect(await svc.overdueList(NOW)).toEqual([{ reference: 'OXP-2026-S44-LUNA', venueName: 'Luna', pendingCents: 1_235, daysOpen: 10 }]);
    await expect(make({ rows: [] }).svc.detailForSuperAdmin(ID, NOW)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('apuntar un pago', () => {
  const dto = { amountCents: 2_235, paidOn: '2026-11-03', bankReference: ' TRF-1 ' };

  it('lo pendiente → pagada (con su fecha); menos y con motivo → en parte; el pago, del local de la liquidación', async () => {
    const full = make();
    const out = await full.svc.recordPayment(SA, ID, dto, NOW);
    expect(full.tx.oxioPaySettlementPayment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ tenantId: V, settlementId: ID, amountCents: 2_235, bankReference: 'TRF-1', reason: null, recordedById: SA.id }),
    });
    expect(full.tx.oxioPaySettlement.update).toHaveBeenCalledWith({ where: { id: ID }, data: { paidCents: 2_235, status: 'PAID', paidAt: NOW } });
    expect(out).toMatchObject({ paymentId: 'p1', after: { status: 'PAID' } });
    // El registro, en la misma transacción (si falla, no hay pago).
    const onWrite = vi.fn(async () => undefined);
    const withAudit = make();
    await withAudit.svc.recordPayment(SA, ID, dto, NOW, onWrite);
    expect(onWrite).toHaveBeenCalledWith(withAudit.tx, expect.objectContaining({ paymentId: 'p1' }));
    const failing = make();
    await expect(failing.svc.recordPayment(SA, ID, dto, NOW, async () => Promise.reject(new Error('sin registro')))).rejects.toThrow('sin registro');
    const part = make();
    await part.svc.recordPayment(SA, ID, { ...dto, amountCents: 1_000, reason: ' A cuenta ' }, NOW);
    expect(part.tx.oxioPaySettlement.update).toHaveBeenCalledWith({ where: { id: ID }, data: { paidCents: 1_000, status: 'PARTIALLY_PAID', paidAt: null } });
  });

  it('no se apunta: anulada, ya pagada, fecha futura o anterior a la semana, sin motivo, de más o que no existe', async () => {
    await expect(make({ rows: [row({ status: 'VOID' })] }).svc.recordPayment(SA, ID, dto, NOW)).rejects.toBeInstanceOf(ConflictException);
    await expect(make({ rows: [row({ status: 'PAID', paidCents: 2_235 })] }).svc.recordPayment(SA, ID, dto, NOW)).rejects.toBeInstanceOf(ConflictException);
    await expect(make().svc.recordPayment(SA, ID, { ...dto, paidOn: '2026-11-13' }, NOW)).rejects.toThrow(/futura/);
    await expect(make().svc.recordPayment(SA, ID, { ...dto, paidOn: '2026-10-25' }, NOW)).rejects.toThrow(/anterior a la semana/);
    await expect(make().svc.recordPayment(SA, ID, { ...dto, amountCents: 1_000 }, NOW)).rejects.toBeInstanceOf(BadRequestException);
    await expect(make().svc.recordPayment(SA, ID, { ...dto, amountCents: 3_000, reason: 'De más' }, NOW)).rejects.toThrow(/mayor que lo pendiente/);
    await expect(make({ locked: false }).svc.recordPayment(SA, ID, dto, NOW)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('la misma referencia del banco: 409 antes del 2FA (precheck) y dentro (con la liquidación bloqueada), salvo confirmación', async () => {
    const payments = [{ bankReference: 'TRF-1', amountCents: 1_000, paidOn: new Date('2026-11-03T00:00:00Z') }];
    const partial = () => make({ rows: [row({ status: 'PARTIALLY_PAID', paidCents: 1_000, payments })], payments });
    const again = { amountCents: 1_235, paidOn: '2026-11-04', bankReference: 'trf-1' };
    await expect(partial().svc.paymentPrecheck(ID, again, NOW)).rejects.toThrow(/Ya hay un pago con la referencia TRF-1/);
    await expect(partial().svc.recordPayment(SA, ID, again, NOW)).rejects.toBeInstanceOf(ConflictException);
    await expect(partial().svc.paymentPrecheck(ID, { ...again, confirmDuplicate: true }, NOW)).resolves.toBeUndefined();
    await expect(make({ rows: [] }).svc.paymentPrecheck(ID, again, NOW)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('anular', () => {
  it('sin pagos: anulada con fecha, quién y motivo (con el local bloqueado, como al generar)', async () => {
    const { svc, tx } = make();
    await svc.voidSettlement(SA, ID, '  Cifras mal  ', NOW);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(tx.oxioPaySettlement.update).toHaveBeenCalledWith({ where: { id: ID }, data: { status: 'VOID', voidedAt: NOW, voidedById: SA.id, voidReason: 'Cifras mal' } });
  });

  it('antes del 2FA: se puede anular o no', async () => {
    await expect(make().svc.voidPrecheck(ID)).resolves.toBeUndefined();
    await expect(make({ rows: [row({ status: 'PARTIALLY_PAID', paidCents: 1 })] }).svc.voidPrecheck(ID)).rejects.toThrow(/sin pagos/);
    await expect(make({ rows: [] }).svc.voidPrecheck(ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('con pagos, ya anulada o que no existe: no', async () => {
    await expect(make({ rows: [row({ status: 'PARTIALLY_PAID', paidCents: 1 })] }).svc.voidSettlement(SA, ID, 'x', NOW)).rejects.toThrow(/sin pagos/);
    await expect(make({ rows: [row({ status: 'VOID' })] }).svc.voidSettlement(SA, ID, 'x', NOW)).rejects.toThrow(/ya está anulada/);
    await expect(make({ rows: [] }).svc.voidSettlement(SA, ID, 'x', NOW)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('la cuenta de OxioPay y el repaso', () => {
  it('se guarda (una fila) con quién la cambió y lo que había', async () => {
    const { svc, tx } = make();
    const out = await svc.setPayee(SA, { name: ' OxioPay S.L. ', iban: 'ES9121000418450200051332', holder: ' OxioPay Pagos ' });
    expect(tx.oxioPayPayee.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 1 }, create: { id: 1, name: 'OxioPay S.L.', iban: 'ES9121000418450200051332', holder: 'OxioPay Pagos', updatedById: SA.id } }),
    );
    expect(out.before).toMatchObject({ name: 'OxioPay' });
    expect(out.after).toMatchObject({ name: 'OxioPay S.L.' });
    expect(await make({ payee: null }).svc.payee()).toBeNull();
  });

  it('el repaso: nada antes del lunes 10:00; los locales de esa semana, uno a uno (un fallo no corta los demás)', async () => {
    expect(await make().svc.runDue(new Date('2026-11-02T08:00:00Z'))).toEqual({ week: null, created: [], failed: [], findings: [] });
    const { svc, tx } = make({ venues: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] });
    const reconcile = vi.spyOn(svc, 'reconcile').mockResolvedValue([]);
    const generate = vi
      .spyOn(svc, 'generate')
      .mockResolvedValueOnce({ kind: 'created', id: 'x', reference: 'OXP-2026-S44-A', totalCents: 1, replacesId: null })
      .mockRejectedValueOnce(new Error('boom'));
    const out = await svc.runDue(new Date('2026-11-02T09:30:00Z'));
    expect(tx.venue.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ createdAt: { lt: W.to } }) }));
    expect(generate).toHaveBeenCalledTimes(2);
    expect(out).toMatchObject({ created: ['OXP-2026-S44-A'], failed: ['B: boom'], findings: [] });
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('la semana que toca es anterior a la de inicio: no se liquida nada', async () => {
    const { svc, tx } = make({ venues: [{ id: 'a', name: 'A' }] });
    tx.oxioPaySettlementSettings.findUnique.mockResolvedValue({ id: 1, startWeek: new Date('2026-11-09T00:00:00.000Z') });
    const generate = vi.spyOn(svc, 'generate');
    expect(await svc.runDue(new Date('2026-11-02T09:30:00Z'))).toMatchObject({ beforeStart: true, created: [] });
    expect(generate).not.toHaveBeenCalled();
  });

  it('cambiar la semana de inicio: un lunes, con su registro en la misma transacción', async () => {
    const { svc, tx } = make();
    const onWrite = vi.fn(async () => undefined);
    expect(await svc.setStartWeek(SA, '2026-11-02', onWrite)).toEqual({ before: '2026-01-05', after: '2026-11-02' });
    expect(tx.oxioPaySettlementSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 1 }, update: { startWeek: new Date('2026-11-02T00:00:00.000Z'), updatedById: SA.id } }),
    );
    expect(onWrite).toHaveBeenCalledWith(tx, { before: '2026-01-05', after: '2026-11-02' });
    await expect(svc.setStartWeek(SA, '2026-11-03')).rejects.toBeInstanceOf(BadRequestException);
  });
});
