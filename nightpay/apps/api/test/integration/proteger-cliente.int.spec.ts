// Integración (Postgres real, np_app y FORCE RLS): proteger al cliente frente a abusos del personal (19-11-2026).
//  - /pay dice quién cobra: su nombre visible y su foto (user_photos tiene FORCE RLS), nunca el correo.
//  - Tope de «Otro importe» del local también para el camarero (cobro del saldo); la carta no cuenta.
//  - Avisos por persona, con el SQL de verdad: cancelaciones (el evento con quién canceló), «Otro importe»
//    (líneas tecleadas cobradas con tarjeta o con el saldo), PIN fallado en varios saldos y cobros seguidos
//    al mismo saldo; el dueño no cuenta; los umbrales del local (0 = no se mira); se cierran con nota.
//  - Desbloquear el PIN con la 2FA deja la acción delicada en Incidencias.
//  - «No he sido yo» desde /w: el enlace firmado solo para un cobro pagado de ESE saldo; sin Face ID, ni la
//    página ni la incidencia dicen que con él sigue pagando.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { IncidentsService } from '../../src/modules/incidents/incidents.service';
import { WalletChargesService } from '../../src/modules/wallets/wallet-charges.service';
import { ChargeDisputeService } from '../../src/modules/wallets/charge-alert/charge-dispute.service';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const audit = new AuditService(prisma, cls as never);
const noop = () => undefined;
const payments = new PaymentsService(
  prisma as never,
  cls as never,
  {} as never,
  {} as never,
  {} as never,
  { emitPaymentUpdate: noop, emitPaymentCompleted: noop } as never,
  { paymentsTransitioned: { inc: noop }, walletCreditSkipped: { inc: noop } } as never,
  {} as never,
  {} as never,
  {} as never,
);
const totp = { isEnabled: async () => true, assertForUser: async () => undefined };
const charges = new WalletChargesService(prisma as never, audit, { get: () => ({}) } as never, totp as never);
const incidents = new IncidentsService(prisma, audit);
const disputes = new ChargeDisputeService(prisma, audit, { JWT_SECRET: 'secreto-de-pruebas-proteger-0123456789abcdef' } as never);

const r = randomUUID().slice(0, 6);
let V: string, term: string, owner: string, leo: string, ana: string, nameless: string, walletId: string, otherWallet: string;
let seq = 0;

const inVenue = <T>(tenantId: string | undefined, fn: () => Promise<T>): Promise<T> =>
  cls.run(async () => {
    cls.set('ctx', { tenantId, traceId: 't-proteger' });
    return fn();
  });
const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) => inVenue(undefined, () => prisma.asSystem(fn));

/** Un cobro con tarjeta de `by` (sin pagar o con el estado que se diga). */
async function cobro(by: string, o: { status?: string; amount?: number } = {}): Promise<{ id: string; qrToken: string }> {
  const qrToken = `pc-${r}-${(seq += 1)}`;
  return sys((tx) =>
    tx.payment.create({
      data: {
        tenantId: V, terminalId: term, createdByUserId: by, idempotencyKey: qrToken, qrToken, qrExpiresAt: new Date(Date.now() + 3600_000),
        amountCents: o.amount ?? 2_000, availableAmountCents: o.amount ?? 2_000, status: (o.status ?? 'CREATED') as never, revenueCategory: 'VENUE_BAR',
      },
      select: { id: true, qrToken: true },
    }),
  );
}

const staff = async () => (await inVenue(V, () => incidents.list(V))).filter((i) => i.kind === 'staff_pattern');

