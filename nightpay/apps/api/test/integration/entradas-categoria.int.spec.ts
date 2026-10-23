// Integración (Postgres real, np_app): las Entradas (VENUE_ENTRY) se cobran y suman.
//
// Hasta la migración 20261028000000_entradas_categoria, el CHECK de
// payments.revenueCategory no admitía VENUE_ENTRY (payment_lines sí): un cobro
// en el que las entradas son la sección con más importe (la que se guarda en
// el cobro) daba 500 al crearlo. Aquí: «Cobrar → Entrada» y «Otro importe →
// Entradas» con tarjeta (QR), la recepción con la app antigua, el cobro único
// pagado con el NFC del cliente y el cobro solo del saldo; que las entradas
// salen en el Z de la noche, el Z del periodo, el mapa del dinero, la lista de
// cobros y el libro de cobros (CSV); que el CHECK admite todas las secciones
// de SECTION_CODES (check-drift no mira los CHECK: si se añade una sección sin
// migración, falla aquí); y que la migración sustituye el CHECK antiguo sin
// tocar datos, se puede repetir y no rompe el despliegue con filas raras.
// Ver README.md.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ClsService } from 'nestjs-cls';
import { CobrosQuerySchema, LEGACY_SECTION, SECTION_CODES } from '@nightpay/contracts';
import { Prisma } from '@nightpay/db';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { WalletChargesService } from '../../src/modules/wallets/wallet-charges.service';
import { CartaService } from '../../src/modules/carta/carta.service';
import { CobrosService } from '../../src/modules/money-map/cobros.service';
import { MoneyMapService } from '../../src/modules/money-map/money-map.service';
import { ReportsService } from '../../src/modules/reports/reports.service';
import { PeriodReportsService } from '../../src/modules/reports/period-reports.service';
import { cobrosCsv } from '../../src/modules/reports/export-csv';
import { IncidentsService } from '../../src/modules/incidents/incidents.service';
import { CloseCheckService } from '../../src/modules/nights/close-check.service';
import { NightsService } from '../../src/modules/nights/nights.service';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const audit = { log: vi.fn(async () => undefined) };
const queue = { add: vi.fn(async () => undefined) };
const config = { get: () => undefined, getOrThrow: () => undefined };
const payments = new PaymentsService(
  prisma as never,
  cls as never,
  queue as never,
  queue as never,
  {} as never,
  { emitPaymentUpdate: vi.fn(), emitPaymentCompleted: vi.fn() } as never,
  { paymentsCreated: { inc: vi.fn() }, paymentsTransitioned: { inc: vi.fn() }, walletCreditSkipped: { inc: vi.fn() } } as never,
  {} as never,
  {} as never,
);
const charges = new WalletChargesService(prisma as never, audit as never, { get: () => ({}) } as never, {} as never);
const carta = new CartaService(prisma as never, audit as never);
const cobros = new CobrosService(prisma);
const reports = new ReportsService(prisma);
const period = new PeriodReportsService(prisma);
const moneyMap = new MoneyMapService(prisma, reports, config as never);
const checks = new CloseCheckService(prisma, new IncidentsService(prisma, audit as never), config as never);
const nights = new NightsService(prisma, reports, audit as never, checks, undefined, moneyMap);
// La noche se abre «hace 2 h»: que el cierre automático de las 08:00 no se cruce con la prueba.
vi.spyOn(nights as unknown as { safeAutoClose(t: string): Promise<void> }, 'safeAutoClose').mockResolvedValue(undefined);

const DB_PKG = join(__dirname, '../../../../packages/db');
const MIGRATION = join(DB_PKG, 'prisma/migrations/20261028000000_entradas_categoria/migration.sql');
const OLD_CHECK = `"revenueCategory" IN ('CHICA_SERVICE', 'VENUE_BAR', 'VENUE_ROOM', 'VENUE_FOOD', 'EXTRA')`;

const inVenue = <T>(tenantId: string | undefined, fn: () => Promise<T>): Promise<T> =>
  cls.run(async () => {
    cls.set('ctx', { tenantId, traceId: 't' });
    return fn();
  });
const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) =>
  inVenue(undefined, () => prisma.asSystem(fn));

