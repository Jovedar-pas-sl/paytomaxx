import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { WalletChargesService } from './wallet-charges.service';
import { passChargeSecret, passChargeToken } from './google-wallet/pass-charge-token';
import { hashPin } from './wallet-pin';

/**
 * El móvil del personal lee el QR del pase de Google Wallet del cliente
 * (/c/<token>, solo para cobrar) y le cobra con su PIN: la misma comprobación
 * de la firma que el datáfono, y nunca el enlace del saldo (/w/<token>). Base
 * en memoria con rollback y el hash real del PIN (como wallet-charges.terminal.spec).
 */

type Row = Record<string, unknown>;
interface Args { where?: Row; data?: Row; select?: Row; take?: number }

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
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
    list: (a: Args = {}): Row[] => [...t.rows.values()].filter((r) => matches(r, a.where)).slice(0, a.take),
    pick: (r: Row | undefined, select?: Row): Row | null =>
      r ? (select ? Object.fromEntries(Object.keys(select).map((k) => [k, r[k]])) : { ...r }) : null,
    findUnique: vi.fn(async (a: Args) => t.pick(t.list(a)[0], a.select)),
    findFirst: vi.fn(async (a: Args) => t.pick(t.list(a)[0], a.select)),
    findMany: vi.fn(async (a: Args) => t.list(a).map((r) => t.pick(r, a.select))),
    count: vi.fn(async (a: Args) => t.list(a).length),
    create: vi.fn(async (a: Args) => t.put({ id: `${prefix}-${(t.seq += 1)}`, createdAt: new Date(), ...a.data })),
    update: vi.fn(async (a: Args) => {
      const row = t.list(a)[0];
      if (!row) throw new Error(`${prefix}: la fila no existe`);
      return t.put({ ...row, ...a.data });
    }),
    updateMany: vi.fn(async (a: Args) => {
      const hit = t.list(a);
      hit.forEach((r) => t.put({ ...r, ...a.data }));
      return { count: hit.length };
    }),
  };
  return t;
}

const NOW = new Date('2026-10-23T01:30:00+02:00');
const PEPPER = 'clave-del-servidor-nightpay-0123456789abcdef';
const PIN = '4827';
let PIN_HASH = '';

const SALA = '3f2b8c1e-6a4d-4f7e-9b21-5c8d0e1f2a01'; // Sala Bambú (Madrid)
const NEON = '8a7b6c5d-4e3f-4a2b-8c1d-0e9f8a7b6c03'; // Club Neón (Valencia), otro dueño
const LOLA = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d01';
const NURIA = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d02';
const JAVI = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d03';
const WALLET = 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70';
const ENLACE = 'enlace-del-saldo-del-cliente-0001'; // /w/<token>: la credencial entera

const lola = { userId: LOLA, role: 'OPERATOR' as const, tenantId: SALA };
const nuria = { userId: NURIA, role: 'OPERATOR' as const, tenantId: SALA };
const javi = { userId: JAVI, role: 'MANAGER' as const, tenantId: SALA };

function setup(wallet: Row = {}) {
  const tables = {
    clientWallet: table('w'),
    walletCard: table('card'),
    walletChargeRequest: table('req', { walletId: null, decidedAt: null }),
    walletConsumption: table('cons'),
    operatorEarning: table('earn'),
    user: table('user'),
    venue: table('venue', { pausedAt: null, business: null, operatorCommissionDefaults: { CHICA_SERVICE: 6000 } }),
  };
  const $queryRaw = vi.fn(async (_s: TemplateStringsArray, ...values: unknown[]) =>
    tables.clientWallet.list({ where: { id: values[0] } }),
  );
  const tx = { ...tables, $queryRaw, $executeRaw: vi.fn(async () => 0) };
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
  tables.venue.put({ id: SALA, name: 'Sala Bambú', walletGroup: 'grupo-bambu' });
  tables.venue.put({ id: NEON, name: 'Club Neón', walletGroup: 'grupo-neon' });
  tables.user.put({ id: LOLA, role: 'OPERATOR', commissionBps: null, displayName: 'Lola', email: 'lola@bambu.es' });
  tables.user.put({ id: NURIA, role: 'OPERATOR', commissionBps: null, displayName: 'Nuria', email: 'nuria@bambu.es' });
  tables.user.put({ id: JAVI, role: 'MANAGER', commissionBps: null, displayName: null, email: 'javi@bambu.es' });
  tables.clientWallet.put({
    id: WALLET, tenantId: SALA, walletGroup: 'grupo-bambu', shortCode: 'K7Q4M2', identifier: 'Mesa 3',
    qrToken: ENLACE, balanceCents: 12_000, status: 'ACTIVE', closeRequestedAt: null, mergedIntoId: null, blockedAt: null,
    pinHash: PIN_HASH, pinFails: 0, pinLockedAt: null, pinFailedAt: null, pinSetById: null, ...wallet,
  });
  const audit = { log: vi.fn(async () => undefined) };
  const svc = new WalletChargesService(prisma as never, audit as never, { get: vi.fn() } as never, {} as never);
  return { svc, db: tables };
}