beforeAll(async () => {
  await prisma.onModuleInit();
  await sys(async (tx) => {
    V = (await tx.venue.create({ data: { name: 'Sala Proteger', slug: `pc-${r}`, walletGroup: `gpc-${r}` } })).id;
    term = (await tx.terminal.create({ data: { tenantId: V, externalId: `PC-${r}`, label: 'Barra' } })).id;
    owner = (await tx.user.create({ data: { tenantId: V, email: `dueno-pc-${r}@x.es`, passwordHash: 'x', role: 'OWNER', displayName: 'Marta' } })).id;
    leo = (await tx.user.create({ data: { tenantId: V, email: `leo-pc-${r}@x.es`, passwordHash: 'x', role: 'WAITER', displayName: 'Leo' } })).id;
    ana = (await tx.user.create({ data: { tenantId: V, email: `ana-pc-${r}@x.es`, passwordHash: 'x', role: 'OPERATOR', displayName: 'Ana' } })).id;
    nameless = (await tx.user.create({ data: { tenantId: V, email: `sin-nombre-pc-${r}@x.es`, passwordHash: 'x', role: 'WAITER' } })).id;
    // La foto de Ana («Mi perfil»): bytes de mentira, la base solo mira tipo, medidas y huella.
    await tx.userPhoto.create({
      data: { userId: ana, tenantId: V, contentType: 'image/webp', data: Buffer.from('RIFF-foto-de-ana'), contentHash: 'b'.repeat(64), width: 64, height: 64 },
    });
    walletId = (await tx.clientWallet.create({ data: { tenantId: V, balanceCents: 9_000, qrToken: `pc-w-${r}`, shortCode: `P${r.slice(0, 5).toUpperCase()}`, walletGroup: `gpc-${r}` } })).id;
    otherWallet = (await tx.clientWallet.create({ data: { tenantId: V, balanceCents: 100, qrToken: `pc-w2-${r}`, walletGroup: `gpc-${r}` } })).id;
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('/pay dice quién cobra (Postgres real)', () => {
  it('el nombre visible y la foto de quien hizo el cobro (FORCE RLS en user_photos); nunca el correo', async () => {
    const p = await cobro(ana);
    const view = await inVenue(undefined, () => payments.getPayPage(p.qrToken));
    expect(view).toMatchObject({ kind: 'choose', staffName: 'Ana', staffPhoto: `data:image/webp;base64,${Buffer.from('RIFF-foto-de-ana').toString('base64')}` });
    const byLeo = await cobro(leo);
    const leoView = await inVenue(undefined, () => payments.getPayPage(byLeo.qrToken));
    expect(leoView).toMatchObject({ kind: 'choose', staffName: 'Leo' });
    expect(leoView).not.toHaveProperty('staffPhoto');
    const byNobody = await cobro(nameless);
    const noName = await inVenue(undefined, () => payments.getPayPage(byNobody.qrToken));
    expect(noName).not.toHaveProperty('staffName');
    expect(JSON.stringify(noName)).not.toContain('sin-nombre-pc');
  });
});

describe('tope de «Otro importe» del local para el camarero (Postgres real)', () => {
  it('cobro del saldo: 250 € tecleados no (403); la carta y el dueño, sí', async () => {
    const waiter = { userId: leo, role: 'WAITER', tenantId: V };
    await expect(inVenue(V, () => charges.createQrCharge(waiter, { amountCents: 25_000 }))).rejects.toMatchObject({ status: 403 });
    await expect(inVenue(V, () => charges.createQrCharge({ userId: owner, role: 'OWNER', tenantId: V }, { amountCents: 25_000, category: 'VENUE_BAR' }))).resolves.toMatchObject({ amountCents: 25_000 });
    const item = await sys((tx) => tx.serviceItem.create({ data: { tenantId: V, name: 'Botella', priceCents: 30_000, category: 'VENUE_BAR' } }));
    await expect(inVenue(V, () => charges.createQrCharge(waiter, { serviceItemId: item.id }))).resolves.toMatchObject({ amountCents: 30_000 });
  });
});

describe('avisos por persona (Postgres real)', () => {
  it('muchas cancelaciones: 5 de Leo salen (con el evento de quién canceló); las del dueño, no', async () => {
    for (let i = 0; i < 5; i += 1) {
      const p = await cobro(leo);
      await inVenue(V, () => payments.cancel(p.id, { userId: leo, role: 'WAITER', tenantId: V }));
    }
    for (let i = 0; i < 6; i += 1) {
      const p = await cobro(ana);
      await inVenue(V, () => payments.cancel(p.id, { userId: owner, role: 'OWNER', tenantId: V }));
    }
    const found = (await staff()).filter((i) => i.refId.startsWith('cancels:'));
    expect(found).toHaveLength(1);
    expect(found[0]!.refId).toMatch(new RegExp(`^cancels:\\d{4}-\\d{2}-\\d{2}:${leo}$`));
    expect(found[0]!.detail).toMatch(/^Leo ha cancelado 5 cobros la noche del/);
    expect(found[0]!.alertDetail).not.toContain('Leo');
  });

  it('mucho «Otro importe»: lo tecleado y cobrado, con tarjeta o con el saldo (ni la carta ni lo sin pagar)', async () => {
    await sys(async (tx) => {
      const line = (o: { paymentId?: string; walletChargeId?: string; amount: number; item?: string }) =>
        tx.paymentLine.create({
          data: { tenantId: V, paymentId: o.paymentId ?? null, walletChargeId: o.walletChargeId ?? null, category: 'CHICA_SERVICE', serviceItemId: o.item ?? null, label: 'Importe', unitCents: o.amount, amountCents: o.amount },
        });
      const item = await tx.serviceItem.create({ data: { tenantId: V, name: 'Servicio', priceCents: 90_000, category: 'CHICA_SERVICE' } });
      const paid1 = await tx.payment.create({ data: { tenantId: V, terminalId: term, createdByUserId: ana, idempotencyKey: `fa1-${r}`, qrToken: `fa1-${r}`, qrExpiresAt: new Date(), amountCents: 30_000, availableAmountCents: 30_000, status: 'AUTHORIZED', authorizedAt: new Date() } });
      const paid2 = await tx.payment.create({ data: { tenantId: V, terminalId: term, createdByUserId: ana, idempotencyKey: `fa2-${r}`, qrToken: `fa2-${r}`, qrExpiresAt: new Date(), amountCents: 115_000, availableAmountCents: 115_000, status: 'AUTHORIZED', authorizedAt: new Date() } });
      const unpaid = await tx.payment.create({ data: { tenantId: V, terminalId: term, createdByUserId: ana, idempotencyKey: `fa3-${r}`, qrToken: `fa3-${r}`, qrExpiresAt: new Date(), amountCents: 40_000, availableAmountCents: 40_000, status: 'CANCELED' } });
      const saldo = await tx.walletChargeRequest.create({ data: { tenantId: V, walletId, requestedByUserId: ana, amountCents: 10_000, category: 'CHICA_SERVICE', status: 'ACCEPTED', decidedAt: new Date(), expiresAt: new Date() } });
      await line({ paymentId: paid1.id, amount: 30_000 });
      await line({ paymentId: paid2.id, amount: 25_000 });
      await line({ paymentId: paid2.id, amount: 90_000, item: item.id });
      await line({ paymentId: unpaid.id, amount: 40_000 });
      await line({ walletChargeId: saldo.id, amount: 10_000 });
    });
    const found = (await staff()).filter((i) => i.refId.startsWith('free_amount:'));
    expect(found.map((i) => [i.refId.endsWith(`:${ana}`), i.amountCents])).toEqual([[true, 65_000]]);
    expect(found[0]!.detail).toMatch(/^Ana ha cobrado 650,00 € con «Otro importe» \(tecleado, sin la carta\) en 3 cobros/);
  });

  it('PIN fallado en 3 saldos distintos en el móvil de Leo; 2 en el de Ana, no', async () => {
    await sys(async (tx) => {
      for (const target of [randomUUID(), randomUUID(), randomUUID()]) {
        await tx.auditEvent.create({ data: { tenantId: V, actorId: leo, action: 'wallet.pin_failed', targetType: 'ClientWallet', targetId: target, payload: { attemptsLeft: 4 } } });
      }
      await tx.auditEvent.create({ data: { tenantId: V, actorId: ana, action: 'wallet.pin_failed', targetType: 'ClientWallet', targetId: randomUUID(), payload: {} } });
      await tx.auditEvent.create({ data: { tenantId: V, actorId: ana, action: 'wallet.pin_locked', targetType: 'ClientWallet', targetId: randomUUID(), payload: {} } });
    });
    const found = (await staff()).filter((i) => i.refId.startsWith('pin_fails:'));
    expect(found.map((i) => i.refId.endsWith(`:${leo}`))).toEqual([true]);
    expect(found[0]!.detail).toMatch(/^En el móvil de Leo se ha fallado el PIN de 3 saldos distintos/);
  });

  it('3 cobros de Leo al mismo saldo en 15 minutos (el código del saldo, solo en el panel); separados o deshechos, no', async () => {
    const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000);
    await sys(async (tx) => {
      const cons = (wallet: string, createdAt: Date, reversed = false) =>
        tx.walletConsumption.create({ data: { tenantId: V, walletId: wallet, amountCents: 2_000, providedByUserId: leo, category: 'VENUE_BAR', createdAt, ...(reversed ? { reversedAt: new Date(), reversedByUserId: owner } : {}) } });
      await cons(walletId, at(14));
      await cons(walletId, at(8));
      await cons(walletId, at(1));
      // Otro saldo: dos seguidos, uno deshecho y uno a los 40 min: no llega a 3 en 15 min.
      await cons(otherWallet, at(50));
      await cons(otherWallet, at(45), true);
      await cons(otherWallet, at(10));
    });
    const found = (await staff()).filter((i) => i.refId.startsWith('same_saldo:'));
    expect(found.map((i) => [i.refId.endsWith(`:${leo}:${walletId}`), i.amountCents])).toEqual([[true, 6_000]]);
    expect(found[0]!.detail).toMatch(/^Leo ha cobrado 3 veces al mismo saldo \(P[0-9A-Z]{2}-[0-9A-Z]{3}\) en 15 minutos \(60,00 €\)/);
    expect(found[0]!.alertDetail).not.toMatch(/\(P[0-9A-Z]{2}-/);
  });

  it('los umbrales del local mandan (0 = no se mira) y se cierran con nota', async () => {
    await sys((tx) => tx.venue.update({ where: { id: V }, data: { alertSettings: { staffWatch: { cancels: 6, freeAmountCents: 0 } } } }));
    const rules = (await staff()).map((i) => i.refId.split(':')[0]).sort();
    expect(rules).toEqual(['pin_fails', 'same_saldo']);
    await sys((tx) => tx.venue.update({ where: { id: V }, data: { alertSettings: {} } }));
    const pin = (await staff()).find((i) => i.refId.startsWith('pin_fails:'))!;
    expect(pin.noteRequired).toBe(true);
    await expect(inVenue(V, () => incidents.ack(V, owner, { kind: 'staff_pattern', refId: pin.refId }))).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'INCIDENT_NOTE_REQUIRED' }),
    });
    await inVenue(V, () => incidents.ack(V, owner, { kind: 'staff_pattern', refId: pin.refId, note: 'Hablado con Leo: eran clientes despistados' }));
    expect((await staff()).some((i) => i.refId === pin.refId)).toBe(false);
  });
});

