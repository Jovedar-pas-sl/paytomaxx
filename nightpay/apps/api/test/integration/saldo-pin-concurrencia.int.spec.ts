// Integración (Postgres real): PIN del saldo y cobros del saldo con varias
// peticiones a la vez (candado FOR UPDATE del saldo). Ver README.md.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { UnprocessableEntityException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { WalletChargesService } from '../../src/modules/wallets/wallet-charges.service';
import { PIN_MAX_FAILS } from '../../src/modules/wallets/wallet-pin';

const cls = new ClsService(new AsyncLocalStorage());

const prisma = new PrismaService(cls as never);
const audit = { log: vi.fn(async (_entry: { action: string; targetId?: string }) => undefined) };
const charges = new WalletChargesService(prisma as never, audit as never, { get: () => ({}) } as never);

const inVenue = <T>(tenantId: string | undefined, fn: () => Promise<T>): Promise<T> =>
  cls.run(async () => {
    cls.set('ctx', { tenantId, traceId: 't' });
    return fn();
  });
const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) =>
  inVenue(undefined, () => prisma.asSystem(fn));

const r = randomUUID().slice(0, 6);
let V: string;
let lola: string;
let n = 0;

const chica = () => ({ userId: lola, role: 'OPERATOR' as const, tenantId: V });

/** Saldo con PIN 4827 elegido por el cliente; devuelve id y código corto. */
async function walletWithPin(balanceCents: number): Promise<{ id: string; code: string }> {
  n += 1;
  const code = `P${n}${r}`.toUpperCase().slice(0, 6);
  const id = await sys(
    async (tx) =>
      (
        await tx.clientWallet.create({
          data: { tenantId: V, balanceCents, qrToken: `pc-${n}-${r}`, shortCode: code, walletGroup: `gpc-${r}` },
        })
      ).id,
  );
  await inVenue(undefined, () => charges.setPinFromPayer(id, '4827'));
  return { id, code };
}

const qr = (amountCents: number) => inVenue(V, () => charges.createQrCharge(chica(), { amountCents }));
const payWithPin = (requestId: string, code: string, pin: string) =>
  inVenue(V, () => charges.payQrChargeWithPin(chica(), requestId, { code, pin }));
const walletRow = (id: string) => sys((tx) => tx.clientWallet.findUniqueOrThrow({ where: { id } }));

beforeAll(async () => {
  await prisma.onModuleInit();
  await sys(async (tx) => {
    V = (await tx.venue.create({ data: { name: 'Sala Bambú (Madrid)', slug: `pc-${r}`, walletGroup: `gpc-${r}` } })).id;
    lola = (
      await tx.user.create({
        data: { tenantId: V, email: `lola-${r}@x.es`, passwordHash: 'x', role: 'OPERATOR', commissionBps: 9000, displayName: 'Lola' },
      })
    ).id;
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('PIN del saldo a la vez (Postgres real)', () => {
  it('diez PIN malos a la vez: cuentan uno a uno, se bloquea al quinto y el resto ni se compara', async () => {
    const w = await walletWithPin(5_000);
    const c = await qr(500);
    audit.log.mockClear();

    const out = await Promise.allSettled(Array.from({ length: 10 }, () => payWithPin(c.id, w.code, '0101')));

    const reasons = out.map((o) => (o.status === 'rejected' ? (o.reason as Error) : null));
    expect(reasons.every((e) => e instanceof UnprocessableEntityException)).toBe(true);
    const messages = reasons.map((e) => e!.message);
    // Cuatro avisos con los intentos que quedan, uno que bloquea y cinco que ya lo encuentran bloqueado.
    expect(messages.filter((m) => /Queda/.test(m))).toHaveLength(PIN_MAX_FAILS - 1);
    expect(messages.filter((m) => /^PIN incorrecto\. Saldo bloqueado/.test(m))).toHaveLength(1);
    expect(messages.filter((m) => /^Saldo bloqueado por PIN/.test(m))).toHaveLength(10 - PIN_MAX_FAILS);

    const row = await walletRow(w.id);
    expect(row.pinFails).toBe(PIN_MAX_FAILS);
    expect(row.pinLockedAt).not.toBeNull();
    expect(row.balanceCents).toBe(5_000);
    // Cada fallo real queda en el registro (quién lo tecleó); los de después del bloqueo, no.
    const actions = audit.log.mock.calls.map(([e]) => e.action).filter((a) => a.startsWith('wallet.pin_'));
    expect(actions.sort()).toEqual([...Array(PIN_MAX_FAILS - 1).fill('wallet.pin_failed'), 'wallet.pin_locked'].sort());

    // Ni con el PIN bueno mientras dure el bloqueo.
    await expect(payWithPin(c.id, w.code, '4827')).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect((await walletRow(w.id)).balanceCents).toBe(5_000);
  });

  it('dos cobros distintos con el mismo saldo a la vez y solo llega para uno: se cobra uno y el saldo no queda en negativo', async () => {
    const w = await walletWithPin(5_000);
    const [c1, c2] = [await qr(4_000), await qr(4_000)];

    const out = await Promise.allSettled([payWithPin(c1.id, w.code, '4827'), payWithPin(c2.id, w.code, '4827')]);

    expect(out.map((o) => o.status).sort()).toEqual(['fulfilled', 'rejected']);
    const ok = out.find((o) => o.status === 'fulfilled') as PromiseFulfilledResult<{ status: string; newBalanceCents: number }>;
    expect(ok.value).toMatchObject({ status: 'ACCEPTED', newBalanceCents: 1_000 });
    expect((await walletRow(w.id)).balanceCents).toBe(1_000);
    const consumptions = await sys((tx) => tx.walletConsumption.findMany({ where: { walletId: w.id }, select: { amountCents: true } }));
    expect(consumptions).toEqual([{ amountCents: 4_000 }]);
    // El PIN era el bueno: no cuenta como fallo.
    expect((await walletRow(w.id)).pinFails).toBe(0);
  });
});
