import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@nightpay/db';
import { PartyLiveQuerySchema, PartySettlementQuerySchema, type JwtPayload } from '@nightpay/contracts';
import { PartyEditionGuard } from './party-edition.guard';
import { NO_DEBTOR_IBAN_CODE, NO_TRANSFERS_CODE, PartyPanelService } from './party-panel.service';

/**
 * El servicio del panel con la base simulada: lee todo dentro de withTenant
 * (FORCE RLS), arma el directo, la caja de la taquilla, la liquidación y el
 * fichero SEPA (con su registro). Las cuentas, en party-live-rules.spec y
 * party-settlement-rules.spec.
 */

const T = 't-1';
const NOW = new Date('2027-06-23T23:47:00Z');
const IBAN = 'ES9121000418450200051332';
const STALL_IBAN = 'ES7921000813610123456789';
const owner = { sub: 'owner-1', email: 'org@fiesta.es', role: 'OWNER', tenantId: T, venueSlug: 'fiesta' } as JwtPayload;

const STALLS = [
  { id: 'a', name: 'Peña El Cántaro', managerName: 'Ana', managerContact: null, organizerBps: 1000, iban: STALL_IBAN, active: true, sortOrder: 0 },
  { id: 'b', name: 'Barra propia', managerName: 'Comisión', managerContact: null, organizerBps: 10_000, iban: null, active: true, sortOrder: 1 },
  { id: 'c', name: 'Churrería', managerName: 'Paqui', managerContact: null, organizerBps: 800, iban: null, active: true, sortOrder: 2 },
];

/** Respuestas de cada consulta, por un trozo de su SQL. */
interface Answers {
  sales?: unknown[];
  card?: unknown[];
  cash?: unknown[];
  payouts?: unknown[];
  payoutsTotal?: unknown[];
  wristbands?: unknown[];
}

function make(venue: Record<string, unknown> = {}, answers: Answers = {}) {
  const sql: string[] = [];
  const values: unknown[][] = [];
  const queryRaw = vi.fn(async (strings: TemplateStringsArray, ...vals: unknown[]) => {
    // Con los trozos de dentro (la ventana, la persona) ya en su sitio.
    const q = Prisma.sql(strings, ...(vals as Prisma.Sql[]));
    const text = q.sql;
    sql.push(text);
    values.push(q.values);
    if (text.includes('WITH ventas')) return answers.sales ?? [];
    if (text.includes('client_wallets')) return answers.wristbands ?? [{ cents: 0n, active: 0 }];
    if (text.includes('wallet_cash_topups')) return answers.cash ?? [];
    if (text.includes('"paidByUserId"::text')) return answers.payouts ?? [];
    if (text.includes('wallet_payouts')) return answers.payoutsTotal ?? [{ cents: 0n }];
    if (text.includes('"walletId" IS NOT NULL')) return answers.card ?? [];
    throw new Error(`consulta inesperada: ${text}`);
  });
  const tx = {
    $queryRaw: queryRaw,
    stall: { findMany: vi.fn().mockResolvedValue(STALLS) },
    user: { findMany: vi.fn().mockResolvedValue([{ id: 'u-1', displayName: 'Lucía', email: 'lucia@fiesta.es' }]) },
    terminal: { findMany: vi.fn().mockResolvedValue([]) },
    venue: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        name: 'Fiestas de San Juan',
        cashAlertCents: 200_000,
        eventStartsAt: new Date('2027-06-23T18:00:00Z'),
        eventEndsAt: new Date('2027-06-25T04:00:00Z'),
        settlementIban: IBAN,
        settlementHolder: 'Comisión de Fiestas',
        ...venue,
      }),
    },
  };
  const prisma = {
    withTenant: vi.fn(async (_t: string, fn: (t: typeof tx) => unknown) => fn(tx)),
    asSystem: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const svc = new PartyPanelService(prisma as never, audit as never);
  return { svc, tx, prisma, audit, sql, values };
}

const SALES = [
  { stallId: 'a', hour: BigInt(Math.floor(NOW.getTime() / 3_600_000)), cents: 792_000n, count: 1102, lastAt: new Date('2027-06-23T23:45:00Z'), refunded: 0n, lastHour: 9_000n },
  { stallId: 'b', hour: 0n, cents: 326_000n, count: 512, lastAt: null, refunded: 0n, lastHour: 0n },
  { stallId: 'c', hour: 0n, cents: 184_000n, count: 233, lastAt: null, refunded: 0n, lastHour: 0n },
];

