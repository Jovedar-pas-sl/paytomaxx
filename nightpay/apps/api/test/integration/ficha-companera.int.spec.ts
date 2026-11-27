// Integración (Postgres real, FORCE RLS, rol sin superusuario): cobro por el encargado, fase 2
// (migración 20261127030000_ficha_companera, 26-nov-2026): la ficha NFC de la compañera.
//  - El encargado le da una ficha (en blanco, con su número de serie) y su hoja dice «Ficha nº …».
//  - Al cobrar a su nombre se acerca su ficha: vale la original; una copia (otro chip con su código), no.
//  - Si la pierde se le da otra: la de antes deja de valer al momento. Se puede anular, y la baja la anula.
//  - Dar y anular quedan en el registro.
//  - La ficha de una compañera acercada como la de un cliente (cobro, recarga, saldo, darla a un saldo)
//    se rechaza con un mensaje claro; y la de un cliente no se puede dar como ficha de compañera.
//  - La migración se puede repetir y la tabla no se ve desde otro local.
// Ver README.md.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { HttpException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import {
  SERVICE_OPERATOR_INVALID_CODE,
  STAFF_CARD_COPY_MESSAGE,
  STAFF_CARD_NOT_BLANK_MESSAGE,
  STAFF_CARD_NOT_CUSTOMER_CODE,
  STAFF_CARD_REVOKED_MESSAGE,
} from '@nightpay/contracts';
import { PrismaService, type TransactionalClient } from '../../src/common/prisma/prisma.service';
import { AdminController } from '../../src/modules/admin/admin.controller';
import { AuditService } from '../../src/modules/audit/audit.service';
import { OperatorsService } from '../../src/modules/operators/operators.service';
import { signStaffToken, verifyStaffToken } from '../../src/modules/operators/staff-qr';
import { StaffCardsService } from '../../src/modules/operators/staff-cards.service';
import { resolveChargeOrThrow } from '../../src/modules/payments/charge-request';
import { readReceptionDesk } from '../../src/modules/wallets/reception-desk';
import { attachCard } from '../../src/modules/wallets/wallet-card-ops';
import { WalletChargesService } from '../../src/modules/wallets/wallet-charges.service';
import { topUpTarget } from '../../src/modules/wallets/wallet-topup-target';

process.env.JWT_SECRET ??= 'clave-de-las-pruebas-de-integracion-0123456789';
const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const audit = new AuditService(prisma, cls as never);
const cards = new StaffCardsService(prisma, audit);
const config = { get: () => undefined, getOrThrow: () => undefined };
const sessions = { revokeAllForUser: vi.fn(async () => 0) };
const operators = new OperatorsService(prisma, {} as never, audit, config as never, {} as never, {} as never, sessions as never);
const admin = new AdminController(prisma, {} as never, audit, operators, {} as never, cls as never, {} as never, {} as never);
const charges = new WalletChargesService(prisma, audit, { get: () => ({}) } as never, {} as never);

const MIGRATION = join(__dirname, '../../../../packages/db/prisma/migrations/20261127030000_ficha_companera/migration.sql');

const r = randomUUID().slice(0, 6);
let V: string;
let OTHER: string;
let boss: string;
let manager: string;
let nerea: string;
let lola: string;

function inVenue<T>(tenantId: string | undefined, fn: () => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { tenantId, traceId: `t-fc-${r}` });
    return fn();
  });
}
const sys = <T>(fn: (tx: TransactionalClient) => Promise<T>) => inVenue(undefined, () => prisma.asSystem(fn));
const token = () => randomBytes(16).toString('base64url');
const chip = () => `04${randomBytes(6).toString('hex').toUpperCase()}`;
const byManager = { userId: '', tenantId: '' };

async function failure(p: Promise<unknown>): Promise<{ status: number; message: string; code?: string }> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof HttpException)) throw new Error(`se esperaba un error HTTP y llegó ${String(err)}`);
  const body = err.getResponse();
  const b = typeof body === 'string' ? { message: body } : (body as { message: string; code?: string });
  return { status: err.getStatus(), message: b.message, code: b.code };
}