describe('desbloquear el PIN con la 2FA (Postgres real)', () => {
  it('queda en Incidencias como acción delicada, con quién lo hizo', async () => {
    await sys((tx) => tx.clientWallet.update({ where: { id: walletId }, data: { pinHash: 'x', pinFails: 5, pinLockedAt: new Date() } }));
    const manager = await sys((tx) => tx.user.create({ data: { tenantId: V, email: `javi-pc-${r}@x.es`, passwordHash: 'x', role: 'MANAGER', displayName: 'Javi' } }));
    await inVenue(V, () => charges.unlockPinWithCode({ userId: manager.id, role: 'MANAGER', tenantId: V }, walletId, '123456'));
    expect(await sys((tx) => tx.clientWallet.findUnique({ where: { id: walletId }, select: { pinFails: true, pinLockedAt: true } }))).toEqual({ pinFails: 0, pinLockedAt: null });
    const items = await inVenue(V, () => incidents.list(V));
    expect(items.find((i) => i.kind === 'sensitive_action' && i.title === 'PIN de un cliente desbloqueado')?.detail).toMatch(/^Javi ha desbloqueado el PIN/);
  });
});

describe('«No he sido yo» desde los movimientos del saldo (Postgres real)', () => {
  it('el enlace firmado solo sale para un cobro pagado de ESE saldo; lleva a la página que pide confirmar', async () => {
    const charge = await sys((tx) =>
      tx.walletChargeRequest.create({ data: { tenantId: V, walletId, requestedByUserId: leo, amountCents: 1_500, category: 'VENUE_BAR', status: 'ACCEPTED', decidedAt: new Date(), expiresAt: new Date() } }),
    );
    const url = await inVenue(undefined, () => disputes.linkFor(walletId, charge.id));
    await expect(inVenue(undefined, () => disputes.view(url.replace('/w/no/', '')))).resolves.toMatchObject({ state: 'ask', totalCents: 1_500, venueName: 'Sala Proteger', hasFaceId: false });
    await expect(inVenue(undefined, () => disputes.linkFor(otherWallet, charge.id))).rejects.toMatchObject({ status: 404 });
    const pending = await sys((tx) =>
      tx.walletChargeRequest.create({ data: { tenantId: V, walletId, requestedByUserId: leo, amountCents: 500, category: 'VENUE_BAR', expiresAt: new Date(Date.now() + 60_000) } }),
    );
    await expect(inVenue(undefined, () => disputes.linkFor(walletId, pending.id))).rejects.toMatchObject({ status: 404 });
    // Confirmado, un saldo sin Face ID ya no paga: la incidencia no dice «con su Face ID, sí».
    await expect(inVenue(undefined, () => disputes.dispute(url.replace('/w/no/', '')))).resolves.toMatchObject({ state: 'done', hasFaceId: false });
    const aviso = (await inVenue(V, () => incidents.list(V))).find((i) => i.kind === 'wallet_charge_disputed');
    expect(aviso?.detail).toContain('Su ficha y su PIN ya no pagan. Revisa el cobro');
    expect(aviso?.detail).not.toContain('Face ID');
  });
});