const liveQuery = (q: Record<string, unknown> = {}) => PartyLiveQuerySchema.parse(q);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('en directo', () => {
  it('todo dentro de withTenant (FORCE RLS), con el local explícito; las taquillas con su nombre', async () => {
    const { svc, prisma, sql, values, tx } = make({}, {
      sales: SALES,
      card: [{ kind: 'phone', who: null, cents: 260_000n, count: 52, lastHour: 0n }],
      cash: [{ kind: 'person', who: 'u-1', cents: 624_000n, fee: 0n, count: 300, lastHour: 0n }],
      wristbands: [{ cents: 433_000n, active: 1212 }],
    });
    const live = await svc.live(T, liveQuery(), NOW);
    expect(prisma.withTenant).toHaveBeenCalledWith(T, expect.any(Function), expect.objectContaining({ timeout: 30_000 }));
    expect(sql.every((s) => s.includes('"tenantId" = '))).toBe(true);
    expect(values.every((v) => v.includes(T))).toBe(true);
    expect(tx.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: T, id: { in: ['u-1'] } } }));
    expect(tx.terminal.findMany).not.toHaveBeenCalled();
    expect(live).toMatchObject({
      scope: 'night',
      night: '2027-06-23',
      live: true,
      from: '2027-06-23T06:00:00.000Z',
      loaded: { totalCents: 884_000, cashCents: 624_000, cardCents: 0, phoneCents: 260_000 },
      sold: { totalCents: 1_302_000, count: 1847, refundedCents: 0 },
      inWristbandsCents: 433_000,
      activeWristbands: 1212,
      cashAlertCents: 200_000,
    });
    expect(live.desks.map((d) => d.name)).toEqual(['Lucía', 'Desde el móvil']);
    expect(live.alerts).toEqual([{ kind: 'CASH_OVER', deskKey: 'person:u-1', name: 'Lucía', cashCents: 624_000, thresholdCents: 200_000 }]);
    expect(live.event.nights).toEqual([
      { day: '2027-06-23', current: true },
      { day: '2027-06-24', current: false },
    ]);
  });

  it('la fiesta entera: sin principio (también lo cargado desde casa antes), sin avisos', async () => {
    const { svc, sql } = make({}, { sales: SALES });
    const live = await svc.live(T, liveQuery({ scope: 'event' }), NOW);
    expect(live).toMatchObject({ scope: 'event', night: null, from: null, live: true, alerts: [] });
    // Sin «>= from»: solo el final de la ventana (la noche sí lo lleva).
    expect(sql.find((s) => s.includes('WITH ventas'))).not.toMatch(/>= \? AND/);
    const night = make({}, { sales: SALES });
    await night.svc.live(T, liveQuery(), NOW);
    expect(night.sql.find((s) => s.includes('WITH ventas'))).toMatch(/>= \? AND/);
  });

  it('una noche concreta y el aviso de N minutos llegan de la URL', async () => {
    const { svc } = make();
    const q = liveQuery({ night: '2027-06-22', idleMin: '30' });
    expect(q.idleMin).toBe(30);
    const live = await svc.live(T, q, NOW);
    expect(live).toMatchObject({ night: '2027-06-22', live: false, idleMinutes: 30, from: '2027-06-22T06:00:00.000Z', to: '2027-06-23T06:00:00.000Z' });
  });

  it('la consulta: de serie, esta noche y 15 min; mal formada, error', () => {
    expect(liveQuery()).toEqual({ scope: 'night', idleMin: 15 });
    expect(PartyLiveQuerySchema.safeParse({ idleMin: '0' }).success).toBe(false);
    expect(PartyLiveQuerySchema.safeParse({ idleMin: '241' }).success).toBe(false);
    expect(PartyLiveQuerySchema.safeParse({ night: '2027-02-30' }).success).toBe(false);
    expect(PartyLiveQuerySchema.safeParse({ scope: 'mes' }).success).toBe(false);
  });
});

describe('la caja de la taquilla (cash-desk/me)', () => {
  it('solo lo de esa persona en la noche de ahora: recargas en efectivo + comisión − saldo devuelto en efectivo', async () => {
    const { svc, values, sql } = make({}, {
      cash: [{ kind: 'person', who: 'u-1', cents: 210_000n, fee: 4_000n, count: 21, lastHour: 0n }],
      payouts: [{ who: 'u-1', cents: 3_000n, count: 1 }],
    });
    const desk = await svc.cashDesk(T, 'u-1', NOW);
    expect(desk).toEqual({
      from: '2027-06-23T06:00:00.000Z',
      to: NOW.toISOString(),
      cashInCents: 214_000,
      topUpsCount: 21,
      cashOutCents: 3_000,
      payoutsCount: 1,
      cashCents: 211_000,
      alertCents: 200_000,
      overAlert: true,
    });
    expect(sql.every((s) => s.includes('"takenByUserId" = ') || s.includes('"paidByUserId" = '))).toBe(true);
    expect(values.every((v) => v.includes('u-1'))).toBe(true);
  });

  it('por debajo del umbral, o con el umbral a 0, sin aviso', async () => {
    const low = make({}, { cash: [{ kind: 'person', who: 'u-1', cents: 1_000n, fee: 0n, count: 1, lastHour: 0n }] });
    expect((await low.svc.cashDesk(T, 'u-1', NOW)).overAlert).toBe(false);
    const off = make({ cashAlertCents: 0 }, { cash: [{ kind: 'person', who: 'u-1', cents: 999_000n, fee: 0n, count: 1, lastHour: 0n }] });
    expect((await off.svc.cashDesk(T, 'u-1', NOW)).overAlert).toBe(false);
  });
});

