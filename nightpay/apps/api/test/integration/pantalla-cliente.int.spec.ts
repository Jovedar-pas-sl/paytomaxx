// Integración (Postgres real, FORCE RLS, rol sin superusuario): «Pantalla del cliente».
// Emparejar con el código (una vez, 5 min), la credencial (12 h, revocable desde los dos
// lados), solo los cobros de esa persona y lo que ve la tablet sin datos personales.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { CustomerDisplayService, type DisplayOwner } from '../../src/modules/customer-display/customer-display.service';
import { findActiveDisplay } from '../../src/modules/customer-display/display-auth';
import { sha256 } from '../../src/modules/customer-display/display-code';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const audit = new AuditService(prisma, cls as never);
const realtime = { showOnDisplay: vi.fn(), closeDisplay: vi.fn() };
const svc = new CustomerDisplayService(prisma, audit, realtime as never);

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
        data: { name: 'Sala Luna', slug: `pantalla-${r}`, paymentMethods: { wallet: true, nfc: true } },
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
    const hours = (new Date(status.pairedUntil!).getTime() - Date.now()) / 3600_000;
    expect(hours).toBeGreaterThan(11.9);
    expect(hours).toBeLessThanOrEqual(12);

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

    // Caduca sola a las 12 h.
    const fourth = (await run(async () => svc.pair((await svc.createCode(camarero)).code))).token;
    expect(await screenOf(fourth, new Date(Date.now() + 11 * 3600_000))).not.toBeNull();
    expect(await screenOf(fourth, new Date(Date.now() + 12 * 3600_000 + 60_000))).toBeNull();

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
