import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@nightpay/db';
import { NightsService } from './nights.service';

const OPENED = new Date('2026-10-13T20:00:00Z'); // 22:00 de Madrid

function night(o: Record<string, unknown> = {}) {
  return {
    id: 'night-1',
    tenantId: 't-1',
    openedAt: OPENED,
    closedAt: null,
    autoClosed: false,
    pendingAtClose: 0,
    closeNote: null,
    zReport: null,
    ...o,
  };
}

function makeService(opts: { open?: ReturnType<typeof night> | null; pending?: unknown[]; closedCount?: number } = {}) {
  const prisma = {
    venueNight: {
      create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => night(data)),
      findFirst: vi.fn().mockResolvedValue(opts.open === undefined ? night() : opts.open),
      findMany: vi.fn().mockResolvedValue(opts.open ? [opts.open] : []),
      updateMany: vi.fn().mockResolvedValue({ count: opts.closedCount ?? 1 }),
    },
    $queryRaw: vi.fn().mockResolvedValue(opts.pending ?? []),
  };
  Object.assign(prisma, {
    asSystem: vi.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  });
  const reports = {
    cobros: vi.fn().mockResolvedValue([]),
    devoluciones: vi.fn().mockResolvedValue([]),
    liquidaciones: vi.fn().mockResolvedValue([]),
    consumos: vi.fn().mockResolvedValue([]),
  };
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const svc = new NightsService(prisma as never, reports as never, audit as never);
  return { svc, prisma, reports, audit };
}

const PENDING = [
  { id: 'p-1', status: 'AUTHORIZING', amountCents: 100, createdAt: OPENED, captureMethod: 'QR', total: 1 },
];

// Las 01:00 de Madrid de esa noche: la noche sigue abierta (se cerraría sola a las 08:00).
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-13T23:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('abrir la noche', () => {
  it('abre y deja constancia', async () => {
    const { svc, audit } = makeService({ open: null });
    const view = await svc.open('t-1', 'u-1');
    expect(view.closedAt).toBeNull();
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'night.opened' }));
  });

  it('ya hay una abierta → 409', async () => {
    const { svc, prisma } = makeService({ open: null });
    prisma.venueNight.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' }),
    );
    await expect(svc.open('t-1', 'u-1')).rejects.toThrow(ConflictException);
  });
});

describe('cerrar la noche', () => {
  const manager = { userId: 'u-1', role: 'MANAGER' };
  const owner = { userId: 'u-2', role: 'OWNER' };

  it('sin pendientes: congela el Z y la cierra', async () => {
    const { svc, prisma, audit } = makeService();
    await svc.close('t-1', manager, 'night-1', { force: false });
    const call = prisma.venueNight.updateMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      data: { zReport: { summary: { count: number } }; autoClosed: boolean; pendingAtClose: number };
    };
    expect(call.where).toEqual({ id: 'night-1', tenantId: 't-1', closedAt: null });
    expect(call.data.autoClosed).toBe(false);
    expect(call.data.pendingAtClose).toBe(0);
    expect(call.data.zReport.summary.count).toBe(0);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'night.closed' }));
  });

  it('con cobros sin resolver → no se cierra', async () => {
    const { svc, prisma } = makeService({ pending: PENDING });
    await expect(svc.close('t-1', manager, 'night-1', { force: false })).rejects.toThrow(/Queda 1 cobro sin resolver/);
    expect(prisma.venueNight.updateMany).not.toHaveBeenCalled();
  });

  it('cerrar igualmente: el encargado no puede; el dueño sí, con nota', async () => {
    const { svc, prisma } = makeService({ pending: PENDING });
    await expect(svc.close('t-1', manager, 'night-1', { force: true, note: 'mañana' })).rejects.toThrow(
      ForbiddenException,
    );
    await expect(svc.close('t-1', owner, 'night-1', { force: true })).rejects.toThrow(BadRequestException);
    await svc.close('t-1', owner, 'night-1', { force: true, note: 'BBVA lo confirma mañana' });
    const data = (prisma.venueNight.updateMany.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ pendingAtClose: 1, closeNote: 'BBVA lo confirma mañana' });
  });

  it('cerrar a mano pasadas las 08:00 → ya se cerró sola, con el Z hasta las 08:00', async () => {
    vi.setSystemTime(new Date('2026-10-14T07:30:00Z')); // 09:30 de Madrid
    const { svc, prisma } = makeService({ open: night() });
    prisma.venueNight.findFirst.mockResolvedValue(night({ closedAt: new Date('2026-10-14T06:00:00Z'), autoClosed: true }));
    await expect(svc.close('t-1', manager, 'night-1', { force: false })).rejects.toThrow(/se cerró sola a las 08:00/);
    const data = (prisma.venueNight.updateMany.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ autoClosed: true, closedAt: new Date('2026-10-14T06:00:00Z') });
  });

  it('ya cerrada (o cerrada a la vez por otro) → 409', async () => {
    const { svc } = makeService({ open: night({ closedAt: new Date() }) });
    await expect(svc.close('t-1', manager, 'night-1', { force: false })).rejects.toThrow(ConflictException);
    const race = makeService({ closedCount: 0 });
    await expect(race.svc.close('t-1', manager, 'night-1', { force: false })).rejects.toThrow(ConflictException);
  });
});

