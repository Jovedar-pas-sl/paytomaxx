// Integración (Postgres real, np_app con FORCE RLS; Redis de mentira): «Detalle del pago».
//  - El dispositivo de cada paso (payment.device): al crear el cobro (el móvil de la chica),
//    al pagar con el NFC en su móvil (con el saldo antes y después) y al cancelar (con quién);
//    del saldo suelto, en el registro y SIN IP.
//  - Quién ve qué: la chica, solo lo suyo y «lo tuyo» (nunca la parte del local); de otra, 404;
//    el cliente, solo los de su saldo; el móvil y la IP del cliente, solo el encargado y el dueño
//    verificados; lo delicado sin verificar: null en el detalle y 403 pedido aparte; la
//    verificación caduca; el reparto, el dueño y el encargado con «Informes».
//  - Buscar por los últimos 4 de la tarjeta y por la ficha (también una devuelta y dada a otro).
//  - La IP se borra a los 90 días. GET /v1/payments/:id cerrado al camarero (lo suyo sí).
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { CobrosQuerySchema, type JwtPayload } from '@nightpay/contracts';
import type { ClientDevice } from '../../src/common/http/client-device';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { createFakeRedis } from '../../src/modules/auth/testing/fake-redis';
import { StepUpService } from '../../src/modules/auth/step-up.service';
import { CobroDetailService } from '../../src/modules/money-map/cobro-detail.service';
import { CobrosService } from '../../src/modules/money-map/cobros.service';
import { DeviceIpRetentionService } from '../../src/modules/payments/device-ip-retention.service';
import { PaymentsController } from '../../src/modules/payments/payments.controller';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { WalletChargesService } from '../../src/modules/wallets/wallet-charges.service';

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
const charges = new WalletChargesService(prisma as never, audit as never, { get: () => ({}) } as never, {} as never, cls as never);
const redis = createFakeRedis();
const totp = { isEnabled: async () => true, assertForUser: async () => undefined };
const stepUp = new StepUpService(redis as never, totp as never);
const details = new CobroDetailService(prisma, stepUp, { get: () => undefined } as never);
const cobros = new CobrosService(prisma);
const paymentsController = new PaymentsController(payments, prisma);

const IPHONE: ClientDevice = { model: 'iPhone', os: 'iOS', osVersion: '18', browser: 'Safari 18', mobile: true, inApp: null, ip: '10.20.0.7' };
const ANDROID: ClientDevice = { model: 'SM-S918B', os: 'Android', osVersion: '14', browser: 'Chrome 130', mobile: true, inApp: null, ip: '83.45.120.7' };

const r = randomUUID().slice(0, 6);
let V: string, O: string, lola: string, nerea: string, carlos: string, owner: string, manager: string, hora: string;
let n = 0;
const key = () => `dc-${r}-${(n += 1)}`;

/** En el local, como una petición de esa persona con ese móvil (el contexto que pone el API). */
const as = <T>(who: { userId?: string; role?: string; tenantId?: string } | null, device: ClientDevice | null, fn: () => Promise<T>) =>
  cls.run(async () => {
    cls.set('ctx', { ...(who ?? {}), traceId: `t-${r}`, ...(device ? { device } : {}) } as never);
    return fn();
  });
const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) => as(null, null, () => prisma.asSystem(fn));
const jwt = (sub: string, role: JwtPayload['role'], tenantId = V, sid: string = randomUUID()): JwtPayload =>
  ({ sub, role, tenantId, email: `${sub.slice(0, 6)}@x.es`, venueSlug: 'x', sid }) as JwtPayload;

function code6(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from(randomBytes(6), (b) => alphabet[b % alphabet.length]).join('');
}