const r = randomUUID().slice(0, 6);
const HOUR = 60 * 60_000;
const ago = (ms: number) => new Date(Date.now() - ms);
// La hora de la base puede ir unos ms por delante de la de Node.
const soon = () => new Date(Date.now() + 1_000);
let V: string, owner: string, carlos: string, rocio: string, entrada: string, copa: string;
// Sondas del CHECK, en otro local (no salen en los informes de V).
let P: string, probeTerm: string, probePayment: string, probeLine: string;
let n = 0;
const key = () => `en-${r}-${(n += 1)}`;
// Carlos: camarero sin puesto (Barra: Copas, Entradas y Comida). Rocío: recepción (todo; por defecto, Entradas).
const asCarlos = () => ({ userId: carlos, role: 'WAITER' as const });
const carlosActor = () => ({ userId: carlos, role: 'WAITER' as const, tenantId: V });
const body = (o: Record<string, unknown>) => ({ currency: 'EUR', terminalExternalId: `EN-${r}`, ...o }) as never;

/** Lo que manda «Cobrar» en la app nueva: líneas y el cobro del saldo enlazado (cobro único). */
const cobrar = (lines: unknown[], creator = asCarlos()) =>
  inVenue(V, () => payments.create(V, key(), body({ lines, withSaldo: true }), creator));

/** El cliente pagó con su tarjeta en el banco (Redsys) y llega la aprobación. */
async function approveCard(paymentId: string, order: string, amountCents: number): Promise<void> {
  await sys(async (tx) => {
    await tx.payment.update({ where: { id: paymentId }, data: { status: 'AUTHORIZING', provider: 'REDSYS', providerTxId: order } });
    await tx.paymentAttempt.create({ data: { paymentId, tenantId: V, provider: 'REDSYS', providerTxId: order, amountCents, tipCents: 0 } });
  });
  await inVenue(undefined, () => payments.transition(paymentId, { type: 'AUTHORIZED', provider: 'REDSYS', providerTxId: order }));
}

function code6(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from(randomBytes(6), (b) => alphabet[b % alphabet.length]).join('');
}

/** Saldo del cliente con su NFC (y su número de serie) y su PIN. */
async function walletWithNfc(balanceCents: number): Promise<{ id: string; card: string; uid: string }> {
  n += 1;
  const card = randomBytes(16).toString('base64url');
  const uid = randomBytes(7).toString('hex').toUpperCase();
  const id = await sys(async (tx) => {
    const w = await tx.clientWallet.create({
      data: { tenantId: V, balanceCents, qrToken: `en-${r}-${n}-abcdefgh`, shortCode: code6(), walletGroup: `gen-${r}` },
    });
    await tx.walletCard.create({ data: { token: card, uid, walletId: w.id, status: 'ISSUED', venueId: V } });
    return w.id;
  });
  await inVenue(undefined, () => charges.setPinFromPayer(id, '4827'));
  return { id, card, uid };
}

const payNfc = (chargeId: string, w: { card: string; uid: string }) =>
  inVenue(V, () => charges.payQrChargeWithCard(carlosActor(), chargeId, { card: w.card, uid: w.uid }));

// Lo cobrado, para los informes de abajo: cobros con tarjeta pagados y cobros del saldo pagados.
const paid: { card: string[]; saldo: string[]; mixed: string | null } = { card: [], saldo: [], mixed: null };

