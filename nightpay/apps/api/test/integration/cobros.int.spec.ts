// Integración (Postgres real): cobros (propina del banco, confirmación atómica, idempotencia) con np_app y FORCE RLS. Ver README.md.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';

const cls = new ClsService(new AsyncLocalStorage());
 
const prisma = new PrismaService(cls as any);
const metrics = {
  paymentsCreated: { inc: vi.fn() },
  paymentsTransitioned: { inc: vi.fn() },
  walletCreditSkipped: { inc: vi.fn() },
};
const realtime = { emitPaymentUpdate: vi.fn(), emitPaymentCompleted: vi.fn() };
const queue = { add: vi.fn(async () => undefined) };
const payments = new PaymentsService(
  prisma as never,
  cls as never,
  queue as never,
  queue as never,
  {} as never,
  realtime as never,
  metrics as never,
  {} as never,
  {} as never,
  {} as never,
);

export const inVenue = <T>(tenantId: string | undefined, fn: () => Promise<T>, extra: Record<string, unknown> = {}): Promise<T> =>
  cls.run(async () => {
    cls.set('ctx', { tenantId, traceId: 't', ...extra });
    return fn();
  });
export const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) =>
  inVenue(undefined, () => prisma.asSystem(fn));

const r = randomUUID().slice(0, 6);
let A: string, chica: string, owner: string, term: string;
let n = 0;

async function payment(o: Record<string, unknown>) {
  n += 1;
  return sys((tx) =>
    tx.payment.create({
      data: {
        tenantId: A,
        terminalId: term,
        idempotencyKey: `zz-${r}-${n}`,
        amountCents: 10_000,
        availableAmountCents: 10_000,
        qrToken: `zz-${r}-${n}`,
        qrExpiresAt: new Date(Date.now() + 3600_000),
        status: 'AUTHORIZING',
        createdByUserId: chica,
        revenueCategory: 'CHICA_SERVICE',
        ...o,
      } as never,
    }),
  );
}

