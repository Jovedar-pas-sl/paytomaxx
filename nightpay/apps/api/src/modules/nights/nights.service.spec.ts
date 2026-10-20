import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { NightCash, NightCloseCheck, NightCloseStep } from '@nightpay/contracts';
import { Prisma } from '@nightpay/db';
import { buildCloseSteps } from './close-check-rules';
import { settleWritesBefore } from './night-cutoff';
import { NightsService } from './nights.service';

// Esperar a lo abierto antes del corte va contra pg_stat_activity (night-cutoff.spec.ts y la
// prueba de integración cierre-carrera): aquí, «ya está todo a la vista».
vi.mock('./night-cutoff', async (original) => ({
  ...(await original<typeof import('./night-cutoff')>()),
  settleWritesBefore: vi.fn(async () => ({ settled: true, open: 0, waitedMs: 0 })),
}));
const settle = vi.mocked(settleWritesBefore);

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
    openingFloatCents: null,
    zReport: null,
    ...o,
  };
}

/** Un pago a una chica (operator_payouts) de la noche. */
function liquidacion(o: Record<string, unknown> = {}) {
  return {
    id: 'po-1',
    paidAt: OPENED,
    totalCents: 1000,
    externalRail: 'BIZUM',
    externalTxId: null,
    reconciliationStatus: 'PENDING',
    notes: null,
    operatorName: 'Lola',
    operatorEmail: 'lola@local.es',
    paidByName: null,
    paidByEmail: 'jefe@local.es',
    earningCount: 1,
    ...o,
  };
}

const NO_CASH: NightCash = {
  openingFloatCents: null,
  cashInCents: 0,
  walletCashPayoutsCount: 0,
  walletCashPayoutsCents: 0,
  chicaCashPayoutsCount: 0,
  chicaCashPayoutsCents: 0,
  cashOutCents: 0,
  expectedCents: 0,
};

/** Una noche con 50 € devueltos del saldo en efectivo y 90 € pagados en efectivo a una chica; fondo de 200 €. */
const CASH: NightCash = {
  openingFloatCents: 20_000,
  cashInCents: 0,
  walletCashPayoutsCount: 1,
  walletCashPayoutsCents: 5000,
  chicaCashPayoutsCount: 1,
  chicaCashPayoutsCents: 9000,
  cashOutCents: 14_000,
  expectedCents: 6000,
};

/** Los pasos del cierre con las reglas de verdad (todo en orden salvo lo que se cambie). */
function check(o: { cash?: NightCash; steps?: Partial<Record<NightCloseStep['key'], NightCloseStep['status']>> } = {}): NightCloseCheck {
  const cash = o.cash ?? NO_CASH;
  const steps = buildCloseSteps({
    now: new Date('2026-10-13T23:00:00Z'),
    holdDays: 0,
    payments: [],
    refunds: [],
    posStarted: [],
    posUnreconciled: [],
    pairedDevices: 0,
    walletPayouts: [],
    walletsToClose: [],
    cash,
    chicas: [],
    incidents: [],
  }).map((s) => (o.steps?.[s.key] ? { ...s, status: o.steps[s.key]! } : s));
  return {
    nightId: 'night-1',
    openedAt: OPENED.toISOString(),
    from: OPENED.toISOString(),
    generatedAt: '2026-10-13T23:00:00.000Z',
    holdDays: 0,
    steps,
    cash,
    chicas: [],
  };
}

function makeService(
  opts: { open?: ReturnType<typeof night> | null; pending?: unknown[]; closedCount?: number; check?: NightCloseCheck } = {},
) {
  const totp = { isEnabled: vi.fn().mockResolvedValue(true), assertForUser: vi.fn().mockResolvedValue(undefined) };
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
    withTenant: vi.fn().mockImplementation(async (_tenantId: string, fn: (tx: unknown) => unknown) => fn(prisma)),
    acrossVenues: vi.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  });
  const reports = {
    cobros: vi.fn().mockResolvedValue([]),
    devoluciones: vi.fn().mockResolvedValue([]),
    liquidaciones: vi.fn().mockResolvedValue([]),
    consumos: vi.fn().mockResolvedValue([]),
    pagosSaldo: vi.fn().mockResolvedValue([]),
    recargasEfectivo: vi.fn().mockResolvedValue([]),
    ajustes: vi.fn().mockResolvedValue({ cobros: [], devoluciones: [], consumosAnulados: [] }),
  };
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const checks = {
    check: vi.fn().mockResolvedValue(opts.check ?? check()),
    cash: vi.fn().mockResolvedValue((opts.check ?? check()).cash),
  };
  const svc = new NightsService(prisma as never, reports as never, audit as never, checks as never, totp as never);
  return { svc, prisma, reports, audit, checks, totp };
}

