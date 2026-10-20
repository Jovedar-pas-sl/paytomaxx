// Integración (Postgres real): el mapa del dinero — secciones, packs, líneas
// de cada cobro (con tarjeta y del saldo), comisión por línea, referencia
// corta por local, puesto y la lista de cobros / ficha del saldo del panel,
// con np_app y FORCE RLS en payment_lines y charge_ref_counters. Ver README.md.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { WalletChargesService } from '../../src/modules/wallets/wallet-charges.service';
import { CartaService } from '../../src/modules/carta/carta.service';
import { CobrosService } from '../../src/modules/money-map/cobros.service';
import { WalletFichaService } from '../../src/modules/money-map/wallet-ficha.service';
import { CobrosQuerySchema } from '@nightpay/contracts';
import { Prisma } from '@nightpay/db';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as any);
const audit = { log: vi.fn(async () => undefined) };
const queue = { add: vi.fn(async () => undefined) };
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
  {} as never,
);
const charges = new WalletChargesService(prisma as never, audit as never, { get: () => ({}) } as never, {} as never);
const carta = new CartaService(prisma as never, audit as never);
const cobros = new CobrosService(prisma as never);
const fichas = new WalletFichaService(prisma as never);

const inVenue = <T>(tenantId: string | undefined, fn: () => Promise<T>): Promise<T> =>
  cls.run(async () => {
    cls.set('ctx', { tenantId, traceId: 't' });
    return fn();
  });
const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) =>
  inVenue(undefined, () => prisma.asSystem(fn));

const r = randomUUID().slice(0, 6);
let A: string, B: string, owner: string, chica: string, camarero: string, cocina: string, recepcion: string;
let copa: string, pack: string;
let walletId: string;
let n = 0;
const key = () => `md-${r}-${(n += 1)}`;
const CODE = `M${r.slice(0, 5)}`.toUpperCase();

const asChica = { userId: '', role: 'OPERATOR' };
const asCamarero = { userId: '', role: 'WAITER' };

