// Integración (Postgres real): cobro con QR + Face ID, PIN del saldo y ficha NFC. Ver README.md.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { WalletChargesService } from '../../src/modules/wallets/wallet-charges.service';
import { WalletsService } from '../../src/modules/wallets/wallets.service';

const cls = new ClsService(new AsyncLocalStorage());
 
const prisma = new PrismaService(cls as any);
const audit = { log: vi.fn(async () => undefined) };

const inVenue = <T>(tenantId: string | undefined, fn: () => Promise<T>): Promise<T> =>
  cls.run(async () => {
    cls.set('ctx', { tenantId, traceId: 't' });
    return fn();
  });
const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) =>
  inVenue(undefined, () => prisma.asSystem(fn));

/**
 * Como RefundsService.registerBankRefund (devolución hecha en BBVA): solo cobros
 * del local de quien la apunta; baja lo devolvible del cobro y deja la
 * devolución SUCCEEDED. `failOn`: el cobro cuya devolución falla.
 */
const bank = { calls: [] as Array<{ paymentId: string; amountCents: number }>, failOn: null as string | null };
const refundsStub = {
  registerBankRefund: vi.fn(async (req: { paymentId: string; amountCents: number }, actor: { userId: string; tenantId: string }) => {
    if (req.paymentId === bank.failOn) throw new Error('fallo del banco');
    await sys(async (tx) => {
      const p = await tx.payment.findUnique({ where: { id: req.paymentId } });
      if (!p || p.tenantId !== actor.tenantId) throw new Error('Payment not found');
      const left = p.availableAmountCents - req.amountCents;
      await tx.payment.update({
        where: { id: p.id },
        data: { availableAmountCents: left, status: left <= 0 ? 'REFUNDED' : 'PARTIALLY_REFUNDED' },
      });
      await tx.refund.create({
        data: { tenantId: p.tenantId, paymentId: p.id, amountCents: req.amountCents, requestedBy: actor.userId, status: 'SUCCEEDED', registeredManually: true },
      });
    });
    bank.calls.push({ paymentId: req.paymentId, amountCents: req.amountCents });
    return {};
  }),
};
const charges = new WalletChargesService(prisma as never, audit as never, { get: () => refundsStub } as never);

const r = randomUUID().slice(0, 6);
let A: string, B: string, X: string, chicaB: string, managerB: string, ownerA: string, svcB: string;
let rich: string, poor: string, foreign: string, spare: string;

const wallet = (tenantId: string, balanceCents: number, group: string, n: string) =>
  sys(async (tx) =>
    (
      await tx.clientWallet.create({
        data: { tenantId, balanceCents, qrToken: `fq-${n}-${r}`, shortCode: `${n}${r}`.toUpperCase().slice(0, 6), walletGroup: group },
      })
    ).id,
  );

beforeAll(async () => {
  await prisma.onModuleInit();
  await sys(async (tx) => {
    A = (await tx.venue.create({ data: { name: 'A', slug: `fa-${r}`, walletGroup: `fg-${r}` } })).id;
    B = (await tx.venue.create({ data: { name: 'Luna', slug: `fb-${r}`, walletGroup: `fg-${r}`, operatorMaxCobroCents: 50_000 } })).id;
    X = (await tx.venue.create({ data: { name: 'X', slug: `fx-${r}`, walletGroup: `fo-${r}` } })).id;
    managerB = (await tx.user.create({ data: { tenantId: B, email: `fm-${r}@x.es`, passwordHash: 'x', role: 'MANAGER' } })).id;
    ownerA = (await tx.user.create({ data: { tenantId: A, email: `fo-${r}@x.es`, passwordHash: 'x', role: 'OWNER' } })).id;
    chicaB = (
      await tx.user.create({
        data: { tenantId: B, email: `fc-${r}@x.es`, passwordHash: 'x', role: 'OPERATOR', commissionBps: 9000, displayName: 'Lola' },
      })
    ).id;
    svcB = (
      await tx.serviceItem.create({ data: { tenantId: B, name: 'Masaje', priceCents: 6000, category: 'CHICA_SERVICE', active: true } })
    ).id;
  });
  rich = await wallet(A, 10_000, `fg-${r}`, 'R');
  poor = await wallet(A, 500, `fg-${r}`, 'P');
  foreign = await wallet(X, 50_000, `fo-${r}`, 'F');
  spare = await wallet(A, 5_000, `fg-${r}`, 'S');
});

afterAll(async () => {
  await prisma.$disconnect();
});

const chica = () => ({ userId: chicaB, role: 'OPERATOR' as const, tenantId: B });
const manager = () => ({ userId: managerB, role: 'MANAGER' as const, tenantId: B });
const qr = (input: { serviceItemId?: string; amountCents?: number } = { serviceItemId: svcB }) =>
  inVenue(B, () => charges.createQrCharge(chica(), input));
// Las rutas públicas (/s/:token) no tienen local en el contexto.
const pay = (token: string, walletId: string) => inVenue(undefined, () => charges.payQrCharge(token, walletId));
const balanceOf = async (id: string) => (await sys((tx) => tx.clientWallet.findUnique({ where: { id } })))!;