beforeAll(async () => {
  await prisma.onModuleInit();
  await sys(async (tx) => {
    A = (await tx.venue.create({ data: { name: 'Local P', slug: `p-${r}`, walletGroup: `gp-${r}` } })).id;
    owner = (await tx.user.create({ data: { tenantId: A, email: `own-${r}@x.es`, passwordHash: 'x', role: 'OWNER' } })).id;
    chica = (
      await tx.user.create({ data: { tenantId: A, email: `op-${r}@x.es`, passwordHash: 'x', role: 'OPERATOR', commissionBps: 9000 } })
    ).id;
    term = (await tx.terminal.create({ data: { tenantId: A, externalId: `TP-${r}`, label: 'P', zone: 'BARRA' } })).id;
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('#3 la propina es la que cobró el banco (Postgres real)', () => {
  it('Paytef QR con propina inventada al crear → AUTHORIZED sin propina; la chica solo su comisión', async () => {
    const p = await payment({ provider: 'PAYTEF', providerTxId: `PT-${r}`, tipCents: 3_000, availableAmountCents: 13_000, tipGoesTo: 'operator' });
    await inVenue(undefined, () => payments.transition(p.id, { type: 'AUTHORIZED', provider: 'PAYTEF', providerTxId: `PT-${r}` }));
    const after = await sys((tx) => tx.payment.findUnique({ where: { id: p.id } }));
    expect(after).toMatchObject({ status: 'AUTHORIZED', tipCents: 0, availableAmountCents: 10_000, tipGoesTo: null });
    const e = await sys((tx) => tx.operatorEarning.findFirst({ where: { paymentId: p.id } }));
    expect(e).toMatchObject({ commissionBps: 9000, commissionCents: 9000, tipCents: 0 });
  });

  it('Redsys: la propina del intento aprobado sí cuenta', async () => {
    const p = await payment({ provider: 'REDSYS', providerTxId: `RS-${r}` });
    await sys((tx) =>
      tx.paymentAttempt.create({
        data: { paymentId: p.id, tenantId: A, provider: 'REDSYS', providerTxId: `RS-${r}`, amountCents: 10_500, tipCents: 500 },
      }),
    );
    await inVenue(undefined, () => payments.transition(p.id, { type: 'AUTHORIZED', provider: 'REDSYS', providerTxId: `RS-${r}` }));
    const after = await sys((tx) => tx.payment.findUnique({ where: { id: p.id } }));
    expect(after).toMatchObject({ status: 'AUTHORIZED', tipCents: 500, availableAmountCents: 10_500, tipGoesTo: 'operator' });
    const e = await sys((tx) => tx.operatorEarning.findFirst({ where: { paymentId: p.id } }));
    expect(e).toMatchObject({ commissionCents: 9000, tipCents: 500 });
  });
});

describe('#13 confirmar un cobro POS a mano (Postgres real)', () => {
  const waiterOf = () => ({ userId: owner, role: 'OWNER', tenantId: A });
  const pos = (o: Record<string, unknown> = {}) =>
    payment({ status: 'CREATED', captureMethod: 'POS_EXTERNAL', tipCents: 2_000, availableAmountCents: 12_000, tipGoesTo: 'operator', ...o });

  it('dos camareros a la vez con el MISMO ticket en dos cobros → solo uno', async () => {
    const p1 = await pos();
    const p2 = await pos();
    const code = `Q${r.slice(0, 5)}`.toUpperCase();
    const go = (id: string) => inVenue(A, () => payments.confirmPosPayment(id, waiterOf(), { posReceiptRef: code }));
    const out = await Promise.allSettled([go(p1.id), go(p2.id)]);
    expect(out.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const rej = out.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    expect(String(rej.reason.message)).toMatch(/ya se usó en otro cobro/);
    const rows = await sys((tx) => tx.payment.findMany({ where: { id: { in: [p1.id, p2.id] } }, orderBy: { status: 'asc' } }));
    expect(rows.map((x) => x.status).sort()).toEqual(['AUTHORIZED', 'CREATED']);
    const paid = rows.find((x) => x.status === 'AUTHORIZED')!;
    // Pagado con su código, su fecha y sin la propina inventada; la prueba, en la misma transacción.
    expect(paid).toMatchObject({ authCode: code, tipCents: 0, availableAmountCents: 10_000, tipGoesTo: null });
    expect(paid.authorizedAt).not.toBeNull();
    const ev = await sys((tx) => tx.paymentEvent.count({ where: { paymentId: paid.id, eventType: 'pos.confirmed' } }));
    expect(ev).toBe(1);
    const e = await sys((tx) => tx.operatorEarning.findFirst({ where: { paymentId: paid.id } }));
    expect(e).toMatchObject({ commissionCents: 9000, tipCents: 0 });
  });

  it('el mismo cobro confirmado dos veces a la vez → una vez', async () => {
    const p = await pos();
    const go = (code: string) => inVenue(A, () => payments.confirmPosPayment(p.id, waiterOf(), { posReceiptRef: code }));
    const out = await Promise.allSettled([go('ZZ1111'), go('ZZ2222')]);
    expect(out.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const ev = await sys((tx) => tx.paymentEvent.count({ where: { paymentId: p.id, eventType: 'pos.confirmed' } }));
    expect(ev).toBe(1);
  });

  it('la red de la base: el mismo código el mismo día en el mismo datáfono no entra', async () => {
    const p1 = await pos();
    const p2 = await pos();
    const mark = (id: string) =>
      sys((tx) => tx.payment.update({ where: { id }, data: { status: 'AUTHORIZED', authCode: 'NET123', authorizedAt: new Date() } }));
    await mark(p1.id);
    await expect(mark(p2.id)).rejects.toMatchObject({ code: 'P2002' });
  });
});

describe('#32 Idempotency-Key (Postgres real)', () => {
  const body = (o: Record<string, unknown> = {}) =>
    ({ amountCents: 3_000, currency: 'EUR', terminalExternalId: `TP-${r}`, ...o }) as never;
  const asChica = () => ({ userId: chica, role: 'OPERATOR' });
  const asOwner = () => ({ userId: owner, role: 'OWNER' });

  it('tres peticiones a la vez con la misma clave → el mismo cobro, ningún 500', async () => {
    const key = `zz-idem-${r}-a`;
    const go = () => inVenue(A, () => payments.create(A, key, body(), asChica()));
    const out = await Promise.allSettled([go(), go(), go()]);
    const ok = out.filter((o) => o.status === 'fulfilled') as Array<PromiseFulfilledResult<{ id: string }>>;
    expect(ok).toHaveLength(3);
    expect(new Set(ok.map((o) => o.value.id)).size).toBe(1);
    const n = await sys((tx) => tx.payment.count({ where: { tenantId: A, idempotencyKey: key } }));
    expect(n).toBe(1);
  });

  it('la misma clave de otra persona u otros datos → 409', async () => {
    const key = `zz-idem-${r}-b`;
    await inVenue(A, () => payments.create(A, key, body(), asChica()));
    await expect(inVenue(A, () => payments.create(A, key, body(), asOwner()))).rejects.toMatchObject({ status: 409 });
    await expect(inVenue(A, () => payments.create(A, key, body({ amountCents: 3_001 }), asChica()))).rejects.toMatchObject({
      status: 409,
    });
  });

  it('recarga que crea saldo, dos a la vez con la misma clave → un cobro y UN saldo', async () => {
    const key = `zz-idem-${r}-c`;
    const before = await sys((tx) => tx.clientWallet.count({ where: { tenantId: A } }));
    const go = () => inVenue(A, () => payments.create(A, key, body({ wallet: { create: true } }), asOwner()));
    const out = await Promise.allSettled([go(), go()]);
    expect(out.every((o) => o.status === 'fulfilled')).toBe(true);
    const after = await sys((tx) => tx.clientWallet.count({ where: { tenantId: A } }));
    expect(after - before).toBe(1);
    const p = await sys((tx) => tx.payment.findFirst({ where: { tenantId: A, idempotencyKey: key } }));
    const w = await sys((tx) => tx.clientWallet.findUnique({ where: { id: p!.walletId! } }));
    expect(w).toMatchObject({ tenantId: A, status: 'ACTIVE', balanceCents: 0, walletGroup: `gp-${r}` });
    expect(w!.shortCode).toMatch(/^[A-Z0-9]{6}$/);
  });
});

describe('#7/#56 recarga cobrada (Postgres real)', () => {
  let n2 = 0;
  const mkWallet = (tenantId: string, o: Record<string, unknown> = {}) => {
    n2 += 1;
    return sys((tx) =>
      tx.clientWallet.create({
        data: { tenantId, qrToken: `zzw-${r}-${n2}`, walletGroup: `gp-${r}`, ...o } as never,
      }),
    );
  };
  const topUpPay = (walletId: string) =>
    payment({ walletId, revenueCategory: 'EXTRA', captureMethod: 'WALLET_TOPUP', provider: 'PAYTEF', providerTxId: `TU-${r}-${walletId.slice(0, 6)}`, amountCents: 5_000, availableAmountCents: 5_000 });
  const authorize = (p: { id: string; providerTxId: string | null }) =>
    inVenue(undefined, () => payments.transition(p.id, { type: 'AUTHORIZED', provider: 'PAYTEF', providerTxId: p.providerTxId! }));

  it('saldo sumado a otro de OTRO local del grupo → la recarga llega al saldo bueno', async () => {
    const B = await sys(async (tx) => (await tx.venue.create({ data: { name: 'Local P2', slug: `p2-${r}`, walletGroup: `gp-${r}` } })).id);
    const target = await mkWallet(B, { balanceCents: 4_000, shortCode: `T${r.slice(0, 5)}`.toUpperCase() });
    const source = await mkWallet(A, { balanceCents: 0, status: 'DEPLETED', mergedIntoId: target.id });
    const p = await topUpPay(source.id);
    await authorize(p);
    const t = await sys((tx) => tx.clientWallet.findUnique({ where: { id: target.id } }));
    expect(t).toMatchObject({ balanceCents: 9_000, status: 'ACTIVE' });
    const s = await sys((tx) => tx.clientWallet.findUnique({ where: { id: source.id } }));
    expect(s).toMatchObject({ balanceCents: 0, status: 'DEPLETED' });
    const a = await sys((tx) => tx.auditEvent.count({ where: { targetId: p.id, action: 'wallet.credit_followed_merge' } }));
    expect(a).toBe(1);
  });

  it('saldo a cero cuyo código tiene ahora otro saldo activo → se reactiva con código nuevo (sin chocar con el índice)', async () => {
    const code = `C${r.slice(0, 5)}`.toUpperCase();
    const old = await mkWallet(A, { balanceCents: 0, status: 'DEPLETED', shortCode: code });
    await mkWallet(A, { balanceCents: 1_000, status: 'ACTIVE', shortCode: code });
    const p = await topUpPay(old.id);
    await authorize(p);
    const w = await sys((tx) => tx.clientWallet.findUnique({ where: { id: old.id } }));
    expect(w).toMatchObject({ balanceCents: 5_000, status: 'ACTIVE' });
    expect(w!.shortCode).not.toBe(code);
    expect(w!.shortCode).toMatch(/^[A-Z0-9]{6}$/);
  });

  it('saldo devuelto → cobro AUTHORIZED, saldo intacto e incidencia explícita', async () => {
    const w = await mkWallet(A, { balanceCents: 0, status: 'REFUNDED' });
    const p = await topUpPay(w.id);
    await authorize(p);
    const after = await sys((tx) => tx.payment.findUnique({ where: { id: p.id } }));
    expect(after!.status).toBe('AUTHORIZED');
    expect((await sys((tx) => tx.clientWallet.findUnique({ where: { id: w.id } })))!.balanceCents).toBe(0);
    const audit = await sys((tx) => tx.auditEvent.findFirst({ where: { targetId: p.id, action: 'wallet.credit_skipped_critical' } }));
    expect(audit!.payload).toMatchObject({ amountCents: 5_000, paymentId: p.id, walletStatus: 'REFUNDED', cause: 'closed' });
  });
});

describe('#54 % de la chica fijado al crear (Postgres real)', () => {
  it('el dueño baja el % mientras el cliente paga → la comisión usa el de cuando se creó', async () => {
    const created = await inVenue(A, () =>
      payments.create(A, `zz-com-${r}`, { amountCents: 10_000, currency: 'EUR', terminalExternalId: `TP-${r}` } as never, {
        userId: chica,
        role: 'OPERATOR',
      }),
    );
    const row = await sys((tx) => tx.payment.findUnique({ where: { id: created.id } }));
    expect(row!.operatorCommissionBps).toBe(9000);
    await sys((tx) => tx.user.update({ where: { id: chica }, data: { commissionBps: 5000 } }));
    await sys((tx) =>
      tx.payment.update({ where: { id: created.id }, data: { status: 'AUTHORIZING', provider: 'PAYTEF', providerTxId: `CM-${r}` } }),
    );
    await inVenue(undefined, () => payments.transition(created.id, { type: 'AUTHORIZED', provider: 'PAYTEF', providerTxId: `CM-${r}` }));
    const e = await sys((tx) => tx.operatorEarning.findFirst({ where: { paymentId: created.id } }));
    expect(e).toMatchObject({ commissionBps: 9000, commissionCents: 9000 });
    await sys((tx) => tx.user.update({ where: { id: chica }, data: { commissionBps: 9000 } }));
  });
});
