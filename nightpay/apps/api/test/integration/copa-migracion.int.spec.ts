// Integración (Postgres real, np_app sin superusuario): la migración
// 20261028100000_copa_con_invitacion con los datos que pueden tener los locales
// en producción. Solo toca lo que sigue tal como lo dejó la carta de referencia
// de antes: «Invitar a una copa» → «Copa con invitación» (y detrás de «Copa» si
// seguía al final) y apaga «Copa premium» si nunca se cobró. No borra nada, no
// toca lo que el dueño cambió ni las partes guardadas en Ajustes, y la segunda
// vez no hace nada. Ver README.md.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ClsService } from 'nestjs-cls';
import { cartaTemplatePlan } from '@nightpay/contracts';
import { PrismaService } from '../../src/common/prisma/prisma.service';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) =>
  cls.run(async () => {
    cls.set('ctx', { tenantId: undefined, traceId: 't' });
    return prisma.asSystem(fn);
  });

const DB_PKG = join(__dirname, '../../../../packages/db');
const MIGRATION = join(DB_PKG, 'prisma/migrations/20261028100000_copa_con_invitacion/migration.sql');

/** Lanza el SQL de la migración (como `prisma migrate deploy`, con el rol de la base). */
function runMigration(): void {
  const cli = join(DB_PKG, 'node_modules/prisma/build/index.js');
  const res = spawnSync(process.execPath, [cli, 'db', 'execute', '--url', String(process.env.DATABASE_URL), '--file', MIGRATION], {
    encoding: 'utf8',
    env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
  });
  expect(res.stderr).not.toMatch(/error/i);
  expect(res.status).toBe(0);
}

const r = randomUUID().slice(0, 6);

/** La carta de referencia de antes (hasta el 2026-10-28), con sus 13 productos y su orden. */
const OLD_TEMPLATE: ReadonlyArray<[string, string, number, number | null]> = [
  ['Copa', 'VENUE_BAR', 1000, null],
  ['Copa premium', 'VENUE_BAR', 1400, null],
  ['Botella', 'VENUE_BAR', 12000, null],
  ['Chupito', 'VENUE_BAR', 500, null],
  ['Tabla ibérica', 'VENUE_FOOD', 3000, null],
  ['Ración del día', 'VENUE_FOOD', 1200, null],
  ['Entrada', 'VENUE_ENTRY', 1500, null],
  ['Entrada VIP', 'VENUE_ENTRY', 3000, null],
  ['30 min', 'CHICA_SERVICE', 8000, 30],
  ['45 min', 'CHICA_SERVICE', 10000, 45],
  ['1 h', 'CHICA_SERVICE', 12000, 60],
  ['2 h', 'CHICA_SERVICE', 22000, 120],
  ['Invitar a una copa', 'VENUE_BAR', 2000, null],
];

async function venueWithOldTemplate(slug: string, extra: { invitationRules?: object } = {}): Promise<string> {
  return sys(async (tx) => {
    const id = (await tx.venue.create({ data: { name: `Local ${slug}`, slug: `${slug}-${r}`, ...extra } })).id;
    await tx.serviceItem.createMany({
      data: OLD_TEMPLATE.map(([name, category, priceCents, durationMin], sortOrder) => ({
        tenantId: id,
        name,
        category,
        priceCents,
        durationMin,
        sortOrder,
        isInvitation: name === 'Invitar a una copa',
      })),
    });
    return id;
  });
}

const carta = (tenantId: string) =>
  sys((tx) =>
    tx.serviceItem.findMany({
      where: { tenantId },
      orderBy: [{ sortOrder: 'asc' }, { priceCents: 'asc' }],
      select: { id: true, name: true, category: true, priceCents: true, durationMin: true, sortOrder: true, active: true, isInvitation: true, components: true, updatedAt: true },
    }),
  );
const byName = async (tenantId: string, name: string) => (await carta(tenantId)).filter((i) => i.name === name);

let untouched: string, edited: string, sold: string, saved: string;
const SAVED_RULES = { chica: { kind: 'PERCENT', bps: 5000 }, camarero: { kind: 'PERCENT', bps: 5000 }, inviteFirst: true, requireQr: true };

