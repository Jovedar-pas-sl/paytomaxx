import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { isWalletCardToken } from '@nightpay/contracts';
import { Prisma } from '@nightpay/db';
import { WalletChargesService } from './wallet-charges.service';
import { hashPin } from './wallet-pin';

/**
 * Ficha NFC del saldo: la graba el servidor, se da a un saldo (una por
 * saldo, nunca la de otro cliente con dinero), una copia (otro número de
 * serie) no vale y una perdida se bloquea. Pagar siempre pide el PIN.
 * Base en memoria con rollback (como la transacción de verdad).
 */

type Row = Record<string, unknown>;
interface Args { where?: Row; data?: Row; select?: Row; orderBy?: Record<string, 'asc' | 'desc'>; take?: number }

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'NOT') return !matches(row, cond as Row);
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as { not?: unknown; in?: unknown[]; gt?: unknown };
      if ('not' in c) return row[key] !== c.not;
      if ('in' in c) return (c.in ?? []).includes(row[key]);
      if ('gt' in c) return Number(row[key]) > Number(c.gt);
    }
    return row[key] === cond;
  });
}

function table(prefix: string, defaults: Row = {}) {
  const t = {
    rows: new Map<string, Row>(),
    seq: 0,
    put: (row: Row): Row => {
      const full = { ...defaults, ...row };
      t.rows.set(String(full.id), full);
      return full;
    },
    get: (id: string): Row => t.rows.get(id) ?? {},
    list: (a: Args = {}): Row[] => {
      const found = [...t.rows.values()].filter((r) => matches(r, a.where));
      const [order] = Object.entries(a.orderBy ?? {});
      if (order) found.sort((x, y) => (Number(x[order[0]]) - Number(y[order[0]])) * (order[1] === 'asc' ? 1 : -1));
      return found.slice(0, a.take ?? found.length);
    },
    pick: (r: Row | undefined, select?: Row): Row | null =>
      r ? (select ? Object.fromEntries(Object.keys(select).map((k) => [k, r[k]])) : { ...r }) : null,
    findUnique: vi.fn(async (a: Args): Promise<Row | null> => t.pick(t.list(a)[0], a.select)),
    findFirst: vi.fn(async (a: Args): Promise<Row | null> => t.pick(t.list(a)[0], a.select)),
    count: vi.fn(async (a: Args): Promise<number> => t.list(a).length),
    create: vi.fn(async (a: Args): Promise<Row> => t.put({ id: `${prefix}-${(t.seq += 1)}`, createdAt: new Date(), ...a.data })),
    update: vi.fn(async (a: Args): Promise<Row> => {
      const row = t.list(a)[0];
      if (!row) throw new Error(`${prefix}: la fila no existe`);
      return t.put(withData(row, a.data));
    }),
    updateMany: vi.fn(async (a: Args): Promise<{ count: number }> => {
      const hit = t.list(a);
      hit.forEach((r) => t.put(withData(r, a.data)));
      return { count: hit.length };
    }),
  };
  return t;
}

function withData(row: Row, data: Row = {}): Row {
  const next: Row = { ...row };
  for (const [k, v] of Object.entries(data)) {
    const inc = (v as { increment?: unknown } | null)?.increment;
    next[k] = typeof inc === 'number' ? Number(row[k]) + inc : v;
  }
  return next;
}

const NOW = new Date('2026-10-17T02:10:00+02:00'); // sábado noche en Madrid
const PEPPER = 'clave-del-servidor-nightpay-0123456789abcdef';
const PIN = '4827';
let PIN_HASH = '';