describe('cobro con QR y Face ID (Postgres real)', () => {
  it('la chica enseña el QR; lo paga un saldo de otro local del grupo: consumo en su local y su parte', async () => {
    const c = await qr();
    expect(c).toMatchObject({ status: 'PENDING', amountCents: 6000 });
    expect(c.payToken.length).toBeGreaterThanOrEqual(32);
    const view = await inVenue(undefined, () => charges.qrChargeForClient(c.payToken));
    expect(view).toMatchObject({ status: 'PENDING', amountCents: 6000, serviceName: 'Masaje', venueName: 'Luna', requestedByName: 'Lola' });

    expect(await pay(c.payToken, rich)).toEqual({ amountCents: 6000, balanceCents: 4000 });
    const rows = await sys((tx) =>
      tx.$queryRaw<Array<{ amountCents: number; tenantId: string; commissionCents: number }>>`
        SELECT c."amountCents", c."tenantId"::text AS "tenantId", e."commissionCents"
          FROM wallet_consumptions c JOIN operator_earnings e ON e."consumptionId" = c.id
         WHERE c."walletId" = ${rich}::uuid`,
    );
    expect(rows).toEqual([{ amountCents: 6000, tenantId: B, commissionCents: 5400 }]);
    const seen = await inVenue(B, () => charges.getRequest(chica(), c.id));
    expect(seen).toMatchObject({ status: 'ACCEPTED', newBalanceCents: 4000 });
  });

  it('el mismo QR no se cobra dos veces (ni con otro saldo)', async () => {
    const c = await qr({ amountCents: 1000 });
    await pay(c.payToken, rich);
    await expect(pay(c.payToken, rich)).rejects.toThrow();
    await expect(pay(c.payToken, spare)).rejects.toThrow();
    expect((await balanceOf(rich)).balanceCents).toBe(3000);
    expect((await balanceOf(spare)).balanceCents).toBe(5000);
  });

  it('no le llega o es de otro grupo: no se cobra y el QR queda libre para otro saldo', async () => {
    const c = await qr();
    await expect(pay(c.payToken, poor)).rejects.toThrow(/saldo suficiente/);
    await expect(pay(c.payToken, foreign)).rejects.toThrow(/no vale en este local/);
    const req = await sys((tx) => tx.walletChargeRequest.findUnique({ where: { id: c.id } }));
    expect(req).toMatchObject({ status: 'PENDING', walletId: null });
    expect((await balanceOf(poor)).balanceCents).toBe(500);
    expect((await balanceOf(foreign)).balanceCents).toBe(50_000);
    await inVenue(B, () => charges.cancelRequest(chica(), c.id));
  });

  it('dos móviles pagan el mismo QR a la vez: solo uno', async () => {
    const c = await qr({ amountCents: 700 });
    const a = await wallet(A, 2_000, `fg-${r}`, 'C1');
    const b = await wallet(A, 2_000, `fg-${r}`, 'C2');
    const res = await Promise.allSettled([pay(c.payToken, a), pay(c.payToken, b)]);
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const total = (await balanceOf(a)).balanceCents + (await balanceOf(b)).balanceCents;
    expect(total).toBe(3_300);
    const consumptions = await sys((tx) => tx.walletConsumption.count({ where: { idempotencyKey: `charge-request:${c.id}` } }));
    expect(consumptions).toBe(1);
  });

  it('caducado o cancelado: no se cobra', async () => {
    const c1 = await qr({ amountCents: 100 });
    await sys((tx) => tx.walletChargeRequest.update({ where: { id: c1.id }, data: { expiresAt: new Date(Date.now() - 1000) } }));
    await expect(pay(c1.payToken, rich)).rejects.toThrow();
    const c2 = await qr({ amountCents: 100 });
    await inVenue(B, () => charges.cancelRequest(chica(), c2.id));
    await expect(pay(c2.payToken, rich)).rejects.toThrow();
    expect((await balanceOf(rich)).balanceCents).toBe(3000);
  });

  it('el tope por cobro de la chica también vale con QR', async () => {
    await expect(qr({ amountCents: 60_000 })).rejects.toThrow(/máximo/);
  });

  it('#37 otra chica del local no ve ni retira el cobro de una compañera; el encargado sí', async () => {
    const otra = await sys(async (tx) =>
      (await tx.user.create({ data: { tenantId: B, email: `f37-${r}@x.es`, passwordHash: 'x', role: 'OPERATOR' } })).id,
    );
    const otraActor = { userId: otra, role: 'OPERATOR' as const, tenantId: B };
    const c = await qr({ amountCents: 200 });
    await expect(inVenue(B, () => charges.getRequest(otraActor, c.id))).rejects.toThrow(/no encontrado/i);
    await expect(inVenue(B, () => charges.cancelRequest(otraActor, c.id))).rejects.toThrow(/no encontrado/i);
    expect((await sys((tx) => tx.walletChargeRequest.findUnique({ where: { id: c.id } })))!.status).toBe('PENDING');
    // Desde otro local, ni el encargado.
    await expect(inVenue(A, () => charges.getRequest({ userId: ownerA, role: 'OWNER', tenantId: A }, c.id))).rejects.toThrow(
      /no encontrado/i,
    );
    expect(await inVenue(B, () => charges.getRequest(manager(), c.id))).toMatchObject({ status: 'PENDING' });
    await inVenue(B, () => charges.cancelRequest(manager(), c.id));
    expect(await inVenue(B, () => charges.getRequest(chica(), c.id))).toMatchObject({ status: 'CANCELED' });
  });

  it('sin batería: el encargado ve el cobro y lo cobra del saldo; la chica no puede', async () => {
    const c = await qr({ amountCents: 1500 });
    const pending = await inVenue(B, () => charges.pendingQrCharges(manager()));
    expect(pending.map((p) => p.id)).toContain(c.id);
    await expect(inVenue(B, () => charges.pendingQrCharges(chica()))).rejects.toThrow(/encargado/);
    await expect(inVenue(B, () => charges.approveWithoutFaceId(chica(), c.id, spare))).rejects.toThrow(/encargado/);
    await expect(inVenue(B, () => charges.approveWithoutFaceId(manager(), c.id, foreign))).rejects.toThrow(/no encontrado/i);
    const done = await inVenue(B, () => charges.approveWithoutFaceId(manager(), c.id, spare));
    expect(done).toMatchObject({ status: 'ACCEPTED', newBalanceCents: 3500 });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'wallet.charge_without_faceid', targetId: spare }));
    const after = await inVenue(B, () => charges.pendingQrCharges(manager()));
    expect(after.map((p) => p.id)).not.toContain(c.id);
  });

  it('sumar a mi saldo: la recarga nueva pasa al saldo de su Face ID', async () => {
    const fresh = await wallet(A, 8_000, `fg-${r}`, 'N');
    const res = await inVenue(undefined, () => charges.mergeInto(fresh, rich));
    expect(res.balanceCents).toBe(11_000);
    expect(await balanceOf(fresh)).toMatchObject({ balanceCents: 0, status: 'DEPLETED', mergedIntoId: rich });
    await expect(inVenue(undefined, () => charges.mergeInto(fresh, rich))).rejects.toThrow(/ya no se puede sumar/);
    // A un saldo de otro grupo, no.
    const other = await wallet(A, 1_000, `fg-${r}`, 'M');
    await expect(inVenue(undefined, () => charges.mergeInto(other, foreign))).rejects.toThrow(/otro local/);
    // Una recarga que ya tiene su Face ID no se junta con otra.
    await sys((tx) =>
      tx.walletPasskey.create({ data: { walletId: other, credentialId: `cred-${r}`, publicKey: Buffer.from('k'), counter: 0n, transports: [] } }),
    );
    await expect(inVenue(undefined, () => charges.mergeInto(other, rich))).rejects.toThrow(/propio Face ID/);
    expect((await balanceOf(rich)).balanceCents).toBe(11_000);
  });

  it('#7 un cobro de la recarga confirmándose mientras se suma: la fusión espera y se lleva también eso', async () => {
    const src = await wallet(A, 4_000, `fg-${r}`, 'W7');
    const tgt = await wallet(A, 1_000, `fg-${r}`, 'T7');
    const payId = await sys(async (tx) => {
      const term = (await tx.terminal.create({ data: { tenantId: A, externalId: `F7-${r}`, label: 'T' } })).id;
      return (
        await tx.payment.create({
          data: {
            tenantId: A, terminalId: term, idempotencyKey: `f7-${r}`, amountCents: 2000, availableAmountCents: 2000,
            qrToken: `fq7-${r}`, qrExpiresAt: new Date(Date.now() + 300_000), status: 'AUTHORIZING', provider: 'REDSYS', walletId: src,
          },
        })
      ).id;
    });
    // El "webhook" (como transition): bloquea el pago, tarda, lo da por pagado y suma a la recarga.
    const webhook = sys(async (tx) => {
      await tx.$queryRaw`SELECT id FROM payments WHERE id = ${payId}::uuid FOR UPDATE`;
      await tx.$executeRaw`SELECT pg_sleep(0.6)`;
      await tx.$executeRaw`UPDATE payments SET status = 'AUTHORIZED' WHERE id = ${payId}::uuid`;
      await tx.$queryRaw`SELECT id FROM client_wallets WHERE id = ${src}::uuid FOR UPDATE`;
      await tx.$executeRaw`UPDATE client_wallets SET "balanceCents" = "balanceCents" + 2000 WHERE id = ${src}::uuid`;
    });
    await new Promise((res) => setTimeout(res, 150));
    const merged = await inVenue(undefined, () => charges.mergeInto(src, tgt));
    await webhook;
    expect(merged.balanceCents).toBe(7_000);
    expect(await balanceOf(src)).toMatchObject({ balanceCents: 0, status: 'DEPLETED', mergedIntoId: tgt });
    expect((await balanceOf(tgt)).balanceCents).toBe(7_000);
  });

  it('#56 se reabre un saldo a 0 cuyo código ya tiene otro cliente: código nuevo, sin chocar con el índice', async () => {
    const empty = await wallet(A, 0, `fg-${r}`, 'Z5');
    const code = (await balanceOf(empty)).shortCode!;
    await sys((tx) => tx.clientWallet.update({ where: { id: empty }, data: { status: 'DEPLETED' } }));
    // Otro cliente se lleva su código mientras estaba a 0.
    const other = await sys(async (tx) =>
      (await tx.clientWallet.create({ data: { tenantId: A, balanceCents: 500, qrToken: `fq-z5o-${r}`, shortCode: code, walletGroup: `fg-${r}` } })).id,
    );
    const fresh = await wallet(A, 1_500, `fg-${r}`, 'Z6');
    await inVenue(undefined, () => charges.mergeInto(fresh, empty));
    const after = await balanceOf(empty);
    expect(after).toMatchObject({ balanceCents: 1_500, status: 'ACTIVE' });
    expect(after.shortCode).not.toBe(code);
    expect((await balanceOf(other)).shortCode).toBe(code);
    // Un saldo ya sumado a otro no recibe más recargas.
    const late = await wallet(A, 700, `fg-${r}`, 'Z7');
    await expect(inVenue(undefined, () => charges.mergeInto(late, fresh))).rejects.toThrow(/cerrado/);
  });

  it('fusión de un saldo a 0 (DEPLETED) lo reactiva', async () => {
    const empty = await wallet(A, 0, `fg-${r}`, 'E');
    await sys((tx) => tx.clientWallet.update({ where: { id: empty }, data: { status: 'DEPLETED' } }));
    const fresh = await wallet(A, 2_500, `fg-${r}`, 'G');
    await inVenue(undefined, () => charges.mergeInto(fresh, empty));
    expect(await balanceOf(empty)).toMatchObject({ balanceCents: 2_500, status: 'ACTIVE' });
  });

  it('seguridad: el encargado no aprueba su propio cobro; fusión con recarga a medias, no', async () => {
    const mine = await inVenue(B, () => charges.createQrCharge(manager(), { amountCents: 500 }));
    await expect(inVenue(B, () => charges.approveWithoutFaceId(manager(), mine.id, spare))).rejects.toThrow(/otro encargado/);
    // #90: ya no hay cobro con petición que se acepte con el enlace del saldo.
    expect('createRequest' in charges).toBe(false);
    expect('accept' in charges).toBe(false);
    // Recarga a medias en el saldo que se quiere sumar.
    const half = await wallet(A, 4_000, `fg-${r}`, 'H');
    await sys(async (tx) => {
      const term = (await tx.terminal.create({ data: { tenantId: A, externalId: `FT-${r}`, label: 'T' } })).id;
      await tx.payment.create({
        data: {
          tenantId: A, terminalId: term, idempotencyKey: `fh-${r}`, amountCents: 2000, availableAmountCents: 2000,
          qrToken: `fqh-${r}`, qrExpiresAt: new Date(Date.now() + 300_000), status: 'CREATED', provider: 'REDSYS', walletId: half,
        },
      });
    });
    await expect(inVenue(undefined, () => charges.mergeInto(half, spare))).rejects.toThrow(/a medias/);
  });

  it('enlace nuevo (móvil perdido): se borra su Face ID', async () => {
    await sys((tx) =>
      tx.walletPasskey.create({ data: { walletId: rich, credentialId: `cred2-${r}`, publicKey: Buffer.from('k'), counter: 0n, transports: [] } }),
    );
    await inVenue(A, () => charges.relink({ userId: ownerA, role: 'OWNER', tenantId: A }, rich));
    expect(await sys((tx) => tx.walletPasskey.count({ where: { walletId: rich } }))).toBe(0);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'wallet.relinked', payload: expect.objectContaining({ removedPasskeys: 1 }) }));
  });
});