beforeAll(async () => {
  await prisma.onModuleInit();
  await sys(async (tx) => {
    V = (await tx.venue.create({ data: { name: 'Sala Taquilla', slug: `en-${r}`, walletGroup: `gen-${r}` } })).id;
    owner = (await tx.user.create({ data: { tenantId: V, email: `own-en-${r}@x.es`, passwordHash: 'x', role: 'OWNER' } })).id;
    carlos = (
      await tx.user.create({ data: { tenantId: V, email: `carlos-en-${r}@x.es`, passwordHash: 'x', role: 'WAITER', displayName: 'Carlos' } })
    ).id;
    rocio = (
      await tx.user.create({
        data: { tenantId: V, email: `rocio-en-${r}@x.es`, passwordHash: 'x', role: 'WAITER', displayName: 'Rocío', post: 'RECEPCION' },
      })
    ).id;
    await tx.terminal.create({ data: { tenantId: V, externalId: `EN-${r}`, label: 'Taquilla' } });
    // La noche, abierta hace 2 h.
    await tx.venueNight.create({ data: { tenantId: V, openedAt: ago(2 * HOUR), openedBy: owner } });
    // Un cobro antiguo («Otros») con una línea, para probar el CHECK sin depender de los de arriba.
    P = (await tx.venue.create({ data: { name: 'Sondas', slug: `en-p-${r}` } })).id;
    probeTerm = (await tx.terminal.create({ data: { tenantId: P, externalId: `ENP-${r}`, label: 'Sonda' } })).id;
    probePayment = (
      await tx.payment.create({
        data: {
          tenantId: P,
          terminalId: probeTerm,
          idempotencyKey: key(),
          amountCents: 100,
          availableAmountCents: 100,
          qrToken: `en-probe-${r}`,
          qrExpiresAt: ago(-HOUR),
          status: 'CANCELED',
          revenueCategory: LEGACY_SECTION,
        },
      })
    ).id;
    probeLine = (
      await tx.paymentLine.create({
        data: { tenantId: P, paymentId: probePayment, category: 'VENUE_BAR', label: 'Sonda', unitCents: 100, amountCents: 100 },
      })
    ).id;
  });
  // La carta de fábrica trae «Entrada» (15 €) en Entradas.
  entrada = (await inVenue(V, () => carta.create(V, owner, { name: 'Entrada', priceCents: 1_500, category: 'VENUE_ENTRY' }))).id;
  copa = (await inVenue(V, () => carta.create(V, owner, { name: 'Copa', priceCents: 1_000, category: 'VENUE_BAR' }))).id;
});

afterAll(async () => {
  // Las pruebas de la migración cambian el CHECK: pase lo que pase, se deja
  // como lo dejan las migraciones (para los demás ficheros de esta base).
  try {
    if (existsSync(MIGRATION)) {
      const restored = runMigration();
      if (restored.status !== 0) throw new Error(`el CHECK no ha quedado como lo deja la migración:\n${restored.out}`);
    }
  } finally {
    await prisma.$disconnect();
  }
});

describe('solo entradas con tarjeta (QR): se crea el cobro (antes, 500)', () => {
  it('«Cobrar» → «Entrada» → Cobrar 15 €: cobro en Entradas, con su cobro del saldo enlazado', async () => {
    const c = await cobrar([{ serviceItemId: entrada, qty: 1 }]);
    expect(c.amountCents).toBe(1_500);
    expect(c.lines?.map((l) => [l.category, l.amountCents])).toEqual([['VENUE_ENTRY', 1_500]]);
    const p = await sys((tx) => tx.payment.findUniqueOrThrow({ where: { id: c.id } }));
    expect(p).toMatchObject({ revenueCategory: 'VENUE_ENTRY', serviceName: 'Entrada', status: 'CREATED' });
    const saldo = await sys((tx) => tx.walletChargeRequest.findUniqueOrThrow({ where: { id: c.saldo!.chargeId } }));
    expect(saldo).toMatchObject({ category: 'VENUE_ENTRY', amountCents: 1_500, status: 'PENDING' });
    await approveCard(c.id, `EN${r}1`, 1_500);
    expect((await sys((tx) => tx.payment.findUniqueOrThrow({ where: { id: c.id } }))).status).toBe('AUTHORIZED');
    paid.card.push(c.id);
  });

  it('«Otro importe» → Entradas 15 €', async () => {
    const c = await cobrar([{ category: 'VENUE_ENTRY', amountCents: 1_500 }]);
    expect(c.lines).toEqual([
      { category: 'VENUE_ENTRY', label: 'Otro importe', qty: 1, unitCents: 1_500, amountCents: 1_500, serviceItemId: null },
    ]);
    expect((await sys((tx) => tx.payment.findUniqueOrThrow({ where: { id: c.id } }))).revenueCategory).toBe('VENUE_ENTRY');
    await approveCard(c.id, `EN${r}2`, 1_500);
    paid.card.push(c.id);
  });

  it('recepción con la app antigua (un importe, sin sección): la de su puesto, Entradas', async () => {
    const c = await inVenue(V, () => payments.create(V, key(), body({ amountCents: 2_000 }), { userId: rocio, role: 'WAITER' }));
    expect(c.lines?.map((l) => [l.category, l.amountCents])).toEqual([['VENUE_ENTRY', 2_000]]);
    expect((await sys((tx) => tx.payment.findUniqueOrThrow({ where: { id: c.id } }))).revenueCategory).toBe('VENUE_ENTRY');
    await approveCard(c.id, `EN${r}3`, 2_000);
    paid.card.push(c.id);
  });

  it('2 entradas y una copa: el cobro va a Entradas (la de más importe) y cada línea a la suya', async () => {
    const c = await cobrar([
      { serviceItemId: entrada, qty: 2 },
      { serviceItemId: copa, qty: 1 },
    ]);
    expect(c.amountCents).toBe(4_000);
    expect(c.lines?.map((l) => [l.category, l.qty, l.amountCents])).toEqual([
      ['VENUE_ENTRY', 2, 3_000],
      ['VENUE_BAR', 1, 1_000],
    ]);
    expect((await sys((tx) => tx.payment.findUniqueOrThrow({ where: { id: c.id } }))).revenueCategory).toBe('VENUE_ENTRY');
    await approveCard(c.id, `EN${r}4`, 4_000);
    paid.card.push(c.id);
    paid.mixed = c.id;
  });
});

