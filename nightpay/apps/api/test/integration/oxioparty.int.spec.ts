// Integración (Postgres real): OxioParty, la base (migración 20261115100000_oxioparty_base).
// Con EDITION=party: casetas con FORCE RLS (dueño y encargado, dentro de withTenant), la caseta
// del personal sellada en el cobro, en su cobro del saldo y en el consumo (pagado con la pulsera
// NFC) y en el cobro con QR del saldo; con la fiesta terminada, 423 EVENT_ENDED (las consultas
// siguen). Con EDITION=club (OxioPay) nada se sella. Las reglas de la base: la parte del
// organizador de 0 a 10000, la caseta siempre del mismo local, una caseta con cobros no se borra
// y la migración se puede repetir. np_app y FORCE RLS. Ver README.md.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ClsService } from 'nestjs-cls';
import { ConflictException } from '@nestjs/common';
import type { JwtPayload } from '@nightpay/contracts';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { WalletChargesService } from '../../src/modules/wallets/wallet-charges.service';
import { StallsService } from '../../src/modules/party/stalls.service';
import { myStall } from '../../src/modules/party/stall-seal';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const noop = () => undefined;
const audit = { log: vi.fn(async () => undefined) };
const queue = { add: vi.fn(async () => undefined) };
const metrics = { paymentsCreated: { inc: noop }, paymentsTransitioned: { inc: noop }, walletCreditSkipped: { inc: noop }, duplicateCharges: { inc: noop } };
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
const charges = new WalletChargesService(prisma as never, audit as never, { get: () => ({}) } as never, {} as never);
const totp = { assertIfEnrolledForUser: vi.fn(async () => undefined) };
const stalls = new StallsService(prisma, totp as never, audit as never);

const inVenue = <T>(tenantId: string | undefined, fn: () => Promise<T>): Promise<T> =>
  cls.run(async () => {
    cls.set('ctx', { tenantId, traceId: 't-party' });
    return fn();
  });
const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) =>
  inVenue(undefined, () => prisma.asSystem(fn));

const r = randomUUID().slice(0, 6);
let V: string, OTHER: string, owner: string, toni: string, sinCaseta: string, otherStall: string;
let n = 0;
const key = () => `party-${r}-${(n += 1)}`;
const ownerJwt = (): JwtPayload => ({ sub: owner, email: `duena-${r}@x.es`, role: 'OWNER', tenantId: V, venueSlug: `party-${r}` });
const IBAN = 'ES9121000418450200051332';

function code6(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from(randomBytes(6), (b) => alphabet[b % alphabet.length]).join('');
}

/** Saldo del cliente con su pulsera NFC. */
async function wallet(balanceCents: number): Promise<{ id: string; card: string; uid: string }> {
  n += 1;
  const card = randomBytes(16).toString('base64url');
  const uid = randomBytes(7).toString('hex').toUpperCase();
  const id = await sys(async (tx) => {
    const w = await tx.clientWallet.create({
      data: { tenantId: V, balanceCents, qrToken: `party-${r}-${n}-abcdefgh`, shortCode: code6(), walletGroup: `gparty-${r}` },
    });
    await tx.walletCard.create({ data: { token: card, uid, walletId: w.id, status: 'ISSUED', venueId: V } });
    return w.id;
  });
  return { id, card, uid };
}

const cobro = (userId: string, extra: Record<string, unknown> = {}) =>
  inVenue(V, () =>
    payments.create(
      V,
      key(),
      { currency: 'EUR', terminalExternalId: `PARTY-${r}`, amountCents: 1000, revenueCategory: 'VENUE_BAR', withSaldo: true, ...extra } as never,
      { userId, role: 'WAITER' },
    ),
  );

const stallOfPayment = (id: string) => sys(async (tx) => (await tx.payment.findUniqueOrThrow({ where: { id }, select: { stallId: true } })).stallId);
const stallOfCharge = (id: string) => sys(async (tx) => (await tx.walletChargeRequest.findUniqueOrThrow({ where: { id }, select: { stallId: true } })).stallId);

let stallId: string;

