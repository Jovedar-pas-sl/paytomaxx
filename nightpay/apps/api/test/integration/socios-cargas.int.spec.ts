// Integración (Postgres y Redis de verdad): la API de socios, PR 3 parte A.
// POST /v1/partner/wallet/loads: una carga = una fila de caja (VENUE_COLLECTS)
// + su LOAD + su registro, o nada; topes en la base bajo los candados; el
// efectivo con recepción (la regla de los 1.000 €) en los dos órdenes y a la
// vez; la misma clave a la vez; el alcance antes que nada; el corte de 25 s y
// la clave tomada. Montaje: test/support/socios.ts. Ver README.md.
import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WalletLoad, type WalletLoadBody } from '@nightpay/contracts';
import * as sentry from '../../src/common/observability/sentry';
import { CashTopUpService } from '../../src/modules/wallets/wallet-cash-topup.service';
import {
  business,
  clearRedis,
  connection,
  ficha,
  mountSocios,
  newKey,
  partner,
  venue,
  wallet,
  type Seeded,
  type Socios,
  type TestConnection,
} from '../support/socios';

vi.mock('../../src/common/observability/sentry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/common/observability/sentry')>()),
  reportError: vi.fn(),
}));

let s: Socios;
let reception: CashTopUpService;
const G = `gcargas-${Math.random().toString(36).slice(2, 8)}`;
let X = '';
let A: Seeded;
let A2: Seeded;
let A3: Seeded;
let P = '';
let Q = '';
/** Socio P en A, socio P en A2 y socio Q en A. */
let PA: TestConnection;
let PA2: TestConnection;
let QA: TestConnection;

interface LoadOpts {
  amount?: number;
  key?: string;
  nfcUid?: string;
  description?: string;
  device?: string;
  funding?: string;
  reference?: string;
  body?: unknown;
}

function load(conn: TestConnection, qr: string, o: LoadOpts = {}) {
  const key = o.key ?? newKey();
  return s.app.inject({
    method: 'POST',
    url: '/v1/partner/wallet/loads',
    headers: { authorization: `Bearer ${conn.key}`, 'idempotency-key': key },
    payload: (o.body ?? {
      qr,
      amount: o.amount ?? 2000,
      description: o.description ?? 'Recarga en cajero 0042',
      funding: o.funding ?? 'cash',
      ...(o.nfcUid ? { nfc_uid: o.nfcUid } : {}),
      ...(o.device ? { device: o.device } : {}),
      ...(o.reference ? { reference: o.reference } : {}),
    }) as object,
  });
}

const codeOf = (res: { json: () => unknown }) => (res.json() as { code?: string }).code;
const counts = (walletId: string) =>
  s.sys(async (tx) => ({
    loads: await tx.partnerWalletOperation.count({ where: { walletId, kind: 'LOAD' } }),
    cash: await tx.walletCashTopUp.count({ where: { walletId, partnerConnectionId: { not: null } } }),
    balance: (await tx.clientWallet.findUnique({ where: { id: walletId }, select: { balanceCents: true } }))!.balanceCents,
  }));
const maxAuditId = async () => (await s.sys((tx) => tx.auditEvent.aggregate({ _max: { id: true } })))._max.id ?? 0n;
const auditsSince = (since: bigint) => s.sys((tx) => tx.auditEvent.findMany({ where: { id: { gt: since } }, orderBy: { id: 'asc' } }));

beforeAll(async () => {
  vi.stubEnv('PARTNER_API_ENABLED', 'true');
  vi.stubEnv('PARTNER_API_MODE', 'test');
  vi.stubEnv('EDITION', 'club');
  s = await mountSocios();
  reception = new CashTopUpService(s.prisma, s.audit, s.totp as never);
  X = await business(s, 'Sociedad X');
  const Y = await business(s, 'Sociedad Y');
  A = await venue(s, 'Sala A', G, X);
  A2 = await venue(s, 'Sala A2', G, X);
  A3 = await venue(s, 'Sala A3', G, Y);
  P = await partner(s);
  Q = await partner(s);
  PA = await connection(s, { venueId: A.venueId, businessId: X, partnerId: P });
  PA2 = await connection(s, { venueId: A2.venueId, businessId: X, partnerId: P });
  QA = await connection(s, { venueId: A.venueId, businessId: X, partnerId: Q });
});

