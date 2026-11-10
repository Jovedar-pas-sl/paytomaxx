import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConflictException, ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import { CashTopUpSchema, MAX_CASH_TOP_UP_CENTS } from '@nightpay/contracts';
import { Prisma } from '@nightpay/db';
import { CashTopUpService } from './wallet-cash-topup.service';
import { cashIntentFingerprint, isPrintedIntent } from './wallet-cash-intent';

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

function setup(o: { venue?: Row; wallet?: Row | null; pacoPost?: string | null } = {}) {
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
    if (text.includes('wallet_cash_topups') && text.includes('FOR UPDATE')) {
      // La recarga que se anula, de este local y sin ser ella una anulación.
      const t = topUps.get(String(values[0]));
      return t && t.tenantId === values[1] && !t.voidOfId ? [{ ...t }] : [];
    }
    if (text.includes('wallet_cash_topups')) {
      const net = (t: Row) => Number(t.amountCents);
      if (text.includes('"createdWallet"')) {
        // Aviso de saldos nuevos seguidos: las de esa persona o datáfono que abrieron saldo.
        // La persona o el datáfono van en un trozo de SQL (Prisma.sql) con su id.
        const last = values[values.length - 1] as { values?: unknown[] };
        const who = last?.values?.[0] ?? last;
        const rows = [...topUps.values()].filter(
          (t) => t.createdWallet && !t.voidOfId && (t.takenByUserId === who || t.terminalId === who),
        );
        const voided = (t: Row) => [...topUps.values()].filter((v) => v.voidOfId === t.id).reduce((a, v) => a + net(v), 0);
        return [{ count: rows.length, totalCents: BigInt(rows.reduce((a, t) => a + net(t) + voided(t), 0)) }];
      }
      // El efectivo del saldo y de los sumados a él.
      const ids = new Set([String(values[0]), ...[...wallets.values()].filter((w) => w.mergedIntoId === values[0]).map((w) => String(w.id))]);
      const mine = [...topUps.values()].filter((t) => ids.has(String(t.walletId)));
      const sum = mine.reduce((a, t) => a + net(t), 0);
      // Lo que pagó el cliente en efectivo (con la comisión del servicio): el tope legal.
      const paid = mine.reduce((a, t) => a + net(t) + Number(t.serviceFeeCents ?? 0), 0);
      return [{ inCents: BigInt(sum), inWindowCents: BigInt(sum), inWindowPaidCents: BigInt(paid), outCents: 0n, outWindowCents: 0n }];
    }
    if (text.includes('SELECT "mergedIntoId"')) {
      const w = wallets.get(String(values[0]));
      return w ? [{ mergedIntoId: w.mergedIntoId }] : [];
    }
    if (text.includes('SELECT "blockedAt"')) {
      const w = wallets.get(String(values[0]));
      return w ? [{ blockedAt: w.blockedAt }] : [];
    }
    if (text.includes('FOR UPDATE')) {
      const w = wallets.get(String(values[0]));
      return w ? [{ ...w }] : [];
    }
    return []; // código libre al reabrir
  });
  // El puesto de cada persona: Paco, el camarero (Barra si no se dice otro).
  const posts = new Map<string, string | null>([[PACO, o.pacoPost ?? null]]);
  const tx = {
    $queryRaw,
    venue: { findUnique: vi.fn(async (a: { where: { id: string } }) => venues.get(a.where.id) ?? null) },
    user: { findFirst: vi.fn(async (a: { where: { id: string } }) => ({ post: posts.get(a.where.id) ?? null })) },
    clientWallet: {
      findUnique: vi.fn(async (a: { where: { id: string } }) => (wallets.get(a.where.id) ? { ...wallets.get(a.where.id) } : null)),
      findFirst: vi.fn(async (a: { where: { shortCode: string } }) => [...wallets.values()].find((w) => w.shortCode === a.where.shortCode && w.status === 'ACTIVE') ?? null),
      update: vi.fn(async (a: { where: { id: string }; data: Row }) => {
        const w = wallets.get(a.where.id)!;
        const b = a.data.balanceCents as number | { increment: number };
        const next = { ...w, ...a.data, balanceCents: typeof b === 'number' ? b : Number(w.balanceCents) + b.increment };
        wallets.set(a.where.id, next);
        return next;
      }),
    },
    walletCard: {
      findUnique: vi.fn(async (a: { where: { token?: string; id?: string } }) =>
        (a.where.id ? [...cards.values()].find((c) => c.id === a.where.id) : cards.get(String(a.where.token))) ?? null),
    },
    walletCashTopUp: {
      findUnique: vi.fn(async (a: { where: { id?: string; tenantId_idempotencyKey?: { tenantId: string; idempotencyKey: string }; voidOfId?: string } }) => {
        if (a.where.id) return topUps.get(a.where.id) ?? null;
        if (a.where.voidOfId) return [...topUps.values()].find((t) => t.voidOfId === a.where.voidOfId) ?? null;
        const k = a.where.tenantId_idempotencyKey!;
        return [...topUps.values()].find((t) => t.tenantId === k.tenantId && t.idempotencyKey === k.idempotencyKey) ?? null;
      }),
      findMany: vi.fn(async () => []),
      create: vi.fn(async (a: { data: Row }) => {
        const clash =
          [...topUps.values()].some((t) => t.tenantId === a.data.tenantId && t.idempotencyKey === a.data.idempotencyKey) ||
          (a.data.voidOfId !== undefined && [...topUps.values()].some((t) => t.voidOfId === a.data.voidOfId));
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
  const prisma = { venue: tx.venue, asSystem: vi.fn(run), acrossVenues: vi.fn(run), withTenant: vi.fn(async (_t: string, fn: (t: typeof tx) => unknown) => run(fn)) };
  const audit = { log: vi.fn(async (_e: Record<string, unknown>) => undefined) };
  const totp = { isEnabled: vi.fn(async () => true), assertForUser: vi.fn(async () => undefined) };
  const svc = new CashTopUpService(prisma as never, audit as never, totp as never);
  return { svc, wallets, topUps, audit, venues, totp, prisma, tx };
}

const nueva = (amountCents: number, key = 'clave-nueva-0001') => ({ amountCents, idempotencyKey: key, wallet: { create: true as const } });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('recarga en efectivo', () => {
  describe('la misma clave guarda lo que se pidió (destino, saldo nuevo o no, importe)', () => {
    const pedida = { amountCents: 500, idempotencyKey: 'intent-0000001', wallet: { code: 'K7Q4M2' } as const };

    it('otro destino con la clave → 409, aunque sea la ficha del mismo saldo o un saldo nuevo; nada se carga', async () => {
      const { svc, wallets, topUps } = setup();
      await svc.topUp(SALA, javi, pedida);
      for (const wallet of [{ create: true as const }, { code: 'OTR123' }, { card: FICHA }]) {
        await expect(svc.topUp(SALA, javi, { ...pedida, wallet })).rejects.toBeInstanceOf(ConflictException);
      }
      await expect(svc.topUp(SALA, javi, { ...pedida, amountCents: 501 })).rejects.toBeInstanceOf(ConflictException);
      expect(topUps.size).toBe(1);
      expect(wallets.get(WALLET)).toMatchObject({ balanceCents: 2_500 });
    });

    it('la huella guarda destino e importe, no el saldo resuelto: el código escrito de otra forma es el mismo', async () => {
      const { svc, topUps } = setup();
      await svc.topUp(SALA, javi, pedida);
      expect([...topUps.values()][0]).toMatchObject({ intentFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
      await expect(svc.topUp(SALA, javi, { ...pedida, wallet: { code: 'k7q-4m2' } })).resolves.toMatchObject({ replayed: true });
    });

    it('el reintento idéntico devuelve el recibo de entonces, aunque el saldo haya seguido moviéndose', async () => {
      const { svc, wallets } = setup();
      const first = await svc.topUp(SALA, javi, pedida);
      expect(first).toMatchObject({ code: 'K7Q-4M2', balanceCents: 2_500, replayed: false });
      wallets.set(WALLET, { ...wallets.get(WALLET), balanceCents: 900 });
      await expect(svc.topUp(SALA, javi, pedida)).resolves.toEqual({ ...first, replayed: true });
    });

    it('saldo nuevo: repetirlo no crea otro; la etiqueta no cambia el destino, una ficha sí', async () => {
      const { svc, wallets, topUps } = setup({ wallet: null });
      const nuevo = { amountCents: 700, idempotencyKey: 'intent-nuevo-01', wallet: { create: true as const, identifier: 'Pulsera azul' } };
      const first = await svc.topUp(SALA, javi, nuevo);
      await expect(svc.topUp(SALA, javi, { ...nuevo, wallet: { create: true, identifier: 'Pulsera roja' } })).resolves.toEqual({ ...first, replayed: true });
      await expect(svc.topUp(SALA, javi, { ...nuevo, wallet: { card: FICHA } })).rejects.toBeInstanceOf(ConflictException);
      expect(topUps.size).toBe(1);
      expect(wallets.size).toBe(1);
    });

    it('la ficha leída otra vez con otro UID repite la misma recarga (el destino es la ficha)', async () => {
      const { svc, topUps } = setup();
      const ficha = { amountCents: 400, idempotencyKey: 'intent-ficha-01', wallet: { card: FICHA, uid: '04:a2:3b:5c:1d:80:00' } };
      const first = await svc.topUp(SALA, javi, ficha);
      await expect(svc.topUp(SALA, javi, { ...ficha, wallet: { card: FICHA } })).resolves.toEqual({ ...first, replayed: true });
      expect(topUps.size).toBe(1);
    });

    it('S-4: la ficha nueva ya cargada, leída otra vez (ahora con saldo) con la misma clave: el mismo recibo, nada se carga', async () => {
      const { svc, topUps, wallets } = setup();
      const nueva = { amountCents: 5_000, idempotencyKey: 'intent-nueva-01', wallet: { create: true as const, card: FICHA } };
      // La recarga que creó el saldo con esta ficha (la pantalla falló después).
      topUps.set('ct-1', {
        id: 'ct-1', tenantId: SALA, idempotencyKey: nueva.idempotencyKey, walletId: WALLET, amountCents: 5_000, createdWallet: true,
        takenByUserId: JAVI, terminalId: null, intentFingerprint: cashIntentFingerprint(nueva), receipt: null, serviceFeeCents: 0,
      });
      await expect(svc.topUp(SALA, javi, { ...nueva, wallet: { card: FICHA } })).resolves.toMatchObject({ topUpId: 'ct-1', walletId: WALLET, replayed: true });
      expect(topUps.size).toBe(1);
      expect(wallets.get(WALLET)).toMatchObject({ balanceCents: 2_000 });
      // Otra ficha, otro importe o un código con esa clave: 409, como siempre.
      for (const retry of [{ ...nueva, wallet: { card: 'Zz9yX8wV7uT6sR5qP4oN3m' } }, { ...nueva, amountCents: 5_001, wallet: { card: FICHA } }, { ...nueva, wallet: { code: 'K7Q4M2' } }]) {
        await expect(svc.topUp(SALA, javi, retry)).rejects.toBeInstanceOf(ConflictException);
      }
      // Si aquella no creó el saldo (fue a un saldo que ya había), no vale.
      topUps.set('ct-1', { ...topUps.get('ct-1')!, createdWallet: false });
      await expect(svc.topUp(SALA, javi, { ...nueva, wallet: { card: FICHA } })).rejects.toBeInstanceOf(ConflictException);
    });

    it('la otra petición ganó la carrera (choque de único aunque Prisma no diga qué índice): devuelve su recibo', async () => {
      const { svc, tx, topUps, wallets } = setup();
      const first = await svc.topUp(SALA, javi, pedida);
      tx.walletCashTopUp.findUnique.mockResolvedValueOnce(null);
      tx.walletCashTopUp.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the (not available)', {
          code: 'P2002',
          clientVersion: 'x',
          meta: { target: '(not available)' },
        }),
      );
      await expect(svc.topUp(SALA, javi, pedida)).resolves.toEqual({ ...first, replayed: true });
      expect(topUps.size).toBe(1);
      expect(wallets.get(WALLET)).toMatchObject({ balanceCents: 2_500 });
    });

    it('un choque de único que no es de esta clave sigue siendo un error', async () => {
      const { svc, tx } = setup();
      const clash = new Prisma.PrismaClientKnownRequestError('otro único', { code: 'P2002', clientVersion: 'x', meta: { target: ['voidOfId'] } });
      tx.walletCashTopUp.create.mockRejectedValueOnce(clash);
      await expect(svc.topUp(SALA, javi, pedida)).rejects.toBe(clash);
    });

    it('el saldo se sumó a otro después: el reintento sigue valiendo y da el recibo de entonces', async () => {
      const { svc, wallets } = setup();
      const first = await svc.topUp(SALA, javi, pedida);
      wallets.set('merged-target', { ...wallets.get(WALLET), id: 'merged-target', shortCode: 'NEW123', balanceCents: 9_000 });
      wallets.set(WALLET, { ...wallets.get(WALLET), mergedIntoId: 'merged-target', status: 'DEPLETED', balanceCents: 0 });
      await expect(svc.topUp(SALA, javi, pedida)).resolves.toEqual({ ...first, replayed: true });
    });

    it('filas anteriores (sin huella ni recibo): solo el mismo saldo o su cadena, y un nuevo solo con otro nuevo', async () => {
      const { svc, wallets, topUps } = setup();
      const first = await svc.topUp(SALA, javi, pedida);
      const stored = [...topUps.values()][0]!;
      stored.intentFingerprint = null;
      stored.receipt = null;
      wallets.set('merged-target', { ...wallets.get(WALLET), id: 'merged-target', shortCode: 'NEW123', balanceCents: 9_000 });
      wallets.set(WALLET, { ...wallets.get(WALLET), mergedIntoId: 'merged-target', status: 'DEPLETED', balanceCents: 0 });
      // Por el código de entonces, por el del saldo al que se sumó o por su ficha: es la misma.
      for (const wallet of [{ code: 'K7Q4M2' }, { code: 'NEW123' }, { card: FICHA }]) {
        await expect(svc.topUp(SALA, javi, { ...pedida, wallet })).resolves.toMatchObject({
          topUpId: first.topUpId, replayed: true, createdWallet: false, code: 'K7Q-4M2', balanceCents: 0,
        });
      }
      wallets.set('other-wallet', { ...wallets.get('merged-target'), id: 'other-wallet', shortCode: 'OTR123' });
      await expect(svc.topUp(SALA, javi, { ...pedida, wallet: { code: 'OTR123' } })).rejects.toBeInstanceOf(ConflictException);
      await expect(svc.topUp(SALA, javi, { ...pedida, wallet: { create: true } })).rejects.toBeInstanceOf(ConflictException);
      await expect(svc.topUp(SALA, javi, { ...pedida, wallet: { code: 'ZZZ999' } })).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('por el número impreso de la ficha (FichaNumbersService)', () => {
    const porNumero = { amountCents: 600, idempotencyKey: 'intent-numero-01', wallet: { printed: { cardId: 'card-1' } } };

    it('va al saldo de esa ficha con su huella marcada «printed»; repetirla da el mismo recibo; otro destino con la clave, 409', async () => {
      const { svc, topUps, wallets } = setup();
      const first = await svc.topUp(SALA, javi, porNumero);
      expect(first).toMatchObject({ walletId: WALLET, balanceCents: 2_600, replayed: false });
      const row = [...topUps.values()][0]!;
      expect(row.intentFingerprint).toMatch(/^printed:[a-f0-9]{64}$/);
      expect(isPrintedIntent(row.intentFingerprint as string)).toBe(true);
      expect(row.intentFingerprint).toBe(cashIntentFingerprint(porNumero));
      await expect(svc.topUp(SALA, javi, porNumero)).resolves.toEqual({ ...first, replayed: true });
      // Con la misma clave por la ficha acercada o el código (que sí enseñan el código entero): 409.
      for (const wallet of [{ card: FICHA }, { code: 'K7Q4M2' }, { create: true as const }]) {
        await expect(svc.topUp(SALA, javi, { ...porNumero, wallet })).rejects.toBeInstanceOf(ConflictException);
      }
      expect(wallets.get(WALLET)).toMatchObject({ balanceCents: 2_600 });
    });

    it('una fila antigua (sin huella) nunca casa con una por número', async () => {
      const { svc, topUps } = setup();
      await svc.topUp(SALA, javi, { ...porNumero, wallet: { code: 'K7Q4M2' } });
      const stored = [...topUps.values()][0]!;
      stored.intentFingerprint = null;
      stored.receipt = null;
      await expect(svc.topUp(SALA, javi, porNumero)).rejects.toBeInstanceOf(ConflictException);
    });

    it('las de código y ficha no llevan la marca', () => {
      expect(isPrintedIntent(cashIntentFingerprint({ amountCents: 1, wallet: { card: FICHA } }))).toBe(false);
      expect(isPrintedIntent(null)).toBe(false);
    });
  });

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
  it('el camarero de barra no (aunque el dueño se lo diera a los camareros): las recargas, en recepción', async () => {
    const barra = setup({ venue: { staffPermissions: { roles: { WAITER: { cashTopUp: true } } } } });
    const err = await barra.svc.topUp(SALA, paco, nueva(1_000)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as HttpException).getResponse()).toMatchObject({
      code: 'TOP_UP_RECEPTION_ONLY',
      message: 'Las recargas se hacen en recepción.',
    });
    await expect(barra.svc.cashBlockedReason(SALA, paco)).resolves.toBe('Las recargas se hacen en recepción.');
    expect(barra.topUps.size).toBe(0);
  });

  it('el camarero de recepción, sí (sin que el dueño se lo dé); si se lo quita a esa persona, no', async () => {
    const recepcionista = setup({ pacoPost: 'RECEPCION' });
    await expect(recepcionista.svc.topUp(SALA, paco, nueva(1_000))).resolves.toMatchObject({ balanceCents: 1_000 });
    const quitado = setup({ pacoPost: 'RECEPCION', venue: { staffPermissions: { people: { [PACO]: { cashTopUp: false } } } } });
    await expect(quitado.svc.topUp(SALA, paco, nueva(1_000))).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'STAFF_PERMISSION_DENIED' }),
    });
    // Recepción sin efectivo en la tabla de puestos (Ajustes): tampoco.
    const sinEfectivo = setup({ pacoPost: 'RECEPCION', venue: { postRules: { RECEPCION: { cash: false } } } });
    await expect(sinEfectivo.svc.topUp(SALA, paco, nueva(1_000))).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'CASH_RECEPTION_ONLY' }),
    });
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

describe('tope legal del efectivo: los pagos troceados suman (art. 7 Ley 7/2012)', () => {
  const byCode = (amountCents: number, key: string) => ({ amountCents, idempotencyKey: key, wallet: { code: 'K7Q4M2' } });

  it('dos recargas de 999,99 € al mismo saldo: la segunda no (409 CASH_LIMIT) y no se suma nada', async () => {
    const { svc, wallets, topUps } = setup();
    await svc.topUp(SALA, javi, byCode(MAX_CASH_TOP_UP_CENTS, 'clave-tope-00001'));
    const err = await svc.topUp(SALA, javi, byCode(1, 'clave-tope-00002')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as HttpException).getResponse()).toMatchObject({ code: 'CASH_LIMIT' });
    expect((err as Error).message).toMatch(/ya lleva 999,99 € en 24 h/);
    expect(wallets.get(WALLET)).toMatchObject({ balanceCents: 2_000 + MAX_CASH_TOP_UP_CENTS });
    expect(topUps.size).toBe(1);
  });

  it('500 € y luego 600 €: dice cuánto cabe aún, y eso sí entra', async () => {
    const { svc } = setup();
    await svc.topUp(SALA, javi, byCode(50_000, 'clave-tope-00003'));
    await expect(svc.topUp(SALA, javi, byCode(60_000, 'clave-tope-00004'))).rejects.toThrow(/como mucho 499,99 € más/);
    await expect(svc.topUp(SALA, javi, byCode(49_999, 'clave-tope-00005'))).resolves.toMatchObject({ balanceCents: 2_000 + 99_999 });
  });

  it('cuenta también el efectivo de los saldos sumados a él (la cadena del Face ID)', async () => {
    const { svc, wallets, topUps } = setup();
    wallets.set('w-sumado', { id: 'w-sumado', tenantId: SALA, walletGroup: 'grupo-bambu', balanceCents: 0, status: 'DEPLETED', mergedIntoId: WALLET });
    topUps.set('ct-viejo', { id: 'ct-viejo', tenantId: SALA, walletId: 'w-sumado', amountCents: 90_000, idempotencyKey: 'vieja', createdAt: NOW });
    await expect(svc.topUp(SALA, javi, byCode(10_000, 'clave-tope-00006'))).rejects.toThrow(/ya lleva 900,00 €/);
  });

  it('el saldo se sumó a otro justo antes de cobrar: el efectivo va al bueno (sin «haz un saldo nuevo»)', async () => {
    const { svc, wallets, venues, prisma } = setup();
    const bueno = 'e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f7a80';
    wallets.set(bueno, { id: bueno, tenantId: SALA, walletGroup: 'grupo-bambu', shortCode: 'BUENO1', balanceCents: 7_000, status: 'ACTIVE', mergedIntoId: null, blockedAt: null });
    // Justo después de encontrar el saldo por su código (antes de cobrar), el cliente lo suma con su Face ID.
    const tx = (await prisma.acrossVenues(async (t) => t)) as { clientWallet: { findFirst: ReturnType<typeof vi.fn> } };
    const findFirst = tx.clientWallet.findFirst;
    let merged = false;
    prisma.venue.findUnique.mockImplementation(async (a: { where: { id: string } }) => {
      if (findFirst.mock.calls.length > 0 && !merged) {
        merged = true;
        wallets.set(WALLET, { ...wallets.get(WALLET)!, balanceCents: 0, status: 'DEPLETED', mergedIntoId: bueno });
        wallets.set(bueno, { ...wallets.get(bueno)!, balanceCents: 9_000 });
      }
      return venues.get(a.where.id) ?? null;
    });
    const out = await svc.topUp(SALA, javi, byCode(1_000, 'clave-carrera-01'));
    expect(out).toMatchObject({ walletId: bueno, balanceCents: 10_000 });
    expect(wallets.get(WALLET)).toMatchObject({ balanceCents: 0, mergedIntoId: bueno });
  });

  it('saldos nuevos en efectivo seguidos de la misma persona: al pasar de 1.000 € sale el aviso (cada 1.000 €)', async () => {
    const { svc, audit } = setup({ wallet: null });
    const split = () => audit.log.mock.calls.filter((c) => c[0].action === 'wallet.cash_split_suspected');
    await svc.topUp(SALA, javi, nueva(60_000, 'clave-trozo-0001'));
    expect(split()).toHaveLength(0);
    await svc.topUp(SALA, javi, nueva(60_000, 'clave-trozo-0002'));
    expect(split()).toHaveLength(1);
    expect(split()[0]![0]).toMatchObject({ tenantId: SALA, payload: { count: 2, amountCents: 120_000, userId: JAVI } });
    await svc.topUp(SALA, javi, nueva(30_000, 'clave-trozo-0003'));
    expect(split()).toHaveLength(1);
    await svc.topUp(SALA, javi, nueva(60_000, 'clave-trozo-0004'));
    expect(split()).toHaveLength(2);
    // Otra persona empieza de cero.
    await svc.topUp(SALA, { userId: PACO, role: 'OWNER' }, nueva(60_000, 'clave-trozo-0005'));
    expect(split()).toHaveLength(2);
  });
});