/** Datos con los que se cerró (updateMany de venue_nights). */
function closedData(prisma: ReturnType<typeof makeService>['prisma']): Record<string, unknown> & {
  zReport: { summary: Record<string, unknown>; caja?: Record<string, unknown> };
} {
  return (prisma.venueNight.updateMany.mock.calls[0]![0] as { data: never }).data;
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

  it('el Z congelado lleva el saldo devuelto: el efectivo resta del neto, la tarjeta solo se informa', async () => {
    const { svc, prisma, reports } = makeService();
    reports.pagosSaldo.mockResolvedValueOnce([
      { id: 'wp-1', at: OPENED, amountCents: 8000, method: 'CASH', paidByName: null, paidByEmail: 'jefe@local.es' },
      { id: 'wp-2', at: OPENED, amountCents: 3000, method: 'CARD', paidByName: null, paidByEmail: 'jefe@local.es' },
    ]);
    await svc.close('t-1', manager, 'night-1');
    expect(closedData(prisma).zReport.summary).toMatchObject({
      walletCashPayoutsCents: 8000,
      walletCardPayoutsCents: 3000,
      netCents: -8000,
    });
  });

  it('todo en orden: el encargado la cierra y congela el Z (sin efectivo, caja sin contar)', async () => {
    const { svc, prisma, audit, checks } = makeService();
    await svc.close('t-1', manager, 'night-1');
    const call = prisma.venueNight.updateMany.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(call.where).toEqual({ id: 'night-1', tenantId: 't-1', closedAt: null });
    expect(closedData(prisma)).toMatchObject({
      autoClosed: false,
      pendingAtClose: 0,
      cashExpectedCents: 0,
      cashCountedCents: null,
      cashDiffCents: null,
    });
    expect(closedData(prisma).zReport.caja).toMatchObject({ expectedCents: 0, countedCents: null });
    // Los pasos se recalculan al cerrar, con la misma ventana que el Z.
    // …y la caja sale de las mismas filas que el Z (no de otra lectura).
    expect(checks.check).toHaveBeenCalledWith('t-1', expect.objectContaining({ id: 'night-1' }), {
      from: OPENED,
      to: new Date('2026-10-13T23:00:00Z'),
    }, new Date('2026-10-13T23:00:00Z'), expect.objectContaining({ cashInCents: 0, cashOutCents: 0 }));
    expect(checks.cash).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'night.closed' }));
  });

  it('el fondo apuntado al abrir no se cambia al cerrar para cuadrar la caja: bloquea sin el 2FA del dueño', async () => {
    const recorded = { ...NO_CASH, openingFloatCents: 20_000, expectedCents: 20_000 };
    const { svc, prisma, totp } = makeService({ open: night({ openingFloatCents: 20_000 }), check: check({ cash: recorded }) });
    const typed = { openingFloatCents: 5000, cashCountedCents: 5000 };
    // El encargado teclea un fondo más bajo: bloquea (aunque así «cuadraría»).
    const err = await svc.close('t-1', manager, 'night-1', typed).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: 'NIGHT_CLOSE_BLOCKED', missing: ['efectivo'] });
    // Su código 2FA no vale: lo aprueba el dueño.
    await expect(svc.close('t-1', manager, 'night-1', { ...typed, totpCode: '123456' })).rejects.toThrow(ConflictException);
    expect(totp.assertForUser).not.toHaveBeenCalled();
    // El dueño sin código, tampoco.
    await expect(svc.close('t-1', { userId: 'own-1', role: 'OWNER' }, 'night-1', typed)).rejects.toThrow(ConflictException);
    expect(prisma.venueNight.updateMany).not.toHaveBeenCalled();
    // El dueño con su 2FA: se cierra con el fondo nuevo y el Z guarda los dos.
    await svc.close('t-1', { userId: 'own-1', role: 'OWNER' }, 'night-1', { ...typed, totpCode: '123456' });
    expect(totp.assertForUser).toHaveBeenCalledWith('own-1', '123456');
    expect(closedData(prisma).zReport.caja).toMatchObject({ openingFloatCents: 5000, recordedFloatCents: 20_000, diffCents: 0 });
    expect(closedData(prisma)).toMatchObject({ openingFloatCents: 5000 });
  });

  it('teclear el mismo fondo que se apuntó al abrir no es cambiarlo', async () => {
    const recorded = { ...NO_CASH, openingFloatCents: 20_000, expectedCents: 20_000 };
    const { svc, prisma } = makeService({ open: night({ openingFloatCents: 20_000 }), check: check({ cash: recorded }) });
    await svc.close('t-1', manager, 'night-1', { openingFloatCents: 20_000, cashCountedCents: 20_000 });
    expect(closedData(prisma).zReport.caja).toMatchObject({ openingFloatCents: 20_000, recordedFloatCents: 20_000 });
  });

  it('un paso que bloquea → 409 con los pasos, y no se cierra', async () => {
    const { svc, prisma } = makeService({ check: check({ steps: { cobros: 'block' } }) });
    const err = await svc.close('t-1', manager, 'night-1', { acknowledged: ['cobros'] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    const body = (err as ConflictException).getResponse() as { code: string; steps: NightCloseStep[]; missing: string[] };
    expect(body.code).toBe('NIGHT_CLOSE_BLOCKED');
    expect(body.missing).toEqual(['cobros']);
    expect(body.steps).toHaveLength(7);
    expect(prisma.venueNight.updateMany).not.toHaveBeenCalled();
  });

  it('avisos sin confirmar → 409 NIGHT_CLOSE_NEEDS_ACK; confirmados, se cierra', async () => {
    const { svc, prisma } = makeService({ check: check({ steps: { saldo: 'warn', incidencias: 'warn' } }) });
    const err = await svc.close('t-1', manager, 'night-1', { acknowledged: ['saldo'] }).catch((e: unknown) => e);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: 'NIGHT_CLOSE_NEEDS_ACK',
      missing: ['incidencias'],
    });
    expect(prisma.venueNight.updateMany).not.toHaveBeenCalled();
    await svc.close('t-1', manager, 'night-1', { acknowledged: ['saldo', 'incidencias'] });
    expect(prisma.venueNight.updateMany).toHaveBeenCalledTimes(1);
  });

  it('con cobros sin terminar: el encargado cierra confirmándolo y con nota (queda en pendingAtClose)', async () => {
    const { svc, prisma } = makeService({ pending: PENDING, check: check({ steps: { cobros: 'warn' } }) });
    await expect(svc.close('t-1', manager, 'night-1')).rejects.toThrow(/Confirma antes/);
    await expect(svc.close('t-1', manager, 'night-1', { acknowledged: ['cobros'] })).rejects.toThrow(
      BadRequestException,
    );
    await svc.close('t-1', manager, 'night-1', { acknowledged: ['cobros'], note: 'BBVA lo confirma mañana' });
    expect(closedData(prisma)).toMatchObject({ pendingAtClose: 1, closeNote: 'BBVA lo confirma mañana' });
  });

  it('con efectivo: sin contar no se cierra; contado y cuadrado, la caja va al Z y a la noche', async () => {
    const { svc, prisma } = makeService({ check: check({ cash: CASH }) });
    const err = await svc.close('t-1', manager, 'night-1').catch((e: unknown) => e);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: 'NIGHT_CLOSE_BLOCKED', missing: ['efectivo'] });

    await svc.close('t-1', manager, 'night-1', { cashCountedCents: 6000 });
    expect(closedData(prisma)).toMatchObject({
      openingFloatCents: 20_000,
      cashExpectedCents: 6000,
      cashCountedCents: 6000,
      cashDiffCents: 0,
    });
    expect(closedData(prisma).zReport.caja).toMatchObject({
      walletCashPayoutsCents: 5000,
      chicaCashPayoutsCents: 9000,
      expectedCents: 6000,
      countedCents: 6000,
      diffCents: 0,
    });
  });

  it('contado ≠ esperado: hay que confirmarlo y la diferencia queda congelada', async () => {
    const { svc, prisma, audit } = makeService({ check: check({ cash: CASH }) });
    await expect(svc.close('t-1', manager, 'night-1', { cashCountedCents: 4750 })).rejects.toThrow(/Faltan 12,50 €/);
    await svc.close('t-1', manager, 'night-1', {
      cashCountedCents: 4750,
      acknowledged: ['efectivo'],
      cashNote: 'cambio mal dado',
    });
    expect(closedData(prisma)).toMatchObject({ cashCountedCents: 4750, cashDiffCents: -1250, cashNote: 'cambio mal dado' });
    expect(closedData(prisma).zReport.caja).toMatchObject({ diffCents: -1250, note: 'cambio mal dado' });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ cash: expect.objectContaining({ diffCents: -1250 }) }),
      }),
    );
  });

  it('salió efectivo sin fondo apuntado: hay que decirlo al cerrar', async () => {
    const noFloat = { ...CASH, openingFloatCents: null, expectedCents: -14_000 };
    const { svc, prisma } = makeService({ check: check({ cash: noFloat }) });
    await expect(svc.close('t-1', manager, 'night-1', { cashCountedCents: 0 })).rejects.toThrow(/fondo/);
    await svc.close('t-1', manager, 'night-1', { openingFloatCents: 14_000, cashCountedCents: 0 });
    expect(closedData(prisma)).toMatchObject({ openingFloatCents: 14_000, cashExpectedCents: 0, cashDiffCents: 0 });
  });

  it('cerrar a mano pasadas las 08:00 → ya se cerró sola, con el Z hasta las 08:00', async () => {
    vi.setSystemTime(new Date('2026-10-14T07:30:00Z')); // 09:30 de Madrid
    const { svc, prisma } = makeService({ open: night() });
    prisma.venueNight.findFirst.mockResolvedValue(night({ closedAt: new Date('2026-10-14T06:00:00Z'), autoClosed: true }));
    await expect(svc.close('t-1', manager, 'night-1')).rejects.toThrow(/se cerró sola a las 08:00/);
    expect(closedData(prisma)).toMatchObject({ autoClosed: true, closedAt: new Date('2026-10-14T06:00:00Z') });
  });

  it('ya cerrada (o cerrada a la vez por otro) → 409', async () => {
    const { svc } = makeService({ open: night({ closedAt: new Date() }) });
    await expect(svc.close('t-1', manager, 'night-1')).rejects.toThrow(ConflictException);
    const race = makeService({ closedCount: 0 });
    await expect(race.svc.close('t-1', manager, 'night-1')).rejects.toThrow(ConflictException);
  });

  it('el corte: antes de leer las filas del Z se espera a lo empezado antes; el Z cuenta hasta ese corte y lo guarda', async () => {
    const { svc, prisma, reports } = makeService();
    const order: string[] = [];
    settle.mockImplementationOnce(async () => {
      order.push('settle');
      return { settled: true, open: 0, waitedMs: 0 };
    });
    reports.cobros.mockImplementationOnce(async () => {
      order.push('cobros');
      return [];
    });
    await svc.close('t-1', manager, 'night-1');
    const NOW = new Date('2026-10-13T23:00:00Z');
    expect(settle).toHaveBeenLastCalledWith(prisma, NOW);
    expect(order).toEqual(['settle', 'cobros']);
    expect(reports.cobros).toHaveBeenCalledWith('t-1', { from: OPENED, to: NOW }, { recordedBefore: NOW });
    // El cierre y el corte son el mismo instante: el Z siguiente empieza (y busca ajustes) justo ahí.
    expect(closedData(prisma)).toMatchObject({ closedAt: NOW });
    expect(closedData(prisma).zReport).toMatchObject({ to: NOW.toISOString(), generatedAt: NOW.toISOString() });
  });

  it('si algo sigue abierto pasado el plazo, se cierra igual y queda en el registro', async () => {
    const { svc, prisma } = makeService();
    settle.mockResolvedValueOnce({ settled: false, open: 1, waitedMs: 6000 });
    const warn = vi.spyOn((svc as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn').mockImplementation(() => undefined);
    await svc.close('t-1', manager, 'night-1');
    expect(prisma.venueNight.updateMany).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/1 transacción\(es\) de antes del corte .* siguen abiertas tras 6000 ms/));
  });
});

