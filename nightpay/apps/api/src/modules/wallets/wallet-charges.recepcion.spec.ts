import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { WalletChargesService } from './wallet-charges.service';
import { hashPin, verifyPin } from './wallet-pin';

/**
 * Recepción en el datáfono: el saldo que acaba de recargar ESTE datáfono (en
 * sus 15 min) recibe su ficha y el PIN que el cliente teclea en él (suyo, no
 * del personal). La ficha acercada para recargar dice de qué saldo es sin
 * enseñarlo. Y al devolver el saldo («Me voy»), su ficha vuelve al stock.
 */

type Row = Record<string, unknown>;
interface Args { where?: Row; data?: Row; select?: Row; orderBy?: Record<string, 'asc' | 'desc'>; take?: number }

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'NOT') return !matches(row, cond as Row);
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as { not?: unknown; in?: unknown[] };
      if ('not' in c) return row[key] !== c.not;
      if ('in' in c) return (c.in ?? []).includes(row[key]);
    }
    return row[key] === cond;
  });
}

function table(prefix: string, defaults: Row = {}) {
  const t = {
    rows: new Map<string, Row>(),
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
    findMany: vi.fn(async (a: Args): Promise<Row[]> => t.list(a)),
    count: vi.fn(async (a: Args): Promise<number> => t.list(a).length),
    createMany: vi.fn(async (a: { data: Row[] }): Promise<{ count: number }> => {
      a.data.forEach((d, i) => t.put({ id: `${prefix}-m${t.rows.size + i + 1}`, ...d }));
      return { count: a.data.length };
    }),
    create: vi.fn(async (a: Args): Promise<Row> => t.put({ id: `${prefix}-${t.rows.size + 1}`, createdAt: new Date(), ...a.data })),
    update: vi.fn(async (a: Args): Promise<Row> => t.put({ ...t.list(a)[0], ...a.data })),
    updateMany: vi.fn(async (a: Args): Promise<{ count: number }> => {
      const hit = t.list(a);
      hit.forEach((r) => t.put({ ...r, ...a.data }));
      return { count: hit.length };
    }),
  };
  return t;
}

const NOW = new Date('2026-10-21T01:10:00+02:00');
const PEPPER = 'clave-del-servidor-nightpay-0123456789abcdef';
const SALA = '3f2b8c1e-6a4d-4f7e-9b21-5c8d0e1f2a01';
const NEON = '8a7b6c5d-4e3f-4a2b-8c1d-0e9f8a7b6c03';
const WALLET = 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70';
const FICHA = 'q3VbX9kLmN2pR7sT4wYz1A';
const OTRA = 'zzzzX9kLmN2pR7sT4wYz1A';
const recepcion = { terminalId: 'term-recepcion', tenantId: SALA };
const barra = { terminalId: 'term-barra', tenantId: SALA };
let OLD_PIN = '';

function setup(o: { cashBy?: Row | null; wallet?: Row } = {}) {
  const tables = {
    clientWallet: table('w', { walletGroup: 'grupo', mergedIntoId: null, blockedAt: null, closeRequestedAt: null, pinHash: null, pinSetById: null }),
    walletCard: table('card', { uid: null, walletId: null, status: 'STOCK', venueId: SALA }),
    walletCashTopUp: table('cash'),
    walletCardEvent: table('ev'),
    walletPayout: table('payout'),
    payment: table('pay'),
    walletConsumption: table('cons'),
    walletPasskey: table('pk'),
    venue: table('venue', { pausedAt: null, business: null, paymentMethods: null }),
  };
  const $queryRaw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    if (text.includes('wallet_cash_topups')) {
      // Lo que entró en efectivo y lo devuelto en efectivo del saldo (sin cadena: no hay sumados).
      const cashIn = tables.walletCashTopUp.list({ where: { walletId: values[0] } }).reduce((a, r) => a + Number(r.amountCents), 0);
      const cashOut = tables.walletPayout
        .list({ where: { walletId: values[0], method: 'CASH', status: 'DONE' } })
        .reduce((a, r) => a + Number(r.amountCents), 0);
      return [{ inCents: cashIn, inWindowCents: cashIn, outCents: cashOut, outWindowCents: cashOut }];
    }
    if (text.includes('FROM wallet_cards')) return tables.walletCard.list({ where: { token: values[0] } });
    return tables.clientWallet.list({ where: { id: values[0] } });
  });
  const tx = { ...tables, $queryRaw, $executeRaw: vi.fn(async () => 0) };
  const run = async (fn: (t: typeof tx) => unknown) => fn(tx);
  const prisma = { ...tx, asSystem: vi.fn(run), acrossVenues: vi.fn(run) };
  tables.venue.put({ id: SALA, name: 'Sala Bambú', walletGroup: 'grupo' });
  tables.venue.put({ id: NEON, name: 'Club Neón', walletGroup: 'otro' });
  tables.clientWallet.put({ id: WALLET, tenantId: SALA, shortCode: 'K7Q4M2', balanceCents: 5_000, status: 'ACTIVE', qrToken: 'enlace-del-saldo', ...o.wallet });
  if (o.cashBy !== null) {
    tables.walletCashTopUp.put({ id: 'ct-1', walletId: WALLET, tenantId: SALA, amountCents: 5_000, takenByUserId: null, terminalId: 'term-recepcion', createdAt: NOW, ...o.cashBy });
  }
  tables.walletCard.put({ id: 'card-1', token: FICHA });
  const audit = { log: vi.fn(async (_e: Record<string, unknown>) => undefined) };
  const totp = { assertForUser: vi.fn(), isEnabled: vi.fn().mockResolvedValue(true) };
  const svc = new WalletChargesService(prisma as never, audit as never, { get: vi.fn() } as never, totp as never);
  return { svc, db: tables, audit };
}