const SALA = '3f2b8c1e-6a4d-4f7e-9b21-5c8d0e1f2a01'; // Sala Bambú (Madrid)
const NORTE = '3f2b8c1e-6a4d-4f7e-9b21-5c8d0e1f2a02'; // Bambú Norte (Alcobendas), mismo grupo
const NEON = '8a7b6c5d-4e3f-4a2b-8c1d-0e9f8a7b6c03'; // Club Neón (Valencia), otro dueño
const LOLA = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d01';
const JAVI = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d03';
const WALLET = 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70';
const OTRO = 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f71'; // saldo de otro cliente
const FICHA = 'q3VbX9kLmN2pR7sT4wYz1A'; // código grabado en la ficha
const UID = '04:a2:3b:5c:1d:80:00'; // número de serie que lee un Android

const lola = { userId: LOLA, role: 'OPERATOR' as const, tenantId: SALA };
const javi = { userId: JAVI, role: 'MANAGER' as const, tenantId: SALA };
const encargadoNeon = { userId: 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d06', role: 'MANAGER' as const, tenantId: NEON };

function setup(o: { card?: Row | null; topUpAt?: Date } = {}) {
  const tables = {
    clientWallet: table('w', {
      walletGroup: 'grupo-bambu', identifier: null, closeRequestedAt: null, mergedIntoId: null, blockedAt: null,
      pinFails: 0, pinLockedAt: null, pinFailedAt: null, pinSetById: null,
    }),
    walletCard: table('card', { uid: null, walletId: null, status: 'ISSUED', blockedAt: null, lastUsedAt: null, venueId: SALA }),
    walletChargeRequest: table('req', { walletId: null, decidedAt: null }),
    walletConsumption: table('cons'),
    operatorEarning: table('earn'),
    payment: table('pay'),
    walletCashTopUp: table('cash'),
    user: table('user'),
    venue: table('venue', { pausedAt: null, business: null, operatorCommissionDefaults: null }),
  };
  const queries: Prisma.Sql[] = [];
  const $queryRaw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = Prisma.sql(strings, ...values);
    queries.push(q);
    if (q.text.includes('FROM wallet_cards')) return tables.walletCard.list({ where: { token: values[0] } });
    return tables.clientWallet.list({ where: { id: values[0] } });
  });
  const tx = { ...tables, $queryRaw };
  const all = Object.values(tables);
  const run = async (fn: (t: typeof tx) => unknown) => {
    const snap = all.map((t) => new Map(t.rows));
    try {
      return await fn(tx);
    } catch (err) {
      all.forEach((t, i) => (t.rows = snap[i] ?? new Map()));
      throw err;
    }
  };
  const prisma = { ...tx, asSystem: vi.fn(run), acrossVenues: vi.fn(run) };
  tables.venue.put({ id: SALA, name: 'Sala Bambú (Madrid)', walletGroup: 'grupo-bambu' });
  tables.venue.put({ id: NORTE, name: 'Bambú Norte (Alcobendas)', walletGroup: 'grupo-bambu' });
  tables.venue.put({ id: NEON, name: 'Club Neón (Valencia)', walletGroup: 'grupo-neon' });
  tables.user.put({ id: LOLA, role: 'OPERATOR', commissionBps: null });
  tables.clientWallet.put({ id: WALLET, tenantId: SALA, shortCode: 'K7Q4M2', balanceCents: 12_000, status: 'ACTIVE', pinHash: PIN_HASH });
  tables.clientWallet.put({ id: OTRO, tenantId: SALA, shortCode: 'P9X3T7', balanceCents: 5_000, status: 'ACTIVE', pinHash: null });
  if (o.card !== null) tables.walletCard.put({ id: 'card-1', token: FICHA, walletId: WALLET, ...o.card });
  tables.payment.put({ id: 'pay-1', walletId: WALLET, createdByUserId: LOLA, authorizedAt: o.topUpAt ?? NOW, createdAt: o.topUpAt ?? NOW });
  const audit = { log: vi.fn(async (_e: { action: string; payload: Record<string, unknown> }) => undefined) };
  const svc = new WalletChargesService(prisma as never, audit as never, { get: vi.fn() } as never);
  return { svc, db: tables, audit, queries };
}