describe('los pasos del cierre y el fondo de caja', () => {
  it('sin noche abierta → 404', async () => {
    const { svc } = makeService({ open: null });
    await expect(svc.closeCheck('t-1')).rejects.toThrow(NotFoundException);
  });

  it('con la noche abierta: los pasos desde el inicio del Z hasta ahora', async () => {
    const { svc, checks } = makeService();
    const result = await svc.closeCheck('t-1');
    expect(result.steps).toHaveLength(7);
    expect(checks.check).toHaveBeenCalledWith(
      't-1',
      expect.objectContaining({ id: 'night-1', openingFloatCents: null }),
      { from: OPENED, to: new Date('2026-10-13T23:00:00Z') },
      new Date('2026-10-13T23:00:00Z'),
    );
  });

  it('abrir con fondo de caja: se guarda y se ve', async () => {
    const { svc, prisma } = makeService({ open: null });
    const view = await svc.open('t-1', 'u-1', 15_000);
    expect(prisma.venueNight.create).toHaveBeenCalledWith({
      data: { tenantId: 't-1', openedBy: 'u-1', openingFloatCents: 15_000 },
    });
    expect(view.openingFloatCents).toBe(15_000);
  });
});

describe('lo apuntado después de cerrar una noche: ajuste en el Z siguiente', () => {
  const manager = { userId: 'u-1', role: 'MANAGER' };
  // La noche anterior se cerró sola a las 08:00 y su Z se generó a las 08:10.
  const PREV_CLOSED = new Date('2026-10-13T06:00:00Z');
  const PREV_Z = new Date('2026-10-13T06:10:00Z');
  const NOW = new Date('2026-10-13T23:00:00Z');
  const LATE_COBRO = {
    id: 'p-late', paidAt: new Date('2026-10-13T05:30:00Z'), status: 'AUTHORIZED', amountCents: 5000, tipCents: 0,
    revenueCategory: 'VENUE_BAR', captureMethod: 'QR', serviceName: null, payMethod: null, payMethodCode: null,
    cardBrand: null, cardType: null, cardCountry: null, authCode: null, providerTxId: 'X', walletId: null,
    creatorName: null, creatorEmail: 'barra@local.es', earningOperatorName: null, earningOperatorEmail: null,
    refundedCents: 0, commissionCents: null, earningTipCents: null, reversedCents: null, reversedAfterPayoutCents: 0,
  };

  /** findFirst: la noche anterior (cerrada, con su Z) cuando se busca la cerrada; si no, la de hoy. */
  function withPrevious(prisma: ReturnType<typeof makeService>['prisma'], previous: unknown) {
    prisma.venueNight.findFirst.mockImplementation(async (args: { where: { closedAt?: unknown } }) => {
      const closed = args.where.closedAt;
      return closed && typeof closed === 'object' && 'not' in closed ? previous : night();
    });
  }

  it('un cobro que el banco confirma tarde (fecha de la noche ya cerrada) sale como ajuste del Z nuevo', async () => {
    const { svc, prisma, reports } = makeService();
    withPrevious(prisma, { closedAt: PREV_CLOSED, zReport: { generatedAt: PREV_Z.toISOString() } });
    reports.ajustes.mockResolvedValueOnce({ cobros: [LATE_COBRO], devoluciones: [], consumosAnulados: [] });
    await svc.close('t-1', manager, 'night-1');

    // Lo de antes de las 08:10 ya lo contó el Z anterior; lo de después con fecha anterior al cierre, aquí.
    expect(reports.ajustes).toHaveBeenCalledWith('t-1', { before: PREV_CLOSED, since: PREV_Z, until: NOW });
    expect(reports.cobros).toHaveBeenCalledWith('t-1', { from: PREV_CLOSED, to: NOW }, { recordedBefore: NOW });
    const data = (prisma.venueNight.updateMany.mock.calls[0]![0] as { data: { zReport: Record<string, unknown> } }).data;
    expect(data.zReport.adjustments).toMatchObject({
      since: PREV_Z.toISOString(),
      before: PREV_CLOSED.toISOString(),
      count: 1,
      summary: expect.objectContaining({ count: 1, chargedCents: 5000, netCents: 5000 }),
    });
    // El resumen de la noche es solo lo suyo.
    expect(data.zReport.summary).toMatchObject({ count: 0 });
  });

  it('primera noche del local: ajustes desde que se abrió', async () => {
    const { svc, prisma, reports } = makeService();
    withPrevious(prisma, null);
    await svc.close('t-1', manager, 'night-1');
    expect(reports.ajustes).toHaveBeenCalledWith('t-1', { before: OPENED, since: OPENED, until: NOW });
  });

  it('una noche cerrada enseña su Z congelado: no se recalcula', async () => {
    const frozen = { from: 'a', to: 'b', generatedAt: 'c', summary: { count: 7 }, pendingCount: 0 };
    const { svc, reports } = makeService({ open: night({ closedAt: PREV_CLOSED, zReport: frozen }) });
    const view = await svc.get('t-1', 'night-1');
    expect(view.z).toEqual(frozen);
    expect(reports.cobros).not.toHaveBeenCalled();
    expect(reports.ajustes).not.toHaveBeenCalled();
  });
});