/** Un cobro con QR de Lola (40 €) en Sala Bambú, sin pagar, que caduca a los 5 min. */
function cobro(db: ReturnType<typeof setup>['db'], o: Row = {}): string {
  const n = db.walletChargeRequest.rows.size + 1;
  const row = db.walletChargeRequest.put({
    id: `req-${n}`, tenantId: SALA, requestedByUserId: LOLA, amountCents: 4_000, category: 'CHICA_SERVICE',
    serviceName: 'Reservado 30 min', payToken: `qr-del-cobro-numero-${n}`, status: 'PENDING', createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + 5 * 60_000), ...o,
  });
  return String(row.id);
}

const paseDe = (qrToken = ENLACE) => passChargeToken(passChargeSecret(), WALLET, qrToken);

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

describe('el pase leído con el móvil del personal (antes del PIN)', () => {
  it('de quién es y si le llega, como en el datáfono: sin su saldo, sin su código entero y sin el enlace', async () => {
    const { svc, db } = setup();
    const check = await svc.checkPassForCharge(lola, cobro(db), paseDe());
    expect(check).toEqual({ codeHint: 'K7Q-•••', hasPin: true, pinLocked: false, ownPin: false, enough: true });
    expect(JSON.stringify(check)).not.toContain(ENLACE);
    expect(JSON.stringify(check)).not.toContain('K7Q4M2');
    // El encargado también puede con el cobro de la chica.
    await expect(svc.checkPassForCharge(javi, cobro(db), paseDe())).resolves.toMatchObject({ enough: true });
  });

  it('el enlace del saldo (/w) no vale aquí, ni un pase con la firma tocada o de un enlace ya cambiado', async () => {
    const { svc, db } = setup();
    await expect(svc.checkPassForCharge(lola, cobro(db), ENLACE)).rejects.toBeInstanceOf(NotFoundException);
    const charge = paseDe();
    const flipped = `${charge.slice(0, 30)}${charge[30] === 'A' ? 'B' : 'A'}${charge.slice(31)}`;
    await expect(svc.checkPassForCharge(lola, cobro(db), flipped)).rejects.toBeInstanceOf(NotFoundException);
    db.clientWallet.put({ ...db.clientWallet.get(WALLET), qrToken: 'enlace-nuevo-del-saldo-0002' });
    await expect(svc.checkPassForCharge(lola, cobro(db), charge)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('cobro de otra chica, de otro local o ya pagado; saldo de otro grupo o bloqueado: no', async () => {
    const { svc, db } = setup();
    await expect(svc.checkPassForCharge(nuria, cobro(db), paseDe())).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.checkPassForCharge(lola, cobro(db, { tenantId: NEON }), paseDe())).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(svc.checkPassForCharge(lola, cobro(db, { status: 'ACCEPTED', walletId: WALLET }), paseDe())).rejects.toBeInstanceOf(
      ConflictException,
    );
    const otro = setup({ walletGroup: 'grupo-neon', tenantId: NEON });
    await expect(otro.svc.checkPassForCharge(lola, cobro(otro.db), paseDe())).rejects.toBeInstanceOf(NotFoundException);
    const bloqueado = setup({ blockedAt: NOW });
    await expect(bloqueado.svc.checkPassForCharge(lola, cobro(bloqueado.db), paseDe())).rejects.toThrow(/bloqueado/);
  });

  it('un PIN que puso quien cobra (o quien hizo el cobro) se dice antes: lo tiene que cobrar otra persona', async () => {
    const { svc, db } = setup({ pinSetById: LOLA });
    await expect(svc.checkPassForCharge(lola, cobro(db), paseDe())).resolves.toMatchObject({ ownPin: true });
    await expect(svc.checkPassForCharge(javi, cobro(db), paseDe())).resolves.toMatchObject({ ownPin: true });
    const delEncargado = setup({ pinSetById: JAVI });
    await expect(delEncargado.svc.checkPassForCharge(lola, cobro(delEncargado.db), paseDe())).resolves.toMatchObject({
      ownPin: false,
    });
  });
});

describe('pagar con el PIN desde el pase en el móvil del personal', () => {
  it('se cobra el cobro de la chica del saldo del pase, una sola vez', async () => {
    const { svc, db } = setup();
    const req = cobro(db);
    await expect(svc.payQrChargeWithPin(lola, req, { walletToken: paseDe(), pin: PIN })).resolves.toMatchObject({
      id: req,
      status: 'ACCEPTED',
      newBalanceCents: 8_000,
    });
    expect(db.clientWallet.get(WALLET)).toMatchObject({ balanceCents: 8_000 });
    await expect(svc.payQrChargeWithPin(lola, req, { walletToken: paseDe(), pin: PIN })).rejects.toBeInstanceOf(ConflictException);
    expect(db.clientWallet.get(WALLET)).toMatchObject({ balanceCents: 8_000, pinFails: 0 });
  });

  it('con el enlace del saldo (/w) no se paga ni se gasta un intento de PIN', async () => {
    const { svc, db } = setup();
    await expect(svc.payQrChargeWithPin(lola, cobro(db), { walletToken: ENLACE, pin: PIN })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(db.clientWallet.get(WALLET)).toMatchObject({ balanceCents: 12_000, pinFails: 0 });
  });

  it('PIN mal: cuenta el fallo como con el código (5 bloquean)', async () => {
    const { svc, db } = setup();
    await expect(svc.payQrChargeWithPin(lola, cobro(db), { walletToken: paseDe(), pin: '0000' })).rejects.toThrow();
    expect(db.clientWallet.get(WALLET)).toMatchObject({ balanceCents: 12_000, pinFails: 1 });
  });
});