beforeAll(async () => {
  await prisma.onModuleInit();
  // 1. La referencia de antes, sin tocar.
  untouched = await venueWithOldTemplate('mig-a');
  // 2. El dueño la cambió: la invitación a 25 € y en otro sitio, la copa premium a 15 €.
  edited = await venueWithOldTemplate('mig-b');
  await sys(async (tx) => {
    await tx.serviceItem.updateMany({ where: { tenantId: edited, name: 'Invitar a una copa' }, data: { priceCents: 2500, sortOrder: 5 } });
    await tx.serviceItem.updateMany({ where: { tenantId: edited, name: 'Copa premium' }, data: { priceCents: 1500 } });
  });
  // 3. La copa premium se ha vendido, y ya hay otro «Copa con invitación» (que no es la invitación).
  sold = await venueWithOldTemplate('mig-c');
  await sys(async (tx) => {
    const premium = await tx.serviceItem.findFirstOrThrow({ where: { tenantId: sold, name: 'Copa premium' } });
    const terminal = await tx.terminal.create({ data: { tenantId: sold, externalId: `MIG-${r}`, label: 'Barra' } });
    const payment = await tx.payment.create({
      data: {
        tenantId: sold, terminalId: terminal.id, idempotencyKey: `mig-${r}`, amountCents: 1400, availableAmountCents: 1400,
        qrToken: `mig-q-${r}`, qrExpiresAt: new Date(Date.now() + 60_000), status: 'AUTHORIZED', revenueCategory: 'VENUE_BAR',
      },
    });
    await tx.paymentLine.create({
      data: { tenantId: sold, paymentId: payment.id, serviceItemId: premium.id, category: 'VENUE_BAR', label: 'Copa premium', unitCents: 1400, amountCents: 1400 },
    });
    await tx.serviceItem.create({ data: { tenantId: sold, name: 'COPA CON INVITACIÓN', category: 'VENUE_BAR', priceCents: 1800, sortOrder: 20 } });
  });
  // 4. Guardó en Ajustes la mitad para el camarero (y la clave «Invitar» primero, de antes).
  saved = await venueWithOldTemplate('mig-d', { invitationRules: SAVED_RULES });
  runMigration();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('migración «Copa con invitación» (datos de producción)', () => {
  it('la referencia de antes sin tocar: la invitación se llama «Copa con invitación» y va detrás de «Copa»; «Copa premium», apagada', async () => {
    const rows = await carta(untouched);
    expect(rows).toHaveLength(13);
    const active = rows.filter((i) => i.active);
    expect(active.slice(0, 3).map((i) => [i.name, i.sortOrder, i.isInvitation])).toEqual([
      ['Copa', 0, false],
      ['Copa con invitación', 1, true],
      ['Botella', 2, false],
    ]);
    expect(await byName(untouched, 'Copa premium')).toEqual([expect.objectContaining({ active: false, priceCents: 1400 })]);
    expect(await byName(untouched, 'Invitar a una copa')).toEqual([]);
    // Ya es igual que la referencia de ahora: aplicarla no cambiaría nada.
    expect(cartaTemplatePlan(rows).every((c) => c.action === 'keep')).toBe(true);
  });

  it('lo que el dueño cambió se queda: la invitación (otro precio, otro sitio) solo cambia de nombre; la copa premium a 15 €, encendida', async () => {
    expect(await byName(edited, 'Copa con invitación')).toEqual([
      expect.objectContaining({ isInvitation: true, priceCents: 2500, sortOrder: 5, active: true }),
    ]);
    expect(await byName(edited, 'Copa premium')).toEqual([expect.objectContaining({ active: true, priceCents: 1500 })]);
  });

  it('una copa premium ya vendida no se apaga; con otro «Copa con invitación» en la carta, la invitación no se renombra', async () => {
    expect(await byName(sold, 'Copa premium')).toEqual([expect.objectContaining({ active: true })]);
    expect(await byName(sold, 'Invitar a una copa')).toEqual([expect.objectContaining({ isInvitation: true, sortOrder: 12, active: true })]);
    expect(await byName(sold, 'COPA CON INVITACIÓN')).toEqual([expect.objectContaining({ isInvitation: false })]);
    // Lo cobrado no cambia: la línea guarda su nombre.
    const line = await sys((tx) => tx.paymentLine.findFirstOrThrow({ where: { tenantId: sold } }));
    expect(line.label).toBe('Copa premium');
  });

  it('no toca las partes guardadas en Ajustes (la del camarero se queda hasta que el dueño la quite)', async () => {
    const venue = await sys((tx) => tx.venue.findUniqueOrThrow({ where: { id: saved }, select: { invitationRules: true } }));
    expect(venue.invitationRules).toEqual(SAVED_RULES);
    expect(await byName(saved, 'Copa con invitación')).toHaveLength(1);
  });

  it('no borra nada y la segunda vez no cambia nada', async () => {
    const before = await Promise.all([untouched, edited, sold, saved].map(carta));
    expect(before.map((rows) => rows.length)).toEqual([13, 13, 14, 13]);
    runMigration();
    const after = await Promise.all([untouched, edited, sold, saved].map(carta));
    expect(after).toEqual(before);
  });
});