describe('PIN del saldo (Postgres real)', () => {
  const codeOf = async (id: string) => (await sys((tx) => tx.clientWallet.findUnique({ where: { id } })))!.shortCode!;

  it('elige su PIN en "Pagado"; la chica cobra el QR con su código + PIN (sin su móvil)', async () => {
    const w = await wallet(A, 10_000, `fg-${r}`, 'Q');
    await expect(inVenue(undefined, () => charges.setPinFromPayer(w, '1234'))).rejects.toThrow(/fácil/);
    await inVenue(undefined, () => charges.setPinFromPayer(w, '4827'));
    await expect(inVenue(undefined, () => charges.setPinFromPayer(w, '5938'))).rejects.toThrow(/ya tiene PIN/);
    const code = await codeOf(w);
    expect(await inVenue(B, () => charges.lookup(B, code))).toMatchObject({ hasPin: true, pinLocked: false });
    const c = await qr();
    const res = await inVenue(B, () => charges.payQrChargeWithPin(chica(), c.id, { code, pin: '4827' }));
    expect(res).toMatchObject({ status: 'ACCEPTED', newBalanceCents: 4000 });
    const rows = await sys((tx) =>
      tx.$queryRaw<Array<{ amountCents: number; commissionCents: number }>>`
        SELECT c."amountCents", e."commissionCents" FROM wallet_consumptions c
          JOIN operator_earnings e ON e."consumptionId" = c.id WHERE c."walletId" = ${w}::uuid`,
    );
    expect(rows).toEqual([{ amountCents: 6000, commissionCents: 5400 }]);
  });

  it('5 PIN malos → bloqueado (ni con el bueno); el encargado lo desbloquea y vuelve a pagar', async () => {
    const w = await wallet(A, 5_000, `fg-${r}`, 'L');
    await inVenue(undefined, () => charges.setPinFromPayer(w, '4827'));
    const code = await codeOf(w);
    const c = await qr({ amountCents: 500 });
    for (let i = 0; i < 4; i++) {
      await expect(inVenue(B, () => charges.payQrChargeWithPin(chica(), c.id, { code, pin: '0101' }))).rejects.toThrow(/PIN incorrecto/);
    }
    await expect(inVenue(B, () => charges.payQrChargeWithPin(chica(), c.id, { code, pin: '0101' }))).rejects.toThrow(/bloqueado/);
    await expect(inVenue(B, () => charges.payQrChargeWithPin(chica(), c.id, { code, pin: '4827' }))).rejects.toThrow(/bloqueado/);
    expect((await balanceOf(w)).balanceCents).toBe(5_000);
    await inVenue(B, () => charges.unlockPin(manager(), w));
    const ok = await inVenue(B, () => charges.payQrChargeWithPin(chica(), c.id, { code, pin: '4827' }));
    expect(ok).toMatchObject({ status: 'ACCEPTED', newBalanceCents: 4_500 });
  });

  it('cobro ya pagado o caducado: no gasta un intento; el cobro de otra chica, tampoco', async () => {
    const w = await wallet(A, 5_000, `fg-${r}`, 'U');
    await inVenue(undefined, () => charges.setPinFromPayer(w, '4827'));
    const code = await codeOf(w);
    const c = await qr({ amountCents: 300 });
    await sys((tx) => tx.walletChargeRequest.update({ where: { id: c.id }, data: { expiresAt: new Date(Date.now() - 1000) } }));
    await expect(inVenue(B, () => charges.payQrChargeWithPin(chica(), c.id, { code, pin: '0000' }))).rejects.toThrow();
    const other = await sys(async (tx) =>
      (await tx.user.create({ data: { tenantId: B, email: `fc2-${r}@x.es`, passwordHash: 'x', role: 'OPERATOR' } })).id,
    );
    const c2 = await qr({ amountCents: 300 });
    await expect(
      inVenue(B, () => charges.payQrChargeWithPin({ userId: other, role: 'OPERATOR', tenantId: B }, c2.id, { code, pin: '0000' })),
    ).rejects.toThrow(/otra persona/);
    expect((await sys((tx) => tx.clientWallet.findUnique({ where: { id: w } })))!.pinFails).toBe(0);
  });

  const topUp = (walletId: string, by: string | null, authorizedAt: Date, tag: string) =>
    sys(async (tx) => {
      const term = (await tx.terminal.create({ data: { tenantId: A, externalId: `FP-${tag}-${r}`, label: 'T' } })).id;
      await tx.payment.create({
        data: {
          tenantId: A, terminalId: term, idempotencyKey: `fp-${tag}-${r}`, amountCents: 2000, availableAmountCents: 2000,
          qrToken: `fqp-${tag}-${r}`, qrExpiresAt: new Date(Date.now() + 300_000), status: 'AUTHORIZED', provider: 'REDSYS',
          walletId, authorizedAt, createdByUserId: by, createdAt: authorizedAt,
        },
      });
    });

  it('la chica pone el PIN solo tras la PRIMERA recarga que hizo ella (15 min); y solo ve ese código', async () => {
    const w = await wallet(A, 2_000, `fg-${r}`, 'T');
    const code = await codeOf(w);
    await expect(inVenue(B, () => charges.setPin(chica(), { code, pin: '4827' }))).rejects.toThrow(/encargado/);
    await expect(inVenue(B, () => charges.lookupById(chica(), w))).rejects.toThrow(/no encontrado/i);
    await topUp(w, chicaB, new Date(), 'a');
    expect((await inVenue(B, () => charges.lookupById(chica(), w))).code).toBeTruthy();
    const other = await sys(async (tx) =>
      (await tx.user.create({ data: { tenantId: B, email: `fc3-${r}@x.es`, passwordHash: 'x', role: 'OPERATOR' } })).id,
    );
    const otherActor = { userId: other, role: 'OPERATOR' as const, tenantId: B };
    await expect(inVenue(B, () => charges.setPin(otherActor, { code, pin: '4827' }))).rejects.toThrow(/encargado/);
    await expect(inVenue(B, () => charges.lookupById(otherActor, w))).rejects.toThrow(/no encontrado/i);
    const after = await inVenue(B, () => charges.setPin(chica(), { code, pin: '4827' }));
    expect(after.hasPin).toBe(true);
    expect((await sys((tx) => tx.clientWallet.findUnique({ where: { id: w } })))!.pinSetById).toBeNull();
    await inVenue(B, () => charges.resetPin(manager(), w));
    expect((await inVenue(B, () => charges.lookup(B, code))).hasPin).toBe(false);
  });

  it('una recarga de 1 € a un saldo viejo no vuelve a abrir la puerta del PIN', async () => {
    const w = await wallet(A, 2_000, `fg-${r}`, 'V');
    await topUp(w, chicaB, new Date(Date.now() - 3600_000), 'old');
    await topUp(w, chicaB, new Date(), 'new');
    const code = await codeOf(w);
    await expect(inVenue(B, () => charges.setPin(chica(), { code, pin: '4827' }))).rejects.toThrow(/encargado/);
  });

  it('el PIN que pone el encargado sin el cliente: él no cobra con ese PIN (hacen falta dos)', async () => {
    const w = await wallet(A, 5_000, `fg-${r}`, 'M2');
    const code = await codeOf(w);
    await inVenue(B, () => charges.setPin(manager(), { code, pin: '5938' }));
    expect((await sys((tx) => tx.clientWallet.findUnique({ where: { id: w } })))!.pinSetById).toBe(managerB);
    const own = await inVenue(B, () => charges.createQrCharge(manager(), { amountCents: 1000 }));
    await expect(inVenue(B, () => charges.payQrChargeWithPin(manager(), own.id, { code, pin: '5938' }))).rejects.toThrow(/otra persona/);
    const girls = await qr({ amountCents: 1000 });
    await expect(inVenue(B, () => charges.payQrChargeWithPin(manager(), girls.id, { code, pin: '5938' }))).rejects.toThrow(/otra persona/);
    expect((await sys((tx) => tx.clientWallet.findUnique({ where: { id: w } })))!.pinFails).toBe(0);
    const ok = await inVenue(B, () => charges.payQrChargeWithPin(chica(), girls.id, { code, pin: '5938' }));
    expect(ok).toMatchObject({ status: 'ACCEPTED', newBalanceCents: 4_000 });
  });

  it('fallos de hace más de 12 h no cuentan para el bloqueo', async () => {
    const w = await wallet(A, 5_000, `fg-${r}`, 'O');
    await inVenue(undefined, () => charges.setPinFromPayer(w, '4827'));
    await sys((tx) =>
      tx.clientWallet.update({ where: { id: w }, data: { pinFails: 4, pinFailedAt: new Date(Date.now() - 13 * 3600_000) } }),
    );
    const c = await qr({ amountCents: 100 });
    const code = await codeOf(w);
    await expect(inVenue(B, () => charges.payQrChargeWithPin(chica(), c.id, { code, pin: '0101' }))).rejects.toThrow(
      /Quedan 4 intentos/,
    );
    expect(await sys((tx) => tx.clientWallet.findUnique({ where: { id: w } }))).toMatchObject({ pinFails: 1, pinLockedAt: null });
  });

  it('PIN y Face ID a la vez en el mismo QR: solo se cobra uno', async () => {
    const a = await wallet(A, 3_000, `fg-${r}`, 'X1');
    const b = await wallet(A, 3_000, `fg-${r}`, 'X2');
    await inVenue(undefined, () => charges.setPinFromPayer(a, '4827'));
    const code = await codeOf(a);
    const c = await qr({ amountCents: 1000 });
    const res = await Promise.allSettled([
      inVenue(B, () => charges.payQrChargeWithPin(chica(), c.id, { code, pin: '4827' })),
      pay(c.payToken, b),
    ]);
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect((await balanceOf(a)).balanceCents + (await balanceOf(b)).balanceCents).toBe(5_000);
  });
});