/** Saldo del cliente con su ficha NFC (con número de serie) y PIN 4827. */
async function wallet(balanceCents: number, printedNumber?: string): Promise<{ id: string; card: string; uid: string; cardId: string; code: string; qrToken: string }> {
  n += 1;
  const card = randomBytes(16).toString('base64url');
  const uid = randomBytes(7).toString('hex').toUpperCase();
  const code = code6();
  const qrToken = `dc-${r}-${n}-abcdefgh`;
  const made = await sys(async (tx) => {
    const w = await tx.clientWallet.create({ data: { tenantId: V, balanceCents, qrToken, shortCode: code, walletGroup: `gdc-${r}` } });
    // El número impreso como lo apunta recepción (ficha-numbers.ts): tal cual, sin ceros delante y en el grupo.
    const printed = printedNumber ? { printedNumber, printedNumberNorm: printedNumber.replace(/^0+(?=\d)/, ''), printedScope: `g:gdc-${r}` } : {};
    const c = await tx.walletCard.create({
      data: { token: card, uid, walletId: w.id, status: 'ISSUED', venueId: V, linkedAt: new Date(Date.now() - 60_000), ...printed },
    });
    await tx.walletCardEvent.create({ data: { cardId: c.id, venueId: V, walletId: w.id, kind: 'ISSUED', at: new Date(Date.now() - 60_000) } });
    return { id: w.id, cardId: c.id };
  });
  await as(null, null, () => charges.setPinFromPayer(made.id, '4827'));
  return { ...made, card, uid, code, qrToken };
}

/** El cobro único de «Cobrar» hecho por la chica desde su iPhone. */
const cobroDe = (userId: string, device: ClientDevice = IPHONE) =>
  as({ userId, role: 'OPERATOR', tenantId: V }, device, () =>
    payments.create(V, key(), { currency: 'EUR', terminalExternalId: `DC-${r}`, lines: [{ serviceItemId: hora, qty: 1 }], withSaldo: true } as never, {
      userId,
      role: 'OPERATOR',
    }),
  );

/** El cliente pagó con tarjeta (como lo deja el aviso del banco). */
async function paidByCard(paymentId: string, last4: string): Promise<void> {
  await sys((tx) =>
    tx.payment.update({
      where: { id: paymentId },
      data: { status: 'AUTHORIZED', provider: 'REDSYS', providerTxId: `RS${r}${last4}`, authorizedAt: new Date(), cardLast4: last4, cardBrand: '1', cardCountry: '826', secure3ds: false, authCode: '654321' },
    }),
  );
}

const events = (paymentId: string) =>
  sys((tx) => tx.paymentEvent.findMany({ where: { paymentId, eventType: 'payment.device' }, orderBy: { id: 'asc' } }));