beforeAll(async () => {
  await prisma.onModuleInit();
  await sys(async (tx) => {
    A = (await tx.venue.create({ data: { name: 'Local Mapa', slug: `md-a-${r}`, walletGroup: `gmd-${r}` } })).id;
    B = (await tx.venue.create({ data: { name: 'Otro dueño', slug: `md-b-${r}` } })).id;
    owner = (await tx.user.create({ data: { tenantId: A, email: `own-md-${r}@x.es`, passwordHash: 'x', role: 'OWNER' } })).id;
    chica = (
      await tx.user.create({
        data: { tenantId: A, email: `lola-md-${r}@x.es`, passwordHash: 'x', role: 'OPERATOR', commissionBps: 9000, displayName: 'Lola' },
      })
    ).id;
    camarero = (
      await tx.user.create({ data: { tenantId: A, email: `dani-md-${r}@x.es`, passwordHash: 'x', role: 'WAITER', displayName: 'Dani' } })
    ).id;
    cocina = (
      await tx.user.create({ data: { tenantId: A, email: `coc-md-${r}@x.es`, passwordHash: 'x', role: 'WAITER', post: 'COCINA' } })
    ).id;
    recepcion = (
      await tx.user.create({ data: { tenantId: A, email: `rec-md-${r}@x.es`, passwordHash: 'x', role: 'WAITER', post: 'RECEPCION' } })
    ).id;
    await tx.terminal.create({ data: { tenantId: A, externalId: `MD-${r}`, label: 'Barra' } });
    walletId = (
      await tx.clientWallet.create({
        data: { tenantId: A, qrToken: `md-tok-${r}-abcdefgh`, balanceCents: 50_000, status: 'ACTIVE', shortCode: CODE, walletGroup: `gmd-${r}` },
      })
    ).id;
  });
  asChica.userId = chica;
  asCamarero.userId = camarero;
  // La carta: una copa y el pack «1 h con habitación» (Servicios 120 € + Habitaciones 30 €).
  copa = (await inVenue(A, () => carta.create(A, owner, { name: 'Copa', priceCents: 1000, category: 'VENUE_BAR' }))).id;
  pack = (
    await inVenue(A, () =>
      carta.create(A, owner, {
        name: '1 h con habitación',
        priceCents: 15_000,
        durationMin: 60,
        category: 'CHICA_SERVICE',
        components: [
          { category: 'CHICA_SERVICE', amountCents: 12_000 },
          { category: 'VENUE_ROOM', amountCents: 3_000 },
        ],
      }),
    )
  ).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

const body = (o: Record<string, unknown>) => ({ currency: 'EUR', terminalExternalId: `MD-${r}`, ...o }) as never;

/** El banco lo aprueba (Redsys): a AUTHORIZING y aviso de pagado, como en producción. */
async function authorize(paymentId: string, order: string): Promise<void> {
  await sys((tx) => tx.payment.update({ where: { id: paymentId }, data: { status: 'AUTHORIZING', provider: 'REDSYS', providerTxId: order } }));
  await inVenue(undefined, () => payments.transition(paymentId, { type: 'AUTHORIZED', provider: 'REDSYS', providerTxId: order }));
}

async function earningOf(paymentId: string) {
  return sys((tx) => tx.operatorEarning.findUnique({ where: { paymentId } }));
}

describe('carta de todas las secciones y packs', () => {
  it('un pack que no suma su precio no se guarda; la carta lo devuelve con sus partes', async () => {
    await expect(
      inVenue(A, () =>
        carta.create(A, owner, {
          name: 'Mal sumado',
          priceCents: 10_000,
          category: 'CHICA_SERVICE',
          components: [
            { category: 'CHICA_SERVICE', amountCents: 8_000 },
            { category: 'VENUE_ROOM', amountCents: 1_000 },
          ],
        }),
      ),
    ).rejects.toThrow(/suman 90,00 €/);
    const list = await inVenue(A, () => carta.listForStaff(A, 'WAITER'));
    expect(list.find((i) => i.id === pack)?.components).toEqual([
      { category: 'CHICA_SERVICE', amountCents: 12_000 },
      { category: 'VENUE_ROOM', amountCents: 3_000 },
    ]);
    expect(list.some((i) => i.id === copa)).toBe(true);
  });

  it('una sección apagada: no se crean servicios en ella y sus servicios no salen en las apps', async () => {
    await sys((tx) => tx.venue.update({ where: { id: A }, data: { sections: { VENUE_FOOD: { enabled: false } } } }));
    await expect(inVenue(A, () => carta.create(A, owner, { name: 'Bocadillo', priceCents: 500, category: 'VENUE_FOOD' }))).rejects.toThrow(
      /«Comida» está apagada/,
    );
    await sys((tx) => tx.venue.update({ where: { id: A }, data: { sections: { VENUE_FOOD: { enabled: true } } } }));
  });
});

describe('cobro con tarjeta: líneas, referencia y comisión por línea', () => {
  it('pack de la chica: dos líneas (Servicios + Habitaciones) y su % solo sobre los 120 €', async () => {
    const created = await inVenue(A, () => payments.create(A, key(), body({ amountCents: 1, serviceItemId: pack }), asChica));
    expect(created.amountCents).toBe(15_000);
    expect(created.ref).toMatch(/^C-\d{4}$/);
    expect(created.lines?.map((l) => [l.category, l.amountCents])).toEqual([
      ['CHICA_SERVICE', 12_000],
      ['VENUE_ROOM', 3_000],
    ]);
    const p = await sys((tx) => tx.payment.findUnique({ where: { id: created.id } }));
    expect(p).toMatchObject({ revenueCategory: 'CHICA_SERVICE', operatorCommissionBps: 7_200, serviceName: '1 h con habitación' });
    await authorize(created.id, `MD${r}1`);
    expect(await earningOf(created.id)).toMatchObject({ commissionCents: 10_800, commissionBps: 7_200, paymentAmountCents: 15_000 });
  });

  it('REGRESIÓN: un cobro de una sola sección deja la misma comisión que antes', async () => {
    const created = await inVenue(A, () => payments.create(A, key(), body({ amountCents: 4_505 }), asChica));
    await authorize(created.id, `MD${r}2`);
    // round(4505 × 90 %) = 4055, como siempre; con su línea en Servicios.
    expect(await earningOf(created.id)).toMatchObject({ commissionCents: 4_055, commissionBps: 9_000 });
    expect(created.lines).toEqual([
      { category: 'CHICA_SERVICE', label: 'Otro importe', qty: 1, unitCents: 4_505, amountCents: 4_505, serviceItemId: null },
    ]);
  });

  it('apps antiguas: sin sección o con «Otros» (EXTRA) → la del puesto o la del rol, nunca EXTRA', async () => {
    const barra = await inVenue(A, () => payments.create(A, key(), body({ amountCents: 900, revenueCategory: 'EXTRA' }), asCamarero));
    expect(barra.lines?.[0]?.category).toBe('VENUE_BAR');
    const cocinaCharge = await inVenue(A, () =>
      payments.create(A, key(), body({ amountCents: 1200 }), { userId: cocina, role: 'WAITER' }),
    );
    expect(cocinaCharge.lines?.[0]?.category).toBe('VENUE_FOOD');
    const p = await sys((tx) => tx.payment.findUnique({ where: { id: cocinaCharge.id } }));
    expect(p?.revenueCategory).toBe('VENUE_FOOD');
  });

  it('varias cosas en un cobro: 2 copas y una habitación, total del servidor (recepción cobra todo)', async () => {
    const created = await inVenue(A, () =>
      payments.create(
        A,
        key(),
        body({ lines: [{ serviceItemId: copa, qty: 2 }, { category: 'VENUE_ROOM', amountCents: 3_000, label: 'Hab. 4' }] }),
        { userId: recepcion, role: 'WAITER' },
      ),
    );
    expect(created.amountCents).toBe(5_000);
    expect(created.lines?.map((l) => [l.category, l.qty, l.amountCents])).toEqual([
      ['VENUE_ROOM', 1, 3_000],
      ['VENUE_BAR', 2, 2_000],
    ]);
  });

  it('referencias seguidas por local: diez cobros a la vez no repiten ninguna; otro local empieza en C-0001', async () => {
    const made = await Promise.all(
      Array.from({ length: 10 }, () => inVenue(A, () => payments.create(A, key(), body({ amountCents: 100 }), asCamarero))),
    );
    const refs = made.map((m) => Number(m.ref!.slice(2))).sort((a, b) => a - b);
    expect(new Set(refs).size).toBe(10);
    expect(refs[9]! - refs[0]!).toBe(9);
    await sys((tx) => tx.terminal.create({ data: { tenantId: B, externalId: `MDB-${r}`, label: 'B' } }));
    const other = await inVenue(B, () =>
      payments.create(B, key(), { currency: 'EUR', terminalExternalId: `MDB-${r}`, amountCents: 100 } as never, { userId: owner, role: 'OWNER' }),
    );
    expect(other.ref).toBe('C-0001');
  });

  it('una recarga de saldo no es venta: sin líneas (y con su referencia); solo en recepción', async () => {
    await expect(inVenue(A, () => payments.create(A, key(), body({ amountCents: 5_000, wallet: { walletId } }), asCamarero))).rejects.toThrow(
      /Las recargas se hacen en recepción/,
    );
    await expect(inVenue(A, () => payments.create(A, key(), body({ amountCents: 5_000, wallet: { walletId } }), asChica))).rejects.toThrow(
      /Las recargas se hacen en recepción/,
    );
    const topUp = await inVenue(A, () =>
      payments.create(A, key(), body({ amountCents: 5_000, wallet: { walletId } }), { userId: recepcion, role: 'WAITER' }),
    );
    expect(topUp.lines).toEqual([]);
    expect(topUp.ref).toMatch(/^C-/);
  });

  it('devolución de la mitad de un pack: se descuenta la mitad de la comisión por línea', async () => {
    const created = await inVenue(A, () => payments.create(A, key(), body({ amountCents: 1, serviceItemId: pack }), asChica));
    await authorize(created.id, `MD${r}3`);
    const refund = await sys((tx) =>
      tx.refund.create({ data: { tenantId: A, paymentId: created.id, amountCents: 7_500, requestedBy: owner, status: 'SUCCEEDED' } }),
    );
    await inVenue(undefined, () => payments.applyRefundToEarning(created.id, refund.id, 7_500));
    expect(await earningOf(created.id)).toMatchObject({ commissionCents: 10_800, reversedCents: 5_400 });
  });
});

describe('el puesto decide lo que se cobra (servidor)', () => {
  it('la chica solo Servicios: la barra → 403 (también del saldo); el camarero de barra no cobra habitaciones', async () => {
    await expect(
      inVenue(A, () => payments.create(A, key(), body({ amountCents: 1_000, revenueCategory: 'VENUE_BAR' }), asChica)),
    ).rejects.toMatchObject({ status: 403, response: expect.objectContaining({ code: 'SECTION_NOT_ALLOWED' }) });
    await expect(
      inVenue(A, () => charges.createQrCharge({ userId: chica, role: 'OPERATOR', tenantId: A }, { serviceItemId: copa })),
    ).rejects.toThrow(/Desde tu app solo puedes cobrar Servicios/);
    await expect(
      inVenue(A, () => payments.create(A, key(), body({ amountCents: 1_000, revenueCategory: 'VENUE_ROOM' }), asCamarero)),
    ).rejects.toThrow(/Desde tu puesto \(Barra\) no se cobra Habitaciones/);
  });

  it('la tabla de Ajustes manda: si la barra también cobra habitaciones, se puede', async () => {
    await sys((tx) =>
      tx.venue.update({ where: { id: A }, data: { postRules: { BARRA: { sections: ['VENUE_BAR', 'VENUE_ROOM'] } } } }),
    );
    const ok = await inVenue(A, () => payments.create(A, key(), body({ amountCents: 1_000, revenueCategory: 'VENUE_ROOM' }), asCamarero));
    expect(ok.lines?.[0]?.category).toBe('VENUE_ROOM');
    await sys((tx) => tx.venue.update({ where: { id: A }, data: { postRules: Prisma.DbNull } }));
  });
});

describe('cobro del saldo: líneas, referencia y comisión por línea', () => {
  it('la chica cobra el pack del saldo: líneas con el cobro del saldo y su % solo sobre Servicios', async () => {
    const qr = await inVenue(A, () => charges.createQrCharge({ userId: chica, role: 'OPERATOR', tenantId: A }, { serviceItemId: pack }));
    expect(qr.ref).toMatch(/^C-\d{4}$/);
    const lines = await sys((tx) => tx.paymentLine.findMany({ where: { walletChargeId: qr.id }, orderBy: { amountCents: 'desc' } }));
    expect(lines.map((l) => [l.category, l.amountCents])).toEqual([
      ['CHICA_SERVICE', 12_000],
      ['VENUE_ROOM', 3_000],
    ]);
    await inVenue(undefined, () => charges.payQrCharge(qr.payToken, walletId));
    const earning = await sys(async (tx) => {
      const c = await tx.walletConsumption.findFirst({ where: { idempotencyKey: `charge-request:${qr.id}` } });
      return tx.operatorEarning.findUnique({ where: { consumptionId: c!.id } });
    });
    expect(earning).toMatchObject({ commissionCents: 10_800, commissionBps: 7_200 });
    // El cliente ve la referencia en sus movimientos.
    const state = await inVenue(undefined, () => charges.clientState(`md-tok-${r}-abcdefgh`));
    expect(state.movements.find((m) => m.kind === 'consumption')?.ref).toBe(qr.ref);
  });
});

describe('RLS de las tablas nuevas (FORCE)', () => {
  it('sin local ni bypass no se ve ninguna línea ni contador; con otro local, tampoco', async () => {
    const none = await inVenue(undefined, () =>
      prisma.$transaction((tx) => tx.$queryRaw<unknown[]>`SELECT id FROM payment_lines WHERE "tenantId" = ${A}::uuid`),
    );
    expect(none).toHaveLength(0);
    const fromB = await inVenue(B, () =>
      prisma.withTenant(B, (tx) => tx.$queryRaw<unknown[]>`SELECT "tenantId" FROM charge_ref_counters WHERE "tenantId" = ${A}::uuid`),
    );
    expect(fromB).toHaveLength(0);
    const own = await inVenue(A, () => prisma.withTenant(A, (tx) => tx.$queryRaw<unknown[]>`SELECT id FROM payment_lines`));
    expect(own.length).toBeGreaterThan(0);
  });

  it('con el local B en la sesión no se puede escribir una línea del local A', async () => {
    await expect(
      inVenue(B, () =>
        prisma.withTenant(B, (tx) =>
          tx.$executeRaw`INSERT INTO payment_lines ("tenantId", "walletChargeId", category, label, "unitCents", "amountCents")
                         SELECT ${A}::uuid, id, 'VENUE_BAR', 'x', 1, 1 FROM wallet_charge_requests LIMIT 1`,
        ),
      ),
    ).rejects.toThrow();
  });
});

describe('panel: lista de cobros con filtros y ficha del saldo', () => {
  const q = (o: Record<string, unknown> = {}) => CobrosQuerySchema.parse(o);

  it('cobros con tarjeta y del saldo juntos, más nuevos primero, con chica, sección y cómo pagó', async () => {
    const page = await inVenue(A, () => cobros.list(A, q({ limit: 200 })));
    expect(page.items.some((i) => i.kind === 'SALDO')).toBe(true);
    const saldo = page.items.find((i) => i.kind === 'SALDO')!;
    expect(saldo).toMatchObject({ method: 'SALDO', methodLabel: `Saldo ${CODE.slice(0, 3)}-•••`, person: { name: 'Lola' } });
    expect(saldo.sections).toEqual([
      { category: 'CHICA_SERVICE', amountCents: 12_000 },
      { category: 'VENUE_ROOM', amountCents: 3_000 },
    ]);
    const dates = page.items.map((i) => i.createdAt);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it('filtros: chica, sección, método y código del saldo', async () => {
    const lola = await inVenue(A, () => cobros.list(A, q({ operatorId: chica, limit: 200 })));
    expect(lola.items.length).toBeGreaterThan(0);
    expect(lola.items.every((i) => i.person?.id === chica)).toBe(true);
    const rooms = await inVenue(A, () => cobros.list(A, q({ category: 'VENUE_ROOM', limit: 200 })));
    expect(rooms.items.every((i) => i.sections.some((s) => s.category === 'VENUE_ROOM'))).toBe(true);
    const food = await inVenue(A, () => cobros.list(A, q({ category: 'VENUE_FOOD', limit: 200 })));
    expect(food.items).toHaveLength(1);
    const saldo = await inVenue(A, () => cobros.list(A, q({ method: 'SALDO', limit: 200 })));
    expect(saldo.items.every((i) => i.kind === 'SALDO')).toBe(true);
    const byCode = await inVenue(A, () => cobros.list(A, q({ walletCode: `${CODE.slice(0, 3)}-${CODE.slice(3)}`, limit: 200 })));
    // Su consumo y su recarga.
    expect(byCode.items.map((i) => i.kind).sort()).toEqual(['PAYMENT', 'SALDO']);
    const otherVenue = await inVenue(B, () => cobros.list(B, q({ limit: 200 })));
    expect(otherVenue.items.every((i) => i.person?.id !== chica)).toBe(true);
  });

  it('páginas sin repetir ni saltarse ninguno', async () => {
    const all = await inVenue(A, () => cobros.list(A, q({ limit: 200 })));
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await inVenue(A, () => cobros.list(A, q({ limit: 4, ...(cursor ? { cursor } : {}) })));
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(all.items.map((i) => i.id));
  });

  it('ficha del saldo: su recarga (cómo y quién), su consumo (ref, chica, sección) y nada de otro dueño', async () => {
    const ficha = await inVenue(A, () => fichas.ficha(A, walletId));
    expect(ficha.wallet.code).toBe(`${CODE.slice(0, 3)}-${CODE.slice(3)}`);
    expect(ficha.consumptions[0]).toMatchObject({ kind: 'SALDO', person: { name: 'Lola' }, venueName: 'Local Mapa' });
    expect(ficha.consumptions[0]!.ref).toMatch(/^C-/);
    await expect(inVenue(B, () => fichas.ficha(B, walletId))).rejects.toThrow(/Saldo no encontrado/);
  });
});
