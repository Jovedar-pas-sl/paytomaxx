// Integración (Postgres real, FORCE RLS, rol sin superusuario): «Pantalla del cliente».
// Emparejar con el código (una vez, 5 min), la credencial (hasta el cierre de la noche, 12 h
// como mucho, revocable desde los dos lados), solo los cobros de esa persona, lo que ve la
// tablet sin datos personales, la propina que elige el cliente y pagar con la ficha en la tablet.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { CustomerDisplayService, type DisplayOwner } from '../../src/modules/customer-display/customer-display.service';
import { findActiveDisplay, pairingExpiresAt } from '../../src/modules/customer-display/display-auth';
import { sha256 } from '../../src/modules/customer-display/display-code';
import { WalletChargesService } from '../../src/modules/wallets/wallet-charges.service';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const audit = new AuditService(prisma, cls as never);
const realtime = { showOnDisplay: vi.fn(), closeDisplay: vi.fn() };
const charges = new WalletChargesService(
  prisma as never,
  audit as never,
  { get: () => ({}) } as never,
  { isEnabled: async () => true, assertForUser: async () => undefined } as never,
);
const svc = new CustomerDisplayService(prisma, audit, realtime as never, charges);

/** Como una petición: con contexto CLS (sin local; el servicio usa asSystem). */
function run<T>(fn: () => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { traceId: 't-pantalla' });
    return fn();
  });
}

const r = randomUUID().slice(0, 6);
const SECRET_NAME = 'Lola Secreta';
let camarero: DisplayOwner;
let otro: DisplayOwner;
let otroLocal: DisplayOwner;
let terminalId: string;
let payCam: { id: string; qrToken: string };
let chargeCam: string;
let payOtro: string;
let payOtroLocal: string;

async function newPayment(owner: DisplayOwner, term: string, over: { status?: 'CREATED' | 'AUTHORIZED' } = {}) {
  const qrToken = `pc-${randomUUID()}`;
  const p = await prisma.asSystem((tx) =>
    tx.payment.create({
      data: {
        tenantId: owner.tenantId,
        terminalId: term,
        idempotencyKey: `pc-${randomUUID()}`,
        qrToken,
        qrExpiresAt: new Date(Date.now() + 15 * 60_000),
        amountCents: 3300,
        availableAmountCents: 3300,
        serviceFeeCents: 330,
        serviceFeeBps: 1000,
        status: over.status ?? 'CREATED',
        provider: 'PEANPE',
        createdByUserId: owner.userId,
      },
    }),
  );
  return { id: p.id, qrToken };
}

async function setPayment(id: string, status: 'AUTHORIZED' | 'CANCELED') {
  await run(() => prisma.asSystem((tx) => tx.payment.update({ where: { id }, data: { status } })));
}

async function screenOf(token: string, now = new Date()) {
  const display = await run(() => findActiveDisplay(prisma, token, now));
  if (!display) return null;
  return run(() => svc.screen(display, now));
}

beforeAll(async () => {
  await run(() =>
    prisma.asSystem(async (tx) => {
      const venue = await tx.venue.create({
        data: { name: 'Sala Luna', slug: `pantalla-${r}`, walletGroup: `gpc-${r}`, paymentMethods: { wallet: true, nfc: true } },
      });
      const venueB = await tx.venue.create({ data: { name: 'Otro local', slug: `pantalla-b-${r}` } });
      const mk = (tenantId: string, tag: string, displayName?: string) =>
        tx.user.create({
          data: { tenantId, email: `pantalla-${tag}-${r}@x.es`, passwordHash: 'x', role: 'WAITER', displayName },
        });
      const cam = await mk(venue.id, 'cam', SECRET_NAME);
      const ot = await mk(venue.id, 'otro');
      const ob = await mk(venueB.id, 'b');
      camarero = { userId: cam.id, tenantId: venue.id };
      otro = { userId: ot.id, tenantId: venue.id };
      otroLocal = { userId: ob.id, tenantId: venueB.id };
      terminalId = (await tx.terminal.create({ data: { tenantId: venue.id, externalId: `PC-${r}`, label: 'Barra' } })).id;
      const termB = (await tx.terminal.create({ data: { tenantId: venueB.id, externalId: `PCB-${r}`, label: 'Barra' } })).id;
      return termB;
    }),
  ).then(async (termB) => {
    payCam = await run(() => newPayment(camarero, terminalId));
    payOtro = (await run(() => newPayment(otro, terminalId))).id;
    payOtroLocal = (await run(() => newPayment(otroLocal, termB))).id;
    chargeCam = (
      await run(() =>
        prisma.asSystem((tx) =>
          tx.walletChargeRequest.create({
            data: {
              tenantId: camarero.tenantId,
              requestedByUserId: camarero.userId,
              amountCents: 3300,
              category: 'VENUE_BAR',
              expiresAt: new Date(Date.now() + 15 * 60_000),
              linkedPaymentId: payCam.id,
            },
          }),
        ),
      )
    ).id;
  });
});