beforeEach(async () => {
  await clearRedis(s.redis);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await s?.close();
  vi.unstubAllEnvs();
});

/** Recepción carga en efectivo ese saldo (por su código), como el dueño. */
function receptionTopUp(w: { shortCode: string }, amountCents: number) {
  return reception.topUp(A.venueId, { userId: A.owner, role: 'OWNER' }, { amountCents, idempotencyKey: newKey('rec'), wallet: { code: w.shortCode } });
}

describe('1. una carga: saldo, fila de caja, LOAD y registro, con el mismo `now`', () => {
  it('201 igual a su parse(); la fila de caja (sin comisión ni recibo) con el createdAt de la LOAD; el registro sin qr ni descripción', async () => {
    const w = await wallet(s, A.venueId, G, { balanceCents: 5000 });
    const qr = await ficha(s, w.id, A.venueId, { uid: '04A1B2C3D4E5F6' });
    const since = await maxAuditId();
    const res = await load(PA, qr, { nfcUid: '04:a1:b2:c3:d4:e5:f6', device: 'ATM0042', reference: 'ATM0042-20261205-000731-K7QM' });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as WalletLoadBody;
    expect(WalletLoad.parse(body)).toEqual(body);
    expect(body).toMatchObject({ status: 'succeeded', amount: 2000, balance_after: 7000, device: 'ATM0042', reference: 'ATM0042-20261205-000731-K7QM', livemode: false });
    expect(body.voided_at).toBeUndefined();
    expect(new Date(body.void_until).getTime() - new Date(body.created_at).getTime()).toBe(600_000);
    expect(res.headers['idempotent-replayed']).toBeUndefined();
    const [op] = await s.sys((tx) => tx.partnerWalletOperation.findMany({ where: { walletId: w.id }, include: { cashTopup: true } }));
    expect(op).toMatchObject({ kind: 'LOAD', tenantId: A.venueId, connectionId: PA.id, refKind: 'ficha_nfc', balanceBeforeCents: 5000, balanceAfterCents: 7000 });
    expect(op!.cashTopup).toMatchObject({
      tenantId: A.venueId,
      amountCents: 2000,
      partnerConnectionId: PA.id,
      takenByUserId: null,
      terminalId: null,
      serviceFeeCents: 0,
      serviceFeeBps: null,
      receipt: null,
      createdWallet: false,
      idempotencyKey: `partner:${op!.id}`,
    });
    expect(op!.cashTopup!.createdAt.getTime()).toBe(op!.createdAt.getTime());
    expect(await counts(w.id)).toEqual({ loads: 1, cash: 1, balance: 7000 });
    const audits = await auditsSince(since);
    const loaded = audits.find((a) => a.action === 'partner.wallet.loaded');
    expect(loaded).toMatchObject({ targetType: 'PartnerConnection', targetId: PA.id, tenantId: A.venueId });
    expect(loaded!.payload).toMatchObject({ amountCents: 2000, funding: 'cash', device: 'ATM0042', loadId: body.id });
    const text = JSON.stringify(audits.map((a) => ({ ...a, id: String(a.id) })));
    expect(text).not.toContain('Recarga en cajero');
    expect(text).not.toContain(qr.split('=')[1]!);
    expect(text).not.toMatch(/04:?A1:?B2/i);
  });

  it('una descripción con una tarjeta: 422 description_personal_data y ninguna fila', async () => {
    const w = await wallet(s, A.venueId, G);
    const qr = await ficha(s, w.id, A.venueId);
    const res = await load(PA, qr, { description: 'Tarjeta 4111 1111 1111 1111' });
    expect(res.statusCode).toBe(422);
    expect(codeOf(res)).toBe('description_personal_data');
    expect(await counts(w.id)).toEqual({ loads: 0, cash: 0, balance: 5000 });
  });

  it('la misma clave con otro cuerpo: 422 idempotency_key_reused con `operation`; con el mismo, el 201 guardado e Idempotent-Replayed', async () => {
    const w = await wallet(s, A.venueId, G);
    const qr = await ficha(s, w.id, A.venueId);
    const key = newKey();
    const first = await load(PA, qr, { key });
    expect(first.statusCode).toBe(201);
    const again = await load(PA, qr, { key });
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json()).toEqual(first.json());
    const other = await load(PA, qr, { key, amount: 2001 });
    expect(other.statusCode).toBe(422);
    expect(other.json()).toMatchObject({
      code: 'idempotency_key_reused',
      operation: { object: 'wallet_load', id: (first.json() as WalletLoadBody).id, status: 'succeeded', amount: 2000 },
    });
    // Un reintento nunca recibe los 422 de texto: con la clave de una carga hecha, la repetición o el «reused».
    const card = await load(PA, qr, { key, funding: 'card' });
    expect(codeOf(card)).toBe('idempotency_key_reused');
    expect(await counts(w.id)).toEqual({ loads: 1, cash: 1, balance: 7000 });
  });

  it('la misma clave en dos conexiones: dos cargas', async () => {
    const w = await wallet(s, A.venueId, G);
    const qr = await ficha(s, w.id, A.venueId);
    const key = newKey();
    expect((await load(PA, qr, { key })).statusCode).toBe(201);
    expect((await load(QA, qr, { key })).statusCode).toBe(201);
    expect(await counts(w.id)).toEqual({ loads: 2, cash: 2, balance: 9000 });
  });
});

