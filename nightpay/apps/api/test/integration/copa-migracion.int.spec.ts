// Integración (Postgres real, np_app sin superusuario): la migración
// 20261028100000_copa_con_invitacion con los datos que pueden tener los locales
// en producción. Solo toca lo que sigue tal como lo dejó la carta de referencia
// de antes: «Invitar a una copa» → «Copa con invitación» (y detrás de «Copa» si
// seguía al final), apaga «Copa premium» si nunca se cobró (tampoco con el saldo
// de antes de las líneas, que solo guardaba el nombre) y, se quede o no, la
// saca del sitio justo detrás de «Copa»; y la parte del camarero que el Ajustes
// anterior guardaba de fábrica (50 %) pasa a 0. No borra nada, no toca lo que el
// dueño cambió y la segunda vez no hace nada. Ver README.md.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ClsService } from 'nestjs-cls';
import { cartaTemplatePlan, invitationRulesOf, mergeInvitationRules } from '@nightpay/contracts';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { CartaService } from '../../src/modules/carta/carta.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { signStaffToken } from '../../src/modules/operators/staff-qr';

process.env.JWT_SECRET ??= 'clave-de-las-pruebas-de-integracion-0123456789';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const noop = () => undefined;
const audit = { log: vi.fn(async () => undefined) };
const queue = { add: vi.fn(async () => undefined) };
const metrics = {
  paymentsCreated: { inc: noop },
  paymentsTransitioned: { inc: noop },
  walletCreditSkipped: { inc: noop },
  duplicateCharges: { inc: noop },
  refundsCreated: { inc: noop },
  earningReversalFailed: { inc: noop },
};
const payments = new PaymentsService(
  prisma as never,
  cls as never,
  queue as never,
  queue as never,
  {} as never,
  { emitPaymentUpdate: noop, emitPaymentCompleted: noop } as never,
  metrics as never,
  {} as never,
  {} as never,
);
const cartaService = new CartaService(prisma as never, audit as never);

const inVenue = <T>(tenantId: string | undefined, fn: () => Promise<T>): Promise<T> =>
  cls.run(async () => {
    cls.set('ctx', { tenantId, traceId: 't' });
    return fn();
  });
const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) =>
  inVenue(undefined, () => prisma.asSystem(fn));

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
let n = 0;
const key = () => `mig-${r}-${(n += 1)}`;
const HOUR = 60 * 60_000;

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
/** La primera referencia (2026-10-21): las mismas 12, sin la invitación. */
const FIRST_TEMPLATE = OLD_TEMPLATE.slice(0, 12);

async function venueWith(
  slug: string,
  template: typeof OLD_TEMPLATE,
  extra: { invitationRules?: object } = {},
): Promise<string> {
  return sys(async (tx) => {
    const id = (await tx.venue.create({ data: { name: `Local ${slug}`, slug: `${slug}-${r}`, ...extra } })).id;
    await tx.serviceItem.createMany({
      data: template.map(([name, category, priceCents, durationMin], sortOrder) => ({
        tenantId: id,
        name,
        category,
        priceCents,
        durationMin,
        sortOrder,
        isInvitation: name === 'Invitar a una copa',
      })),
    });
    await tx.terminal.create({ data: { tenantId: id, externalId: `MIG-${id.slice(0, 8)}`, label: 'Barra' } });
    return id;
  });
}
const venueWithOldTemplate = (slug: string, extra: { invitationRules?: object } = {}) => venueWith(slug, OLD_TEMPLATE, extra);

/** Una «Copa premium» cobrada con tarjeta (con su línea). */
async function soldByCard(tenantId: string): Promise<void> {
  await sys(async (tx) => {
    const premium = await tx.serviceItem.findFirstOrThrow({ where: { tenantId, name: 'Copa premium' } });
    const terminal = await tx.terminal.findFirstOrThrow({ where: { tenantId } });
    const payment = await tx.payment.create({
      data: {
        tenantId, terminalId: terminal.id, idempotencyKey: key(), amountCents: 1400, availableAmountCents: 1400,
        qrToken: `mig-q-${key()}`, qrExpiresAt: new Date(Date.now() + 60_000), status: 'AUTHORIZED', revenueCategory: 'VENUE_BAR',
      },
    });
    await tx.paymentLine.create({
      data: { tenantId, paymentId: payment.id, serviceItemId: premium.id, category: 'VENUE_BAR', label: 'Copa premium', unitCents: 1400, amountCents: 1400 },
    });
  });
}