describe('solo entradas por el saldo (NFC del cliente)', () => {
  it('cobro único pagado con el NFC: consumo en Entradas; el cobro con tarjeta se cancela', async () => {
    const w = await walletWithNfc(5_000);
    const c = await cobrar([{ serviceItemId: entrada, qty: 1 }]);
    const view = await payNfc(c.saldo!.chargeId, w);
    expect(view).toMatchObject({ status: 'ACCEPTED', newBalanceCents: 3_500 });
    const state = await sys(async (tx) => ({
      payment: await tx.payment.findUniqueOrThrow({ where: { id: c.id }, select: { status: true } }),
      consumption: await tx.walletConsumption.findFirstOrThrow({ where: { walletId: w.id } }),
      saldoLines: await tx.paymentLine.findMany({ where: { walletChargeId: c.saldo!.chargeId } }),
    }));
    expect(state.payment.status).toBe('CANCELED');
    expect(state.consumption).toMatchObject({ category: 'VENUE_ENTRY', amountCents: 1_500, authMethod: 'nfc_nopin' });
    expect(state.saldoLines.map((l) => [l.category, l.amountCents])).toEqual([['VENUE_ENTRY', 1_500]]);
    paid.saldo.push(c.saldo!.chargeId);
  });

  it('local solo con saldo: el cobro del saldo (QR /s) pagado con el NFC, en Entradas', async () => {
    const w = await walletWithNfc(5_000);
    const qr = await inVenue(V, () => charges.createQrCharge(carlosActor(), { lines: [{ serviceItemId: entrada, qty: 1 }] }));
    await payNfc(qr.id, w);
    const consumption = await sys((tx) => tx.walletConsumption.findFirstOrThrow({ where: { walletId: w.id } }));
    expect(consumption).toMatchObject({ category: 'VENUE_ENTRY', amountCents: 1_500 });
    paid.saldo.push(qr.id);
  });
});