describe('2. topes', () => {
  it('el mismo socio en A y A2 suma en unnamed_wallet_30d (sin teléfono) y en wallet_24h_all_partners', async () => {
    // 30 días: 1.500 € entre las conexiones del socio. Cargas antiguas (de hace 2 días) para no tocar el de 24 h.
    const w = await wallet(s, A.venueId, G);
    const qr = await ficha(s, w.id, A.venueId);
    const today = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    for (const [i, c] of [PA, PA2, PA, PA2, PA].entries()) {
      vi.setSystemTime(new Date(today - (6 - i) * 86_400_000));
      const res = await load(c, qr, { amount: 29000 });
      expect(res.statusCode, res.body).toBe(201);
    }
    vi.useRealTimers();
    const over = await load(PA2, qr, { amount: 5001 });
    expect(over.statusCode).toBe(402);
    expect(over.json()).toMatchObject({ code: 'limit_exceeded', limit: 'unnamed_wallet_30d', remaining: 5000 });
    // Con teléfono, ese tope no cuenta.
    await s.sys((tx) => tx.clientWallet.update({ where: { id: w.id }, data: { contactPhone: '+34612345678' } }));
    expect((await load(PA2, qr, { amount: 5001 })).statusCode).toBe(201);

    // 24 h entre todos: 999,99 € (cada conexión con su tope de 600 €).
    const w2 = await wallet(s, A.venueId, G, { contactPhone: '+34612345679' });
    const qr2 = await ficha(s, w2.id, A.venueId);
    for (const [c, amount] of [[PA, 30000], [PA, 30000], [PA2, 30000]] as const) expect((await load(c, qr2, { amount })).statusCode).toBe(201);
    const all = await load(PA2, qr2, { amount: 10000 });
    expect(all.json()).toMatchObject({ code: 'limit_exceeded', limit: 'wallet_24h_all_partners' });
    expect((all.json() as { remaining?: number }).remaining).toBeUndefined();
    expect((await load(PA2, qr2, { amount: 9999 })).statusCode).toBe(201);
  });

  it('per_operation y wallet_24h con su `remaining`; Problem con el detail del tope de la conexión', async () => {
    const w = await wallet(s, A.venueId, G, { contactPhone: '+34611111111' });
    const qr = await ficha(s, w.id, A.venueId);
    const big = await load(PA, qr, { amount: 30001 });
    expect(big.json()).toMatchObject({
      status: 402,
      code: 'limit_exceeded',
      limit: 'per_operation',
      remaining: 30000,
      detail: "This load is above this connection's limit per operation (300.00 EUR).",
    });
    expect((await load(PA, qr, { amount: 30000 })).statusCode).toBe(201);
    expect((await load(PA, qr, { amount: 25000 })).statusCode).toBe(201);
    expect((await load(PA, qr, { amount: 5001 })).json()).toMatchObject({ code: 'limit_exceeded', limit: 'wallet_24h', remaining: 5000 });
  });

  it('efectivo con recepción, primero recepción: el cajero no pasa de 1.000 € en 24 h (402 cash_limit_reached sin remaining)', async () => {
    const w = await wallet(s, A.venueId, G, { contactPhone: '+34611111112', balanceCents: 0 });
    const qr = await ficha(s, w.id, A.venueId);
    await receptionTopUp(w, 80000);
    const res = await load(PA, qr, { amount: 20000 });
    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ code: 'cash_limit_reached' });
    expect((res.json() as { remaining?: number }).remaining).toBeUndefined();
    expect((await load(PA, qr, { amount: 19999 })).statusCode).toBe(201);
  });

  it('efectivo con recepción, primero el cajero: recepción no pasa de 1.000 € en 24 h', async () => {
    const w = await wallet(s, A.venueId, G, { contactPhone: '+34611111113', balanceCents: 0 });
    const qr = await ficha(s, w.id, A.venueId);
    for (const c of [PA, QA]) expect((await load(c, qr, { amount: 30000 })).statusCode).toBe(201);
    expect((await load(PA2, qr, { amount: 30000 })).statusCode).toBe(201);
    await expect(receptionTopUp(w, 10000)).rejects.toMatchObject({ response: expect.objectContaining({ code: 'CASH_LIMIT' }) });
    await expect(receptionTopUp(w, 9999)).resolves.toMatchObject({ amountCents: 9999 });
  });
});

