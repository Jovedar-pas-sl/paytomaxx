import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConflictException, ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import { CashTopUpSchema, MAX_CASH_TOP_UP_CENTS } from '@nightpay/contracts';
import { Prisma } from '@nightpay/db';
import { CashTopUpService } from './wallet-cash-topup.service';

/**
 * Recarga del saldo en efectivo (recepción): suma al momento, queda apuntada
 * con quién la cobró (persona o datáfono), no carga dos veces con la misma
 * clave y la guardan las formas de cobro, la pausa y el permiso. Base en
 * memoria con rollback, como la transacción de verdad.
 */

type Row = Record<string, unknown>;

const NOW = new Date('2026-10-21T01:30:00+02:00');
const SALA = '3f2b8c1e-6a4d-4f7e-9b21-5c8d0e1f2a01';
const NORTE = '3f2b8c1e-6a4d-4f7e-9b21-5c8d0e1f2a02'; // mismo grupo
const NEON = '8a7b6c5d-4e3f-4a2b-8c1d-0e9f8a7b6c03'; // otro dueño
const JAVI = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d03'; // encargado
const PACO = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d04'; // camarero
const WALLET = 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70';
const FICHA = 'q3VbX9kLmN2pR7sT4wYz1A';

const javi = { userId: JAVI, role: 'MANAGER' };
const paco = { userId: PACO, role: 'WAITER' };
const recepcion = { terminalId: 'term-recepcion' };

function setup(o: { venue?: Row; wallet?: Row | null } = {}) {
  const venues = new Map<string, Row>([
    [SALA, { id: SALA, walletGroup: 'grupo-bambu', pausedAt: null, business: null, paymentMethods: null, staffPermissions: null, ...o.venue }],
    [NORTE, { id: NORTE, walletGroup: 'grupo-bambu', pausedAt: null, business: null, paymentMethods: null, staffPermissions: null }],
    [NEON, { id: NEON, walletGroup: 'grupo-neon', pausedAt: null, business: null, paymentMethods: null, staffPermissions: null }],
  ]);
  const wallets = new Map<string, Row>();
  const topUps = new Map<string, Row>();
  const cards = new Map<string, Row>();
  if (o.wallet !== null) {
    wallets.set(WALLET, {
      id: WALLET, tenantId: SALA, walletGroup: 'grupo-bambu', shortCode: 'K7Q4M2', balanceCents: 2_000,
      status: 'ACTIVE', mergedIntoId: null, blockedAt: null, pinHash: null, closeRequestedAt: null, ...o.wallet,
    });
  }
  cards.set(FICHA, { id: 'card-1', token: FICHA, uid: '04A23B5C1D8000', walletId: WALLET, status: 'ISSUED' });
  let seq = 0;
  const $queryRaw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    if (text.includes('INSERT INTO client_wallets')) {
      const id = `w-nuevo-${(seq += 1)}`;
      wallets.set(id, {
        id, tenantId: values[0], identifier: values[1], shortCode: values[3], walletGroup: values[4], balanceCents: 0,
        status: 'ACTIVE', mergedIntoId: null, blockedAt: null, pinHash: null, closeRequestedAt: null,
      });
      return [{ id }];
    }
    if (text.includes('FOR UPDATE')) {
      const w = wallets.get(String(values[0]));
      return w ? [{ ...w }] : [];
    }
    return []; // código libre al reabrir
  });
  const tx = {
    $queryRaw,
    venue: { findUnique: vi.fn(async (a: { where: { id: string } }) => venues.get(a.where.id) ?? null) },
    clientWallet: {
      findUnique: vi.fn(async (a: { where: { id: string } }) => (wallets.get(a.where.id) ? { ...wallets.get(a.where.id) } : null)),
      findFirst: vi.fn(async (a: { where: { shortCode: string } }) => [...wallets.values()].find((w) => w.shortCode === a.where.shortCode && w.status === 'ACTIVE') ?? null),
      update: vi.fn(async (a: { where: { id: string }; data: Row }) => {
        const w = wallets.get(a.where.id)!;
        const inc = (a.data.balanceCents as { increment: number }).increment;
        const next = { ...w, ...a.data, balanceCents: Number(w.balanceCents) + inc };
        wallets.set(a.where.id, next);
        return next;
      }),
    },
    walletCard: { findUnique: vi.fn(async (a: { where: { token: string } }) => cards.get(a.where.token) ?? null) },
    walletCashTopUp: {
      findUnique: vi.fn(async (a: { where: { tenantId_idempotencyKey: { tenantId: string; idempotencyKey: string } } }) => {
        const k = a.where.tenantId_idempotencyKey;
        return [...topUps.values()].find((t) => t.tenantId === k.tenantId && t.idempotencyKey === k.idempotencyKey) ?? null;
      }),
      create: vi.fn(async (a: { data: Row }) => {
        const clash = [...topUps.values()].some((t) => t.tenantId === a.data.tenantId && t.idempotencyKey === a.data.idempotencyKey);
        if (clash) {
          throw new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'x', meta: { target: ['tenantId', 'idempotencyKey'] } });
        }
        const row = { id: `ct-${topUps.size + 1}`, createdAt: new Date(), ...a.data };
        topUps.set(String(row.id), row);
        return row;
      }),
    },
  };
  const run = async (fn: (t: typeof tx) => unknown) => {
    const snap = [new Map(wallets), new Map(topUps)];
    try {
      return await fn(tx);
    } catch (err) {
      wallets.clear();
      snap[0]!.forEach((v, k) => wallets.set(k, v));
      topUps.clear();
      snap[1]!.forEach((v, k) => topUps.set(k, v));
      throw err;
    }
  };
  const prisma = { venue: tx.venue, asSystem: vi.fn(run), acrossVenues: vi.fn(run) };
  const audit = { log: vi.fn(async (_e: Record<string, unknown>) => undefined) };
  const svc = new CashTopUpService(prisma as never, audit as never);
  return { svc, wallets, topUps, audit, venues };
}