describe('las entradas suman en todos los informes', () => {
  it('el Z de la noche en vivo: «Entrada» en los cobros y en los consumos del saldo', async () => {
    const view = await inVenue(V, () => nights.current(V));
    const s = view!.z.summary;
    expect(s.count).toBe(4);
    expect(s.grossCents).toBe(9_000);
    expect(s.byType).toEqual([
      { label: 'Barra', count: 1, chargedCents: 1_000 },
      { label: 'Entrada', count: 4, chargedCents: 8_000 },
    ]);
    expect(s.saldoByType).toEqual([{ label: 'Entrada', count: 2, chargedCents: 3_000 }]);
    expect(s.consumptionsCents).toBe(3_000);
    // Por tipo suma lo mismo que lo cobrado: ninguna entrada se queda fuera.
    expect(s.byType.reduce((a, t) => a + t.chargedCents, 0)).toBe(s.chargedCents);
  });

  it('el Z del periodo: Entradas con tarjeta y del saldo, como ingreso del local', async () => {
    const z = await inVenue(V, () => period.periodZ(V, { from: ago(3 * HOUR), to: soon() }));
    const by = Object.fromEntries(z.byRevenueCategory.map((c) => [c.category, c]));
    expect(Object.keys(by).sort()).toEqual(['VENUE_BAR', 'VENUE_ENTRY']);
    expect(by.VENUE_ENTRY).toMatchObject({
      grossCents: 11_000,
      count: 6,
      paymentCount: 4,
      paymentCents: 8_000,
      consumptionCount: 2,
      consumptionCents: 3_000,
    });
    expect(by.VENUE_BAR).toMatchObject({ grossCents: 1_000, count: 1 });
    expect(z.venueRevenue).toEqual({ count: 7, grossCents: 12_000 });
    expect(z.chicaRevenue).toEqual({ count: 0, grossCents: 0 });
  });

  it('el mapa del dinero: la sección Entradas con lo suyo, y las secciones suman lo vendido', async () => {
    const map = await inVenue(V, () => moneyMap.forQuery(V, {}, soon()));
    const by = Object.fromEntries(map.sections.map((s) => [s.code, s.amountCents]));
    expect(by.VENUE_ENTRY).toBe(11_000);
    expect(by.VENUE_BAR).toBe(1_000);
    expect(by[LEGACY_SECTION]).toBeUndefined();
    expect(map.salesCents).toBe(12_000);
    expect(map.inflow).toMatchObject({ cardCents: 9_000, saldoCents: 3_000 });
    expect(map.sections.reduce((a, s) => a + s.amountCents, 0)).toBe(map.salesCents);
  });

  it('la lista de cobros del panel: el filtro «Entradas» encuentra los de tarjeta y los del saldo', async () => {
    const page = await inVenue(V, () => cobros.list(V, CobrosQuerySchema.parse({ category: 'VENUE_ENTRY', limit: 200 })));
    const ids = (kind: string) => page.items.filter((i) => i.kind === kind).map((i) => i.id);
    expect(ids('PAYMENT')).toEqual(expect.arrayContaining(paid.card));
    expect(ids('SALDO').sort()).toEqual([...paid.saldo].sort());
    expect(page.items.every((i) => i.sections.some((s) => s.category === 'VENUE_ENTRY'))).toBe(true);
    const bar = await inVenue(V, () => cobros.list(V, CobrosQuerySchema.parse({ category: 'VENUE_BAR', limit: 200 })));
    expect(bar.items.map((i) => i.id)).toEqual([paid.mixed]);
  });

  it('el libro de cobros (CSV de la gestoría): tipo y desglose «Entrada»', async () => {
    const rows = await inVenue(V, () => reports.cobros(V, { from: ago(3 * HOUR), to: soon() }));
    expect(rows.map((x) => x.id).sort()).toEqual([...paid.card].sort());
    const csv = cobrosCsv(rows, 'Sala Taquilla');
    expect(csv).toContain('Entrada 15,00');
    expect(csv).toContain('Entrada 20,00');
    expect(csv).toContain('Entrada 30,00 · Barra 10,00');
  });
});

class Rollback extends Error {}

/**
 * ¿La base acepta este UPDATE de una fila? Se deshace siempre. False si lo
 * corta el CHECK `constraint`; si no toca exactamente una fila, la prueba falla.
 */
async function accepts(sql: Prisma.Sql, constraint: string): Promise<boolean> {
  try {
    await sys(async (tx) => {
      const rows = await tx.$executeRaw(sql);
      if (rows !== 1) throw new Error(`la sonda tocó ${rows} filas (esperaba 1)`);
      throw new Rollback();
    });
  } catch (err) {
    if (err instanceof Rollback) return true;
    if (String((err as Error).message).includes(constraint)) return false;
    throw err;
  }
  throw new Error('inalcanzable: la transacción de la sonda siempre se deshace');
}

const paymentAccepts = (category: string) =>
  accepts(
    Prisma.sql`UPDATE payments SET "revenueCategory" = ${category} WHERE id = ${probePayment}::uuid`,
    'payments_revenue_category_valid',
  );
const lineAccepts = (category: string) =>
  accepts(Prisma.sql`UPDATE payment_lines SET category = ${category} WHERE id = ${probeLine}::uuid`, 'payment_lines_category_valid');

describe('la base: las secciones del CHECK son las de SECTION_CODES', () => {
  it('payments.revenueCategory: todas las secciones y «Otros» (EXTRA) de los antiguos y las recargas; nada más', async () => {
    for (const code of [...SECTION_CODES, LEGACY_SECTION]) expect(await paymentAccepts(code), code).toBe(true);
    for (const code of ['VENUE_OTHER', 'venue_entry', '']) expect(await paymentAccepts(code), code).toBe(false);
  });

  it('payment_lines.category: todas las secciones; nunca «Otros»', async () => {
    for (const code of SECTION_CODES) expect(await lineAccepts(code), code).toBe(true);
    expect(await lineAccepts(LEGACY_SECTION)).toBe(false);
  });
});