/**
 * Una «Copa premium» cobrada con el saldo antes de las líneas (hasta el
 * 2026-10-20): solo queda su nombre en el cobro del saldo y en el consumo.
 */
async function soldBySaldoBeforeLines(tenantId: string): Promise<void> {
  await sys(async (tx) => {
    const waiter = await tx.user.create({ data: { tenantId, email: `w-${key()}@x.es`, passwordHash: 'x', role: 'WAITER' } });
    const wallet = await tx.clientWallet.create({
      data: { tenantId, qrToken: `mig-w-${key()}-abcdefgh`, balanceCents: 600, status: 'ACTIVE', shortCode: randomBytes(3).toString('hex').toUpperCase() },
    });
    const consumption = await tx.walletConsumption.create({
      data: {
        tenantId, walletId: wallet.id, amountCents: 1400, providedByUserId: waiter.id, category: 'VENUE_BAR', notes: 'Copa premium',
        createdAt: new Date('2026-10-19T23:30:00Z'),
      },
    });
    await tx.walletChargeRequest.create({
      data: {
        tenantId, walletId: wallet.id, requestedByUserId: waiter.id, amountCents: 1400, category: 'VENUE_BAR', serviceName: 'Copa premium',
        status: 'ACCEPTED', expiresAt: new Date('2026-10-19T23:35:00Z'), decidedAt: new Date('2026-10-19T23:30:00Z'),
        consumptionId: consumption.id, createdAt: new Date('2026-10-19T23:29:00Z'),
      },
    });
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
/** Lo encendido de Copas en el orden del API (el de las losetas de la app del personal dentro de cada sección). */
const copas = async (tenantId: string) =>
  (await inVenue(tenantId, () => cartaService.listAll(tenantId))).filter((i) => i.active && i.category === 'VENUE_BAR').map((i) => i.name);
const rulesOf = (tenantId: string) => sys((tx) => tx.venue.findUniqueOrThrow({ where: { id: tenantId }, select: { invitationRules: true } }));
const auditOf = (tenantId: string) =>
  sys((tx) => tx.auditEvent.findMany({ where: { tenantId, action: 'venue.invitation_rules.updated' }, orderBy: { id: 'asc' } }));

const SAVED_RULES = { chica: { kind: 'PERCENT', bps: 5000 }, camarero: { kind: 'PERCENT', bps: 5000 }, inviteFirst: true, requireQr: true };
/** Lo que eligió el dueño para el camarero (no es el 50 % que traía el formulario): no se toca. */
const CHOSEN_RULES = { chica: { kind: 'PERCENT', bps: 4000 }, camarero: { kind: 'FIXED', cents: 300 }, inviteFirst: true, requireQr: false };
const CHICA_CHANGED_RULES = { chica: { kind: 'PERCENT', bps: 6000 }, camarero: { kind: 'PERCENT', bps: 5000 }, inviteFirst: false, requireQr: true };
const ZERO = { kind: 'PERCENT', bps: 0 };

let untouched: string, edited: string, sold: string, saldo: string, first: string, named: string;
let saved: string, chosen: string, chicaChanged: string;
/** El local con la parte del camarero guardada: el camarero, la chica y el cobro de antes de la migración. */
let dani: string, lola: string, beforePayment: string;

const staffQr = (userId: string, tenantId: string) =>
  `https://operator.local/?invita=${signStaffToken({ userId, tenantId }, Date.now(), process.env.JWT_SECRET!).token}`;
/** Dani (camarero) cobra la invitación del local a Lola, con su QR. */
async function invite(tenantId: string) {
  const item = await sys((tx) => tx.serviceItem.findFirstOrThrow({ where: { tenantId, isInvitation: true } }));
  return inVenue(tenantId, () =>
    payments.create(
      tenantId,
      key(),
      {
        currency: 'EUR',
        terminalExternalId: `MIG-${tenantId.slice(0, 8)}`,
        lines: [{ serviceItemId: item.id, qty: 1 }],
        invitedStaffToken: staffQr(lola, tenantId),
      } as never,
      { userId: dani, role: 'WAITER' },
    ),
  );
}
const lineOf = (paymentId: string) => sys((tx) => tx.paymentLine.findFirstOrThrow({ where: { paymentId } }));

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
  // 3. La copa premium se ha vendido (con tarjeta, con su línea): lo normal en un local que ya trabaja.
  sold = await venueWithOldTemplate('mig-c');
  await soldByCard(sold);
  // 4. La copa premium solo se vendió con el saldo antes de las líneas (solo queda su nombre).
  saldo = await venueWithOldTemplate('mig-e');
  await soldBySaldoBeforeLines(saldo);
  // 5. La primera referencia (sin invitación) con la copa premium vendida: la invitación llega luego con la de ahora.
  first = await venueWith('mig-f', FIRST_TEMPLATE);
  await soldByCard(first);
  // 6. Ya tiene otro «Copa con invitación» (que no es la invitación).
  named = await venueWithOldTemplate('mig-g');
  await sys((tx) => tx.serviceItem.create({ data: { tenantId: named, name: 'COPA CON INVITACIÓN', category: 'VENUE_BAR', priceCents: 1800 } }));
  // 7. Guardó en Ajustes con el formulario de antes: el 50 % del camarero venía relleno (y la clave «Invitar» primero).
  saved = await venueWithOldTemplate('mig-d', { invitationRules: SAVED_RULES });
  await sys(async (tx) => {
    dani = (await tx.user.create({ data: { tenantId: saved, email: `dani-${key()}@x.es`, passwordHash: 'x', role: 'WAITER', displayName: 'Dani' } })).id;
    lola = (await tx.user.create({ data: { tenantId: saved, email: `lola-${key()}@x.es`, passwordHash: 'x', role: 'OPERATOR', displayName: 'Lola' } })).id;
    await tx.venueNight.create({ data: { tenantId: saved, openedAt: new Date(Date.now() - 2 * HOUR), openedBy: dani } });
  });
  // Antes de publicar, el camarero que cobra una invitación se lleva la mitad.
  beforePayment = (await invite(saved)).id;
  // 8. El dueño eligió otra parte para el camarero; 9. cambió solo la de la chica (la del camarero, la de fábrica de antes).
  chosen = await venueWithOldTemplate('mig-h', { invitationRules: CHOSEN_RULES });
  chicaChanged = await venueWithOldTemplate('mig-i', { invitationRules: CHICA_CHANGED_RULES });
  runMigration();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('migración «Copa con invitación»: la carta', () => {
  it('la referencia de antes sin tocar: la invitación se llama «Copa con invitación» y va detrás de «Copa»; «Copa premium», apagada', async () => {
    const rows = await carta(untouched);
    expect(rows).toHaveLength(13);
    expect(await copas(untouched)).toEqual(['Copa', 'Copa con invitación', 'Botella', 'Chupito']);
    expect(rows.find((i) => i.name === 'Copa con invitación')).toMatchObject({ sortOrder: 1, isInvitation: true, priceCents: 2000 });
    expect(await byName(untouched, 'Copa premium')).toEqual([expect.objectContaining({ active: false, priceCents: 1400 })]);
    expect(await byName(untouched, 'Invitar a una copa')).toEqual([]);
    // Ya es igual que la referencia de ahora: aplicarla no cambiaría nada.
    expect(cartaTemplatePlan(rows).every((c) => c.action === 'keep')).toBe(true);
  });

  it('una «Copa premium» ya vendida se queda encendida, pero «Copa con invitación» va justo detrás de «Copa»', async () => {
    expect(await byName(sold, 'Copa premium')).toEqual([expect.objectContaining({ active: true, priceCents: 1400 })]);
    expect(await copas(sold)).toEqual(['Copa', 'Copa con invitación', 'Copa premium', 'Botella', 'Chupito']);
    // Lo cobrado no cambia (la línea guarda su nombre) y la referencia de ahora no tiene nada que cambiar.
    const line = await sys((tx) => tx.paymentLine.findFirstOrThrow({ where: { tenantId: sold } }));
    expect(line.label).toBe('Copa premium');
    expect(cartaTemplatePlan(await carta(sold)).every((c) => c.action === 'keep')).toBe(true);
  });

  it('una «Copa premium» vendida solo con el saldo antes de las líneas (solo su nombre) tampoco se apaga', async () => {
    expect(await byName(saldo, 'Copa premium')).toEqual([expect.objectContaining({ active: true, priceCents: 1400 })]);
    expect(await copas(saldo)).toEqual(['Copa', 'Copa con invitación', 'Copa premium', 'Botella', 'Chupito']);
  });

  it('con la primera referencia (sin invitación) y la premium vendida, la de ahora crea la invitación justo detrás de «Copa»', async () => {
    expect(await byName(first, 'Copa premium')).toEqual([expect.objectContaining({ active: true })]);
    const owner = await sys((tx) => tx.user.create({ data: { tenantId: first, email: `own-${key()}@x.es`, passwordHash: 'x', role: 'OWNER' } }));
    const applied = await inVenue(first, () => cartaService.applyTemplate(first, owner.id, { confirm: true }));
    expect(applied).toMatchObject({ created: 1, updated: 0, skipped: 0 });
    expect(await copas(first)).toEqual(['Copa', 'Copa con invitación', 'Copa premium', 'Botella', 'Chupito']);
  });

  it('lo que el dueño cambió se queda: la invitación (otro precio, otro sitio) solo cambia de nombre; la copa premium a 15 €, encendida', async () => {
    expect(await byName(edited, 'Copa con invitación')).toEqual([
      expect.objectContaining({ isInvitation: true, priceCents: 2500, sortOrder: 5, active: true }),
    ]);
    expect(await byName(edited, 'Copa premium')).toEqual([expect.objectContaining({ active: true, priceCents: 1500 })]);
  });

  it('con otro «Copa con invitación» en la carta (no es la invitación), la invitación no se renombra ni se mueve', async () => {
    expect(await byName(named, 'Invitar a una copa')).toEqual([expect.objectContaining({ isInvitation: true, sortOrder: 12, active: true })]);
    expect(await byName(named, 'COPA CON INVITACIÓN')).toEqual([expect.objectContaining({ isInvitation: false, priceCents: 1800, active: true })]);
    // Su «Copa premium» nunca se vendió: se apaga, como en cualquier otro local.
    expect(await byName(named, 'Copa premium')).toEqual([expect.objectContaining({ active: false })]);
  });
});

describe('migración «Copa con invitación»: la parte del camarero', () => {
  it('el 50 % de fábrica de antes, que guardaba el formulario anterior, pasa a 0 %; lo demás que guardó se queda', async () => {
    expect((await rulesOf(saved)).invitationRules).toEqual({ ...SAVED_RULES, camarero: ZERO });
    expect((await rulesOf(chicaChanged)).invitationRules).toEqual({ ...CHICA_CHANGED_RULES, camarero: ZERO });
    // Queda en el registro: qué había y qué hay, sin persona (lo hizo la migración).
    const events = await auditOf(saved);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorId: null, targetType: 'Venue', targetId: saved });
    expect(events[0]!.payload).toMatchObject({
      before: SAVED_RULES,
      after: { ...SAVED_RULES, camarero: ZERO },
      migration: '20261028100000_copa_con_invitacion',
    });
  });

  it('la parte que eligió el dueño (otra cosa que el 50 % de fábrica de antes) no se toca', async () => {
    expect((await rulesOf(chosen)).invitationRules).toEqual(CHOSEN_RULES);
    expect(await auditOf(chosen)).toEqual([]);
  });

  it('antes y después: el camarero se llevaba la mitad; ahora, nada; lo ya cobrado no cambia', async () => {
    expect(await lineOf(beforePayment)).toMatchObject({ beneficiaryOperatorId: lola, beneficiaryCents: 1000, chargerCents: 1000 });
    const after = await invite(saved);
    expect(await lineOf(after.id)).toMatchObject({ beneficiaryOperatorId: lola, beneficiaryCents: 1000, chargerCents: 0 });
  });

  it('el JSON de antes con «inviteFirst» se lee sin error y se olvida al volver a guardar', async () => {
    const stored = (await rulesOf(saved)).invitationRules;
    expect(stored).toHaveProperty('inviteFirst', true);
    expect(invitationRulesOf(stored)).toEqual({ chica: { kind: 'PERCENT', bps: 5000 }, camarero: ZERO, requireQr: true });
    expect(mergeInvitationRules(stored, { requireQr: false })).toEqual({ chica: { kind: 'PERCENT', bps: 5000 }, camarero: ZERO, requireQr: false });
  });
});

describe('migración «Copa con invitación»: segura', () => {
  const venues = () => [untouched, edited, sold, saldo, first, named, saved, chosen, chicaChanged];
  const snapshot = () =>
    Promise.all(
      venues().map(async (id) => ({ carta: await carta(id), rules: (await rulesOf(id)).invitationRules, audit: (await auditOf(id)).length })),
    );

  it('no borra nada y la segunda vez no cambia nada (ni la carta, ni las partes, ni vuelve a escribir en el registro)', async () => {
    const before = await snapshot();
    expect(before.map((v) => v.carta.length)).toEqual([13, 13, 13, 13, 13, 14, 13, 13, 13]);
    runMigration();
    expect(await snapshot()).toEqual(before);
  });
});