const nueva = (amountCents: number, key = 'clave-nueva-0001') => ({ amountCents, idempotencyKey: key, wallet: { create: true as const } });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('recarga en efectivo', () => {
  it('saldo nuevo: se crea con su código, se suma al momento y queda quién la cobró', async () => {
    const { svc, wallets, topUps, audit } = setup({ wallet: null });
    const out = await svc.topUp(SALA, javi, { ...nueva(5_000), wallet: { create: true, identifier: 'Pulsera azul' } });
    expect(out).toMatchObject({ amountCents: 5_000, balanceCents: 5_000, createdWallet: true, replayed: false });
    expect(out.code).toMatch(/^[A-Z0-9]{3}-[A-Z0-9]{3}$/);
    expect(wallets.get(out.walletId)).toMatchObject({ tenantId: SALA, walletGroup: 'grupo-bambu', identifier: 'Pulsera azul', balanceCents: 5_000 });
    expect([...topUps.values()]).toEqual([
      expect.objectContaining({ tenantId: SALA, walletId: out.walletId, amountCents: 5_000, takenByUserId: JAVI, terminalId: null }),
    ]);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'wallet.cash_topup', tenantId: SALA, actorId: JAVI, targetId: out.walletId }),
    );
  });

  it('por su ficha: un saldo ya gastado (a 0) se reabre y un «Me voy» pendiente ya no vale', async () => {
    const { svc, wallets } = setup({ wallet: { balanceCents: 0, status: 'DEPLETED', closeRequestedAt: NOW } });
    const out = await svc.topUp(SALA, javi, { amountCents: 3_000, idempotencyKey: 'clave-ficha-0001', wallet: { card: FICHA, uid: '04:a2:3b:5c:1d:80:00' } });
    expect(out).toMatchObject({ walletId: WALLET, code: 'K7Q-4M2', balanceCents: 3_000, createdWallet: false });
    expect(wallets.get(WALLET)).toMatchObject({ status: 'ACTIVE', balanceCents: 3_000, closeRequestedAt: null });
  });

  it('en otro local del grupo vale (el efectivo entra en la caja de ese local); en el de otro dueño, no', async () => {
    const { svc, topUps } = setup();
    await expect(svc.topUp(NORTE, javi, { amountCents: 1_000, idempotencyKey: 'clave-norte-0001', wallet: { code: 'k7q-4m2' } })).resolves.toMatchObject({
      walletId: WALLET, balanceCents: 3_000,
    });
    expect([...topUps.values()][0]).toMatchObject({ tenantId: NORTE });
    await expect(svc.topUp(NEON, javi, { amountCents: 1_000, idempotencyKey: 'clave-neon-00001', wallet: { code: 'K7Q4M2' } })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('el mismo botón dos veces (misma clave): no carga dos veces; la clave con otro importe → 409', async () => {
    const { svc, wallets, topUps } = setup();
    const ref = { amountCents: 2_500, idempotencyKey: 'clave-repetida-01', wallet: { code: 'K7Q4M2' } };
    const first = await svc.topUp(SALA, javi, ref);
    const again = await svc.topUp(SALA, javi, ref);
    expect(again).toMatchObject({ topUpId: first.topUpId, replayed: true, balanceCents: 4_500 });
    expect(wallets.get(WALLET)).toMatchObject({ balanceCents: 4_500 });
    expect(topUps.size).toBe(1);
    await expect(svc.topUp(SALA, javi, { ...ref, amountCents: 9_000 })).rejects.toBeInstanceOf(ConflictException);
    // Otra persona con la misma clave tampoco la reutiliza.
    await expect(svc.topUp(SALA, { userId: PACO, role: 'OWNER' }, ref)).rejects.toBeInstanceOf(ConflictException);
  });

  it('saldo cerrado (devuelto), bloqueado por el super-admin o ficha copiada: no se recarga y no se apunta nada', async () => {
    const cerrado = setup({ wallet: { status: 'REFUNDED', balanceCents: 0 } });
    await expect(cerrado.svc.topUp(SALA, javi, { amountCents: 1_000, idempotencyKey: 'clave-cerrado-1', wallet: { card: FICHA } })).rejects.toBeInstanceOf(
      ConflictException,
    );
    const bloqueado = setup({ wallet: { blockedAt: NOW } });
    await expect(bloqueado.svc.topUp(SALA, javi, { amountCents: 1_000, idempotencyKey: 'clave-bloque-01', wallet: { code: 'K7Q4M2' } })).rejects.toThrow(
      /bloqueado/,
    );
    const copiada = setup();
    await expect(copiada.svc.topUp(SALA, javi, { amountCents: 1_000, idempotencyKey: 'clave-copia-001', wallet: { card: FICHA, uid: '04FFFFFFFFFF01' } })).rejects.toThrow(
      /copiada/,
    );
    expect([cerrado.topUps.size, bloqueado.topUps.size, copiada.topUps.size]).toEqual([0, 0, 0]);
  });

  it('como mucho 999,99 € en efectivo (ley española): ni el API ni el esquema lo dejan pasar', async () => {
    const { svc, topUps } = setup();
    await expect(svc.topUp(SALA, javi, nueva(MAX_CASH_TOP_UP_CENTS + 1))).rejects.toThrow(/999,99/);
    expect(CashTopUpSchema.safeParse(nueva(100_000)).success).toBe(false);
    expect(CashTopUpSchema.safeParse(nueva(MAX_CASH_TOP_UP_CENTS)).success).toBe(true);
    expect(topUps.size).toBe(0);
  });
});

describe('quién puede cobrar efectivo', () => {
  it('el camarero, solo si el dueño se lo da (por defecto no): 403 STAFF_PERMISSION_DENIED', async () => {
    const { svc } = setup();
    const err = await svc.topUp(SALA, paco, nueva(1_000)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as HttpException).getResponse()).toMatchObject({ code: 'STAFF_PERMISSION_DENIED', permission: 'cashTopUp' });
    const given = setup({ venue: { staffPermissions: { roles: { WAITER: { cashTopUp: true } } } } });
    await expect(given.svc.topUp(SALA, paco, nueva(1_000))).resolves.toMatchObject({ balanceCents: 1_000 });
  });

  it('el encargado sin el permiso (se lo quitó el dueño): 403', async () => {
    const { svc } = setup({ venue: { staffPermissions: { people: { [JAVI]: { cashTopUp: false } } } } });
    await expect(svc.topUp(SALA, javi, nueva(1_000))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('el datáfono de recepción, con el permiso de los datáfonos: queda su terminalId (no hay persona)', async () => {
    const off = setup();
    await expect(off.svc.topUp(SALA, recepcion, nueva(1_000))).rejects.toThrow(/Permisos → Datáfonos/);
    await expect(off.svc.cashBlockedReason(SALA, recepcion)).resolves.toMatch(/datáfono/);
    const on = setup({ venue: { staffPermissions: { roles: { DEVICE: { cashTopUp: true } } } } });
    await expect(on.svc.cashBlockedReason(SALA, recepcion)).resolves.toBeNull();
    const out = await on.svc.topUp(SALA, recepcion, nueva(1_000));
    expect([...on.topUps.values()][0]).toMatchObject({ takenByUserId: null, terminalId: 'term-recepcion' });
    expect(on.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'wallet.cash_topup', actorId: null, payload: expect.objectContaining({ terminalId: 'term-recepcion' }) }),
    );
    expect(out.balanceCents).toBe(1_000);
  });

  it('formas de cobro: «Recarga en efectivo» o «Saldo» apagados → 409; local en pausa → 423', async () => {
    const sinEfectivo = setup({ venue: { paymentMethods: { cashTopUp: false } } });
    await expect(sinEfectivo.svc.topUp(SALA, javi, nueva(1_000))).rejects.toThrow(/recargas en efectivo/);
    const sinSaldo = setup({ venue: { paymentMethods: { wallet: false } } });
    await expect(sinSaldo.svc.topUp(SALA, javi, nueva(1_000))).rejects.toMatchObject({ status: 409 });
    const pausa = setup({ venue: { pausedAt: NOW } });
    await expect(pausa.svc.topUp(SALA, javi, nueva(1_000))).rejects.toMatchObject({ status: 423 });
    expect(sinEfectivo.topUps.size + sinSaldo.topUps.size + pausa.topUps.size).toBe(0);
  });
});