describe('anular una recarga en efectivo mal tecleada', () => {
  const manager = { userId: JAVI, role: 'MANAGER' as const, tenantId: SALA };

  it('el encargado con su 2FA: fila negativa que apunta a la recarga, el saldo baja y otra vez → 409', async () => {
    const { svc, wallets, topUps, totp, audit } = setup();
    const top = await svc.topUp(SALA, javi, { amountCents: 99_999, idempotencyKey: 'clave-anular-001', wallet: { code: 'K7Q4M2' } });
    const out = await svc.voidTopUp(manager, top.topUpId, { reason: 'Era 99,99', totpCode: '123456' });
    expect(totp.assertForUser).toHaveBeenCalledWith(JAVI, '123456');
    expect(out).toMatchObject({ topUpId: top.topUpId, walletId: WALLET, amountCents: 99_999, balanceCents: 2_000 });
    expect(wallets.get(WALLET)).toMatchObject({ balanceCents: 2_000 });
    expect([...topUps.values()].find((t) => t.voidOfId === top.topUpId)).toMatchObject({
      tenantId: SALA, walletId: WALLET, amountCents: -99_999, takenByUserId: JAVI, reason: 'Era 99,99',
    });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'wallet.cash_topup_voided' }));
    await expect(svc.voidTopUp(manager, top.topUpId, { reason: 'otra vez', totpCode: '123456' })).rejects.toThrow(/ya está anulada/);
    // Anulada, el tope de 24 h vuelve a tener sitio.
    await expect(svc.topUp(SALA, javi, { amountCents: 99_999, idempotencyKey: 'clave-anular-002', wallet: { code: 'K7Q4M2' } })).resolves.toBeDefined();
  });

  it('sin 2FA → 403; el camarero no; de otro local o de hace más de 2 h no; si el saldo ya no la cubre → 409', async () => {
    const { svc, topUps, wallets, totp } = setup();
    const top = await svc.topUp(SALA, javi, { amountCents: 5_000, idempotencyKey: 'clave-anular-003', wallet: { code: 'K7Q4M2' } });
    const noCode = await svc.voidTopUp(manager, top.topUpId, { reason: 'mal' }).catch((e: unknown) => e);
    expect((noCode as HttpException).getResponse()).toMatchObject({ code: 'TOTP_REQUIRED' });
    totp.isEnabled.mockResolvedValueOnce(false);
    const notEnrolled = await svc.voidTopUp(manager, top.topUpId, { reason: 'mal' }).catch((e: unknown) => e);
    expect((notEnrolled as HttpException).getResponse()).toMatchObject({ code: 'TOTP_NOT_ENROLLED' });
    await expect(svc.voidTopUp({ ...manager, role: 'WAITER' as never }, top.topUpId, { reason: 'mal', totpCode: '123456' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(svc.voidTopUp({ ...manager, tenantId: NORTE }, top.topUpId, { reason: 'mal', totpCode: '123456' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    // Ya se gastó parte: con 40 € en el saldo no se anula una recarga de 50 €.
    wallets.set(WALLET, { ...wallets.get(WALLET)!, balanceCents: 4_000 });
    await expect(svc.voidTopUp(manager, top.topUpId, { reason: 'mal', totpCode: '123456' })).rejects.toThrow(/ya no cubre/);
    wallets.set(WALLET, { ...wallets.get(WALLET)!, balanceCents: 7_000 });
    topUps.set(top.topUpId, { ...topUps.get(top.topUpId)!, createdAt: new Date(NOW.getTime() - 3 * 60 * 60 * 1000) });
    await expect(svc.voidTopUp(manager, top.topUpId, { reason: 'mal', totpCode: '123456' })).rejects.toThrow(/últimas 2 h/);
    expect([...topUps.values()].filter((t) => t.voidOfId)).toHaveLength(0);
  });
});

describe('recarga en efectivo con la «Comisión del servicio»', () => {
  const FEE_ON = { serviceFeeEnabled: true, serviceFeeBps: 1000, topUpServiceFeeBps: 1200 };
  const recarga = (amountCents: number, key: string, serviceFeeCents?: number) => ({
    amountCents,
    idempotencyKey: key,
    wallet: { code: 'K7Q4M2' },
    ...(serviceFeeCents !== undefined ? { serviceFeeCents } : {}),
  });

  it('al 12 %: 50 € de saldo + 6 € de comisión; el saldo sube 50 € y se apunta la comisión del momento', async () => {
    const { svc, wallets, topUps } = setup({ venue: FEE_ON });
    const out = await svc.topUp(SALA, javi, recarga(5_000, 'clave-fee-0001', 600));
    expect(out).toMatchObject({ amountCents: 5_000, serviceFeeCents: 600, serviceFeeBps: 1200, chargedCents: 5_600, balanceCents: 7_000 });
    expect(wallets.get(WALLET)).toMatchObject({ balanceCents: 7_000 });
    expect([...topUps.values()][0]).toMatchObject({ amountCents: 5_000, serviceFeeBps: 1200, serviceFeeCents: 600 });
    // El reintento devuelve lo mismo (con su comisión de entonces).
    await expect(svc.topUp(SALA, javi, recarga(5_000, 'clave-fee-0001', 600))).resolves.toEqual({ ...out, replayed: true });
  });

  it('una pantalla que no sabe cobrarla (app anterior) no cobra: 409 y nada se carga', async () => {
    const { svc, wallets, topUps } = setup({ venue: FEE_ON });
    const err = await svc.topUp(SALA, javi, recarga(5_000, 'clave-fee-0002')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: 'SERVICE_FEE_APP_OUTDATED' });
    expect(topUps.size).toBe(0);
    expect(wallets.get(WALLET)).toMatchObject({ balanceCents: 2_000 });
  });

  it('si la pantalla enseñó otra comisión (cambió el %): 409 con la de ahora, nada se carga', async () => {
    const { svc, topUps } = setup({ venue: FEE_ON });
    const err = await svc.topUp(SALA, javi, recarga(5_000, 'clave-fee-0003', 500)).catch((e: unknown) => e);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: 'SERVICE_FEE_CHANGED', serviceFeeCents: 600 });
    expect(topUps.size).toBe(0);
  });

  it('apagada: como siempre (sin comisión), también con la app anterior', async () => {
    const { svc, topUps } = setup();
    const out = await svc.topUp(SALA, javi, recarga(5_000, 'clave-fee-0004'));
    expect(out).toMatchObject({ amountCents: 5_000, serviceFeeCents: 0, serviceFeeBps: null, chargedCents: 5_000 });
    expect([...topUps.values()][0]).toMatchObject({ serviceFeeBps: null, serviceFeeCents: 0 });
  });

  it('el tope legal del efectivo cuenta lo que paga el cliente (saldo + comisión): 900 € + 12 % no cabe', async () => {
    const { svc, topUps } = setup({ venue: FEE_ON });
    const err = await svc.topUp(SALA, javi, recarga(90_000, 'clave-fee-0005', 10_800)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(String((err as Error).message)).toMatch(/999,99 €/);
    expect(topUps.size).toBe(0);
    // 800 € + 96 € = 896 €: cabe; otros 100 € + 12 € ya pasarían de 1.000 € en 24 h.
    await svc.topUp(SALA, javi, recarga(80_000, 'clave-fee-0006', 9_600));
    const over = await svc.topUp(SALA, javi, recarga(10_000, 'clave-fee-0007', 1_200)).catch((e: unknown) => e);
    expect((over as ConflictException).getResponse()).toMatchObject({ code: 'CASH_LIMIT' });
  });

  it('anularla devuelve también su comisión: la fila negativa la lleva en negativo', async () => {
    const { svc, topUps } = setup({ venue: FEE_ON });
    const top = await svc.topUp(SALA, javi, recarga(5_000, 'clave-fee-0008', 600));
    const manager = { userId: JAVI, role: 'MANAGER' as const, tenantId: SALA };
    const out = await svc.voidTopUp(manager, top.topUpId, { reason: 'mal tecleada', totpCode: '123456', serviceFeeCents: 600 });
    expect(out).toMatchObject({ amountCents: 5_000, serviceFeeCents: 600 });
    expect([...topUps.values()].find((t) => t.voidOfId === top.topUpId)).toMatchObject({ amountCents: -5_000, serviceFeeCents: -600, serviceFeeBps: 1200 });
  });

  it('anular con una pantalla de antes (sin la comisión): 409 SERVICE_FEE_APP_OUTDATED antes del 2FA y sin tocar nada', async () => {
    const { svc, topUps } = setup({ venue: FEE_ON });
    const top = await svc.topUp(SALA, javi, recarga(10_000, 'clave-fee-0009', 1_200));
    const manager = { userId: JAVI, role: 'MANAGER' as const, tenantId: SALA };
    const old = await svc.voidTopUp(manager, top.topUpId, { reason: 'mal tecleada' }).catch((e: unknown) => e);
    expect(old).toBeInstanceOf(ConflictException);
    expect((old as ConflictException).getResponse()).toMatchObject({ code: 'SERVICE_FEE_APP_OUTDATED', serviceFeeCents: 1_200 });
    expect(String((old as Error).message)).toMatch(/112,00/);
    const other = await svc.voidTopUp(manager, top.topUpId, { reason: 'mal', totpCode: '123456', serviceFeeCents: 0 }).catch((e: unknown) => e);
    expect((other as ConflictException).getResponse()).toMatchObject({ code: 'SERVICE_FEE_CHANGED', serviceFeeCents: 1_200 });
    expect([...topUps.values()].some((t) => t.voidOfId === top.topUpId)).toBe(false);
  });

  it('una recarga sin comisión se anula como siempre (sin el campo)', async () => {
    const { svc } = setup();
    const top = await svc.topUp(SALA, javi, recarga(5_000, 'clave-fee-0010'));
    const manager = { userId: JAVI, role: 'MANAGER' as const, tenantId: SALA };
    await expect(svc.voidTopUp(manager, top.topUpId, { reason: 'mal tecleada', totpCode: '123456' })).resolves.toMatchObject({ amountCents: 5_000 });
  });
});