describe('ficha NFC (Postgres real)', () => {
  const codeOf = async (id: string) => (await sys((tx) => tx.clientWallet.findUnique({ where: { id } })))!.shortCode!;
  const tok = (n: string) => `ficha${n}${r}`.padEnd(22, 'x').slice(0, 22);
  const topUpBy = (walletId: string, tag: string) =>
    sys(async (tx) => {
      const term = (await tx.terminal.create({ data: { tenantId: A, externalId: `FN-${tag}-${r}`, label: 'T' } })).id;
      await tx.payment.create({
        data: {
          tenantId: A, terminalId: term, idempotencyKey: `fn-${tag}-${r}`, amountCents: 2000, availableAmountCents: 2000,
          qrToken: `fqn-${tag}-${r}`, qrExpiresAt: new Date(Date.now() + 300_000), status: 'AUTHORIZED', provider: 'REDSYS',
          walletId, authorizedAt: new Date(), createdByUserId: chicaB,
        },
      });
    });

  const blank = (t: string) => sys((tx) => tx.walletCard.create({ data: { token: t } }));

  it('el código de la ficha lo crea el servidor; uno inventado no se puede dar', async () => {
    const issued = await inVenue(B, () => charges.issueCard(chica()));
    expect(issued.card).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const w = await wallet(A, 1_000, `fg-${r}`, 'N0');
    await expect(inVenue(B, () => charges.linkCard(manager(), { code: '', card: 'AAAAAAAAAAAAAAAAAAAA' }))).rejects.toThrow();
    const code = (await sys((tx) => tx.clientWallet.findUnique({ where: { id: w } })))!.shortCode!;
    await expect(inVenue(B, () => charges.linkCard(manager(), { code, card: 'AAAAAAAAAAAAAAAAAAAA' }))).rejects.toThrow(/no es nuestra/);
    await inVenue(B, () => charges.linkCard(manager(), { code, card: issued.card }));
  });

  it('dos "dar ficha" a la vez al mismo saldo: queda una sola ficha activa', async () => {
    const w = await wallet(A, 1_000, `fg-${r}`, 'N9');
    const code = (await sys((tx) => tx.clientWallet.findUnique({ where: { id: w } })))!.shortCode!;
    await blank(tok('x'));
    await blank(tok('y'));
    await Promise.allSettled([
      inVenue(B, () => charges.linkCard(manager(), { code, card: tok('x') })),
      inVenue(B, () => charges.linkCard(manager(), { code, card: tok('y') })),
    ]);
    expect(await sys((tx) => tx.walletCard.count({ where: { walletId: w, status: 'ISSUED' } }))).toBe(1);
  });

  it('se da al recargar; la chica cobra acercándola + PIN; sin PIN no paga', async () => {
    await blank(tok('a'));
    await blank(tok('c'));
    await blank(tok('d'));
    const w = await wallet(A, 10_000, `fg-${r}`, 'N1');
    await topUpBy(w, 'n1');
    const code = await codeOf(w);
    const linked = await inVenue(B, () => charges.linkCard(chica(), { code, card: tok('a'), uid: '04:a2:3b:5c:1d:80:01' }));
    expect(linked.hasCard).toBe(true);
    expect((await inVenue(B, () => charges.lookupCard(B, { card: tok('a'), uid: '04A23B5C1D8001' }))).walletId).toBe(w);
    const c = await qr({ amountCents: 2500 });
    await expect(inVenue(B, () => charges.payQrChargeWithPin(chica(), c.id, { card: tok('a'), pin: '4827' }))).rejects.toThrow(/no tiene PIN/);
    await inVenue(undefined, () => charges.setPinFromPayer(w, '4827'));
    const ok = await inVenue(B, () => charges.payQrChargeWithPin(chica(), c.id, { card: tok('a'), uid: '04A23B5C1D8001', pin: '4827' }));
    expect(ok).toMatchObject({ status: 'ACCEPTED', newBalanceCents: 7_500 });
    expect((await sys((tx) => tx.walletCard.findUnique({ where: { token: tok('a') } })))!.lastUsedAt).not.toBeNull();
  });

  it('una copia (otro número de serie) no vale; la de otro cliente con saldo no se reasigna', async () => {
    await expect(inVenue(B, () => charges.lookupCard(B, { card: tok('a'), uid: '04FFFFFFFFFF01' }))).rejects.toThrow(/copiada/);
    const w2 = await wallet(A, 3_000, `fg-${r}`, 'N2');
    await topUpBy(w2, 'n2');
    const code2 = await codeOf(w2);
    await expect(inVenue(B, () => charges.linkCard(chica(), { code: code2, card: tok('a') }))).rejects.toThrow(
      /otro cliente que aún tiene saldo/,
    );
  });

  it('ficha de un saldo ya gastado: se reutiliza para otro cliente', async () => {
    const old = await wallet(A, 0, `fg-${r}`, 'N3');
    await sys((tx) => tx.walletCard.create({ data: { token: tok('b'), walletId: old, status: 'ISSUED' } }));
    await sys((tx) => tx.clientWallet.update({ where: { id: old }, data: { status: 'DEPLETED' } }));
    const fresh = await wallet(A, 4_000, `fg-${r}`, 'N4');
    await topUpBy(fresh, 'n4');
    const code4 = await codeOf(fresh);
    await inVenue(B, () => charges.linkCard(chica(), { code: code4, card: tok('b') }));
    expect((await inVenue(B, () => charges.lookupCard(B, { card: tok('b') }))).walletId).toBe(fresh);
  });

  it('solo la chica de la recarga (15 min) o el encargado; perdida → bloqueada y no paga', async () => {
    const w = await wallet(A, 5_000, `fg-${r}`, 'N5');
    const code = await codeOf(w);
    await expect(inVenue(B, () => charges.linkCard(chica(), { code, card: tok('c') }))).rejects.toThrow(/al recargar/);
    await inVenue(B, () => charges.linkCard(manager(), { code, card: tok('c') }));
    // Una ficha por saldo: dar otra suelta la anterior.
    await inVenue(B, () => charges.linkCard(manager(), { code, card: tok('d') }));
    await expect(inVenue(B, () => charges.lookupCard(B, { card: tok('c') }))).rejects.toThrow(/no tiene saldo/);
    await inVenue(B, () => charges.blockCard(manager(), w));
    await expect(inVenue(B, () => charges.lookupCard(B, { card: tok('d') }))).rejects.toThrow(/no tiene saldo/);
    await expect(inVenue(B, () => charges.linkCard(manager(), { code, card: tok('d') }))).rejects.toThrow(/bloqueada/);
    await expect(inVenue(B, () => charges.blockCard(chica(), w))).rejects.toThrow(/encargado/);
  });

  it('una ficha de otro grupo de locales no paga aquí', async () => {
    await sys((tx) => tx.walletCard.create({ data: { token: tok('e'), walletId: foreign, status: 'ISSUED' } }));
    await expect(inVenue(B, () => charges.lookupCard(B, { card: tok('e') }))).rejects.toThrow(/no tiene saldo en este local/);
  });
});