describe('la liquidación y su fichero', () => {
  const answers: Answers = {
    sales: SALES,
    card: [{ kind: 'person', who: 'u-1', cents: 1_000_000n, count: 10, lastHour: 0n }],
    cash: [{ kind: 'person', who: 'u-1', cents: 500_000n, fee: 0n, count: 5, lastHour: 0n }],
    payoutsTotal: [{ cents: 120_000n }],
    wristbands: [{ cents: 78_000n, active: 3 }],
  };

  it('por caseta, con lo que sobró en las pulseras', async () => {
    const { svc } = make({}, answers);
    const s = await svc.settlement(T, PartySettlementQuerySchema.parse({}), NOW);
    expect(s.rows.map((r) => [r.name, r.soldCents, r.organizerCents, r.toPayCents, r.status])).toEqual([
      ['Peña El Cántaro', 792_000, 79_200, 712_800, 'READY'],
      ['Barra propia', 326_000, 326_000, 0, 'OWN_BAR'],
      ['Churrería', 184_000, 14_720, 169_280, 'NO_IBAN'],
    ]);
    expect(s.wristbands).toEqual({ loadedCents: 1_500_000, refundedCents: 120_000, leftCents: 78_000 });
    expect(s.debtor).toEqual({ name: 'Comisión de Fiestas', ibanMasked: 'ES91 •••• •••• 1332' });
    expect(s).toMatchObject({ from: null, fromNight: null, eventName: 'Fiestas de San Juan' });
  });

  it('unas noches: de las 08:00 de la primera a las 08:00 del día siguiente a la última', async () => {
    const { svc } = make({}, answers);
    const s = await svc.settlement(T, PartySettlementQuerySchema.parse({ from: '2027-06-20', to: '2027-06-21' }), NOW);
    expect(s).toMatchObject({ from: '2027-06-20T06:00:00.000Z', to: '2027-06-22T06:00:00.000Z', fromNight: '2027-06-20', toNight: '2027-06-21' });
    expect(PartySettlementQuerySchema.safeParse({ from: '2027-06-20' }).success).toBe(false);
    expect(PartySettlementQuerySchema.safeParse({ from: '2027-06-21', to: '2027-06-20' }).success).toBe(false);
  });

  it('el SEPA: solo las casetas con IBAN y algo que pagar, el deudor es el local y queda en el registro', async () => {
    const { svc, audit } = make({}, answers);
    const { xml, settlement } = await svc.sepa(owner, PartySettlementQuerySchema.parse({}), NOW);
    expect(xml).toContain(`<IBAN>${IBAN}</IBAN>`);
    expect(xml).toContain(`<IBAN>${STALL_IBAN}</IBAN>`);
    expect(xml.match(/<CdtTrfTxInf>/g)).toHaveLength(1);
    expect(xml).toContain('<InstdAmt Ccy="EUR">7128.00</InstdAmt>');
    expect(xml).toContain('<Ustrd>OxioParty Fiestas de San Juan Pena El Cantaro</Ustrd>');
    expect(xml).toContain('<Dbtr><Nm>Comision de Fiestas</Nm></Dbtr>');
    expect(xml).toContain('<ReqdExctnDt>2027-06-24</ReqdExctnDt>');
    expect(settlement.totals.transfers).toBe(1);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'party.settlement.sepa_exported',
        tenantId: T,
        actorId: 'owner-1',
        payload: expect.objectContaining({ transfers: 1, totalCents: 712_800, fromNight: null }),
      }),
    );
    // Ni el IBAN entero ni el XML en el registro.
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain(STALL_IBAN);
  });

  it('sin la cuenta del local, 409 NO_DEBTOR_IBAN (sin registro)', async () => {
    const { svc, audit } = make({ settlementIban: null }, answers);
    await expect(svc.sepa(owner, PartySettlementQuerySchema.parse({}), NOW)).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: NO_DEBTOR_IBAN_CODE }),
    });
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('sin ninguna caseta que pagar, 409 NO_TRANSFERS', async () => {
    const { svc } = make({}, { ...answers, sales: [] });
    await expect(svc.sepa(owner, PartySettlementQuerySchema.parse({}), NOW)).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: NO_TRANSFERS_CODE }),
    });
  });
});

describe('solo con OxioParty', () => {
  it('con EDITION=club las rutas del panel no existen (404); con party, sí', () => {
    vi.stubEnv('EDITION', 'club');
    expect(() => new PartyEditionGuard().canActivate()).toThrow(NotFoundException);
    vi.stubEnv('EDITION', 'party');
    expect(new PartyEditionGuard().canActivate()).toBe(true);
  });
});