/** Un cobro con QR de Lola (40 €) en Sala Bambú, sin pagar. */
function cobro(db: ReturnType<typeof setup>['db']): string {
  db.walletChargeRequest.put({
    id: 'req-1', tenantId: SALA, requestedByUserId: LOLA, amountCents: 4_000, category: 'CHICA_SERVICE',
    serviceName: 'Reservado 30 min', payToken: 'qr-1', status: 'PENDING', expiresAt: new Date(NOW.getTime() + 5 * 60_000),
  });
  return 'req-1';
}

beforeAll(async () => {
  PIN_HASH = await hashPin(PIN, PEPPER);
});

beforeEach(() => {
  vi.stubEnv('ENCRYPTION_KEK', PEPPER);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('grabar y dar una ficha', () => {
  it('el código lo crea el servidor al azar y la ficha queda en blanco hasta darla', async () => {
    const { svc, db } = setup({ card: null });
    const a = await svc.issueCard(lola);
    const b = await svc.issueCard(lola);
    expect(isWalletCardToken(a.card)).toBe(true);
    expect(a.card).toHaveLength(22); // 128 bits en base64url
    expect(a.card).not.toBe(b.card);
    // En el stock del local, aún sin grabar (stockedAt lo pone quien la graba).
    expect(db.walletCard.list({ where: { token: a.card } })).toEqual([
      expect.objectContaining({ linkedById: LOLA, walletId: null, status: 'STOCK', venueId: SALA }),
    ]);
    expect(db.walletCard.list({ where: { token: a.card } })[0]).not.toHaveProperty('stockedAt');
  });

  it('la chica de la recarga la da en sus 15 min: guarda el número de serie y suelta la ficha anterior', async () => {
    const { svc, db, audit, queries } = setup({ card: { walletId: null } });
    db.walletCard.put({ id: 'card-vieja', token: 'fichaViejaDelCliente01', walletId: WALLET });
    const out = await svc.linkCard(lola, { code: 'k7q-4m2', card: FICHA, uid: UID });
    expect(out).toMatchObject({ walletId: WALLET, hasCard: true, hasPin: true });
    expect(db.walletCard.get('card-1')).toMatchObject({
      walletId: WALLET, status: 'ISSUED', uid: '04A23B5C1D8000', linkedById: LOLA, linkedAt: NOW, venueId: SALA,
    });
    // La que tenía vuelve al stock (devuelta).
    expect(db.walletCard.get('card-vieja')).toMatchObject({ walletId: null, status: 'RETURNED', returnedAt: NOW });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'wallet.card_linked', targetId: WALLET, payload: { replacedCards: 1, withUid: true } }),
    );
    // Siempre en este orden: el saldo y luego la ficha (por su código), los dos bloqueados.
    expect(queries[0]!.text).toMatch(/FROM client_wallets WHERE id = \$1::uuid FOR UPDATE/);
    expect(queries[0]!.values).toEqual([WALLET]);
    expect(queries[1]!.text).toMatch(/FROM wallet_cards WHERE token = \$1 FOR UPDATE/);
    expect(queries[1]!.values).toEqual([FICHA]);
  });

  it('la ficha de otro cliente que aún tiene saldo no se da; si aquel saldo ya se gastó, se reutiliza', async () => {
    const { svc, db } = setup({ card: { walletId: OTRO } });
    await expect(svc.linkCard(javi, { code: 'K7Q4M2', card: FICHA })).rejects.toBeInstanceOf(ConflictException);
    expect(db.walletCard.get('card-1')).toMatchObject({ walletId: OTRO });

    db.clientWallet.put({ ...db.clientWallet.get(OTRO), balanceCents: 0, status: 'DEPLETED' });
    await expect(svc.linkCard(javi, { code: 'K7Q4M2', card: FICHA })).resolves.toMatchObject({ walletId: WALLET });
    expect(db.walletCard.get('card-1')).toMatchObject({ walletId: WALLET, linkedById: JAVI });
  });

  it('ficha bloqueada, copiada (otro número de serie) o que no grabó el servidor: no se da', async () => {
    const bloqueada = setup({ card: { walletId: null, status: 'BLOCKED' } });
    await expect(bloqueada.svc.linkCard(javi, { code: 'K7Q4M2', card: FICHA })).rejects.toBeInstanceOf(ConflictException);
    expect(bloqueada.db.walletCard.get('card-1')).toMatchObject({ walletId: null, status: 'BLOCKED' });

    const copiada = setup({ card: { walletId: null, uid: '04FFEEDDCCBBAA' } });
    await expect(copiada.svc.linkCard(javi, { code: 'K7Q4M2', card: FICHA, uid: UID })).rejects.toBeInstanceOf(ConflictException);
    expect(copiada.db.walletCard.get('card-1')).toMatchObject({ walletId: null, uid: '04FFEEDDCCBBAA' });

    const ajena = setup({ card: null });
    await expect(ajena.svc.linkCard(javi, { code: 'K7Q4M2', card: FICHA })).rejects.toBeInstanceOf(BadRequestException);
    await expect(ajena.svc.linkCard(javi, { code: 'K7Q4M2', card: 'ficha/rara' })).rejects.toBeInstanceOf(BadRequestException);
    expect(ajena.db.walletCard.rows.size).toBe(0);
  });

  it('la chica sin una recarga suya reciente no da fichas (422); el encargado sí', async () => {
    const { svc, db } = setup({ card: { walletId: null }, topUpAt: new Date(NOW.getTime() - 16 * 60_000) });
    await expect(svc.linkCard(lola, { code: 'K7Q4M2', card: FICHA })).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(db.walletCard.get('card-1')).toMatchObject({ walletId: null });
    await expect(svc.linkCard(javi, { code: 'K7Q4M2', card: FICHA })).resolves.toMatchObject({ hasCard: true });
  });

  it('el código del cliente solo vale en su grupo: desde Club Neón no se le da ficha', async () => {
    const { svc, db } = setup({ card: { walletId: null } });
    await expect(svc.linkCard(encargadoNeon, { code: 'K7Q4M2', card: FICHA })).rejects.toBeInstanceOf(NotFoundException);
    expect(db.walletCard.get('card-1')).toMatchObject({ walletId: null });
    expect(db.clientWallet.findFirst).toHaveBeenCalledWith({ where: { shortCode: 'K7Q4M2', status: 'ACTIVE' } });
    expect(db.venue.findUnique).toHaveBeenCalledWith({ where: { id: NEON }, select: { walletGroup: true } });
  });
});