describe('3. alcance: antes que nada', () => {
  it('un saldo de otra sociedad: 404 wallet_not_found sin registro, también bloqueado por otra transacción (al momento)', async () => {
    const w = await wallet(s, A3.venueId, G);
    const qr = await ficha(s, w.id, A3.venueId);
    const since = await maxAuditId();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = s.sys(async (tx) => {
      await tx.$queryRaw`SELECT id FROM client_wallets WHERE id = ${w.id}::uuid FOR UPDATE`;
      locked();
      await held;
    });
    await isLocked;
    const t0 = Date.now();
    const res = await load(PA, qr);
    const took = Date.now() - t0;
    release();
    await holder;
    expect(res.statusCode).toBe(404);
    expect(codeOf(res)).toBe('wallet_not_found');
    expect(took).toBeLessThan(3_000);
    expect(await auditsSince(since)).toEqual([]);
    expect(await counts(w.id)).toEqual({ loads: 0, cash: 0, balance: 5000 });
    expect(await s.redis.keys(`np:prl:wload:*${w.id}*`)).toEqual([]);
  });
});

describe('4. a la vez', () => {
  it('dos cajeros contra wallet_24h: pasa uno', async () => {
    const w = await wallet(s, A.venueId, G, { contactPhone: '+34622222221' });
    const qr = await ficha(s, w.id, A.venueId);
    expect((await load(PA, qr, { amount: 30000 })).statusCode).toBe(201);
    const both = await Promise.all([load(PA, qr, { amount: 20000, device: 'ATM1' }), load(PA, qr, { amount: 20000, device: 'ATM2' })]);
    expect(both.map((r) => r.statusCode).sort()).toEqual([201, 402]);
    expect(await counts(w.id)).toMatchObject({ loads: 2, cash: 2 });
  });

  it('dos socios contra wallet_24h_all_partners: pasa uno', async () => {
    const w = await wallet(s, A.venueId, G, { contactPhone: '+34622222222' });
    const qr = await ficha(s, w.id, A.venueId);
    expect((await load(PA, qr, { amount: 30000 })).statusCode).toBe(201);
    expect((await load(QA, qr, { amount: 30000 })).statusCode).toBe(201);
    const both = await Promise.all([load(PA, qr, { amount: 20000 }), load(QA, qr, { amount: 20000 })]);
    expect(both.map((r) => r.statusCode).sort()).toEqual([201, 402]);
    expect(both.find((r) => r.statusCode === 402)!.json()).toMatchObject({ limit: 'wallet_24h_all_partners' });
  });

  it('20 saldos contra connection_night: nunca se pasa del tope de la noche', async () => {
    const c = await connection(s, { venueId: A.venueId, businessId: X, partnerId: await partner(s) }, { loadNightMaxCents: 50000 });
    const qrs = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const w = await wallet(s, A.venueId, G, { contactPhone: '+34633333333' });
        return ficha(s, w.id, A.venueId);
      }),
    );
    const res = await Promise.all(qrs.map((qr) => load(c, qr, { amount: 3000 })));
    const ok = res.filter((r) => r.statusCode === 201).length;
    expect(ok).toBe(16);
    expect(res.filter((r) => r.statusCode === 402).every((r) => (r.json() as { limit?: string }).limit === 'connection_night')).toBe(true);
    const total = await s.sys((tx) => tx.partnerWalletOperation.aggregate({ where: { connectionId: c.id, kind: 'LOAD' }, _sum: { amountCents: true } }));
    expect(total._sum.amountCents).toBe(48000);
  });

  it('cinco con la misma clave: una fila y cinco 201 iguales', async () => {
    const w = await wallet(s, A.venueId, G);
    const qr = await ficha(s, w.id, A.venueId);
    const key = newKey();
    const res = await Promise.all(Array.from({ length: 5 }, () => load(PA, qr, { key })));
    expect(res.map((r) => r.statusCode)).toEqual([201, 201, 201, 201, 201]);
    const bodies = res.map((r) => r.json());
    for (const b of bodies) expect(b).toEqual(bodies[0]);
    expect(res.filter((r) => r.headers['idempotent-replayed'] === 'true')).toHaveLength(4);
    expect(await counts(w.id)).toEqual({ loads: 1, cash: 1, balance: 7000 });
  });

  it('recepción y cajero a la vez: el efectivo nunca llega a 1.000 €', async () => {
    const w = await wallet(s, A.venueId, G, { contactPhone: '+34644444444', balanceCents: 0 });
    const qr = await ficha(s, w.id, A.venueId);
    await receptionTopUp(w, 70000);
    const [rec, atm] = await Promise.allSettled([receptionTopUp(w, 20000), load(PA, qr, { amount: 20000 })]);
    const atmOk = atm.status === 'fulfilled' && atm.value.statusCode === 201;
    const recOk = rec.status === 'fulfilled';
    expect([atmOk, recOk].filter(Boolean)).toHaveLength(1);
    const cash = await s.sys((tx) => tx.walletCashTopUp.aggregate({ where: { walletId: w.id }, _sum: { amountCents: true } }));
    expect(cash._sum.amountCents).toBe(90000);
  });
});