describe('pantalla del cliente (Postgres)', () => {
  let token = '';

  it('emparejar: código de 5 min que vale una vez; en la base solo huellas', async () => {
    expect(await run(() => svc.status(camarero))).toEqual({ paired: false, pairedUntil: null });
    const { code, expiresAt } = await run(() => svc.createCode(camarero));
    expect(code).toMatch(/^[A-Z2-9]{3}-[A-Z2-9]{3}$/);
    expect(new Date(expiresAt).getTime() - Date.now()).toBeGreaterThan(4 * 60_000);
    expect(new Date(expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(5 * 60_000);

    const paired = await run(() => svc.pair(code.toLowerCase().replace('-', ' ')));
    token = paired.token;
    expect(paired.venueName).toBe('Sala Luna');
    // Otra vez el mismo código: ya no vale.
    await expect(run(() => svc.pair(code))).rejects.toBeInstanceOf(NotFoundException);

    const status = await run(() => svc.status(camarero));
    expect(status.paired).toBe(true);
    // Hasta el corte de la noche (08:00 de Madrid) y 12 h como mucho: sea la hora que sea al lanzar la prueba.
    const until = new Date(status.pairedUntil ?? 0).getTime();
    expect(Math.abs(until - pairingExpiresAt(new Date()).getTime())).toBeLessThan(60_000);
    expect(until - Date.now()).toBeLessThanOrEqual(12 * 3600_000);

    const row = await run(() =>
      prisma.asSystem((tx) => tx.customerDisplay.findUniqueOrThrow({ where: { userId: camarero.userId } })),
    );
    expect(row.tokenHash).toBe(sha256(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.pairingCodeHash).toBeNull();

    expect(await screenOf(token)).toMatchObject({ state: 'idle', venueName: 'Sala Luna', fichas: true });
  });

  it('el código caduca a los 5 minutos; uno inventado no vale', async () => {
    const now = new Date();
    const { code } = await run(() => svc.createCode(otro, now));
    await expect(run(() => svc.pair(code, new Date(now.getTime() + 5 * 60_000 + 1000)))).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(run(() => svc.pair('ZZZ-ZZZ'))).rejects.toBeInstanceOf(NotFoundException);
    await expect(run(() => svc.pair('123'))).rejects.toBeInstanceOf(NotFoundException);
    expect(await run(() => svc.status(otro))).toEqual({ paired: false, pairedUntil: null });
  });

  it('solo enseña un cobro suyo: importe y QR, sin nombres, saldo ni ids', async () => {
    await expect(run(() => svc.show(camarero, { paymentId: payOtro }))).rejects.toBeInstanceOf(NotFoundException);
    await expect(run(() => svc.show(camarero, { paymentId: payOtroLocal }))).rejects.toBeInstanceOf(NotFoundException);
    // Sin pantalla emparejada: no hace nada.
    expect(await run(() => svc.show(otro, { paymentId: payOtro }))).toEqual({ paired: false, pairedUntil: null });

    realtime.showOnDisplay.mockClear();
    expect((await run(() => svc.show(camarero, { paymentId: payCam.id, chargeId: chargeCam }))).paired).toBe(true);
    expect(realtime.showOnDisplay).toHaveBeenCalledWith(expect.any(String), [`payment:${payCam.id}`, `wallet-charge:${chargeCam}`], []);
    // La misma pantalla de espera otra vez: sin aviso.
    await run(() => svc.show(camarero, { paymentId: payCam.id, chargeId: chargeCam }));
    expect(realtime.showOnDisplay).toHaveBeenCalledTimes(1);

    const view = await screenOf(token);
    expect(view).toMatchObject({
      state: 'waiting',
      amountCents: 3300,
      cardAmountCents: 3630,
      ficha: true,
      paying: false,
      topUp: false,
    });
    expect(view && 'qrUrl' in view ? view.qrUrl : null).toMatch(new RegExp(`/pay/${payCam.qrToken}$`));
    const json = JSON.stringify(view);
    for (const secret of [SECRET_NAME, 'pantalla-cam', payCam.id, chargeCam, camarero.userId]) expect(json).not.toContain(secret);
  });

  it('«Pagado» al pagarse (también tras salir del cobro); cancelado o abandonado: reposo', async () => {
    await setPayment(payCam.id, 'AUTHORIZED');
    expect(await screenOf(token)).toMatchObject({ state: 'paid' });
    await run(() => svc.clear(camarero, { paymentId: payCam.id, chargeId: chargeCam }));
    expect(await screenOf(token)).toMatchObject({ state: 'paid' });

    const second = await run(() => newPayment(camarero, terminalId));
    await run(() => svc.show(camarero, { paymentId: second.id }));
    const waiting = await screenOf(token);
    expect(waiting).toMatchObject({ state: 'waiting', ficha: false });
    await setPayment(second.id, 'CANCELED');
    await run(() => svc.clear(camarero, { paymentId: second.id }));
    expect(await screenOf(token)).toMatchObject({ state: 'ended', reason: 'canceled' });

    // Salió de un cobro sin pagar ni cancelar: nada de QR suelto.
    const third = await run(() => newPayment(camarero, terminalId));
    await run(() => svc.show(camarero, { paymentId: third.id }));
    // Limpiar con otro cobro no toca el que se enseña.
    await run(() => svc.clear(camarero, { paymentId: second.id }));
    expect(await screenOf(token)).toMatchObject({ state: 'waiting' });
    await run(() => svc.clear(camarero, { paymentId: third.id }));
    expect(await screenOf(token)).toMatchObject({ state: 'idle' });
  });

  it('otra tablet deja fuera la anterior; se desempareja desde los dos lados; caduca a las 12 h', async () => {
    const first = token;
    realtime.closeDisplay.mockClear();
    const second = (await run(async () => svc.pair((await svc.createCode(camarero)).code))).token;
    expect(await run(() => findActiveDisplay(prisma, first))).toBeNull();
    expect(realtime.closeDisplay).toHaveBeenCalledTimes(1);

    // Desde la tablet.
    const session = await run(() => findActiveDisplay(prisma, second));
    expect(session).not.toBeNull();
    await run(() => svc.unpairByDisplay(session!));
    expect(await run(() => findActiveDisplay(prisma, second))).toBeNull();
    expect(await run(() => svc.status(camarero))).toEqual({ paired: false, pairedUntil: null });

    // Desde la app del personal.
    const third = (await run(async () => svc.pair((await svc.createCode(camarero)).code))).token;
    await run(() => svc.unpairByOwner(camarero));
    expect(await run(() => findActiveDisplay(prisma, third))).toBeNull();

    // Caduca sola (el corte de la noche o las 12 h).
    const fourthPair = await run(async () => svc.pair((await svc.createCode(camarero)).code));
    const fourth = fourthPair.token;
    const fourthUntil = new Date(fourthPair.pairedUntil).getTime();
    expect(await screenOf(fourth, new Date(fourthUntil - 60_000))).not.toBeNull();
    expect(await screenOf(fourth, new Date(fourthUntil + 60_000))).toBeNull();

    // La persona, de baja: su pantalla deja de valer.
    const setDeleted = (deletedAt: Date | null) =>
      run(() => prisma.asSystem((tx) => tx.user.update({ where: { id: camarero.userId }, data: { deletedAt } })));
    await setDeleted(new Date());
    expect(await run(() => findActiveDisplay(prisma, fourth))).toBeNull();
    await setDeleted(null);

    const events = await run(() =>
      prisma.asSystem((tx) =>
        tx.auditEvent.findMany({ where: { tenantId: camarero.tenantId, action: { startsWith: 'customer_display.' } }, select: { action: true } }),
      ),
    );
    expect(new Set(events.map((e) => e.action))).toEqual(
      new Set(['customer_display.code_created', 'customer_display.paired', 'customer_display.unpaired']),
    );
  });
});

describe('propina y ficha en la tablet (Postgres)', () => {
  const waiter = () => ({ userId: camarero.userId, role: 'WAITER' as const, tenantId: camarero.tenantId });
  let token = '';
  let n = 0;

  /** Saldo con PIN 4827 y su ficha (con o sin número de serie guardado). */
  async function walletWithFicha(balanceCents: number, withUid = true) {
    n += 1;
    const code = Array.from(randomBytes(6), (b) => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[b % 31]).join('');
    const card = randomBytes(16).toString('base64url');
    const uid = randomBytes(7).toString('hex').toUpperCase();
    const id = await run(() =>
      prisma.asSystem(async (tx) => {
        const w = await tx.clientWallet.create({
          data: { tenantId: camarero.tenantId, balanceCents, qrToken: `pcw-${r}-${n}`, shortCode: code, walletGroup: `gpc-${r}` },
        });
        await tx.walletCard.create({ data: { token: card, uid: withUid ? uid : null, walletId: w.id, status: 'ISSUED', venueId: camarero.tenantId } });
        return w.id;
      }),
    );
    await run(() => charges.setPinFromPayer(id, '4827'));
    return { id, card, uid, code };
  }

  async function showSaldo(amountCents: number) {
    const charge = await run(() => charges.createQrCharge(waiter(), { amountCents }));
    await run(() => svc.show(camarero, { chargeId: charge.id }));
    const session = await run(() => findActiveDisplay(prisma, token));
    const view = await run(() => svc.screen(session!));
    if (view.state !== 'waiting') throw new Error(`esperaba el cobro en la pantalla: ${view.state}`);
    return { chargeId: charge.id, key: view.key, view };
  }

  const session = async () => {
    const s = await run(() => findActiveDisplay(prisma, token));
    if (!s) throw new Error('pantalla sin emparejar');
    return s;
  };
  const balanceOf = (id: string) =>
    run(() => prisma.asSystem((tx) => tx.clientWallet.findUniqueOrThrow({ where: { id }, select: { balanceCents: true } })));
  const chargeRow = (id: string) =>
    run(() => prisma.asSystem((tx) => tx.walletChargeRequest.findUniqueOrThrow({ where: { id }, select: { status: true, tipCents: true } })));

  beforeAll(async () => {
    token = (await run(async () => svc.pair((await svc.createCode(camarero)).code))).token;
  });

  it('el cliente elige la propina (sin nada marcado): va al total, al QR y al cobro con ficha', async () => {
    const { chargeId, key, view } = await showSaldo(1500);
    expect(view.tip).toMatchObject({ chosenCents: 0, presets: [{ cents: 200 }, { cents: 500 }] });
    expect(view.totalCents).toBe(1500);
    const after = await run(async () => svc.setTip(await session(), { key, tipCents: 200 }));
    expect(after).toMatchObject({ state: 'waiting', totalCents: 1700, tip: { chosenCents: 200 } });
    expect((await chargeRow(chargeId)).tipCents).toBe(200);
    // Solo las que se ofrecen, y solo en el cobro que enseña.
    await expect(run(async () => svc.setTip(await session(), { key, tipCents: 700 }))).rejects.toBeInstanceOf(BadRequestException);
    await expect(run(async () => svc.setTip(await session(), { key: '0'.repeat(16), tipCents: 200 }))).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('la ficha en la tablet paga sin PIN (hasta el tope) lo vendido + la propina; la tablet no ve el saldo', async () => {
    const w = await walletWithFicha(5000);
    const { chargeId, key } = await showSaldo(1500);
    await run(async () => svc.setTip(await session(), { key, tipCents: 200 }));
    const result = await run(async () => svc.payWithFicha(await session(), { key, card: w.card, uid: w.uid }));
    expect(result).toEqual({ status: 'paid' });
    expect(await chargeRow(chargeId)).toEqual({ status: 'ACCEPTED', tipCents: 200 });
    expect((await balanceOf(w.id)).balanceCents).toBe(5000 - 1700);
    expect(await run(async () => svc.screen(await session()))).toMatchObject({ state: 'paid' });
  });

  it('por encima del tope sin PIN: el PIN en la tablet, con sus fallos, y la propina de la pantalla del PIN', async () => {
    const w = await walletWithFicha(10000);
    const { chargeId, key } = await showSaldo(3300);
    expect(await run(async () => svc.payWithFicha(await session(), { key, card: w.card, uid: w.uid }))).toEqual({
      status: 'pin',
      reason: null,
    });
    await expect(
      run(async () => svc.payWithFichaPin(await session(), { key, card: w.card, uid: w.uid, pin: '1111', tipCents: 500 })),
    ).rejects.toThrow();
    expect((await chargeRow(chargeId)).status).toBe('PENDING');
    expect((await balanceOf(w.id)).balanceCents).toBe(10000);
    const paid = await run(async () => svc.payWithFichaPin(await session(), { key, card: w.card, uid: w.uid, pin: '4827', tipCents: 500 }));
    expect(paid).toEqual({ status: 'paid' });
    expect(await chargeRow(chargeId)).toEqual({ status: 'ACCEPTED', tipCents: 500 });
    expect((await balanceOf(w.id)).balanceCents).toBe(10000 - 3800);
  });

  it('una ficha sin número de serie guardado pide el PIN y dice por qué (sin saldo ni código)', async () => {
    const w = await walletWithFicha(5000, false);
    const { key } = await showSaldo(1000);
    const result = await run(async () => svc.payWithFicha(await session(), { key, card: w.card, uid: w.uid }));
    expect(result.status).toBe('pin');
    const json = JSON.stringify(result);
    for (const secret of ['5000', '50,00', w.code, w.id]) expect(json).not.toContain(secret);
  });

  it('solo el cobro activo de su camarero: otro cobro o tras salir de él, no paga', async () => {
    const w = await walletWithFicha(5000);
    const { chargeId, key } = await showSaldo(1000);
    await expect(run(async () => svc.payWithFicha(await session(), { key: 'f'.repeat(16), card: w.card, uid: w.uid }))).rejects.toBeInstanceOf(
      ConflictException,
    );
    await run(() => svc.clear(camarero, { chargeId }));
    await expect(run(async () => svc.payWithFicha(await session(), { key, card: w.card, uid: w.uid }))).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect((await chargeRow(chargeId)).status).toBe('PENDING');
    expect((await balanceOf(w.id)).balanceCents).toBe(5000);
  });

  it('cerrar la noche corta la unión aunque no hayan pasado 12 h', async () => {
    expect(await run(() => findActiveDisplay(prisma, token))).not.toBeNull();
    await run(() =>
      prisma.asSystem((tx) =>
        tx.venueNight.create({ data: { tenantId: camarero.tenantId, openedAt: new Date(Date.now() - 3600_000), closedAt: new Date() } }),
      ),
    );
    expect(await run(() => findActiveDisplay(prisma, token))).toBeNull();
    expect(await run(() => svc.status(camarero))).toEqual({ paired: false, pairedUntil: null });
  });
});
