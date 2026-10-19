import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { WalletChargesService } from './wallet-charges.service';
import { hashPin } from './wallet-pin';

/**
 * Cobrar del saldo en el datáfono (sin persona, Authorization: Device): solo
 * cobros de su local y saldos de su grupo, con las mismas reglas del PIN
 * (5 fallos bloquean), y nunca con un PIN que puso el personal. Base en
 * memoria con rollback y el hash real del PIN.
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

const NOW = new Date('2026-10-17T01:30:00+02:00');
const PEPPER = 'clave-del-servidor-nightpay-0123456789abcdef';
const PIN = '4827';
let PIN_HASH = '';

const SALA = '3f2b8c1e-6a4d-4f7e-9b21-5c8d0e1f2a01'; // Sala Bambú (Madrid)
const TERRAZA = '3f2b8c1e-6a4d-4f7e-9b21-5c8d0e1f2a02'; // Terraza Bambú, mismo dueño
const NEON = '8a7b6c5d-4e3f-4a2b-8c1d-0e9f8a7b6c03'; // Club Neón (Valencia), otro dueño
const LOLA = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d01';
const JAVI = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d03';
const WALLET = 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70';
const FICHA = 'Kp3vX9qL2mN8rT5wYb7c'; // grabada en la ficha
const UID = '04A23B1C2D5E80';
const PASE = 'pase-google-wallet-del-saldo-0001'; // /w/<token>

const barra = { terminalId: 'term-barra', tenantId: SALA };
const terraza = { terminalId: 'term-terraza', tenantId: TERRAZA };
const neon = { terminalId: 'term-neon', tenantId: NEON };

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
  tables.venue.put({ id: SALA, name: 'Sala Bambú', walletGroup: 'grupo-bambu' });
  tables.venue.put({ id: TERRAZA, name: 'Terraza Bambú', walletGroup: 'grupo-bambu' });
  tables.venue.put({ id: NEON, name: 'Club Neón', walletGroup: 'grupo-neon' });
  tables.user.put({ id: LOLA, role: 'OPERATOR', commissionBps: null, displayName: 'Lola', email: 'lola@bambu.es' });
  tables.user.put({ id: JAVI, role: 'MANAGER', commissionBps: null, displayName: null, email: 'javi@bambu.es' });
  tables.clientWallet.put({
    id: WALLET, tenantId: SALA, walletGroup: 'grupo-bambu', shortCode: 'K7Q4M2', identifier: 'Mesa 3',
    qrToken: PASE, balanceCents: 12_000, status: 'ACTIVE', closeRequestedAt: null, mergedIntoId: null, blockedAt: null,
    pinHash: PIN_HASH, pinFails: 0, pinLockedAt: null, pinFailedAt: null, pinSetById: null, ...wallet,
  });
  tables.walletCard.put({ id: 'card-1', token: FICHA, uid: UID, walletId: WALLET, status: 'ACTIVE', lastUsedAt: null });
  const audit = { log: vi.fn(async (_e: { action: string; actorId?: string | null; payload: Record<string, unknown> }) => undefined) };
  const svc = new WalletChargesService(prisma as never, audit as never, { get: vi.fn() } as never, {} as never);
  return { svc, db: tables, audit };
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

const conFicha = { card: FICHA, uid: '04:a2:3b:1c:2d:5e:80' };

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

describe('elegir el cobro en el datáfono', () => {
  it('lista solo los cobros con QR de su local sin pagar ni caducados, con el nombre (nunca el email)', async () => {
    const { svc, db } = setup();
    const deLola = cobro(db);
    const deJavi = cobro(db, { requestedByUserId: JAVI });
    cobro(db, { tenantId: NEON });
    cobro(db, { expiresAt: new Date(NOW.getTime() - 1) });
    cobro(db, { status: 'ACCEPTED', walletId: WALLET });
    cobro(db, { payToken: null });
    const list = await svc.pendingQrChargesForTerminal(barra);
    expect(list.map((c) => [c.id, c.requestedByName])).toEqual([
      [deLola, 'Lola'],
      [deJavi, ''],
    ]);
    expect(list[0]).toMatchObject({ amountCents: 4_000, serviceName: 'Reservado 30 min' });
  });

  it('el QR escaneado del cobro: el de su local, si aún se puede pagar', async () => {
    const { svc, db } = setup();
    const req = cobro(db);
    await expect(svc.qrChargeForTerminal(barra, 'qr-del-cobro-numero-1')).resolves.toMatchObject({ id: req, amountCents: 4_000 });
    // El mismo QR desde el datáfono de otro local (aunque sea del grupo): no.
    await expect(svc.qrChargeForTerminal(terraza, 'qr-del-cobro-numero-1')).rejects.toBeInstanceOf(NotFoundException);
    cobro(db, { expiresAt: new Date(NOW.getTime() - 1) });
    await expect(svc.qrChargeForTerminal(barra, 'qr-del-cobro-numero-2')).rejects.toThrow(/caducado/);
    cobro(db, { status: 'ACCEPTED', walletId: WALLET });
    await expect(svc.qrChargeForTerminal(barra, 'qr-del-cobro-numero-3')).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('¿le llega? (antes del PIN, sin enseñar su saldo)', () => {
  it('por su ficha, su pase o su código: solo si le llega, el código a medias y nada de su nombre', async () => {
    const { svc, db } = setup();
    const req = cobro(db);
    const expected = { codeHint: 'K7Q-•••', hasPin: true, pinLocked: false, pinByStaff: false, enough: true };
    await expect(svc.checkWalletForTerminal(barra, req, conFicha)).resolves.toEqual(expected);
    await expect(svc.checkWalletForTerminal(barra, req, { walletToken: PASE })).resolves.toEqual(expected);
    await expect(svc.checkWalletForTerminal(barra, req, { code: 'k7q-4m2' })).resolves.toEqual(expected);
    const caro = cobro(db, { amountCents: 12_001 });
    await expect(svc.checkWalletForTerminal(barra, caro, conFicha)).resolves.toMatchObject({ enough: false });
    expect(db.clientWallet.get(WALLET)).toMatchObject({ pinFails: 0, balanceCents: 12_000 });
  });

  it('en el datáfono de otro local del grupo vale; en el de otro dueño, no', async () => {
    const { svc, db } = setup();
    const enTerraza = cobro(db, { tenantId: TERRAZA });
    await expect(svc.checkWalletForTerminal(terraza, enTerraza, conFicha)).resolves.toMatchObject({ enough: true });
    const enNeon = cobro(db, { tenantId: NEON });
    await expect(svc.checkWalletForTerminal(neon, enNeon, conFicha)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.checkWalletForTerminal(neon, enNeon, { walletToken: PASE })).rejects.toBeInstanceOf(NotFoundException);
    // Un cobro de Sala Bambú desde el datáfono de la Terraza: no.
    await expect(svc.checkWalletForTerminal(terraza, cobro(db), conFicha)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('el pase de una recarga que se sumó a otro saldo lleva a ese otro', async () => {
    const { svc, db } = setup({ qrToken: 'pase-del-saldo-al-que-se-sumo-01' });
    db.clientWallet.put({
      id: 'w-vieja', tenantId: SALA, walletGroup: 'grupo-bambu', shortCode: 'ZZZ999', qrToken: PASE, balanceCents: 0,
      status: 'DEPLETED', mergedIntoId: WALLET, blockedAt: null, pinHash: null, pinLockedAt: null, pinSetById: null,
    });
    await expect(svc.checkWalletForTerminal(barra, cobro(db), { walletToken: PASE })).resolves.toMatchObject({
      codeHint: 'K7Q-•••',
      enough: true,
    });
  });

  it('ficha copiada (otro número de serie), saldo bloqueado o PIN puesto por el personal: se dice antes del PIN', async () => {
    const copia = setup();
    await expect(
      copia.svc.checkWalletForTerminal(barra, cobro(copia.db), { card: FICHA, uid: '04FFFFFFFFFFFF' }),
    ).rejects.toBeInstanceOf(ConflictException);
    const bloqueado = setup({ blockedAt: NOW });
    await expect(bloqueado.svc.checkWalletForTerminal(barra, cobro(bloqueado.db), conFicha)).rejects.toThrow(/bloqueado/);
    const delEncargado = setup({ pinSetById: JAVI });
    await expect(delEncargado.svc.checkWalletForTerminal(barra, cobro(delEncargado.db), conFicha)).resolves.toMatchObject({
      pinByStaff: true,
    });
  });
});

describe('pagar con el PIN en el datáfono', () => {
  it('se cobra justo el importe, la parte de la chica queda como siempre y queda en la auditoría qué datáfono', async () => {
    const { svc, db, audit } = setup();
    const req = cobro(db);
    await expect(svc.payQrChargeFromTerminal(barra, req, { ...conFicha, pin: PIN })).resolves.toMatchObject({
      id: req,
      status: 'ACCEPTED',
      amountCents: 4_000,
      newBalanceCents: 8_000,
    });
    expect(db.clientWallet.get(WALLET)).toMatchObject({ balanceCents: 8_000 });
    expect([...db.walletConsumption.rows.values()]).toEqual([
      expect.objectContaining({ amountCents: 4_000, providedByUserId: LOLA, idempotencyKey: `charge-request:${req}` }),
    ]);
    expect([...db.operatorEarning.rows.values()]).toEqual([
      expect.objectContaining({ operatorId: LOLA, commissionCents: 2_400 }),
    ]);
    expect(db.walletCard.get('card-1')).toMatchObject({ lastUsedAt: NOW });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'wallet.pin_charge_terminal',
        tenantId: SALA,
        targetId: WALLET,
        payload: { requestId: req, amountCents: 4_000, terminalId: 'term-barra', via: 'ficha' },
      }),
    );
    expect(audit.log.mock.calls[0]![0].actorId).toBeUndefined();
    // Ya pagado: el mismo cobro no se paga dos veces (ni gasta un intento).
    await expect(svc.payQrChargeFromTerminal(barra, req, { ...conFicha, pin: PIN })).rejects.toBeInstanceOf(ConflictException);
    expect(db.clientWallet.get(WALLET)).toMatchObject({ balanceCents: 8_000, pinFails: 0 });
  });

  it('con el pase o el código también; la ficha que llega sin número de serie lo graba la primera vez', async () => {
    const { svc, db, audit } = setup();
    db.walletCard.put({ id: 'card-1', token: FICHA, uid: null, walletId: WALLET, status: 'ACTIVE', lastUsedAt: null });
    await svc.payQrChargeFromTerminal(barra, cobro(db), { walletToken: PASE, pin: PIN });
    await svc.payQrChargeFromTerminal(barra, cobro(db), { code: 'K7Q4M2', pin: PIN });
    await svc.payQrChargeFromTerminal(barra, cobro(db), { ...conFicha, pin: PIN });
    expect(db.clientWallet.get(WALLET)).toMatchObject({ balanceCents: 0, status: 'DEPLETED' });
    expect(db.walletCard.get('card-1')).toMatchObject({ uid: UID });
    expect(audit.log.mock.calls.map(([e]) => e.payload.via)).toEqual(['pase', 'código', 'ficha']);
  });

  it('5 PIN fallidos bloquean el saldo igual que en la app; los fallos dicen qué datáfono, sin persona', async () => {
    const { svc, db, audit } = setup();
    const req = cobro(db);
    for (let i = 1; i <= 5; i += 1) {
      await expect(svc.payQrChargeFromTerminal(barra, req, { ...conFicha, pin: '1111' })).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    }
    expect(db.clientWallet.get(WALLET)).toMatchObject({ pinFails: 5, pinLockedAt: NOW, balanceCents: 12_000 });
    expect(audit.log.mock.calls.map(([e]) => [e.action, e.actorId, e.payload])).toEqual([
      ['wallet.pin_failed', null, { attemptsLeft: 4, terminalId: 'term-barra' }],
      ['wallet.pin_failed', null, { attemptsLeft: 3, terminalId: 'term-barra' }],
      ['wallet.pin_failed', null, { attemptsLeft: 2, terminalId: 'term-barra' }],
      ['wallet.pin_failed', null, { attemptsLeft: 1, terminalId: 'term-barra' }],
      ['wallet.pin_locked', null, { attemptsLeft: 0, terminalId: 'term-barra' }],
    ]);
    await expect(svc.payQrChargeFromTerminal(barra, req, { ...conFicha, pin: PIN })).rejects.toThrow(/bloqueado/);
    expect(db.walletChargeRequest.get(req)).toMatchObject({ status: 'PENDING', walletId: null });
  });

  it('un PIN que puso el personal no vale en el datáfono (nadie sabe quién lo sostiene) y no gasta intentos', async () => {
    const { svc, db } = setup({ pinSetById: JAVI });
    await expect(svc.payQrChargeFromTerminal(barra, cobro(db), { ...conFicha, pin: PIN })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(db.clientWallet.get(WALLET)).toMatchObject({ pinFails: 0, balanceCents: 12_000 });
  });

  it('cobro de otro local, caducado, de otro grupo o ficha copiada: ni se cobra ni se gasta un intento', async () => {
    const { svc, db } = setup();
    const caducado = cobro(db, { expiresAt: new Date(NOW.getTime() - 1) });
    await expect(svc.payQrChargeFromTerminal(barra, caducado, { ...conFicha, pin: '1111' })).rejects.toThrow(/caducado/);
    await expect(svc.payQrChargeFromTerminal(terraza, cobro(db), { ...conFicha, pin: '1111' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      svc.payQrChargeFromTerminal(neon, cobro(db, { tenantId: NEON }), { ...conFicha, pin: '1111' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      svc.payQrChargeFromTerminal(barra, cobro(db), { card: FICHA, uid: '04FFFFFFFFFFFF', pin: '1111' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(db.clientWallet.get(WALLET)).toMatchObject({ pinFails: 0, balanceCents: 12_000 });
  });

  it('¿se pagó? (tras un corte): el estado del cobro de su local, nunca el saldo que le queda', async () => {
    const { svc, db } = setup();
    const req = cobro(db);
    await expect(svc.qrChargeStatusForTerminal(barra, req)).resolves.toMatchObject({ status: 'PENDING', newBalanceCents: null });
    await svc.payQrChargeFromTerminal(barra, req, { ...conFicha, pin: PIN });
    await expect(svc.qrChargeStatusForTerminal(barra, req)).resolves.toMatchObject({ status: 'ACCEPTED', newBalanceCents: null });
    await expect(svc.qrChargeStatusForTerminal(terraza, req)).rejects.toBeInstanceOf(NotFoundException);
    const caducado = cobro(db, { expiresAt: new Date(NOW.getTime() - 1) });
    await expect(svc.qrChargeStatusForTerminal(barra, caducado)).resolves.toMatchObject({ status: 'EXPIRED' });
  });

  it('no le llega: no se cobra nada y el cobro sigue libre para otro saldo', async () => {
    const { svc, db } = setup({ balanceCents: 3_000 });
    const req = cobro(db);
    await expect(svc.payQrChargeFromTerminal(barra, req, { ...conFicha, pin: PIN })).rejects.toThrow(/saldo suficiente/);
    expect(db.walletChargeRequest.get(req)).toMatchObject({ status: 'PENDING', walletId: null });
    expect(db.walletConsumption.rows.size).toBe(0);
  });
});