describe('5. todo o nada: el registro, el corte de 25 s y la clave tomada', () => {
  it('si el registro (logInTx) falla, no queda nada: ni saldo, ni caja, ni LOAD', async () => {
    const w = await wallet(s, A.venueId, G);
    const qr = await ficha(s, w.id, A.venueId);
    vi.spyOn(s.audit, 'logInTx').mockRejectedValueOnce(new Error('registro caído'));
    const res = await load(PA, qr);
    expect(res.statusCode).toBe(500);
    expect(codeOf(res)).toBe('internal_error');
    expect(await counts(w.id)).toEqual({ loads: 0, cash: 0, balance: 5000 });
    expect(vi.mocked(sentry.reportError)).toHaveBeenCalled();
  });

  it('26 s dentro (el reloj salta en el registro): 503 try_later y ninguna fila', async () => {
    const w = await wallet(s, A.venueId, G);
    const qr = await ficha(s, w.id, A.venueId);
    const real = s.audit.logInTx.bind(s.audit);
    vi.spyOn(s.audit, 'logInTx').mockImplementationOnce(async (tx, input) => {
      await real(tx, input);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(Date.now() + 26_000));
    });
    const res = await load(PA, qr);
    vi.useRealTimers();
    expect(res.statusCode).toBe(503);
    expect(codeOf(res)).toBe('try_later');
    expect(res.headers['retry-after']).toBe('5');
    expect(await counts(w.id)).toEqual({ loads: 0, cash: 0, balance: 5000 });
  });

  it('la clave tomada 11 s por otra petición: 503 try_later (espera 10 s y no hace nada)', async () => {
    const w = await wallet(s, A.venueId, G);
    const qr = await ficha(s, w.id, A.venueId);
    const key = newKey();
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = s.cls.run(() =>
      s.prisma.asSystem(
        async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`partner-load:${PA.id}:${key}`}, 0))`;
          locked();
          await tx.$executeRaw`SELECT pg_sleep(11)`;
        },
        { timeout: 20_000 },
      ),
    );
    await isLocked;
    const res = await load(PA, qr, { key });
    await holder;
    expect(res.statusCode).toBe(503);
    expect(codeOf(res)).toBe('try_later');
    expect(await counts(w.id)).toEqual({ loads: 0, cash: 0, balance: 5000 });
  }, 30_000);
});
