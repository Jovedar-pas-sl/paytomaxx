import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@nightpay/db';
import { WalletChargesService } from './wallet-charges.service';
import { hashPin, verifyPin } from './wallet-pin';

/**
 * PIN del saldo (pagar sin sacar el móvil): bloqueo tras 5 fallos, fallos
 * viejos que caducan, quién lo elige y quién lo desbloquea. Base en memoria
 * con rollback (como la transacción de verdad) y el hash real del PIN.
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

const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-10-17T01:30:00+02:00'); // sábado noche en Madrid
const PEPPER = 'clave-del-servidor-nightpay-0123456789abcdef';
const PIN = '4827';
let PIN_HASH = '';

const SALA = '3f2b8c1e-6a4d-4f7e-9b21-5c8d0e1f2a01'; // Sala Bambú (Madrid)
const NEON = '8a7b6c5d-4e3f-4a2b-8c1d-0e9f8a7b6c03'; // Club Neón (Valencia), otro dueño
const LOLA = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d01';
const CARLA = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d02';
const JAVI = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d03';
const MARTA = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d04';
const DANI = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d05';
const WALLET = 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70';

const lola = { userId: LOLA, role: 'OPERATOR' as const, tenantId: SALA };
const carla = { userId: CARLA, role: 'OPERATOR' as const, tenantId: SALA };
const javi = { userId: JAVI, role: 'MANAGER' as const, tenantId: SALA };
const marta = { userId: MARTA, role: 'OWNER' as const, tenantId: SALA };
const dani = { userId: DANI, role: 'WAITER' as const, tenantId: SALA };
const encargadoNeon = { userId: 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d06', role: 'MANAGER' as const, tenantId: NEON };

function setup(wallet: Row = {}, topUp: Row | null = null) {
  const tables = {
    clientWallet: table('w'),
    walletCard: table('card'),
    walletChargeRequest: table('req', { walletId: null, decidedAt: null }),
    // El mapa del dinero: líneas de cada cobro y su referencia (C-0001).
    paymentLine: Object.assign(table('line'), { createMany: vi.fn(async () => ({ count: 0 })), findMany: vi.fn(async () => []) }),
    chargeRefCounter: { upsert: vi.fn(async () => ({ lastRef: 1 })) },
    walletConsumption: table('cons'),
    operatorEarning: table('earn'),
    payment: table('pay'),
    walletCashTopUp: table('cash'),
    user: table('user'),
    venue: table('venue', { pausedAt: null, business: null, operatorCommissionDefaults: { CHICA_SERVICE: 6000 } }),
  };
  const queries: Prisma.Sql[] = [];
  const $queryRaw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push(Prisma.sql(strings, ...values));
    return tables.clientWallet.list({ where: { id: values[0] } });
  });
  // El pago con el saldo deja su evento (detalle del pago) en SQL crudo.
  const tx = { ...tables, $queryRaw, $executeRaw: vi.fn(async () => 1) };
  const all = Object.values(tables);
  // Todo o nada: si la transacción falla, la base vuelve a como estaba.
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
  tables.venue.put({ id: NEON, name: 'Club Neón (Valencia)', walletGroup: 'grupo-neon' });
  tables.user.put({ id: LOLA, role: 'OPERATOR', commissionBps: null, displayName: 'Lola' });
  tables.user.put({ id: CARLA, role: 'OPERATOR', commissionBps: null, displayName: 'Carla' });
  tables.user.put({ id: JAVI, role: 'MANAGER', commissionBps: null, displayName: 'Javi' });
  tables.clientWallet.put({
    id: WALLET, tenantId: SALA, walletGroup: 'grupo-bambu', shortCode: 'K7Q4M2', identifier: null,
    balanceCents: 12_000, status: 'ACTIVE', closeRequestedAt: null, mergedIntoId: null, blockedAt: null,
    pinHash: PIN_HASH, pinFails: 0, pinLockedAt: null, pinFailedAt: null, pinSetById: null, ...wallet,
  });
  if (topUp) tables.payment.put({ id: 'pay-1', walletId: WALLET, createdByUserId: LOLA, createdAt: NOW, ...topUp });
  const audit = { log: vi.fn(async (_e: { action: string; payload: Record<string, unknown> }) => undefined) };
  const svc = new WalletChargesService(prisma as never, audit as never, { get: vi.fn() } as never, { isEnabled: vi.fn(async () => true), assertForUser: vi.fn(async () => undefined) } as never);
  return { svc, db: tables, audit, queries, $queryRaw };
}

/** Un cobro con QR de Lola (40 €), sin pagar, que caduca a los 5 min. */
function cobro(db: ReturnType<typeof setup>['db'], o: Row = {}): string {
  const row = db.walletChargeRequest.put({
    id: `req-${db.walletChargeRequest.rows.size + 1}`, tenantId: SALA, requestedByUserId: LOLA, amountCents: 4_000,
    category: 'CHICA_SERVICE', serviceName: 'Reservado 30 min', payToken: `qr-${db.walletChargeRequest.rows.size}`,
    status: 'PENDING', createdAt: new Date(), expiresAt: new Date(Date.now() + 5 * 60_000), ...o,
  });
  return String(row.id);
}