beforeAll(async () => {
  await prisma.onModuleInit();
  await sys(async (tx) => {
    V = (await tx.venue.create({ data: { name: 'Fiesta Mayor', slug: `party-${r}`, walletGroup: `gparty-${r}` } })).id;
    OTHER = (await tx.venue.create({ data: { name: 'Otra Fiesta', slug: `party-otra-${r}` } })).id;
    await tx.terminal.create({ data: { tenantId: V, externalId: `PARTY-${r}`, label: 'Barra', zone: 'BARRA' } });
    await tx.gatewayCredential.create({
      data: { tenantId: V, provider: 'REDSYS', encKey: Buffer.from('k'), encNonce: Buffer.from('n'), encTag: Buffer.from('t'), kekVersion: 1 },
    });
    owner = (await tx.user.create({ data: { tenantId: V, email: `duena-${r}@x.es`, passwordHash: 'x', role: 'OWNER' } })).id;
    toni = (await tx.user.create({ data: { tenantId: V, email: `toni-${r}@x.es`, passwordHash: 'x', role: 'WAITER', displayName: 'Toni' } })).id;
    sinCaseta = (await tx.user.create({ data: { tenantId: V, email: `ana-${r}@x.es`, passwordHash: 'x', role: 'WAITER' } })).id;
    otherStall = (await tx.stall.create({ data: { tenantId: OTHER, name: 'De otro local', managerName: 'X', organizerBps: 0 } })).id;
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('casetas (EDITION=party, FORCE RLS de verdad)', () => {
  it('se crean, se listan y se asignan dentro de withTenant (sin asSystem)', async () => {
    vi.stubEnv('EDITION', 'party');
    const created = await inVenue(V, () =>
      stalls.create(ownerJwt(), { name: 'Peña El Trago', managerName: 'Lola', organizerBps: 2500, iban: IBAN }),
    );
    stallId = created.id;
    expect(created).toMatchObject({ organizerBps: 2500, iban: IBAN, ownBar: false, staffCount: 0 });
    const person = await inVenue(V, () => stalls.assign(ownerJwt(), toni, { stallId }));
    expect(person.stallId).toBe(stallId);
    const list = await inVenue(V, () => stalls.list(V));
    expect(list.map((s) => [s.name, s.staffCount])).toEqual([['Peña El Trago', 1]]);
    expect((await inVenue(V, () => stalls.staff(V))).find((p) => p.id === toni)?.stallId).toBe(stallId);
    expect(await inVenue(V, () => myStall(prisma, { tenantId: V, userId: toni }))).toEqual({ id: stallId, name: 'Peña El Trago' });
    expect(await inVenue(V, () => myStall(prisma, { tenantId: V, userId: sinCaseta }))).toBeNull();
  });

  it('una caseta de otro local no se puede dar (404) y la base tampoco la deja', async () => {
    vi.stubEnv('EDITION', 'party');
    await expect(inVenue(V, () => stalls.assign(ownerJwt(), sinCaseta, { stallId: otherStall }))).rejects.toMatchObject({ status: 404 });
    await expect(sys((tx) => tx.user.update({ where: { id: sinCaseta }, data: { stallId: otherStall } }))).rejects.toThrow(/foreign key|Foreign key/);
  });

  it('la parte del organizador, de 0 a 10000; el IBAN con forma de IBAN (la base)', async () => {
    await expect(sys((tx) => tx.stall.create({ data: { tenantId: V, name: 'Mal', managerName: 'X', organizerBps: 10_001 } }))).rejects.toThrow(
      /stalls_organizer_bps_range/,
    );
    await expect(
      sys((tx) => tx.stall.create({ data: { tenantId: V, name: 'Mal', managerName: 'X', organizerBps: 0, iban: 'es91 2100' } })),
    ).rejects.toThrow(/stalls_iban_format/);
  });
});

describe('la caseta en el cobro, en el cobro del saldo y en el consumo', () => {
  it('cobro único pagado con la pulsera: cobro, cobro del saldo y consumo con la caseta de quien cobra', async () => {
    vi.stubEnv('EDITION', 'party');
    const w = await wallet(5_000);
    const c = await cobro(toni);
    expect(await stallOfPayment(c.id)).toBe(stallId);
    expect(await stallOfCharge(c.saldo!.chargeId)).toBe(stallId);
    await inVenue(V, () => charges.payQrChargeWithCard({ userId: toni, role: 'WAITER', tenantId: V }, c.saldo!.chargeId, { card: w.card, uid: w.uid }));
    const consumption = await sys((tx) => tx.walletConsumption.findFirstOrThrow({ where: { walletId: w.id } }));
    expect(consumption).toMatchObject({ stallId, amountCents: 1000 });
  });

  it('cobro con QR del saldo: con la caseta, y la conserva aunque la persona cambie de caseta después', async () => {
    vi.stubEnv('EDITION', 'party');
    const qr = await inVenue(V, () =>
      charges.createQrCharge({ userId: toni, role: 'WAITER', tenantId: V }, { amountCents: 500, category: 'VENUE_BAR' } as never),
    );
    expect(await stallOfCharge(qr.id)).toBe(stallId);
    await inVenue(V, () => stalls.assign(ownerJwt(), toni, { stallId: null }));
    const w = await wallet(2_000);
    await inVenue(V, () => charges.payQrChargeWithCard({ userId: toni, role: 'WAITER', tenantId: V }, qr.id, { card: w.card, uid: w.uid }));
    const consumption = await sys((tx) => tx.walletConsumption.findFirstOrThrow({ where: { walletId: w.id } }));
    expect(consumption.stallId).toBe(stallId);
    await inVenue(V, () => stalls.assign(ownerJwt(), toni, { stallId }));
  });

  it('sin caseta, o con OxioPay (club) aunque la tenga: sin stallId', async () => {
    vi.stubEnv('EDITION', 'party');
    const sin = await cobro(sinCaseta);
    expect(await stallOfPayment(sin.id)).toBeNull();
    vi.stubEnv('EDITION', 'club');
    const club = await cobro(toni);
    expect(await stallOfPayment(club.id)).toBeNull();
    expect(await stallOfCharge(club.saldo!.chargeId)).toBeNull();
  });

  it('una caseta con cobros no se borra (409 STALL_IN_USE); una sin cobros, sí, y su personal se queda sin caseta', async () => {
    vi.stubEnv('EDITION', 'party');
    await expect(inVenue(V, () => stalls.remove(ownerJwt(), stallId))).rejects.toBeInstanceOf(ConflictException);
    expect(await sys(async (tx) => (await tx.user.findUniqueOrThrow({ where: { id: toni } })).stallId)).toBe(stallId);
    const vacia = await inVenue(V, () => stalls.create(ownerJwt(), { name: 'Barra propia', managerName: 'Org', organizerBps: 10_000 }));
    await inVenue(V, () => stalls.assign(ownerJwt(), sinCaseta, { stallId: vacia.id }));
    await expect(inVenue(V, () => stalls.remove(ownerJwt(), vacia.id))).resolves.toEqual({ deleted: true, unassignedStaff: 1 });
    expect(await sys(async (tx) => (await tx.user.findUniqueOrThrow({ where: { id: sinCaseta } })).stallId)).toBeNull();
  });
});

describe('la fiesta terminada (EVENT_ENDED)', () => {
  it('con party y el fin pasado: ni cobros ni cobros del saldo nuevos; con club, todo sigue', async () => {
    await sys((tx) =>
      tx.venue.update({ where: { id: V }, data: { eventStartsAt: new Date(Date.now() - 86_400_000), eventEndsAt: new Date(Date.now() - 60_000) } }),
    );
    try {
      vi.stubEnv('EDITION', 'party');
      await expect(cobro(toni)).rejects.toMatchObject({ status: 423, response: expect.objectContaining({ code: 'EVENT_ENDED' }) });
      await expect(
        inVenue(V, () => charges.createQrCharge({ userId: toni, role: 'WAITER', tenantId: V }, { amountCents: 500, category: 'VENUE_BAR' } as never)),
      ).rejects.toMatchObject({ status: 423 });
      // Las consultas siguen.
      expect((await inVenue(V, () => stalls.list(V))).length).toBeGreaterThan(0);
      vi.stubEnv('EDITION', 'club');
      await expect(cobro(toni)).resolves.toMatchObject({ amountCents: 1000 });
    } finally {
      await sys((tx) => tx.venue.update({ where: { id: V }, data: { eventStartsAt: null, eventEndsAt: null } }));
    }
  });

  it('la base no deja un fin antes del inicio', async () => {
    await expect(
      sys((tx) => tx.venue.update({ where: { id: V }, data: { eventStartsAt: new Date('2026-03-20T00:00:00Z'), eventEndsAt: new Date('2026-03-19T00:00:00Z') } })),
    ).rejects.toThrow(/venues_event_window_check/);
  });
});

describe('la migración', () => {
  it('se puede repetir y los locales de antes quedan con los valores de serie', async () => {
    const cli = join(__dirname, '../../../../packages/db/node_modules/prisma/build/index.js');
    const file = join(__dirname, '../../../../packages/db/prisma/migrations/20261115100000_oxioparty_base/migration.sql');
    const res = spawnSync(process.execPath, [cli, 'db', 'execute', '--url', String(process.env.DATABASE_URL), '--file', file], {
      encoding: 'utf8',
      env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    });
    expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0);
    const venue = await sys((tx) => tx.venue.findUniqueOrThrow({ where: { id: OTHER } }));
    expect(venue).toMatchObject({ allowDonation: true, cashAlertCents: 200_000, eventStartsAt: null, eventEndsAt: null, refundDeadline: null });
  });
});