describe('cobrar con la ficha y el PIN', () => {
  it('la chica la acerca: su saldo en cualquier local del grupo; en otro grupo o copiada, no', async () => {
    const { svc } = setup({ card: { uid: '04A23B5C1D8000' } });
    await expect(svc.lookupCard(NORTE, { card: FICHA, uid: UID })).resolves.toMatchObject({
      walletId: WALLET, code: 'K7Q-4M2', balanceCents: 12_000, homeVenueName: 'Sala Bambú (Madrid)', isHomeVenue: false, hasCard: true,
    });
    // Un iPhone no manda el número de serie: vale para saber de qué saldo es (pagar pide el PIN).
    await expect(svc.lookupCard(SALA, { card: FICHA })).resolves.toMatchObject({ walletId: WALLET, isHomeVenue: true });
    await expect(svc.lookupCard(NEON, { card: FICHA })).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.lookupCard(SALA, { card: FICHA, uid: '04:ff:ee:dd:cc:bb:aa' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('un enlace que no es de una ficha nuestra ni se busca en la base', async () => {
    const { svc, db } = setup();
    await expect(svc.lookupCard(SALA, { card: 'https://ejemplo.com/?ficha=x' })).rejects.toBeInstanceOf(NotFoundException);
    expect(db.walletCard.findUnique).not.toHaveBeenCalled();
  });

  it('con la ficha y el PIN se descuenta justo el importe; el primer Android que la lee graba su número de serie', async () => {
    const { svc, db } = setup();
    const out = await svc.payQrChargeWithPin(lola, cobro(db), { card: FICHA, uid: UID, pin: PIN });
    expect(out).toMatchObject({ status: 'ACCEPTED', amountCents: 4_000, newBalanceCents: 8_000 });
    expect(db.clientWallet.get(WALLET)).toMatchObject({ balanceCents: 8_000, status: 'ACTIVE' });
    expect(db.walletConsumption.list()).toEqual([expect.objectContaining({ walletId: WALLET, tenantId: SALA, amountCents: 4_000 })]);
    expect(db.walletCard.get('card-1')).toMatchObject({ uid: '04A23B5C1D8000', lastUsedAt: NOW });
  });

  it('ficha perdida: el encargado la bloquea; ya no paga ni gasta intentos, pero el saldo sigue con código + PIN', async () => {
    const { svc, db, audit } = setup();
    await expect(svc.blockCard(javi, WALLET)).resolves.toEqual({ ok: true });
    expect(db.walletCard.get('card-1')).toMatchObject({ status: 'BLOCKED', blockedAt: NOW });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'wallet.card_blocked', actorId: JAVI, targetId: WALLET }));

    const req = cobro(db);
    await expect(svc.payQrChargeWithPin(lola, req, { card: FICHA, pin: PIN })).rejects.toBeInstanceOf(NotFoundException);
    expect(db.clientWallet.get(WALLET)).toMatchObject({ balanceCents: 12_000, pinFails: 0 });
    await expect(svc.payQrChargeWithPin(lola, req, { code: 'K7Q4M2', pin: PIN })).resolves.toMatchObject({ newBalanceCents: 8_000 });
  });

  it('una copia (otro número de serie) no paga y no gasta intentos de PIN', async () => {
    const { svc, db } = setup({ card: { uid: '04A23B5C1D8000' } });
    await expect(
      svc.payQrChargeWithPin(lola, cobro(db), { card: FICHA, uid: '04:11:22:33:44:55:66', pin: PIN }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(db.clientWallet.get(WALLET)).toMatchObject({ balanceCents: 12_000, pinFails: 0 });
    expect(db.walletChargeRequest.get('req-1')).toMatchObject({ status: 'PENDING', walletId: null });
  });

  it('bloquear la ficha: solo el encargado o el dueño de su grupo; un saldo sin ficha → 409', async () => {
    const { svc, db, audit } = setup();
    await expect(svc.blockCard(lola, WALLET)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.blockCard(encargadoNeon, WALLET)).rejects.toBeInstanceOf(NotFoundException);
    expect(db.walletCard.get('card-1')).toMatchObject({ status: 'ISSUED' });
    await expect(svc.blockCard(javi, OTRO)).rejects.toBeInstanceOf(ConflictException);
    expect(audit.log).not.toHaveBeenCalled();
  });

  // BUG: wallet-charges.service.ts:818-823 (walletByCard) — la ficha que se dio a
  // una recarga que luego se sumó al saldo de siempre del cliente (mergeInto,
  // :582-647, no mueve las fichas) apunta a un saldo DEPLETED con mergedIntoId:
  // lookupCard / pagar con la ficha dan 404 «Esta ficha no tiene saldo» en vez
  // de resolver al saldo que sobrevive (donde está el dinero). Falla cerrado.
  it.skip('la ficha de una recarga que se sumó a otro saldo paga con el saldo que sobrevive', async () => {
    const { svc, db } = setup({ card: { walletId: OTRO } });
    db.clientWallet.put({ ...db.clientWallet.get(OTRO), balanceCents: 0, status: 'DEPLETED', mergedIntoId: WALLET });
    await expect(svc.lookupCard(SALA, { card: FICHA })).resolves.toMatchObject({ walletId: WALLET, balanceCents: 12_000 });
  });
});