type Actor = Parameters<WalletChargesService['payQrChargeWithPin']>[0];
const pagar = (svc: WalletChargesService, actor: Actor, req: string, pin: string) =>
  svc.payQrChargeWithPin(actor, req, { code: 'k7q-4m2', pin });

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

describe('PIN fallado: bloqueo del saldo', () => {
  it('cada fallo resta un intento; al 5.º se bloquea, no se cobra nada y queda quién lo tecleó', async () => {
    const { svc, db, audit } = setup();
    const req = cobro(db);
    for (let i = 1; i <= 5; i += 1) {
      await expect(pagar(svc, lola, req, '1111')).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(db.clientWallet.get(WALLET)).toMatchObject({ pinFails: i, pinFailedAt: NOW });
    }
    expect(db.clientWallet.get(WALLET)).toMatchObject({ pinLockedAt: NOW, balanceCents: 12_000 });
    expect(audit.log.mock.calls.map(([e]) => [e.action, e.payload.attemptsLeft])).toEqual([
      ['wallet.pin_failed', 4],
      ['wallet.pin_failed', 3],
      ['wallet.pin_failed', 2],
      ['wallet.pin_failed', 1],
      ['wallet.pin_locked', 0],
    ]);
    expect(audit.log).toHaveBeenLastCalledWith(expect.objectContaining({ actorId: LOLA, tenantId: SALA, targetId: WALLET }));
    expect(db.walletConsumption.rows.size).toBe(0);
    expect(db.walletChargeRequest.get(req)).toMatchObject({ status: 'PENDING', walletId: null });
  });

  it('bloqueado no paga ni con el PIN bueno, tampoco al día siguiente; tras desbloquearlo el encargado, sí', async () => {
    const { svc, db, audit } = setup({ pinFails: 5, pinFailedAt: NOW, pinLockedAt: NOW });
    await expect(pagar(svc, lola, cobro(db), PIN)).rejects.toBeInstanceOf(UnprocessableEntityException);
    vi.setSystemTime(new Date(NOW.getTime() + 24 * HOUR));
    await expect(pagar(svc, lola, cobro(db), PIN)).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(db.clientWallet.get(WALLET)).toMatchObject({ balanceCents: 12_000, pinFails: 5, pinLockedAt: NOW });
    // Bloqueado, los intentos ni cuentan ni se apuntan.
    expect(audit.log).not.toHaveBeenCalled();

    await expect(svc.unlockPin(javi, WALLET)).resolves.toEqual({ ok: true });
    expect(db.clientWallet.get(WALLET)).toMatchObject({ pinFails: 0, pinLockedAt: null });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'wallet.pin_unlocked', actorId: JAVI }));
    await expect(pagar(svc, lola, cobro(db), PIN)).resolves.toMatchObject({ status: 'ACCEPTED', newBalanceCents: 8_000 });
    expect(db.clientWallet.get(WALLET)).toMatchObject({ balanceCents: 8_000 });
  });

  it('acertar pone el contador a cero: los fallos de antes no se suman a los de después', async () => {
    const { svc, db } = setup();
    const req = cobro(db);
    for (let i = 0; i < 3; i += 1) await expect(pagar(svc, lola, req, '9051')).rejects.toThrow(/intentos/);
    await expect(pagar(svc, lola, req, PIN)).resolves.toMatchObject({ status: 'ACCEPTED' });
    expect(db.clientWallet.get(WALLET)).toMatchObject({ pinFails: 0, pinFailedAt: null, balanceCents: 8_000 });

    const otro = cobro(db);
    for (let i = 0; i < 4; i += 1) await expect(pagar(svc, lola, otro, '9051')).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(db.clientWallet.get(WALLET)).toMatchObject({ pinFails: 4, pinLockedAt: null });
  });

  it('los fallos de hace más de 12 h no cuentan; justo a las 12 h, sí', async () => {
    const viejo = setup({ pinFails: 4, pinFailedAt: new Date(NOW.getTime() - 12 * HOUR - 1000) });
    await expect(pagar(viejo.svc, lola, cobro(viejo.db), '9051')).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(viejo.db.clientWallet.get(WALLET)).toMatchObject({ pinFails: 1, pinFailedAt: NOW, pinLockedAt: null });
    expect(viejo.audit.log.mock.calls[0]![0].payload).toEqual({ attemptsLeft: 4 });

    const reciente = setup({ pinFails: 4, pinFailedAt: new Date(NOW.getTime() - 12 * HOUR) });
    await expect(pagar(reciente.svc, lola, cobro(reciente.db), '9051')).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(reciente.db.clientWallet.get(WALLET)).toMatchObject({ pinFails: 5, pinLockedAt: NOW });
  });

  it('sin PIN elegido → 409 sin gastar intento; sin la clave del servidor no se comprueba nada', async () => {
    const sinPin = setup({ pinHash: null });
    await expect(pagar(sinPin.svc, lola, cobro(sinPin.db), PIN)).rejects.toBeInstanceOf(ConflictException);
    expect(sinPin.db.clientWallet.get(WALLET)).toMatchObject({ pinFails: 0, balanceCents: 12_000 });

    const sinClave = setup();
    vi.stubEnv('ENCRYPTION_KEK', 'corta');
    await expect(pagar(sinClave.svc, lola, cobro(sinClave.db), PIN)).rejects.toThrow(/ENCRYPTION_KEK/);
    expect(sinClave.db.clientWallet.get(WALLET)).toMatchObject({ pinFails: 0, balanceCents: 12_000 });
  });

  it('el PIN se lee con su saldo bloqueado (FOR UPDATE), solo ese saldo', async () => {
    const { svc, db, queries } = setup();
    await expect(pagar(svc, lola, cobro(db), '9051')).rejects.toBeInstanceOf(UnprocessableEntityException);
    const pinQuery = queries.find((q) => q.text.includes('"pinHash"'))!;
    expect(pinQuery.text).toMatch(/FROM client_wallets WHERE id = \$1::uuid FOR UPDATE/);
    expect(pinQuery.values).toEqual([WALLET]);
  });

  it('si el saldo ya no está al ir a comprobar el PIN → 404 y no se cobra nada', async () => {
    const { svc, db, $queryRaw } = setup();
    $queryRaw.mockResolvedValueOnce([]);
    const req = cobro(db);
    await expect(pagar(svc, lola, req, PIN)).rejects.toBeInstanceOf(NotFoundException);
    expect(db.walletChargeRequest.get(req)).toMatchObject({ status: 'PENDING', walletId: null });
  });
});