beforeAll(async () => {
  OLD_PIN = await hashPin('1593', PEPPER);
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

describe('el saldo recién recargado en el datáfono', () => {
  it('lo ve el datáfono que lo recargó, en sus 15 min: su código, saldo, PIN y ficha', async () => {
    const { svc } = setup();
    await expect(svc.receptionWallet(recepcion, WALLET)).resolves.toEqual({
      walletId: WALLET, code: 'K7Q-4M2', balanceCents: 5_000, hasPin: false, hasCard: false,
    });
  });

  it('otro datáfono, pasados los 15 min o una recarga de una persona: como si no existiera', async () => {
    await expect(setup().svc.receptionWallet(barra, WALLET)).rejects.toBeInstanceOf(NotFoundException);
    const tarde = setup({ cashBy: { createdAt: new Date(NOW.getTime() - 16 * 60_000) } });
    await expect(tarde.svc.receptionWallet(recepcion, WALLET)).rejects.toBeInstanceOf(NotFoundException);
    const deUnaPersona = setup({ cashBy: { terminalId: null, takenByUserId: 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d03' } });
    await expect(deUnaPersona.svc.receptionWallet(recepcion, WALLET)).rejects.toBeInstanceOf(NotFoundException);
    await expect(setup().svc.receptionWallet({ ...recepcion, tenantId: NEON }, WALLET)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('también vale la recarga con tarjeta que cobró este datáfono (su venta de Paytef)', async () => {
    const { svc, db } = setup({ cashBy: null });
    db.payment.put({ id: 'p-1', walletId: WALLET, createdByUserId: null, posTerminalId: 'term-recepcion', authorizedAt: NOW, createdAt: NOW });
    await expect(svc.receptionWallet(recepcion, WALLET)).resolves.toMatchObject({ walletId: WALLET });
    await expect(svc.receptionWallet(barra, WALLET)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('le da la ficha acercada (sin persona: queda el datáfono) y una ficha que no es nuestra no vale', async () => {
    const { svc, db, audit } = setup();
    await expect(svc.linkCardFromTerminal(recepcion, { walletId: WALLET, card: FICHA, uid: '04:a2:3b:5c:1d:80:00' })).resolves.toMatchObject({
      hasCard: true,
    });
    expect(db.walletCard.get('card-1')).toMatchObject({
      walletId: WALLET, status: 'ISSUED', uid: '04A23B5C1D8000', linkedById: null, linkedAt: NOW, venueId: SALA,
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'wallet.card_linked', payload: expect.objectContaining({ terminalId: 'term-recepcion' }) }),
    );
    await expect(svc.linkCardFromTerminal(recepcion, { walletId: WALLET, card: 'ficha/rara' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.linkCardFromTerminal(barra, { walletId: WALLET, card: FICHA })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('el cliente elige su PIN en el datáfono: es suyo (vale para pagar en el datáfono) y uno ya puesto no se cambia', async () => {
    const { svc, db, audit } = setup();
    await expect(svc.setPinFromTerminal(recepcion, WALLET, '4827')).resolves.toMatchObject({ hasPin: true });
    const w = db.clientWallet.get(WALLET);
    expect(w.pinSetById).toBeNull();
    expect(await verifyPin('4827', String(w.pinHash), PEPPER)).toBe(true);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'wallet.pin_set', payload: { where: 'terminal', terminalId: 'term-recepcion' } }));
    await expect(svc.setPinFromTerminal(recepcion, WALLET, '7391')).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.setPinFromTerminal(recepcion, WALLET, '1111')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('la ficha acercada para recargar', () => {
  it('dice de qué saldo es sin enseñarlo (también de uno ya gastado); de otro grupo, no', async () => {
    const { svc, db } = setup({ wallet: { balanceCents: 0, status: 'DEPLETED', pinHash: OLD_PIN } });
    db.walletCard.put({ id: 'card-1', token: FICHA, walletId: WALLET, status: 'ISSUED' });
    await expect(svc.lookupCardForReception(SALA, { card: FICHA })).resolves.toEqual({
      walletId: WALLET, codeHint: 'K7Q-•••', hasPin: true, isHomeVenue: true,
    });
    await expect(svc.lookupCardForReception(NEON, { card: FICHA })).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.lookupCardForReception(SALA, { card: OTRA })).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('«Me voy»: al devolver el saldo, su ficha vuelve al stock', () => {
  it('en efectivo: saldo cerrado y la ficha RETURNED, en el stock del local que lo devuelve', async () => {
    const { svc, db } = setup({ wallet: { closeRequestedAt: NOW } });
    db.walletCard.put({ id: 'card-1', token: FICHA, walletId: WALLET, status: 'ISSUED', venueId: SALA });
    const manager = { userId: 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d03', role: 'MANAGER' as const, tenantId: SALA };
    // Recarga en efectivo → se devuelve en efectivo (la tarjeta solo cubre las recargas con tarjeta).
    await expect(svc.payout(manager, WALLET, { method: 'CASH' })).resolves.toEqual({ refundedCents: 5_000, method: 'CASH' });
    expect(db.clientWallet.get(WALLET)).toMatchObject({ balanceCents: 0, status: 'REFUNDED' });
    expect(db.walletCard.get('card-1')).toMatchObject({ status: 'RETURNED', walletId: null, returnedAt: NOW });
  });
});

describe('la página del saldo del cliente', () => {
  it('la recarga en efectivo sale en sus movimientos', async () => {
    const { svc } = setup();
    const state = await svc.clientState('enlace-del-saldo');
    expect(state.movements).toEqual([
      expect.objectContaining({ kind: 'topup', amountCents: 5_000, label: 'Recarga en efectivo', venueName: 'Sala Bambú' }),
    ]);
  });
});