beforeAll(async () => {
  await prisma.onModuleInit();
  await sys(async (tx) => {
    V = (await tx.venue.create({ data: { name: 'Sala Bambú (Madrid)', slug: `dc-${r}`, walletGroup: `gdc-${r}`, platformCommissionBps: 0 } })).id;
    O = (await tx.venue.create({ data: { name: 'Neón (Valencia)', slug: `dco-${r}`, walletGroup: `gdco-${r}` } })).id;
    await tx.terminal.create({ data: { tenantId: V, externalId: `DC-${r}`, label: 'Barra', zone: 'BARRA' } });
    const user = (email: string, role: 'OWNER' | 'MANAGER' | 'WAITER' | 'OPERATOR', displayName: string, tenantId = V) =>
      tx.user.create({ data: { tenantId, email: `${email}-${r}@x.es`, passwordHash: 'x', role, displayName, ...(role === 'OPERATOR' ? { commissionBps: 9000 } : {}) } });
    lola = (await user('lola', 'OPERATOR', 'Lola Martín')).id;
    nerea = (await user('nerea', 'OPERATOR', 'Nerea')).id;
    carlos = (await user('carlos', 'WAITER', 'Carlos Pérez')).id;
    owner = (await user('duena', 'OWNER', 'Dueña')).id;
    manager = (await user('javi', 'MANAGER', 'Javi')).id;
    hora = (await tx.serviceItem.create({ data: { tenantId: V, name: '1 h', priceCents: 12_000, category: 'CHICA_SERVICE' } })).id;
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('el dispositivo de cada paso', () => {
  it('al crear el cobro: el móvil de la chica (con su IP), en la misma transacción que el cobro', async () => {
    const c = await cobroDe(lola);
    const [created] = await events(c.id);
    expect(created!.payload).toMatchObject({ who: 'staff', step: 'create', userId: lola, model: 'iPhone', os: 'iOS', osVersion: '18', ip: '10.20.0.7' });
    expect((created!.payload as Record<string, unknown>).walletChargeId).toBe(c.saldo!.chargeId);
  });

  it('cobro único pagado con el NFC en el móvil de la chica: su móvil, cómo y el saldo antes y después (en el cobro enlazado)', async () => {
    const w = await wallet(20_000);
    const c = await cobroDe(lola);
    await as({ userId: lola, role: 'OPERATOR', tenantId: V }, IPHONE, () =>
      charges.payQrChargeWithPin({ userId: lola, role: 'OPERATOR', tenantId: V }, c.saldo!.chargeId, { card: w.card, uid: w.uid, pin: '4827' }),
    );
    const saldoStep = (await events(c.id)).find((e) => (e.payload as Record<string, unknown>).step === 'saldo');
    expect(saldoStep!.payload).toMatchObject({
      who: 'staff',
      authMethod: 'pin',
      pinVia: 'ficha',
      walletChargeId: c.saldo!.chargeId,
      balanceBeforeCents: 20_000,
      balanceAfterCents: 8_000,
      ip: '10.20.0.7',
    });
  });

  it('cancelar: quién lo canceló y con qué móvil', async () => {
    const c = await cobroDe(lola);
    await as({ userId: lola, role: 'OPERATOR', tenantId: V }, IPHONE, () => payments.cancel(c.id, { userId: lola, role: 'OPERATOR', tenantId: V }));
    const canceled = await sys((tx) => tx.paymentEvent.findFirst({ where: { paymentId: c.id, eventType: 'payment.canceled' } }));
    expect(canceled!.payload).toMatchObject({ type: 'CANCELED', byUserId: lola });
    expect((await events(c.id)).map((e) => (e.payload as Record<string, unknown>).step)).toEqual(['create', 'cancel']);
    const d = await as(null, null, () => details.forStaff(jwt(lola, 'OPERATOR'), 'PAYMENT', c.id));
    expect(d.undo).toEqual([expect.objectContaining({ kind: 'CANCEL', by: 'Lola Martín' })]);
  });

  it('saldo suelto (sin cobro con tarjeta): al registro y SIN la IP (no se puede borrar de ahí)', async () => {
    const w = await wallet(5_000);
    const actor = { userId: nerea, role: 'OPERATOR' as const, tenantId: V };
    const q = await as(actor, ANDROID, () => charges.createQrCharge(actor, { amountCents: 2_000, category: 'CHICA_SERVICE' }));
    await as(actor, ANDROID, () => charges.payQrChargeWithPin(actor, q.id, { code: w.code, pin: '4827' }));
    const rows = await sys((tx) =>
      tx.auditEvent.findMany({ where: { targetId: q.id, action: { in: ['wallet.charge_created', 'wallet.charge_settled'] } }, orderBy: { id: 'asc' } }),
    );
    expect(rows.map((a) => a.action)).toEqual(['wallet.charge_created', 'wallet.charge_settled']);
    for (const a of rows) {
      expect(a.ip).toBeNull();
      expect(a.payload).not.toHaveProperty('ip');
      expect(a.payload).toMatchObject({ who: 'staff', model: 'SM-S918B' });
    }
    expect(rows[1]!.payload).toMatchObject({ authMethod: 'pin', pinVia: 'código', balanceBeforeCents: 5_000, balanceAfterCents: 3_000 });
    // El dueño verificado lo ve, sin IP.
    const me = jwt(owner, 'OWNER');
    await stepUp.grant(owner, me.sid!, 'totp');
    const d = await as(null, null, () => details.forManager(me, 'SALDO', q.id));
    expect(d.sensitive!.devices.map((x) => [x.step, x.label, x.ip])).toEqual([
      ['create', 'SM-S918B · Android 14 · Chrome 130', null],
      ['saldo', 'SM-S918B · Android 14 · Chrome 130', null],
    ]);
  });
});

describe('la propina que elige el cliente al pagar (B1)', () => {
  it('con su PIN: sale en el detalle como siempre (la de la chica y el total), sin otra vía', async () => {
    const w = await wallet(5_000);
    const actor = { userId: nerea, role: 'OPERATOR' as const, tenantId: V };
    const q = await as(actor, ANDROID, () => charges.createQrCharge(actor, { amountCents: 2_000, category: 'CHICA_SERVICE' }));
    await as(actor, ANDROID, () => charges.payQrChargeWithPin(actor, q.id, { code: w.code, pin: '4827', tipCents: 300 }));
    const d = await as(null, null, () => details.forStaff(jwt(nerea, 'OPERATOR'), 'SALDO', q.id));
    expect(d.mine).toMatchObject({ tipCents: 300 });
    expect(d.mine!.totalCents).toBe(d.mine!.commissionCents + 300);
  });
});

describe('quién ve qué', () => {
  it('la chica: lo suyo con «lo tuyo»; nunca la parte del local, el banco ni lo de otras; el cobro de otra, 404', async () => {
    const c = await cobroDe(lola);
    await paidByCard(c.id, '4242');
    await sys((tx) =>
      tx.operatorEarning.create({ data: { tenantId: V, operatorId: lola, paymentId: c.id, paymentAmountCents: 12_000, commissionBps: 9000, commissionCents: 10_800 } }),
    );
    const d = await as(null, null, () => details.forStaff(jwt(lola, 'OPERATOR'), 'PAYMENT', c.id));
    expect(d.mine).toEqual({ commissionCents: 10_800, tipCents: 0, invitationCents: 0, reversedCents: 0, totalCents: 10_800 });
    expect(d).not.toHaveProperty('split');
    expect(d).not.toHaveProperty('bank');
    expect(d.method).toMatchObject({ cardBrand: 'Visa', cardLast4: '4242' });
    expect(d.sensitive).toBeNull();
    await expect(as(null, null, () => details.forStaff(jwt(nerea, 'OPERATOR'), 'PAYMENT', c.id))).rejects.toBeInstanceOf(NotFoundException);
    await expect(as(null, null, () => details.forStaff(jwt(carlos, 'WAITER'), 'PAYMENT', c.id))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('el cliente: solo los pagos de su saldo, con quién le cobró (el nombre de pila) y el saldo antes y después; de otro saldo, 404', async () => {
    const w = await wallet(20_000);
    const other = await wallet(1_000);
    const c = await cobroDe(lola);
    await as({ userId: lola, role: 'OPERATOR', tenantId: V }, IPHONE, () =>
      charges.payQrChargeWithPin({ userId: lola, role: 'OPERATOR', tenantId: V }, c.saldo!.chargeId, { card: w.card, uid: w.uid, pin: '4827' }),
    );
    const d = await as(null, null, () => details.forClient(w.id, 'SALDO', c.saldo!.chargeId));
    expect(d).toMatchObject({ audience: 'CLIENT', chargedBy: { name: 'Lola', role: null }, balance: { beforeCents: 20_000, afterCents: 8_000 }, totalCents: 12_000 });
    expect(d).not.toHaveProperty('sensitive');
    expect(JSON.stringify(d)).not.toContain('10.20.0.7');
    await expect(as(null, null, () => details.forClient(other.id, 'SALDO', c.saldo!.chargeId))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('el cliente: un pago con el saldo deshecho sigue en sus movimientos («Devuelto a tu saldo»), y su detalle dice cuándo, sin quién ni por qué', async () => {
    const w = await wallet(20_000);
    const c = await cobroDe(lola);
    await as({ userId: lola, role: 'OPERATOR', tenantId: V }, IPHONE, () =>
      charges.payQrChargeWithPin({ userId: lola, role: 'OPERATOR', tenantId: V }, c.saldo!.chargeId, { card: w.card, uid: w.uid, pin: '4827' }),
    );
    // Lo deshace el encargado (como lo deja «Anular cobro»: el consumo marcado y el dinero de vuelta).
    await sys(async (tx) => {
      const req = await tx.walletChargeRequest.findUniqueOrThrow({ where: { id: c.saldo!.chargeId }, select: { consumptionId: true } });
      await tx.walletConsumption.update({ where: { id: req.consumptionId! }, data: { reversedAt: new Date(), reversedByUserId: manager } });
      await tx.clientWallet.update({ where: { id: w.id }, data: { balanceCents: { increment: 12_000 } } });
    });
    const state = await as(null, null, () => charges.clientState(w.qrToken));
    const row = state.movements.find((m) => m.kind === 'consumption');
    expect(row).toMatchObject({ returned: true, detail: { kind: 'SALDO', id: c.saldo!.chargeId } });
    const d = await as(null, null, () => details.forClient(w.id, 'SALDO', c.saldo!.chargeId));
    expect(d.undo).toEqual([expect.objectContaining({ kind: 'VOID', by: null, reason: null })]);
    expect(JSON.stringify(d)).not.toContain('Javi');
  });

  it('el móvil y la IP del cliente, solo el encargado y el dueño verificados; sin verificar, null (y 403 pedido aparte)', async () => {
    const c = await cobroDe(lola);
    // El cliente abrió el pago con tarjeta en su Android (el evento de /pay).
    await as(null, ANDROID, () =>
      prisma.asSystem((tx) =>
        tx.$executeRaw`INSERT INTO payment_events ("paymentId","tenantId","eventType",payload,"traceId")
                       VALUES (${c.id}::uuid, ${V}::uuid, 'payment.device', ${JSON.stringify({ who: 'client', step: 'card', ...ANDROID })}::jsonb, 't')`,
      ),
    );
    await paidByCard(c.id, '1111');
    const me = jwt(manager, 'MANAGER');
    const before = await as(null, null, () => details.forManager(me, 'PAYMENT', c.id));
    expect(before.sensitive).toBeNull();
    expect(before.verify).toEqual({ required: true, method: 'totp', verifiedUntil: null });
    await expect(as(null, null, () => details.sensitiveFor(me, 'PAYMENT', c.id, 'MANAGER'))).rejects.toMatchObject({
      response: { code: 'STEP_UP_REQUIRED' },
    });
    await stepUp.grant(manager, me.sid!, 'totp');
    const after = await as(null, null, () => details.forManager(me, 'PAYMENT', c.id));
    expect(after.sensitive!.devices.map((x) => [x.who, x.ip])).toEqual([
      ['staff', '10.20.0.7'],
      ['client', '83.45.120.7'],
    ]);
    // La chica, aun verificada, no ve el del cliente.
    const lolaJwt = jwt(lola, 'OPERATOR');
    await stepUp.grant(lola, lolaJwt.sid!, 'totp');
    const hers = await as(null, null, () => details.forStaff(lolaJwt, 'PAYMENT', c.id));
    expect(JSON.stringify(hers)).not.toContain('83.45.120.7');
    expect(hers.sensitive!.devices.map((x) => x.who)).toEqual(['staff']);
  });

  it('la verificación caduca a los 5 minutos', async () => {
    const c = await cobroDe(lola);
    const me = jwt(owner, 'OWNER');
    await stepUp.grant(owner, me.sid!, 'totp', Date.now() - 6 * 60_000);
    const d = await as(null, null, () => details.forManager(me, 'PAYMENT', c.id));
    expect(d.sensitive).toBeNull();
    await expect(as(null, null, () => details.sensitiveFor(me, 'PAYMENT', c.id, 'MANAGER'))).rejects.toMatchObject({ status: 403 });
  });

  it('el reparto: el dueño siempre; el encargado, solo con «Informes»', async () => {
    const c = await cobroDe(lola);
    await paidByCard(c.id, '2222');
    expect(await as(null, null, () => details.forManager(jwt(owner, 'OWNER'), 'PAYMENT', c.id))).toHaveProperty('split');
    expect(await as(null, null, () => details.forManager(jwt(manager, 'MANAGER'), 'PAYMENT', c.id))).not.toHaveProperty('split');
    await sys((tx) => tx.venue.update({ where: { id: V }, data: { staffPermissions: { roles: { MANAGER: { reports: true } } } } }));
    const withReports = await as(null, null, () => details.forManager(jwt(manager, 'MANAGER'), 'PAYMENT', c.id));
    await sys((tx) => tx.venue.update({ where: { id: V }, data: { staffPermissions: undefined } }));
    expect(withReports).toHaveProperty('split');
  });

  it('un cobro de otro local, 404 (también para el dueño)', async () => {
    const c = await cobroDe(lola);
    await expect(as(null, null, () => details.forManager(jwt(owner, 'OWNER', O), 'PAYMENT', c.id))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('GET /v1/payments/:id: el camarero ya no ve el cobro de otra persona (lo suyo sí; el encargado, todos)', async () => {
    const c = await cobroDe(lola);
    await expect(as({ tenantId: V }, null, () => paymentsController.findOne(c.id, jwt(carlos, 'WAITER')))).rejects.toBeInstanceOf(NotFoundException);
    await expect(as({ tenantId: V }, null, () => paymentsController.findOne(c.id, jwt(manager, 'MANAGER')))).resolves.toMatchObject({ id: c.id });
  });
});

describe('buscar un pago', () => {
  const search = (q: Record<string, string>) => as({ tenantId: V }, null, () => cobros.list(V, CobrosQuerySchema.parse({ limit: 50, ...q })));

  it('por los últimos 4 de la tarjeta (tecleados o con su campo)', async () => {
    const c = await cobroDe(lola);
    await paidByCard(c.id, '7319');
    expect((await search({ search: '7319' })).items.map((i) => i.id)).toContain(c.id);
    expect((await search({ cardLast4: '7319' })).items.map((i) => i.id)).toEqual([c.id]);
    expect((await search({ search: '••7319' })).items.map((i) => i.id)).toEqual([c.id]);
  });

  it('por la ficha: el número impreso y el interno; una ficha devuelta y dada a otro saldo encuentra los cobros de los dos', async () => {
    const printed = `${Math.floor(Math.random() * 9e6) + 1e6}`;
    const a = await wallet(20_000, printed);
    const c1 = await cobroDe(lola);
    await as({ userId: lola, role: 'OPERATOR', tenantId: V }, IPHONE, () =>
      charges.payQrChargeWithPin({ userId: lola, role: 'OPERATOR', tenantId: V }, c1.saldo!.chargeId, { card: a.card, uid: a.uid, pin: '4827' }),
    );
    // Devuelta y dada a otro saldo (el de otro cliente).
    const b = await wallet(20_000);
    await sys(async (tx) => {
      await tx.walletCard.delete({ where: { id: b.cardId } });
      await tx.walletCard.update({ where: { id: a.cardId }, data: { walletId: b.id } });
      await tx.walletCardEvent.create({ data: { cardId: a.cardId, venueId: V, walletId: b.id, kind: 'ISSUED' } });
    });
    const c2 = await cobroDe(lola);
    await as({ userId: lola, role: 'OPERATOR', tenantId: V }, IPHONE, () =>
      charges.payQrChargeWithPin({ userId: lola, role: 'OPERATOR', tenantId: V }, c2.saldo!.chargeId, { card: a.card, uid: a.uid, pin: '4827' }),
    );
    const ids = (await search({ search: `ficha ${printed}` })).items.map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining([c1.saldo!.chargeId, c2.saldo!.chargeId]));
    const number = await sys((tx) => tx.walletCard.findUniqueOrThrow({ where: { id: a.cardId }, select: { number: true } }));
    const byInternal = (await search({ ficha: String(number.number) })).items.map((i) => i.id);
    expect(byInternal).toEqual(expect.arrayContaining([c1.saldo!.chargeId, c2.saldo!.chargeId]));
    // El detalle dice con qué ficha se pagó.
    const d = await as(null, null, () => details.forStaff(jwt(lola, 'OPERATOR'), 'SALDO', c1.saldo!.chargeId));
    expect(d.method.fichaNumber).toBe(printed);
    // En otro local no sale nada.
    const elsewhere = await as({ tenantId: O }, null, () => cobros.list(O, CobrosQuerySchema.parse({ limit: 50, search: `ficha ${printed}` })));
    expect(elsewhere.items).toEqual([]);
  });
});

describe('la IP se borra a los 90 días', () => {
  it('la de hace más de 90 días se borra (queda ipErased y el resto); la reciente se queda', async () => {
    const c = await cobroDe(lola);
    const old = new Date(Date.now() - 100 * 24 * 60 * 60_000);
    await sys((tx) =>
      tx.$executeRaw`INSERT INTO payment_events ("paymentId","tenantId","eventType",payload,"traceId","occurredAt")
                     VALUES (${c.id}::uuid, ${V}::uuid, 'payment.device', ${JSON.stringify({ who: 'client', step: 'card', ...ANDROID })}::jsonb, 't', ${old})`,
    );
    await as(null, null, () => new DeviceIpRetentionService(prisma, createFakeRedis() as never).eraseOld(new Date()));
    const rows = await events(c.id);
    const oldRow = rows.find((e) => (e.payload as Record<string, unknown>).step === 'card')!;
    expect(oldRow.payload).not.toHaveProperty('ip');
    expect(oldRow.payload).toMatchObject({ ipErased: true, model: 'SM-S918B' });
    const recent = rows.find((e) => (e.payload as Record<string, unknown>).step === 'create')!;
    expect(recent.payload).toMatchObject({ ip: '10.20.0.7' });
    const me = jwt(owner, 'OWNER');
    await stepUp.grant(owner, me.sid!, 'totp');
    const d = await as(null, null, () => details.forManager(me, 'PAYMENT', c.id));
    expect(d.sensitive!.devices.find((x) => x.who === 'client')).toMatchObject({ ip: null, ipErased: true });
  });
});