// ─── La migración 20261028000000_entradas_categoria ──────────────────────

// Lanzan la CLI de Prisma y db-heal en procesos aparte: más que el tiempo por defecto.
const MIGRATION_TIMEOUT = 120_000;

function runMigration(): { status: number | null; out: string } {
  const cli = join(DB_PKG, 'node_modules/prisma/build/index.js');
  const res = spawnSync(process.execPath, [cli, 'db', 'execute', '--url', String(process.env.DATABASE_URL), '--file', MIGRATION], {
    encoding: 'utf8',
    env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
  });
  return { status: res.status, out: `${res.stdout}\n${res.stderr}` };
}

function dbHeal(): string {
  const res = spawnSync(process.execPath, [join(DB_PKG, 'node_modules/tsx/dist/cli.mjs'), 'scripts/db-heal.ts'], {
    cwd: DB_PKG,
    encoding: 'utf8',
    env: { ...process.env },
  });
  return `${res.stdout}\n${res.stderr}`;
}

async function categoryCheck(): Promise<{ def: string; valid: boolean } | undefined> {
  const rows = await prisma.$queryRaw<Array<{ def: string; valid: boolean }>>`
    SELECT pg_get_constraintdef(oid) AS def, convalidated AS valid
      FROM pg_constraint
     WHERE conrelid = 'payments'::regclass AND conname = 'payments_revenue_category_valid'`;
  return rows[0];
}

describe('migración 20261028000000_entradas_categoria', () => {
  it('sobre una base como la de producción (el CHECK antiguo): lo sustituye, valida las filas y se puede repetir', async () => {
    // El CHECK de antes (NOT VALID: esta base ya tiene cobros en Entradas).
    await prisma.$executeRawUnsafe(
      `ALTER TABLE payments DROP CONSTRAINT payments_revenue_category_valid,
         ADD CONSTRAINT payments_revenue_category_valid CHECK (${OLD_CHECK}) NOT VALID`,
    );
    expect(await paymentAccepts('VENUE_ENTRY')).toBe(false);

    const first = runMigration();
    expect(first.out).not.toMatch(/error/i);
    expect(first.status).toBe(0);
    const after = await categoryCheck();
    expect(after?.valid).toBe(true);
    for (const code of [...SECTION_CODES, LEGACY_SECTION]) expect(after?.def).toContain(`'${code}'::text`);
    expect(await paymentAccepts('VENUE_ENTRY')).toBe(true);

    // Otra vez: lo mismo, sin error.
    const again = runMigration();
    expect(again.status).toBe(0);
    expect(await categoryCheck()).toEqual(after);
  }, MIGRATION_TIMEOUT);

  it('con una fila antigua fuera de la lista: no rompe el despliegue; el CHECK obliga a las nuevas y db-heal avisa', async () => {
    await prisma.$executeRawUnsafe(`ALTER TABLE payments DROP CONSTRAINT payments_revenue_category_valid`);
    const odd = await sys((tx) =>
      tx.payment.create({
        data: {
          tenantId: P,
          terminalId: probeTerm,
          idempotencyKey: key(),
          amountCents: 100,
          availableAmountCents: 100,
          qrToken: `en-odd-${r}`,
          qrExpiresAt: ago(-HOUR),
          revenueCategory: 'MIXTO_ANTIGUO',
        },
      }),
    );
    try {
      const run = runMigration();
      expect(run.status).toBe(0);
      expect((await categoryCheck())?.valid).toBe(false);
      // NOT VALID también vale para lo nuevo.
      expect(await paymentAccepts('MIXTO_ANTIGUO')).toBe(false);
      expect(await paymentAccepts('VENUE_ENTRY')).toBe(true);
      expect(dbHeal()).toContain('payments.payments_revenue_category_valid está NOT VALID');
    } finally {
      await sys((tx) => tx.payment.delete({ where: { id: odd.id } }));
    }
    // Arreglada la fila, se vuelve a lanzar y queda validado (db-heal ya no avisa).
    expect(runMigration().status).toBe(0);
    expect((await categoryCheck())?.valid).toBe(true);
    expect(dbHeal()).not.toContain('payments_revenue_category_valid');
  }, MIGRATION_TIMEOUT);
});