/** Como el panel: pide su código, «lo graba» y la da. */
const give = (operatorId: string, code?: string, uid = chip()) =>
  inVenue(V, async () => {
    const card = code ?? (await cards.reserve(byManager, operatorId)).card;
    return { view: await cards.issue(byManager, operatorId, { card, uid }), card, uid };
  });
const resolve = (card: string, uid: string) => inVenue(V, () => cards.resolve({ userId: boss, tenantId: V }, { card, uid }));
const auditOf = (action: string, target: string) =>
  sys((tx) => tx.auditEvent.findMany({ where: { action, targetId: target }, orderBy: { occurredAt: 'asc' }, select: { payload: true, actorId: true } }));

beforeAll(async () => {
  await prisma.onModuleInit();
  await sys(async (tx) => {
    V = (await tx.venue.create({ data: { name: `Sala Ficha ${r}`, slug: `fc-${r}`, walletGroup: `gfc-${r}` } })).id;
    OTHER = (await tx.venue.create({ data: { name: `Otra Ficha ${r}`, slug: `fc-o-${r}` } })).id;
    const mk = (role: string, name: string, tenantId = V) =>
      tx.user.create({ data: { tenantId, email: `${name}-${r}@x.es`, passwordHash: 'x', role, displayName: name } as never }).then((u) => u.id);
    boss = await mk('OWNER', 'jefa');
    manager = await mk('MANAGER', 'enc');
    nerea = await mk('OPERATOR', 'Nerea');
    lola = await mk('OPERATOR', 'Lola');
  });
  byManager.userId = manager;
  byManager.tenantId = V;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('Darle su ficha', () => {
  it('la ficha en blanco pasa a ser la suya, con su número (el de las fichas de los clientes) y en el registro', async () => {
    const { view, card } = await give(nerea);
    expect(view.number).toBeGreaterThan(0);
    const stored = await sys((tx) => tx.staffCard.findUniqueOrThrow({ where: { token: card } }));
    expect(stored).toMatchObject({ userId: nerea, tenantId: V, revokedAt: null, issuedById: manager });
    const issued = await auditOf('operator.staff_card_issued', nerea);
    expect(issued.at(-1)).toMatchObject({ actorId: manager, payload: { number: view.number } });
    // Su hoja del panel: «Ficha nº …».
    const list = await inVenue(V, () => admin.listOperators(V, undefined));
    expect(list.find((o) => o.id === nerea)?.staffCard).toEqual({ number: view.number, issuedAt: view.issuedAt });
    expect(list.find((o) => o.id === lola)?.staffCard).toBeNull();
  });

  it('el número no se repite con el de ninguna ficha de cliente (la misma secuencia)', async () => {
    const client = await sys((tx) => tx.walletCard.create({ data: { token: token(), status: 'STOCK', venueId: V } }));
    const { view } = await give(lola);
    expect(view.number).toBeGreaterThan(client.number);
    await inVenue(V, () => cards.revoke(byManager, lola));
  });

  it('la misma respuesta otra vez (se perdió la de antes) no da otra ni deja dos registros', async () => {
    const first = await give(lola);
    const again = await inVenue(V, () => cards.issue(byManager, lola, { card: first.card, uid: first.uid }));
    expect(again.number).toBe(first.view.number);
    const issued = (await auditOf('operator.staff_card_issued', lola)).filter((a) => (a.payload as { number: number }).number === first.view.number);
    expect(issued).toHaveLength(1);
    await inVenue(V, () => cards.revoke(byManager, lola));
  });

  it('una ficha de cliente (por su código o por su chip) no se da como la de una compañera', async () => {
    const uid = chip();
    const client = await sys((tx) => tx.walletCard.create({ data: { token: token(), uid, status: 'STOCK', venueId: V } }));
    expect(await failure(give(lola, client.token))).toMatchObject({ status: 409, message: STAFF_CARD_NOT_BLANK_MESSAGE });
    expect(await failure(give(lola, token(), uid))).toMatchObject({ status: 409, message: STAFF_CARD_NOT_BLANK_MESSAGE });
  });

  it('solo con el código que se pidió para ella: uno inventado o el de otra compañera, no (409)', async () => {
    expect(await failure(give(lola, token()))).toMatchObject({ status: 409, message: STAFF_CARD_NOT_BLANK_MESSAGE });
    const forNerea = (await inVenue(V, () => cards.reserve(byManager, nerea))).card;
    expect(await failure(give(lola, forNerea))).toMatchObject({ status: 409, message: STAFF_CARD_NOT_BLANK_MESSAGE });
    expect(await sys((tx) => tx.staffCard.count({ where: { userId: lola, revokedAt: null } }))).toBe(0);
  });

  it('se grabó pero se perdió la respuesta: al acercarla otra vez (su código ya grabado) se le da', async () => {
    const card = (await inVenue(V, () => cards.reserve(byManager, lola))).card;
    const uid = chip();
    // El primer intento no llegó; el segundo lee el código ya grabado y lo manda.
    const { view } = await give(lola, card, uid);
    expect(await sys((tx) => tx.staffCard.findUniqueOrThrow({ where: { token: card }, select: { userId: true, uid: true } }))).toEqual({ userId: lola, uid });
    // Y si el primero sí llegó, otra vez lo mismo: la misma ficha.
    expect((await give(lola, card, uid)).view.number).toBe(view.number);
    await inVenue(V, () => cards.revoke(byManager, lola));
  });

  it('pedir su código: solo para una compañera de este local (404)', async () => {
    expect((await failure(inVenue(V, () => cards.reserve(byManager, manager)))).status).toBe(404);
  });

  it('el chip de una compañera no se da a otra', async () => {
    const nereaCard = await sys((tx) => tx.staffCard.findFirstOrThrow({ where: { userId: nerea, revokedAt: null } }));
    expect((await failure(give(lola, token(), nereaCard.uid))).status).toBe(409);
  });

  it('a quien no es una compañera de este local, no (404)', async () => {
    expect((await failure(give(manager))).status).toBe(404);
    const elsewhere = await sys((tx) =>
      tx.user.create({ data: { tenantId: OTHER, email: `fuera-${r}@x.es`, passwordHash: 'x', role: 'OPERATOR' } as never }).then((u) => u.id),
    );
    expect((await failure(give(elsewhere))).status).toBe(404);
  });
});

describe('Acercar su ficha al cobrar a su nombre', () => {
  it('la original: sale la compañera con un «Mi QR» firmado que vale para cobrar a su nombre', async () => {
    const { card, uid, view } = await give(lola);
    const out = await resolve(card, uid.toLowerCase().replace(/(..)/g, '$1:').slice(0, -1));
    expect(out).toMatchObject({ id: lola, name: 'Lola', cardNumber: view.number });
    expect(verifyStaffToken(out.token, Date.now(), process.env.JWT_SECRET!)).toMatchObject({ userId: lola, tenantId: V });
  });

  it('una copia (su código en otro chip) no vale, y queda apuntado', async () => {
    const live = await sys((tx) => tx.staffCard.findFirstOrThrow({ where: { userId: lola, revokedAt: null } }));
    expect(await failure(resolve(live.token, chip()))).toMatchObject({ status: 400, message: STAFF_CARD_COPY_MESSAGE });
    expect((await auditOf('operator.staff_card_copy_suspected', lola)).length).toBeGreaterThan(0);
  });

  it('desde otro local no vale', async () => {
    const live = await sys((tx) => tx.staffCard.findFirstOrThrow({ where: { userId: lola, revokedAt: null } }));
    const err = await failure(inVenue(OTHER, () => cards.resolve({ userId: boss, tenantId: OTHER }, { card: live.token, uid: live.uid })));
    expect(err.status).toBe(400);
  });

  it('la perdió: se le da otra y la de antes deja de valer al momento (y el registro lo dice)', async () => {
    const old = await sys((tx) => tx.staffCard.findFirstOrThrow({ where: { userId: lola, revokedAt: null } }));
    const fresh = await give(lola);
    expect(await failure(resolve(old.token, old.uid))).toMatchObject({ status: 400, message: STAFF_CARD_REVOKED_MESSAGE });
    expect((await resolve(fresh.card, fresh.uid)).id).toBe(lola);
    const revoked = await auditOf('operator.staff_card_revoked', lola);
    expect(revoked.at(-1)).toMatchObject({ actorId: manager, payload: { number: old.number, reason: 'replaced', replacedBy: fresh.view.number } });
    // Una sola viva.
    expect(await sys((tx) => tx.staffCard.count({ where: { userId: lola, revokedAt: null } }))).toBe(1);
  });

  it('anulada desde su hoja: no vale, y queda en el registro', async () => {
    const live = await sys((tx) => tx.staffCard.findFirstOrThrow({ where: { userId: lola, revokedAt: null } }));
    expect(await inVenue(V, () => cards.revoke(byManager, lola))).toEqual({ revoked: live.number });
    expect((await failure(resolve(live.token, live.uid))).message).toBe(STAFF_CARD_REVOKED_MESSAGE);
    expect((await auditOf('operator.staff_card_revoked', lola)).at(-1)).toMatchObject({ payload: { number: live.number, reason: 'revoked' } });
    // Sin ficha, anular otra vez no hace nada.
    expect(await inVenue(V, () => cards.revoke(byManager, lola))).toEqual({ revoked: null });
  });

  it('de baja: su ficha queda anulada', async () => {
    const leaving = await sys((tx) =>
      tx.user.create({ data: { tenantId: V, email: `baja-${r}@x.es`, passwordHash: 'x', role: 'OPERATOR', displayName: 'Baja' } as never }).then((u) => u.id),
    );
    const { card, uid } = await give(leaving);
    await inVenue(V, () => operators.updateOperator(V, leaving, boss, 'OWNER', { active: false } as never));
    expect((await failure(resolve(card, uid))).message).toBe(STAFF_CARD_REVOKED_MESSAGE);
    expect(await sys((tx) => tx.staffCard.findUniqueOrThrow({ where: { token: card }, select: { revokedReason: true } }))).toEqual({ revokedReason: 'offboarded' });
  });
});

describe('El «Mi QR» que sale de su ficha, al crear el cobro', () => {
  let servicio: string;
  let sara: string;

  beforeAll(async () => {
    await sys(async (tx) => {
      servicio = (await tx.serviceItem.create({ data: { tenantId: V, name: `Servicio ficha ${r}`, priceCents: 6000, category: 'CHICA_SERVICE' } })).id;
      sara = (await tx.user.create({ data: { tenantId: V, email: `sara-${r}@x.es`, passwordHash: 'x', role: 'OPERATOR', displayName: 'Sara' } as never })).id;
    });
  });

  const cobrar = (serviceStaffToken: string) =>
    inVenue(V, () =>
      resolveChargeOrThrow(prisma, { tenantId: V, userId: manager, role: 'MANAGER', lines: [{ serviceItemId: servicio, qty: 1 }], serviceStaffToken }),
    );
  const invalid = { response: expect.objectContaining({ code: SERVICE_OPERATOR_INVALID_CODE }) };

  it('con la ficha viva, el servicio es suyo', async () => {
    const { card, uid } = await give(sara);
    const { token: qr } = await resolve(card, uid);
    expect((await cobrar(qr)).lines[0]).toMatchObject({ serviceOperatorId: sara });
  });

  it('sacado justo antes de anularla, después ya no vale', async () => {
    const live = await sys((tx) => tx.staffCard.findFirstOrThrow({ where: { userId: sara, revokedAt: null } }));
    const { token: qr } = await resolve(live.token, live.uid);
    await inVenue(V, () => cards.revoke(byManager, sara));
    await expect(cobrar(qr)).rejects.toMatchObject(invalid);
  });

  it('sacado justo antes de sustituirla, después ya no vale (y el de la nueva, sí)', async () => {
    const old = await give(sara);
    const { token: qr } = await resolve(old.card, old.uid);
    const fresh = await give(sara);
    await expect(cobrar(qr)).rejects.toMatchObject(invalid);
    expect((await cobrar((await resolve(fresh.card, fresh.uid)).token)).lines[0]).toMatchObject({ serviceOperatorId: sara });
  });

  it('su «Mi QR» de siempre (sin ficha) sigue valiendo aunque no tenga ficha viva', async () => {
    await inVenue(V, () => cards.revoke(byManager, sara));
    const qr = signStaffToken({ userId: sara, tenantId: V }, Date.now(), process.env.JWT_SECRET!).token;
    expect((await cobrar(qr)).lines[0]).toMatchObject({ serviceOperatorId: sara });
  });
});

describe('La ficha de una compañera acercada como la de un cliente', () => {
  let staffCard: { card: string; uid: string };

  beforeAll(async () => {
    const live = await sys((tx) => tx.staffCard.findFirstOrThrow({ where: { userId: nerea, revokedAt: null } }));
    staffCard = { card: live.token, uid: live.uid };
  });

  const notCustomer = (err: { status: number; code?: string; message: string }) => {
    expect(err.status).toBe(400);
    expect(err.code).toBe(STAFF_CARD_NOT_CUSTOMER_CODE);
    expect(err.message).toMatch(/ficha de una compañera/);
  };

  it('al cobrar con el saldo de la ficha', async () => {
    notCustomer(await failure(inVenue(V, () => charges.lookupCard(V, staffCard))));
  });

  it('al recargar', async () => {
    notCustomer(await failure(inVenue(V, () => topUpTarget(prisma, V, staffCard))));
  });

  it('al mirar el saldo en recepción', async () => {
    notCustomer(await failure(inVenue(V, () => prisma.acrossVenues((tx) => readReceptionDesk(tx, { id: V, walletGroup: `gfc-${r}` }, staffCard)))));
  });

  it('al darla a un saldo', async () => {
    const wallet = await sys((tx) =>
      tx.clientWallet.create({ data: { tenantId: V, walletGroup: `gfc-${r}`, balanceCents: 1_000, qrToken: token() } }),
    );
    notCustomer(await failure(inVenue(V, () => attachCard(prisma, { walletId: wallet.id, venueId: V, card: staffCard.card, uid: staffCard.uid, by: { userId: manager } }))));
  });

  it('una ficha que no es de nadie sigue con su mensaje de siempre', async () => {
    const err = await failure(inVenue(V, () => topUpTarget(prisma, V, { card: token() })));
    expect(err.code).toBeUndefined();
  });
});

describe('La tabla', () => {
  it('desde otro local no se ve (FORCE RLS)', async () => {
    const seen = await inVenue(OTHER, () => prisma.withTenant(OTHER, (tx) => tx.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM staff_cards WHERE "tenantId" = ${V}::uuid`));
    expect(seen[0]!.n).toBe(0);
  });

  it('una ficha viva por compañera, también en la base', async () => {
    const n = await sys(async (tx) => (await tx.$queryRaw<Array<{ n: number }>>`SELECT nextval('wallet_cards_number_seq')::int AS n`)[0]!.n);
    const err = await sys((tx) => tx.staffCard.create({ data: { tenantId: V, userId: nerea, token: token(), uid: chip(), number: n } })).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toMatch(/staff_cards_one_live_per_user|Unique constraint/);
  });

  it('la migración se puede repetir sin tocar lo guardado', async () => {
    const before = await sys((tx) => tx.staffCard.count());
    const cli = join(__dirname, '../../../../packages/db/node_modules/prisma/build/index.js');
    const res = spawnSync(process.execPath, [cli, 'db', 'execute', '--url', String(process.env.DATABASE_URL), '--file', MIGRATION], {
      encoding: 'utf8',
      env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    });
    expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0);
    expect(await sys((tx) => tx.staffCard.count())).toBe(before);
  });
});