describe('quién puede cobrar con el PIN del cliente', () => {
  it('PIN puesto por el encargado sin el cliente: ni él cobra con ese PIN ni otro paga un cobro hecho por él', async () => {
    const { svc, db } = setup({ pinSetById: JAVI });
    const deJavi = cobro(db, { requestedByUserId: JAVI });
    await expect(pagar(svc, javi, deJavi, PIN)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(pagar(svc, marta, deJavi, PIN)).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.clientWallet.get(WALLET)).toMatchObject({ pinFails: 0, balanceCents: 12_000 });
    // Un cobro de la chica con ese PIN, sí: son dos personas.
    await expect(pagar(svc, lola, cobro(db), PIN)).resolves.toMatchObject({ status: 'ACCEPTED', newBalanceCents: 8_000 });
  });

  it('otra chica o el camarero no pagan el cobro de una compañera (y no gastan intentos)', async () => {
    const { svc, db } = setup();
    const req = cobro(db);
    await expect(pagar(svc, carla, req, '9051')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.payQrChargeWithPin(dani, req, { code: 'K7Q4M2', pin: '9051' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.clientWallet.get(WALLET)).toMatchObject({ pinFails: 0, balanceCents: 12_000 });
  });

  it('un cobro caducado o ya pagado no gasta un intento de PIN', async () => {
    const { svc, db } = setup();
    const caducado = cobro(db, { expiresAt: new Date(NOW.getTime() - 1) });
    const pagado = cobro(db, { status: 'ACCEPTED', walletId: WALLET });
    await expect(pagar(svc, lola, caducado, '9051')).rejects.toBeInstanceOf(ConflictException);
    await expect(pagar(svc, lola, pagado, '9051')).rejects.toBeInstanceOf(ConflictException);
    const deNeon = cobro(db, { tenantId: NEON });
    await expect(pagar(svc, lola, deNeon, '9051')).rejects.toBeInstanceOf(NotFoundException);
    expect(db.clientWallet.get(WALLET)).toMatchObject({ pinFails: 0, pinFailedAt: null });
  });
});

describe('elegir el PIN', () => {
  const MIN = 60_000;

  it('la chica que hizo la recarga, en sus 15 min: se guarda con hash (nunca en claro) y como del cliente', async () => {
    const { svc, db, audit } = setup({ pinHash: null }, { authorizedAt: new Date(NOW.getTime() - 15 * MIN) });
    await expect(svc.setPin(lola, { code: 'k7q 4m2', pin: PIN })).resolves.toMatchObject({ walletId: WALLET, hasPin: true });
    const stored = db.clientWallet.get(WALLET);
    expect(stored).toMatchObject({ pinSetById: null, pinFails: 0, pinLockedAt: null });
    expect(String(stored.pinHash)).not.toContain(PIN);
    expect(await verifyPin(PIN, String(stored.pinHash), PEPPER)).toBe(true);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'wallet.pin_set', payload: { where: 'staff-device', role: 'OPERATOR', afterTopUp: true } }),
    );
  });

  it('pasados los 15 min, otra chica, o una recarga que no fue la primera: no; el encargado sí (y queda como suyo)', async () => {
    const tarde = setup({ pinHash: null }, { authorizedAt: new Date(NOW.getTime() - 15 * MIN - 1) });
    await expect(tarde.svc.setPin(lola, { code: 'K7Q4M2', pin: PIN })).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(tarde.svc.setPin(carla, { code: 'K7Q4M2', pin: PIN })).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(tarde.db.clientWallet.get(WALLET).pinHash).toBeNull();

    const segunda = setup({ pinHash: null }, { authorizedAt: new Date(NOW.getTime() - 72 * HOUR), createdAt: new Date(NOW.getTime() - 72 * HOUR) });
    segunda.db.payment.put({ id: 'pay-2', walletId: WALLET, createdByUserId: LOLA, authorizedAt: NOW, createdAt: NOW });
    await expect(segunda.svc.setPin(lola, { code: 'K7Q4M2', pin: PIN })).rejects.toBeInstanceOf(UnprocessableEntityException);

    await expect(tarde.svc.setPin(javi, { code: 'K7Q4M2', pin: PIN })).resolves.toMatchObject({ hasPin: true });
    expect(tarde.db.clientWallet.get(WALLET)).toMatchObject({ pinSetById: JAVI });
    expect(tarde.audit.log.mock.calls.at(-1)![0].payload).toMatchObject({ afterTopUp: false, role: 'MANAGER' });
  });

  it('un PIN fácil no vale y uno ya puesto no se cambia (solo se borra)', async () => {
    const { svc, db } = setup({ pinHash: null }, { authorizedAt: NOW });
    await expect(svc.setPin(lola, { code: 'K7Q4M2', pin: '1234' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.setPin(lola, { code: 'K7Q4M2', pin: '48a7' })).rejects.toBeInstanceOf(BadRequestException);
    expect(db.clientWallet.get(WALLET).pinHash).toBeNull();
    await svc.setPin(lola, { code: 'K7Q4M2', pin: PIN });
    const first = db.clientWallet.get(WALLET).pinHash;
    await expect(svc.setPin(javi, { code: 'K7Q4M2', pin: '5190' })).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.setPinFromPayer(WALLET, '5190')).rejects.toBeInstanceOf(ConflictException);
    expect(db.clientWallet.get(WALLET).pinHash).toBe(first);
  });

  it('el cliente en su móvil: PIN suyo, apuntado en el local del saldo; un saldo que no existe → 404', async () => {
    const { svc, db, audit } = setup({ pinHash: null });
    await svc.setPinFromPayer(WALLET, PIN);
    expect(db.clientWallet.get(WALLET)).toMatchObject({ pinSetById: null });
    expect(await verifyPin(PIN, String(db.clientWallet.get(WALLET).pinHash), PEPPER)).toBe(true);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ tenantId: SALA, payload: { where: 'client-phone' } }));
    await expect(svc.setPinFromPayer('d4e5f6a7-0000-4d0e-8f1a-000000000000', PIN)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('borrar y desbloquear el PIN: solo el encargado o el dueño del grupo', () => {
  it('el dueño borra el PIN olvidado: todo a cero y el cliente puede elegir otro', async () => {
    const { svc, db, audit } = setup({ pinFails: 5, pinLockedAt: NOW, pinFailedAt: NOW, pinSetById: JAVI });
    await expect(svc.resetPin(marta, WALLET, '123456')).resolves.toEqual({ ok: true });
    expect(db.clientWallet.get(WALLET)).toMatchObject({
      pinHash: null, pinFails: 0, pinLockedAt: null, pinFailedAt: null, pinSetById: null,
    });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'wallet.pin_reset', actorId: MARTA }));
    await svc.setPinFromPayer(WALLET, '5190');
    expect(await verifyPin('5190', String(db.clientWallet.get(WALLET).pinHash), PEPPER)).toBe(true);
  });

  it('la chica o el camarero no; el encargado de un local de otro dueño, como si no existiera', async () => {
    const { svc, db, audit } = setup({ pinFails: 5, pinLockedAt: NOW });
    for (const actor of [lola, dani]) {
      await expect(svc.unlockPin(actor, WALLET)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(svc.resetPin(actor, WALLET, '123456')).rejects.toBeInstanceOf(ForbiddenException);
    }
    await expect(svc.unlockPin(encargadoNeon, WALLET)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.resetPin(encargadoNeon, WALLET, '123456')).rejects.toBeInstanceOf(NotFoundException);
    expect(db.clientWallet.get(WALLET)).toMatchObject({ pinHash: PIN_HASH, pinFails: 5, pinLockedAt: NOW });
    expect(audit.log).not.toHaveBeenCalled();
  });
});