describe('cierre automático y noche de la chica', () => {
  it('a las 08:00 cierra sola la noche, con el Z hasta las 08:00 y la caja sin contar', async () => {
    const { svc, prisma, reports, checks } = makeService({ open: night({ openingFloatCents: 20_000 }), check: check({ cash: CASH }) });
    // El efectivo sale de las mismas filas que el Z: 50 € de saldo y 90 € a una chica en efectivo.
    reports.pagosSaldo.mockResolvedValueOnce([
      { id: 'wp-1', at: OPENED, amountCents: 5000, method: 'CASH', paidByName: null, paidByEmail: 'jefe@local.es' },
    ]);
    reports.liquidaciones.mockResolvedValueOnce([liquidacion({ totalCents: 9000, externalRail: 'MANUAL_CASH' })]);
    const closed = await svc.autoCloseDue(undefined, new Date('2026-10-14T09:00:00Z'));
    expect(closed).toBe(1);
    expect(closedData(prisma)).toMatchObject({
      autoClosed: true,
      closedAt: new Date('2026-10-14T06:00:00Z'),
      cashExpectedCents: 6000,
      cashCountedCents: null,
      cashDiffCents: null,
    });
    expect(closedData(prisma).zReport.caja).toMatchObject({ expectedCents: 6000, countedCents: null });
    expect(closedData(prisma).zReport.summary).toMatchObject({ walletCashPayoutsCents: 5000, payoutsCents: 9000 });
    expect(checks.cash).not.toHaveBeenCalled();
    // Hasta las 08:00 por fecha; y solo lo apuntado antes de generar el Z (09:00).
    expect(reports.cobros).toHaveBeenCalledWith(
      't-1',
      { from: OPENED, to: new Date('2026-10-14T06:00:00Z') },
      { recordedBefore: new Date('2026-10-14T09:00:00Z') },
    );
  });

  it('un local con un fallo no impide cerrar las noches de los demás', async () => {
    const { svc, prisma, reports } = makeService({ open: night() });
    prisma.venueNight.findMany.mockResolvedValueOnce([night({ id: 'n-a', tenantId: 't-a' }), night({ id: 'n-b', tenantId: 't-b' })]);
    reports.cobros.mockRejectedValueOnce(new Error('db blip'));
    expect(await svc.autoCloseDue(undefined, new Date('2026-10-14T09:00:00Z'))).toBe(1);
  });

  it('cerrándose sola, el corte de lo apuntado es cuando se genera: antes de leer, se espera a lo empezado antes', async () => {
    const { svc, prisma } = makeService({ open: night() });
    settle.mockClear();
    const at = new Date('2026-10-14T09:00:00Z');
    expect(await svc.autoCloseDue(undefined, at)).toBe(1);
    expect(settle).toHaveBeenCalledWith(prisma, at);
    expect(closedData(prisma).zReport).toMatchObject({ to: '2026-10-14T06:00:00.000Z', generatedAt: at.toISOString() });
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

  it('la noche de la chica no cuenta consumos del saldo anulados y descuenta su deuda por devoluciones', async () => {
    const { svc, prisma } = makeService();
    const sqls: string[] = [];
    prisma.$queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      sqls.push(Prisma.sql(strings, ...values).text);
      return [{ count: 0, chargedCents: 0, commissionCents: 0, tipsCents: 0, reversedCents: 0 }];
    });
    await svc.mine('t-1', 'op-1');
    const sql = sqls.find((s) => s.includes('wallet_consumptions'))!;
    const consumos = sql.slice(sql.indexOf('JOIN wallet_consumptions'));
    expect(consumos).toContain('c."reversedAt" IS NULL');
    expect(sql).toContain('"afterPayout"');
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

  it('lo que aún no se le ha pagado, partido en esta noche y otras noches (mismo tramo que la noche)', async () => {
    const { svc, prisma } = makeService();
    const queries: Array<{ text: string; values: unknown[] }> = [];
    prisma.$queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = Prisma.sql(strings, ...values);
      queries.push({ text: sql.text, values: sql.values });
      return sql.text.includes('"otherUnpaidCents"')
        ? [{ unpaidCents: 12_000, otherUnpaidCents: 8_500 }]
        : [{ count: 2, chargedCents: 20_000, commissionCents: 12_000, tipsCents: 0, reversedCents: 0 }];
    });
    const mine = await svc.mine('t-1', 'op-1');
    expect(mine).toMatchObject({ netCents: 12_000, unpaidCents: 12_000, otherUnpaidCents: 8_500 });
    const split = queries.find((q) => q.text.includes('"otherUnpaidCents"'))!;
    expect(split.text).toContain('"payoutId" IS NULL');
    expect(split.values).toEqual(
      expect.arrayContaining([OPENED, new Date('2026-10-13T23:00:00Z'), 't-1', 'op-1']),
    );
  });

  it('invitada a una copa: lo cobrado cuenta solo su parte (el cobro entero, solo si lo cobró ella), y sus invitaciones', async () => {
    const { svc, prisma } = makeService();
    const queries: Array<{ text: string; values: unknown[] }> = [];
    prisma.$queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = Prisma.sql(strings, ...values);
      queries.push({ text: sql.text, values: sql.values });
      if (sql.text.includes('"beneficiaryOperatorId"')) return [{ count: 6, shareCents: 6_000 }];
      if (sql.text.includes('"otherUnpaidCents"')) return [{ unpaidCents: 0, otherUnpaidCents: 0 }];
      return [{ count: 6, chargedCents: 6_000, commissionCents: 6_000, tipsCents: 0, reversedCents: 0 }];
    });
    const mine = await svc.mine('t-1', 'op-1');
    expect(mine.invitations).toEqual({ count: 6, shareCents: 6_000 });
    const main = queries.find((q) => q.text.includes('AS "chargedCents"'))!;
    // Tarjeta y saldo: el importe entero solo si el cobro es suyo; si no, su parte.
    expect(main.text).toContain('CASE WHEN p."createdByUserId" = $');
    expect(main.text).toContain('CASE WHEN c."providedByUserId" = $');
    expect(main.text).toContain('ELSE e."commissionCents" + e."tipCents" END');
    const inv = queries.find((q) => q.text.includes('"beneficiaryOperatorId"'))!;
    expect(inv.text).toContain('c."reversedAt" IS NULL');
    expect(inv.values).toEqual(expect.arrayContaining(['t-1', 'op-1', OPENED]));
  });

  it('sin nada pendiente de pago: ceros, no undefined', async () => {
    const { svc, prisma } = makeService();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ count: 0, chargedCents: 0, commissionCents: 0, tipsCents: 0, reversedCents: 0 }])
      .mockResolvedValueOnce([{ unpaidCents: null, otherUnpaidCents: null }]);
    const mine = await svc.mine('t-1', 'op-1');
    expect(mine.unpaidCents).toBe(0);
    expect(mine.otherUnpaidCents).toBe(0);
  });
});