describe('cierre automático y noche de la chica', () => {
  it('a las 08:00 cierra sola la noche, con el Z hasta las 08:00', async () => {
    const { svc, prisma, reports } = makeService({ open: night() });
    const closed = await svc.autoCloseDue(undefined, new Date('2026-10-14T09:00:00Z'));
    expect(closed).toBe(1);
    const data = (prisma.venueNight.updateMany.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ autoClosed: true, closedAt: new Date('2026-10-14T06:00:00Z') });
    expect(reports.cobros).toHaveBeenCalledWith('t-1', { from: OPENED, to: new Date('2026-10-14T06:00:00Z') });
  });

  it('un local con un fallo no impide cerrar las noches de los demás', async () => {
    const { svc, prisma, reports } = makeService({ open: night() });
    prisma.venueNight.findMany.mockResolvedValueOnce([night({ id: 'n-a', tenantId: 't-a' }), night({ id: 'n-b', tenantId: 't-b' })]);
    reports.cobros.mockRejectedValueOnce(new Error('db blip'));
    expect(await svc.autoCloseDue(undefined, new Date('2026-10-14T09:00:00Z'))).toBe(1);
  });

  it('antes de las 08:00 no toca nada', async () => {
    const { svc, prisma } = makeService({ open: night() });
    expect(await svc.autoCloseDue(undefined, new Date('2026-10-14T05:00:00Z'))).toBe(0);
    expect(prisma.venueNight.updateMany).not.toHaveBeenCalled();
  });

  it('la chica ve sus cobros de la noche y su parte', async () => {
    const { svc, prisma } = makeService();
    prisma.$queryRaw.mockResolvedValueOnce([
      { count: 3, chargedCents: 31_500, commissionCents: 27_000, tipsCents: 1500, reversedCents: 0 },
    ]);
    const mine = await svc.mine('t-1', 'op-1');
    expect(mine).toMatchObject({ nightOpen: true, to: null, count: 3, netCents: 28_500, from: OPENED.toISOString() });
  });

  it('la noche ya cerrada: la chica sigue viendo esa noche hasta su cierre', async () => {
    const { svc, prisma } = makeService({ open: null });
    const closedAt = new Date('2026-10-14T00:30:00Z');
    prisma.venueNight.findFirst
      .mockResolvedValueOnce(null) // no hay noche abierta
      .mockResolvedValueOnce(night({ closedAt })) // la última, cerrada hace poco
      .mockResolvedValueOnce(null); // sin noche anterior: el Z empieza al abrir
    vi.setSystemTime(new Date('2026-10-14T01:00:00Z'));
    const mine = await svc.mine('t-1', 'op-1');
    expect(mine).toMatchObject({ nightOpen: false, from: OPENED.toISOString(), to: closedAt.toISOString() });
  });
});
