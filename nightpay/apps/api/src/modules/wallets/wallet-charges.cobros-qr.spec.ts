import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@nightpay/db';
import { WalletChargesService } from './wallet-charges.service';
import { hashPin } from './wallet-pin';

/**
 * Cobros con QR que el cliente no puede pagar con su móvil: los ve el
 * encargado y los aprueba otra persona (sin Face ID), o se pagan con el
 * código + PIN. Se descuenta justo el importe o nada (rollback). Además, la
 * recarga recién hecha, las referencias del saldo y los textos de su página.
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
    pick: (r: Row, select?: Row): Row => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, r[k]])) : { ...r }),
    findUnique: vi.fn(async (a: Args): Promise<Row | null> => t.list(a).map((r) => t.pick(r, a.select))[0] ?? null),
    findFirst: vi.fn(async (a: Args): Promise<Row | null> => t.list(a).map((r) => t.pick(r, a.select))[0] ?? null),
    findMany: vi.fn(async (a: Args): Promise<Row[]> => t.list(a).map((r) => t.pick(r, a.select))),
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

const MIN = 60_000;
const NOW = new Date('2026-10-17T03:05:00+02:00'); // sábado noche en Madrid
const PEPPER = 'clave-del-servidor-nightpay-0123456789abcdef';
const PIN = '4827';
let PIN_HASH = '';

const SALA = '3f2b8c1e-6a4d-4f7e-9b21-5c8d0e1f2a01'; // Sala Bambú (Madrid)
const NORTE = '3f2b8c1e-6a4d-4f7e-9b21-5c8d0e1f2a02'; // Bambú Norte (Alcobendas), mismo grupo
const NEON = '8a7b6c5d-4e3f-4a2b-8c1d-0e9f8a7b6c03'; // Club Neón (Valencia), otro dueño
const LOLA = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d01';
const CARLA = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d02';
const JAVI = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d03';
const MARTA = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d04';
const NEREA = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d07';
const WALLET = 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70';
const WALLET_NORTE = 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f72';

const lola = { userId: LOLA, role: 'OPERATOR' as const, tenantId: SALA };
const carla = { userId: CARLA, role: 'OPERATOR' as const, tenantId: SALA };
const javi = { userId: JAVI, role: 'MANAGER' as const, tenantId: SALA };
const marta = { userId: MARTA, role: 'OWNER' as const, tenantId: SALA };
const dani = { userId: 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d05', role: 'WAITER' as const, tenantId: SALA };
const duenoNeon = { userId: 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d08', role: 'OWNER' as const, tenantId: NEON };

function setup() {
  const tables = {
    clientWallet: table('w', {
      walletGroup: 'grupo-bambu', identifier: null, closeRequestedAt: null, mergedIntoId: null, blockedAt: null,
      pinHash: PIN_HASH, pinFails: 0, pinLockedAt: null, pinFailedAt: null, pinSetById: null, status: 'ACTIVE',
    }),
    walletCard: table('card'),
    walletChargeRequest: table('req', { tenantId: SALA, walletId: null, decidedAt: null, status: 'PENDING', category: 'CHICA_SERVICE' }),
    // El mapa del dinero: líneas de cada cobro y su referencia (C-0001).
    paymentLine: Object.assign(table('line'), { createMany: vi.fn(async () => ({ count: 0 })) }),
    chargeRefCounter: { upsert: vi.fn(async () => ({ lastRef: 1 })) },
    walletConsumption: table('cons', { tipCents: 0, notes: null, reversedAt: null }),
    operatorEarning: table('earn'),
    walletPayout: table('po'),
    walletPasskey: table('pk'),
    payment: table('pay'),
    walletCashTopUp: table('cash'),
    user: table('user', { commissionBps: null }),
    venue: table('venue', { pausedAt: null, business: null, operatorCommissionDefaults: { CHICA_SERVICE: 6000 } }),
  };
  const $queryRaw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = Prisma.sql(strings, ...values);
    return q.text.includes('FROM client_wallets') ? tables.clientWallet.list({ where: { id: values[0] } }) : [];
  });
  // El pago con el saldo deja su evento (detalle del pago) en SQL crudo.
  const tx = { ...tables, $queryRaw, $executeRaw: vi.fn(async () => 1) };
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
  tables.user.put({ id: LOLA, role: 'OPERATOR', displayName: 'Lola', email: 'lola@salabambu.es' });
  tables.user.put({ id: NEREA, role: 'OPERATOR', displayName: null, email: 'nerea@salabambu.es' });
  tables.user.put({ id: JAVI, role: 'MANAGER', displayName: 'Javi', email: 'javi@salabambu.es' });
  tables.clientWallet.put({ id: WALLET, tenantId: SALA, shortCode: 'K7Q4M2', qrToken: 'qrTokenDelClienteK7Q4M2xx', balanceCents: 12_000 });
  tables.clientWallet.put({ id: WALLET_NORTE, tenantId: NORTE, shortCode: 'H8M2R5', qrToken: 'qrTokenNorte', balanceCents: 4_000 });
  tables.payment.put({ id: 'pay-1', walletId: WALLET, createdByUserId: LOLA, authorizedAt: new Date(NOW.getTime() - 5 * MIN), createdAt: new Date(NOW.getTime() - 6 * MIN) });
  const audit = { log: vi.fn(async (_e: { action: string; payload: Record<string, unknown> }) => undefined) };
  const svc = new WalletChargesService(prisma as never, audit as never, { get: vi.fn() } as never, { isEnabled: vi.fn(async () => true), assertForUser: vi.fn(async () => undefined) } as never);
  return { svc, db: tables, audit };
}

/** El cobro con QR de 40 € que hizo Lola hace 1 min (Reservado 30 min). */
function cobro(db: ReturnType<typeof setup>['db'], o: Row = {}): string {
  const row = db.walletChargeRequest.put({
    id: `req-${db.walletChargeRequest.rows.size + 1}`, requestedByUserId: LOLA, amountCents: 4_000, serviceName: 'Reservado 30 min',
    payToken: `qr-${db.walletChargeRequest.rows.size + 1}`, createdAt: new Date(NOW.getTime() - MIN), expiresAt: new Date(NOW.getTime() + 4 * MIN), ...o,
  });
  return String(row.id);
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

describe('el encargado ve los cobros con QR que nadie ha pagado', () => {
  it('solo los de su local, sin pagar, sin caducar y con QR; el más reciente primero', async () => {
    const { svc, db } = setup();
    const deLola = cobro(db);
    const deNerea = cobro(db, { requestedByUserId: NEREA, createdAt: new Date(NOW.getTime() - 3 * MIN) });
    cobro(db, { expiresAt: new Date(NOW.getTime() - 1000) });
    cobro(db, { walletId: WALLET });
    cobro(db, { status: 'ACCEPTED' });
    cobro(db, { tenantId: NEON });
    cobro(db, { payToken: null });
    await expect(svc.pendingQrCharges(javi)).resolves.toEqual([
      { id: deLola, amountCents: 4_000, serviceName: 'Reservado 30 min', requestedByName: 'Lola',
        createdAt: '2026-10-17T01:04:00.000Z', expiresAt: '2026-10-17T01:09:00.000Z' },
      expect.objectContaining({ id: deNerea, requestedByName: 'nerea@salabambu.es' }),
    ]);
  });

  it('la chica o el camarero no los ven', async () => {
    const { svc, db } = setup();
    cobro(db);
    await expect(svc.pendingQrCharges(lola)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.pendingQrCharges(dani)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('aprobar sin Face ID (cliente sin batería): hacen falta dos personas', () => {
  it('sin el código de quien aprueba no se cobra nada', async () => {
    const { svc, db } = setup();
    const req = cobro(db);
    await expect(svc.approveWithoutFaceId(javi, req, WALLET)).rejects.toMatchObject({ response: { code: 'TOTP_REQUIRED' } });
    expect(db.clientWallet.get(WALLET)).toMatchObject({ balanceCents: 12_000 });
    expect(db.walletConsumption.list()).toHaveLength(0);
  });

  it('el encargado lo cobra del saldo que elige: justo el importe, consumo, parte de la chica y auditoría', async () => {
    const { svc, db, audit } = setup();
    const req = cobro(db);
    await expect(svc.approveWithoutFaceId(javi, req, WALLET, '123456')).resolves.toMatchObject({ status: 'ACCEPTED', newBalanceCents: 8_000 });
    expect(db.clientWallet.get(WALLET)).toMatchObject({ balanceCents: 8_000, status: 'ACTIVE' });
    const [consumo] = db.walletConsumption.list();
    expect(consumo).toMatchObject({
      tenantId: SALA, walletId: WALLET, amountCents: 4_000, providedByUserId: LOLA, category: 'CHICA_SERVICE',
      notes: 'Reservado 30 min', idempotencyKey: `charge-request:${req}`,
    });
    expect(db.operatorEarning.list()).toEqual([
      expect.objectContaining({ operatorId: LOLA, consumptionId: consumo!.id, commissionBps: 6000, commissionCents: 2_400 }),
    ]);
    expect(db.walletChargeRequest.get(req)).toMatchObject({ status: 'ACCEPTED', walletId: WALLET, consumptionId: consumo!.id, decidedAt: NOW });
    expect(audit.log).toHaveBeenCalledWith({
      action: 'wallet.charge_without_faceid', tenantId: SALA, actorId: JAVI, targetType: 'ClientWallet', targetId: WALLET,
      payload: { requestId: req, amountCents: 4_000, requestedBy: LOLA },
    });
  });

  it('un saldo de otro local del grupo que se queda justo a 0 pasa a gastado (DEPLETED)', async () => {
    const { svc, db } = setup();
    await svc.approveWithoutFaceId(marta, cobro(db), WALLET_NORTE, '123456');
    expect(db.clientWallet.get(WALLET_NORTE)).toMatchObject({ balanceCents: 0, status: 'DEPLETED' });
    expect(db.walletConsumption.list()).toEqual([expect.objectContaining({ tenantId: SALA, walletId: WALLET_NORTE })]);
  });

  it('ni la chica, ni el camarero, ni el encargado aprueban su propio cobro', async () => {
    const { svc, db, audit } = setup();
    const req = cobro(db);
    await expect(svc.approveWithoutFaceId(lola, req, WALLET, '123456')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.approveWithoutFaceId(dani, req, WALLET, '123456')).rejects.toBeInstanceOf(ForbiddenException);
    const deJavi = cobro(db, { requestedByUserId: JAVI });
    await expect(svc.approveWithoutFaceId(javi, deJavi, WALLET, '123456')).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.clientWallet.get(WALLET)).toMatchObject({ balanceCents: 12_000 });
    expect(db.walletConsumption.rows.size).toBe(0);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('saldo de otro dueño o cobro de otro local: como si no existieran', async () => {
    const { svc, db } = setup();
    await expect(svc.approveWithoutFaceId(duenoNeon, cobro(db), WALLET, '123456')).rejects.toBeInstanceOf(NotFoundException);
    const deNeon = cobro(db, { tenantId: NEON });
    await expect(svc.approveWithoutFaceId(javi, deNeon, WALLET, '123456')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.approveWithoutFaceId(javi, cobro(db, { payToken: null }), WALLET, '123456')).rejects.toBeInstanceOf(NotFoundException);
    expect(db.clientWallet.get(WALLET)).toMatchObject({ balanceCents: 12_000 });
  });

  it('sin saldo suficiente no se cobra nada y el cobro queda libre para otro saldo', async () => {
    const { svc, db, audit } = setup();
    db.clientWallet.put({ ...db.clientWallet.get(WALLET), balanceCents: 3_999 });
    const req = cobro(db);
    await expect(svc.approveWithoutFaceId(javi, req, WALLET, '123456')).rejects.toBeInstanceOf(ConflictException);
    expect(db.clientWallet.get(WALLET)).toMatchObject({ balanceCents: 3_999 });
    expect(db.walletChargeRequest.get(req)).toMatchObject({ status: 'PENDING', walletId: null });
    expect(db.walletConsumption.rows.size + db.operatorEarning.rows.size).toBe(0);
    expect(audit.log).not.toHaveBeenCalled();
    await expect(svc.approveWithoutFaceId(javi, req, WALLET_NORTE, '123456')).resolves.toMatchObject({ newBalanceCents: 0 });
  });
});

describe('pagar con Face ID un saldo de otro dueño', () => {
  it('no vale en este local: 409, no se descuenta nada y el cobro sigue libre', async () => {
    const { svc, db } = setup();
    const WALLET_NEON = 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f73';
    db.clientWallet.put({ id: WALLET_NEON, tenantId: NEON, walletGroup: 'grupo-neon', shortCode: 'N3R7W2', balanceCents: 20_000 });
    const req = cobro(db);
    await expect(svc.payQrCharge('qr-1', WALLET_NEON)).rejects.toBeInstanceOf(ConflictException);
    expect(db.clientWallet.get(WALLET_NEON)).toMatchObject({ balanceCents: 20_000 });
    expect(db.walletChargeRequest.get(req)).toMatchObject({ status: 'PENDING', walletId: null });
    await expect(svc.payQrCharge('qr-1', WALLET)).resolves.toEqual({ amountCents: 4_000, balanceCents: 8_000, code: null });
  });
});

describe('pagar con el código y el PIN', () => {
  it('con el PIN bueno se descuenta justo el importe; sin saldo suficiente, nada (y el PIN no cuenta como fallo)', async () => {
    const { svc, db } = setup();
    const req = cobro(db, { amountCents: 12_001 });
    await expect(svc.payQrChargeWithPin(lola, req, { code: 'K7Q-4M2', pin: PIN })).rejects.toBeInstanceOf(ConflictException);
    expect(db.clientWallet.get(WALLET)).toMatchObject({ balanceCents: 12_000, pinFails: 0 });
    expect(db.walletChargeRequest.get(req)).toMatchObject({ status: 'PENDING', walletId: null });

    await expect(svc.payQrChargeWithPin(lola, cobro(db, { amountCents: 2_550 }), { code: 'K7Q-4M2', pin: PIN })).resolves.toMatchObject({
      status: 'ACCEPTED', amountCents: 2_550, newBalanceCents: 9_450,
    });
    expect(db.clientWallet.get(WALLET)).toMatchObject({ balanceCents: 9_450 });
  });
});

describe('la recarga que la chica acaba de cobrar (por su id)', () => {
  it('la chica que la cobró, en sus 15 min; después, otra chica u otro dueño: como si no existiera', async () => {
    const { svc } = setup();
    await expect(svc.lookupById(lola, WALLET)).resolves.toMatchObject({ walletId: WALLET, code: 'K7Q-4M2', balanceCents: 12_000 });
    await expect(svc.lookupById(carla, WALLET)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.lookupById(duenoNeon, WALLET)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.lookupById(javi, 'd4e5f6a7-0000-4d0e-8f1a-000000000000')).rejects.toBeInstanceOf(NotFoundException);
    vi.setSystemTime(new Date(NOW.getTime() + 11 * MIN));
    await expect(svc.lookupById(lola, WALLET)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.lookupById(javi, WALLET)).resolves.toMatchObject({ walletId: WALLET, isHomeVenue: true });
  });
});

describe('referencias del saldo y su página', () => {
  it('por enlace o por id: solo el id y el código (nada de PIN ni saldo); uno que no existe → 404', async () => {
    const { svc } = setup();
    await expect(svc.walletRefByToken('qrTokenDelClienteK7Q4M2xx')).resolves.toEqual({ id: WALLET, shortCode: 'K7Q4M2' });
    await expect(svc.walletRefById(WALLET)).resolves.toEqual({ id: WALLET, shortCode: 'K7Q4M2' });
    await expect(svc.walletRefByToken('enlace-viejo')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.walletRefById('d4e5f6a7-0000-4d0e-8f1a-000000000000')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('cada consumo se ve con su nota o, sin nota, con el nombre de su sección en ese local (y la propina incluida)', async () => {
    const { svc, db } = setup();
    const at = (min: number) => new Date(NOW.getTime() - min * MIN);
    const consumos: Array<[string, string | null, number]> = [
      ['VENUE_BAR', null, 1], ['VENUE_ROOM', null, 2], ['VENUE_FOOD', null, 3], ['EXTRA', null, 4],
      ['CHICA_SERVICE', null, 5], ['CATEGORIA_NUEVA', null, 6], ['VENUE_BAR', 'Botella Moët\nmesa 4', 7],
    ];
    consumos.forEach(([category, notes, min], i) =>
      db.walletConsumption.put({ id: `c-${i}`, walletId: WALLET, tenantId: NORTE, category, notes, amountCents: 1_000, tipCents: 200, createdAt: at(min) }),
    );
    const state = await svc.clientState('qrTokenDelClienteK7Q4M2xx');
    // Los nombres de Ajustes → Secciones (los de fábrica si el local no los cambió); lo que no es una sección, «Otros».
    expect(state.movements.map((m) => m.label)).toEqual(['Copas', 'Habitaciones', 'Comida', 'Otros', 'Servicios', 'Otros', 'Botella Moët']);
    // Con el color de su sección (el de fábrica si el local no eligió otro).
    // Sin cobro del saldo que lo abra (consumos sueltos de antes): sin detalle.
    expect(state.movements[0]).toEqual({ kind: 'consumption', amountCents: -1_200, label: 'Copas', venueName: 'Bambú Norte (Alcobendas)', at: at(1).toISOString(), ref: null, color: '#00e0ae', detail: null });
  });

  it('con las secciones renombradas en ese local, el consumo dice su nombre (el de cada local)', async () => {
    const { svc, db } = setup();
    db.venue.put({ id: NORTE, name: 'Bambú Norte (Alcobendas)', walletGroup: 'grupo-bambu', sections: { VENUE_BAR: { label: 'Barra de arriba' } } });
    db.walletConsumption.put({ id: 'c-r', walletId: WALLET, tenantId: NORTE, category: 'VENUE_BAR', notes: null, amountCents: 1_000, tipCents: 0, createdAt: new Date(NOW.getTime() - MIN) });
    const state = await svc.clientState('qrTokenDelClienteK7Q4M2xx');
    expect(state.movements[0]).toMatchObject({ label: 'Barra de arriba', color: '#00e0ae' });
    // La tarjeta de arriba: el local del saldo; sin NFC, sin número.
    expect(state).toMatchObject({ venueName: 'Sala Bambú (Madrid)', hasCard: false, fichaNumber: null });
  });
});

describe('terminar una devolución del saldo: lo que se comprueba antes de tocar nada', () => {
  it('la compañera no devuelve en efectivo; el dueño de otro grupo no ve el saldo; sin pedirla antes, el saldo no se devuelve', async () => {
    const { svc, db } = setup();
    await expect(svc.payout(lola, WALLET, { method: 'CASH' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.payout(duenoNeon, WALLET, { totpCode: '123456', method: 'CASH' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.payout(marta, WALLET, { totpCode: '123456', method: 'CASH' })).rejects.toMatchObject({ response: { code: 'SALDO_NO_SE_DEVUELVE' } });
    expect(db.walletPayout.rows.size).toBe(0);
  });

  it('pedida antes del cambio pero ya sin nada que devolver → 409 y nada cambia', async () => {
    const { svc, db } = setup();
    db.clientWallet.put({ ...db.clientWallet.get(WALLET), balanceCents: 0, status: 'DEPLETED', closeRequestedAt: new Date(NOW.getTime() - MIN) });
    await expect(svc.payout(marta, WALLET, { totpCode: '123456', method: 'CASH' })).rejects.toThrow(/nada que devolver/);
    expect(db.walletPayout.rows.size).toBe(0);
    expect(db.clientWallet.get(WALLET)).toMatchObject({ balanceCents: 0, status: 'DEPLETED' });
  });
});