describe('devolver el saldo (Postgres real)', () => {
  const ownerActor = () => ({ userId: ownerA, role: 'OWNER' as const, tenantId: A });
  /** Recarga ya pagada del saldo (cobrada en `tenantId`). */
  const paidTopUp = (walletId: string, amountCents: number, tag: string, tenantId = A) =>
    sys(async (tx) => {
      const term = (await tx.terminal.create({ data: { tenantId, externalId: `FD-${tag}-${r}`, label: 'T' } })).id;
      return (
        await tx.payment.create({
          data: {
            tenantId, terminalId: term, idempotencyKey: `fd-${tag}-${r}`, amountCents, availableAmountCents: amountCents,
            qrToken: `fqd-${tag}-${r}`, qrExpiresAt: new Date(Date.now() + 300_000), status: 'AUTHORIZED', provider: 'REDSYS',
            walletId, authorizedAt: new Date(),
          },
        })
      ).id;
    });

  it('#22 a la tarjeta tras sumar una recarga (Face ID): se reparte también entre las recargas del saldo sumado', async () => {
    const tgt = await wallet(A, 2_000, `fg-${r}`, 'D1');
    const src = await wallet(A, 5_000, `fg-${r}`, 'D2');
    const ownTop = await paidTopUp(tgt, 2_000, 'd1');
    const srcTop = await paidTopUp(src, 5_000, 'd2');
    await inVenue(undefined, () => charges.mergeInto(src, tgt));
    bank.calls = [];
    const out = await inVenue(A, () => charges.payout(ownerActor(), tgt, { method: 'CARD', bankReference: 'DEV-22' }));
    expect(out).toEqual({ refundedCents: 7_000, method: 'CARD' });
    expect(bank.calls).toEqual(
      expect.arrayContaining([
        { paymentId: srcTop, amountCents: 5_000 },
        { paymentId: ownTop, amountCents: 2_000 },
      ]),
    );
    expect(await balanceOf(tgt)).toMatchObject({ balanceCents: 0, status: 'REFUNDED' });
  });

  it('#38 en efectivo: en una transacción, saldo cerrado y devolución hecha', async () => {
    const w = await wallet(A, 3_300, `fg-${r}`, 'D3');
    // Entró en efectivo (en efectivo solo se devuelve lo que entró en efectivo).
    await sys((tx) =>
      tx.walletCashTopUp.create({
        data: { tenantId: A, walletId: w, amountCents: 3_300, takenByUserId: ownerA, idempotencyKey: `d3-${r}`, createdAt: new Date(Date.now() - 86_400_000) },
      }),
    );
    const out = await inVenue(A, () => charges.payout(ownerActor(), w, { method: 'CASH', note: 'en mano' }));
    expect(out).toEqual({ refundedCents: 3_300, method: 'CASH' });
    expect(await balanceOf(w)).toMatchObject({ balanceCents: 0, status: 'REFUNDED' });
    const rows = await sys((tx) => tx.walletPayout.findMany({ where: { walletId: w } }));
    expect(rows).toEqual([expect.objectContaining({ amountCents: 3_300, method: 'CASH', status: 'DONE' })]);
  });

  it('#38 a la tarjeta, dos clics a la vez: se apunta una sola vez', async () => {
    const w = await wallet(A, 4_000, `fg-${r}`, 'D4');
    await paidTopUp(w, 4_000, 'd4');
    bank.calls = [];
    const go = () => inVenue(A, () => charges.payout(ownerActor(), w, { method: 'CARD' }));
    const res = await Promise.allSettled([go(), go()]);
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(bank.calls.reduce((s, c) => s + c.amountCents, 0)).toBe(4_000);
    expect(await balanceOf(w)).toMatchObject({ balanceCents: 0, status: 'REFUNDED' });
    const rows = await sys((tx) => tx.walletPayout.findMany({ where: { walletId: w } }));
    expect(rows).toEqual([expect.objectContaining({ amountCents: 4_000, method: 'CARD', status: 'DONE' })]);
  });

  it('#38 se cayó a mitad (PENDING con parte apuntada): al momento espera; pasado el rato se retoma sin repetir', async () => {
    const w = await wallet(A, 0, `fg-${r}`, 'D5');
    const t1 = await paidTopUp(w, 3_000, 'd5a');
    const t2 = await paidTopUp(w, 2_000, 'd5b');
    // Como lo deja una caída: el saldo ya en la devolución PENDING y una recarga ya apuntada en el banco.
    const po = await sys((tx) =>
      tx.walletPayout.create({
        data: { tenantId: A, walletId: w, amountCents: 5_000, method: 'CARD', status: 'PENDING', claimedAt: new Date(), paidByUserId: ownerA },
      }),
    );
    await refundsStub.registerBankRefund({ paymentId: t2, amountCents: 2_000 }, { userId: ownerA, tenantId: A });
    // Solo una a medias por saldo (índice parcial).
    await expect(
      sys((tx) =>
        tx.walletPayout.create({
          data: { tenantId: A, walletId: w, amountCents: 1, method: 'CARD', status: 'PENDING', paidByUserId: ownerA },
        }),
      ),
    ).rejects.toThrow();
    // El cliente no la ve como devuelta mientras está a medias.
    const token = (await balanceOf(w)).qrToken;
    expect((await inVenue(undefined, () => charges.clientState(token))).movements.some((m) => m.kind === 'payout')).toBe(false);
    await expect(inVenue(A, () => charges.payout(ownerActor(), w, { method: 'CARD' }))).rejects.toThrow(/Ya se está apuntando/);
    await sys((tx) => tx.walletPayout.update({ where: { id: po.id }, data: { claimedAt: new Date(Date.now() - 10 * 60_000) } }));
    bank.calls = [];
    const out = await inVenue(A, () => charges.payout(ownerActor(), w, { method: 'CARD' }));
    expect(out).toEqual({ refundedCents: 5_000, method: 'CARD' });
    expect(bank.calls).toEqual([{ paymentId: t1, amountCents: 3_000 }]);
    expect(await sys((tx) => tx.walletPayout.findUnique({ where: { id: po.id } }))).toMatchObject({ status: 'DONE', amountCents: 5_000 });
    expect(await balanceOf(w)).toMatchObject({ balanceCents: 0, status: 'REFUNDED' });
    expect((await inVenue(undefined, () => charges.clientState(token))).movements.filter((m) => m.kind === 'payout')).toHaveLength(1);
  });

  it('#38 a la tarjeta, una devolución falla: lo hecho queda apuntado y el resto vuelve al saldo, abierto', async () => {
    const w = await wallet(A, 6_000, `fg-${r}`, 'D6');
    await paidTopUp(w, 1_000, 'd6a');
    const bad = await paidTopUp(w, 5_000, 'd6b');
    bank.calls = [];
    bank.failOn = bad;
    try {
      // Va primero la más reciente (la que falla): no se apunta nada y el saldo vuelve entero.
      await expect(inVenue(A, () => charges.payout(ownerActor(), w, { method: 'CARD' }))).rejects.toThrow(/quedan 60,00 €/);
    } finally {
      bank.failOn = null;
    }
    expect(await balanceOf(w)).toMatchObject({ balanceCents: 6_000, status: 'ACTIVE' });
    expect(await sys((tx) => tx.walletPayout.count({ where: { walletId: w } }))).toBe(0);
  });

  it('#58 estadísticas: lo devuelto hoy (tarjeta y efectivo, solo hechas) y el resto se ven también con RLS forzado', async () => {
    const walletsSvc = new WalletsService(prisma as never, audit as never);
    const stats = await inVenue(A, () => walletsSvc.getAdminStats(A));
    const [{ total }] = await sys((tx) =>
      tx.$queryRaw<Array<{ total: bigint }>>`
        SELECT COALESCE(SUM("amountCents"),0)::bigint AS total FROM wallet_payouts
         WHERE "tenantId" = ${A}::uuid AND status = 'DONE'`,
    );
    expect(Number(total)).toBeGreaterThan(0);
    expect(stats.todayRefundsCents).toBe(Number(total));
    // Con el rol de la app (no superusuario) client_wallets tiene RLS forzado: antes salía 0.
    expect(stats.activeCount).toBeGreaterThan(0);
  });
});
