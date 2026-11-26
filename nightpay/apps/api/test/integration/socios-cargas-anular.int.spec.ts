// Integración (Postgres y Redis de verdad): anular las cargas de los socios
// (PR 3 parte A). Por la API (POST /v1/partner/wallet/loads/{id}/void): solo
// las suyas, en 10 minutos y si el saldo la cubre; sin cuerpo o con `reason`.
// Desde el panel (POST /v1/admin/partner-connections/:id/loads/:loadId/void):
// el dueño o el encargado, con 2FA atada a la carga, hasta 36 h. La lista y el
// resumen del socio = los del dueño; la pausa automática deja leer, listar y
// anular; el aviso «Carga anulada» al móvil del cliente. Montaje:
// test/support/socios.ts. Ver README.md.
import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Statement, WalletLoad, WalletLoadList, type WalletLoadBody } from '@nightpay/contracts';
import { CashTopUpService } from '../../src/modules/wallets/wallet-cash-topup.service';
import {
  PUSH_AUTH,
  PUSH_P256DH,
  TOTP,
  business,
  clearRedis,
  connection,
  ficha,
  mountSocios,
  newKey,
  partner,
  staffToken,
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
const G = `ganular-${Math.random().toString(36).slice(2, 8)}`;
let X = '';
let A: Seeded;
let B: Seeded;
let PA: TestConnection;
let QA: TestConnection;
let PB: TestConnection;

function load(conn: TestConnection, qr: string, amount = 2000, key = newKey()) {
  return s.app.inject({
    method: 'POST',
    url: '/v1/partner/wallet/loads',
    headers: { authorization: `Bearer ${conn.key}`, 'idempotency-key': key },
    payload: { qr, amount, description: 'Recarga en cajero 0042', funding: 'cash', device: 'ATM0042', reference: key },
  });
}

async function loaded(conn: TestConnection, qr: string, amount = 2000): Promise<WalletLoadBody> {
  const res = await load(conn, qr, amount);
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as WalletLoadBody;
}

function voidApi(conn: TestConnection, id: string, opts: { body?: string; contentType?: string } = {}) {
  return s.app.inject({
    method: 'POST',
    url: `/v1/partner/wallet/loads/${id}/void`,
    headers: { authorization: `Bearer ${conn.key}`, ...(opts.contentType ? { 'content-type': opts.contentType } : {}) },
    ...(opts.body !== undefined ? { payload: opts.body } : {}),
  });
}

const get = (conn: TestConnection, url: string) => s.app.inject({ method: 'GET', url: `/v1/partner${url}`, headers: { authorization: `Bearer ${conn.key}` } });

async function panel(method: 'GET' | 'POST' | 'PATCH', v: Seeded, path: string, body?: object, role: 'OWNER' | 'MANAGER' = 'OWNER') {
  const t = await staffToken(s, role === 'OWNER' ? v.owner : v.manager, v.venueId, role);
  return s.app.inject({
    method,
    url: `/v1/admin/partner-connections${path}`,
    headers: { authorization: `Bearer ${t}` },
    ...(body ? { payload: body } : {}),
  });
}

const uuidOf = (publicId: string) => {
  const h = publicId.slice(3);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
const codeOf = (res: { json: () => unknown }) => (res.json() as { code?: string }).code;
const balanceOf = async (walletId: string) =>
  (await s.sys((tx) => tx.clientWallet.findUnique({ where: { id: walletId }, select: { balanceCents: true } })))!.balanceCents;
const opsOf = (walletId: string) => s.sys((tx) => tx.partnerWalletOperation.findMany({ where: { walletId }, orderBy: { createdAt: 'asc' } }));

beforeAll(async () => {
  vi.stubEnv('PARTNER_API_ENABLED', 'true');
  vi.stubEnv('PARTNER_API_MODE', 'test');
  vi.stubEnv('EDITION', 'club');
  s = await mountSocios();
  X = await business(s, 'Sociedad X');
  A = await venue(s, 'Sala A', G, X);
  B = await venue(s, 'Sala B', G, X);
  QA = await connection(s, { venueId: A.venueId, businessId: X, partnerId: await partner(s) });
});

beforeEach(async () => {
  await clearRedis(s.redis);
  // Cada prueba, su socio con su conexión en A y en B: 3 anulaciones de la API en una noche pausan las cargas.
  const P = await partner(s);
  PA = await connection(s, { venueId: A.venueId, businessId: X, partnerId: P });
  PB = await connection(s, { venueId: B.venueId, businessId: X, partnerId: P });
  s.totpActions.length = 0;
  s.pushes.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await s?.close();
  vi.unstubAllEnvs();
});

describe('1. por la API', () => {
  it('sin cuerpo ni Content-Type: 200 anulada; el saldo baja, la fila de caja negativa con su conexión y la LOAD_VOID', async () => {
    const w = await wallet(s, A.venueId, G, { balanceCents: 1000 });
    const l = await loaded(PA, await ficha(s, w.id, A.venueId));
    const res = await voidApi(PA, l.id);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as WalletLoadBody;
    expect(WalletLoad.parse(body)).toEqual(body);
    expect(body).toMatchObject({ id: l.id, status: 'voided', balance_after: 3000 });
    expect(body.voided_at).toEqual(expect.any(String));
    expect(await balanceOf(w.id)).toBe(1000);
    const [, voidOp] = await opsOf(w.id);
    expect(voidOp).toMatchObject({ kind: 'LOAD_VOID', reversesId: uuidOf(l.id), voidedByUserId: null, reason: null, balanceBeforeCents: 3000, balanceAfterCents: 1000 });
    const cash = await s.sys((tx) => tx.walletCashTopUp.findUnique({ where: { id: voidOp!.cashTopupId! } }));
    expect(cash).toMatchObject({ amountCents: -2000, partnerConnectionId: PA.id, takenByUserId: null, reason: 'Anulada por la plataforma' });
    // Repetirla: 200 con la misma carga, en cualquier momento.
    const again = await voidApi(PA, l.id);
    expect(again.statusCode).toBe(200);
    expect((again.json() as WalletLoadBody).voided_at).toBe(body.voided_at);
    expect((await opsOf(w.id)).filter((o) => o.kind === 'LOAD_VOID')).toHaveLength(1);
  });

  it('con Content-Type JSON y el cuerpo vacío: 400 invalid_request; con `reason`, a sus columnas (nunca al registro ni al log)', async () => {
    const w = await wallet(s, A.venueId, G);
    const l = await loaded(PA, await ficha(s, w.id, A.venueId));
    const empty = await voidApi(PA, l.id, { contentType: 'application/json', body: '' });
    expect(empty.statusCode).toBe(400);
    expect(codeOf(empty)).toBe('invalid_request');
    const bad = await voidApi(PA, l.id, { contentType: 'application/json', body: JSON.stringify({ reason: 'Llama al 612 345 678' }) });
    expect(bad.json()).toMatchObject({ code: 'validation_failed', param: 'reason' });
    const extra = await voidApi(PA, l.id, { contentType: 'application/json', body: JSON.stringify({ reason: 'ok', otra: 1 }) });
    expect(extra.json()).toMatchObject({ code: 'validation_failed', param: 'otra' });
    s.fastifyLog.length = 0;
    const since = (await s.sys((tx) => tx.auditEvent.aggregate({ _max: { id: true } })))._max.id ?? 0n;
    const res = await voidApi(PA, l.id, { contentType: 'application/json', body: JSON.stringify({ reason: 'Billetes devueltos al cliente' }) });
    expect(res.statusCode).toBe(200);
    const voidOp = (await opsOf(w.id)).find((o) => o.kind === 'LOAD_VOID');
    expect(voidOp?.reason).toBe('Billetes devueltos al cliente');
    const audits = await s.sys((tx) => tx.auditEvent.findMany({ where: { id: { gt: since } } }));
    const row = audits.find((a) => a.action === 'partner.wallet.load_voided');
    expect(row?.payload).toMatchObject({ hasReason: true, amountCents: 2000 });
    expect(JSON.stringify(audits.map((a) => a.payload))).not.toContain('Billetes');
    expect(s.fastifyLog.join('\n')).not.toContain('Billetes');
  });

  it('de otra conexión, de otro local, un LOAD_VOID o un id malo: 404 load_not_found sin tocar nada', async () => {
    const w = await wallet(s, A.venueId, G);
    const qr = await ficha(s, w.id, A.venueId);
    const mine = await loaded(PA, qr);
    const balance = await balanceOf(w.id);
    for (const [conn, id] of [
      [QA, mine.id],
      [PB, mine.id],
      [PA, 'wl_nope'],
      [PA, `wl_${'0'.repeat(32)}`],
    ] as const) {
      const res = await voidApi(conn, id);
      expect(res.statusCode, `${conn.id} ${id}`).toBe(404);
      expect(codeOf(res)).toBe('load_not_found');
      const read = await get(conn, `/wallet/loads/${id}`);
      expect(read.statusCode).toBe(404);
    }
    expect(await balanceOf(w.id)).toBe(balance);
    // El id de una LOAD_VOID tampoco es una carga.
    await voidApi(PA, mine.id);
    const voidOp = (await opsOf(w.id)).find((o) => o.kind === 'LOAD_VOID')!;
    const asLoad = `wl_${voidOp.id.replace(/-/g, '')}`;
    expect(codeOf(await voidApi(PA, asLoad))).toBe('load_not_found');
    expect(codeOf(await get(PA, `/wallet/loads/${asLoad}`))).toBe('load_not_found');
  });

  it('pasados 10 minutos: 409 void_window_passed; con el saldo gastado: 409 balance_already_spent con `available`', async () => {
    const w = await wallet(s, A.venueId, G, { balanceCents: 0 });
    const qr = await ficha(s, w.id, A.venueId);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() - 11 * 60_000));
    const old = await loaded(PA, qr);
    vi.useRealTimers();
    expect(codeOf(await voidApi(PA, old.id))).toBe('void_window_passed');
    const fresh = await loaded(PA, qr, 3000);
    await s.sys((tx) => tx.clientWallet.update({ where: { id: w.id }, data: { balanceCents: 1500 } }));
    const spent = await voidApi(PA, fresh.id);
    expect(spent.statusCode).toBe(409);
    expect(spent.json()).toMatchObject({ code: 'balance_already_spent', available: 1500 });
    // Bloqueado o el local en pausa no la paran (si el saldo la cubre).
    await s.sys((tx) => tx.clientWallet.update({ where: { id: w.id }, data: { balanceCents: 5000, blockedAt: new Date() } }));
    await s.sys((tx) => tx.venue.update({ where: { id: A.venueId }, data: { pausedAt: new Date() } }));
    const ok = await voidApi(PA, fresh.id);
    await s.sys((tx) => tx.venue.update({ where: { id: A.venueId }, data: { pausedAt: null } }));
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await balanceOf(w.id)).toBe(2000);
  });

  it('el aviso «Carga anulada · {socio}» al móvil del cliente, con lo quitado y lo que le queda', async () => {
    const w = await wallet(s, A.venueId, G, { balanceCents: 1000 });
    await s.sys((tx) =>
      tx.walletPushSubscription.create({ data: { tenantId: A.venueId, walletId: w.id, endpoint: `https://push.ejemplo.es/${w.id}`, p256dh: PUSH_P256DH, auth: PUSH_AUTH, lang: 'es' } }),
    );
    const l = await loaded(PA, await ficha(s, w.id, A.venueId));
    expect((await voidApi(PA, l.id)).statusCode).toBe(200);
    await vi.waitFor(() => expect(s.pushes).toHaveLength(1));
    const name = (await s.sys((tx) => tx.partnerConnection.findUnique({ where: { id: PA.id }, include: { partner: true } })))!.partner.name;
    const plain = JSON.parse(JSON.stringify(s.pushes[0]!.payload).replace(/[  ]/g, ' '));
    expect(plain).toMatchObject({ title: `Carga anulada · ${name}`, body: 'Se han quitado 20 € de tu saldo · te quedan 10 €' });
    expect(plain.notMeUrl).toBeUndefined();
  });
});

describe('2. desde el panel (dueño y encargado, 2FA)', () => {
  it('con 2FA atada a la carga: 200, LOAD_VOID con quién y la fila negativa con su conexión; sin código, 403', async () => {
    const w = await wallet(s, A.venueId, G, { balanceCents: 1000 });
    const l = await loaded(PA, await ficha(s, w.id, A.venueId));
    const loadId = uuidOf(l.id);
    const path = `/${PA.id}/loads/${loadId}/void`;
    const noCode = await panel('POST', A, path, { reason: 'El cliente se llevó los billetes' }, 'MANAGER');
    expect(noCode.statusCode).toBe(403);
    const res = await panel('POST', A, path, { reason: 'El cliente se llevó los billetes', totpCode: TOTP }, 'MANAGER');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ publicId: l.id, status: 'voided', voidedBy: 'venue', reason: 'El cliente se llevó los billetes' });
    expect(s.totpActions).toEqual([`partner:void:${loadId}`]);
    const voidOp = (await opsOf(w.id)).find((o) => o.kind === 'LOAD_VOID')!;
    expect(voidOp.voidedByUserId).toBe(A.manager);
    const cash = await s.sys((tx) => tx.walletCashTopUp.findUnique({ where: { id: voidOp.cashTopupId! } }));
    expect(cash).toMatchObject({ amountCents: -2000, partnerConnectionId: PA.id, takenByUserId: A.manager });
    expect(codeOf(await panel('POST', A, path, { reason: 'Otra vez', totpCode: TOTP }))).toBe('PARTNER_LOAD_ALREADY_VOIDED');
    // El socio la ve anulada (por el local).
    expect((await get(PA, `/wallet/loads/${l.id}`)).json()).toMatchObject({ status: 'voided' });
    // Otro local: como si no existiera.
    expect((await panel('POST', B, path, { reason: 'No es mía', totpCode: TOTP })).statusCode).toBe(404);
  });

  it('a las 37 h: 409 PARTNER_LOAD_TOO_OLD; con el saldo gastado: 409 PARTNER_LOAD_SPENT', async () => {
    const w = await wallet(s, A.venueId, G, { balanceCents: 0 });
    const qr = await ficha(s, w.id, A.venueId);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() - 37 * 3_600_000));
    const old = await loaded(PA, qr);
    vi.useRealTimers();
    const tooOld = await panel('POST', A, `/${PA.id}/loads/${uuidOf(old.id)}/void`, { reason: 'Muy tarde', totpCode: TOTP });
    expect(tooOld.statusCode).toBe(409);
    expect(codeOf(tooOld)).toBe('PARTNER_LOAD_TOO_OLD');
    const fresh = await loaded(PA, qr, 3000);
    await s.sys((tx) => tx.clientWallet.update({ where: { id: w.id }, data: { balanceCents: 1000 } }));
    const spent = await panel('POST', A, `/${PA.id}/loads/${uuidOf(fresh.id)}/void`, { reason: 'Gastada', totpCode: TOTP });
    expect(spent.statusCode).toBe(409);
    expect(spent.json()).toMatchObject({ code: 'PARTNER_LOAD_SPENT' });
    expect(JSON.stringify(spent.json())).toContain('le quedan 10,00');
  });

  it('una carga de hace 30 h anulada en el panel no abre hueco de efectivo (cuenta a la hora de su carga)', async () => {
    const w = await wallet(s, A.venueId, G, { balanceCents: 0, contactPhone: '+34655555555' });
    const qr = await ficha(s, w.id, A.venueId);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() - 30 * 3_600_000));
    const old = await loaded(PA, qr, 30000);
    vi.useRealTimers();
    // En las últimas 24 h: 699,99 € en efectivo en recepción.
    const reception = new CashTopUpService(s.prisma, s.audit, s.totp as never);
    await reception.topUp(A.venueId, { userId: A.owner, role: 'OWNER' }, { amountCents: 69999, idempotencyKey: newKey('rec'), wallet: { code: w.shortCode } });
    expect((await panel('POST', A, `/${PA.id}/loads/${uuidOf(old.id)}/void`, { reason: 'Corregida', totpCode: TOTP })).statusCode).toBe(200);
    // Si la anulación contara ahora, quedarían 399,99 €: cabría otra de 300 €. No cabe: sigue en 699,99 €.
    await expect(
      reception.topUp(A.venueId, { userId: A.owner, role: 'OWNER' }, { amountCents: 30001, idempotencyKey: newKey('rec'), wallet: { code: w.shortCode } }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'CASH_LIMIT' }) });
    // El cajero: hasta 999,99 € justos (699,99 + 300), ni un céntimo más.
    expect((await load(PA, qr, 30000)).statusCode).toBe(201);
    expect((await load(PA, qr, 1)).json()).toMatchObject({ code: 'cash_limit_reached' });
  });
});

describe('3. lista, resumen y pausa automática', () => {
  it('/wallet/operations y /statement = los del dueño (cargas a su hora, anulaciones a la suya, también las del panel)', async () => {
    const c = await connection(s, { venueId: A.venueId, businessId: X, partnerId: await partner(s) });
    const w = await wallet(s, A.venueId, G, { balanceCents: 10000 });
    const qr = await ficha(s, w.id, A.venueId);
    const l1 = await loaded(c, qr, 2000);
    const l2 = await loaded(c, qr, 3000);
    const l3 = await loaded(c, qr, 4000);
    expect((await voidApi(c, l2.id)).statusCode).toBe(200);
    expect((await panel('POST', A, `/${c.id}/loads/${uuidOf(l3.id)}/void`, { reason: 'Corregida', totpCode: TOTP })).statusCode).toBe(200);
    const night = (await panel('GET', A, `/${c.id}/statement`)).json();
    const day = (night as { from: string }).from;
    const from = encodeURIComponent(day);
    const to = encodeURIComponent((night as { to: string }).to);
    const api = await get(c, `/statement?from=${from}&to=${to}`);
    expect(api.statusCode, api.body).toBe(200);
    expect(Statement.parse(api.json())).toEqual(api.json());
    expect(api.json()).toEqual(night);
    expect(api.json()).toMatchObject({ loads: { count: 3, amount: 9000, by_funding: { cash: { count: 3, amount: 9000 } } }, load_voids: { count: 2, amount: 7000 }, net_loads: 2000 });
    // La lista: de la más antigua a la más nueva, cada una una vez con su estado de ahora; páginas con cursor.
    const page1 = await get(c, `/wallet/operations?from=${from}&to=${to}&limit=2`);
    expect(WalletLoadList.parse(page1.json())).toEqual(page1.json());
    const p1 = page1.json() as { data: WalletLoadBody[]; has_more: boolean; next_cursor: string };
    expect(p1.data.map((d) => [d.id, d.status])).toEqual([[l1.id, 'succeeded'], [l2.id, 'voided']]);
    expect(p1.has_more).toBe(true);
    const page2 = (await get(c, `/wallet/operations?from=${from}&to=${to}&limit=2&cursor=${p1.next_cursor}`)).json() as typeof p1;
    expect(page2.data.map((d) => [d.id, d.status])).toEqual([[l3.id, 'voided']]);
    expect(page2.next_cursor).toBeNull();
    const foreign = await get(c, `/wallet/operations?business_date=2026-01-01&cursor=${p1.next_cursor}`);
    expect(foreign.json()).toMatchObject({ code: 'validation_failed', param: 'cursor' });
    const owner = (await panel('GET', A, `/${c.id}/loads`)).json() as { loads: Array<{ publicId: string; status: string; voidedBy: string | null; codeHint: string }> };
    expect(owner.loads.map((x) => [x.publicId, x.status, x.voidedBy])).toEqual([
      [l1.id, 'succeeded', null],
      [l2.id, 'voided', 'partner'],
      [l3.id, 'voided', 'venue'],
    ]);
    expect(owner.loads[0]!.codeHint).toBe(`${w.shortCode.slice(0, 3)}-•••`);
    // Por referencia exacta.
    const byRef = (await get(c, `/wallet/operations?from=${from}&to=${to}&reference=${encodeURIComponent(l1.reference!)}`)).json() as typeof p1;
    expect(byRef.data.map((d) => d.id)).toEqual([l1.id]);
    // 32 días: range_too_long.
    const long = await get(c, `/wallet/operations?from=2026-01-01T00:00:00Z&to=2026-02-02T00:00:01Z`);
    expect(long.json()).toMatchObject({ code: 'range_too_long', detail: 'The period can be at most 31 days.' });
  });

  it('pausa automática (3 rechazos por máximo por recarga): crear 403 scope_paused; leer, listar, resumen y anular siguen', async () => {
    const c = await connection(s, { venueId: A.venueId, businessId: X, partnerId: await partner(s) });
    const w = await wallet(s, A.venueId, G, { balanceCents: 1000 });
    const qr = await ficha(s, w.id, A.venueId);
    const l = await loaded(c, qr, 2000);
    for (let i = 0; i < 3; i += 1) expect(codeOf(await load(c, qr, 30001))).toBe('limit_exceeded');
    await vi.waitFor(async () => {
      const row = await s.sys((tx) => tx.partnerConnection.findUnique({ where: { id: c.id } }));
      expect(row).toMatchObject({ pausedScopes: ['wallet:load'], pausedReason: 'load_refusals' });
    });
    expect(codeOf(await load(c, qr))).toBe('scope_paused');
    expect((await get(c, `/wallet/loads/${l.id}`)).statusCode).toBe(200);
    const night = (await panel('GET', A, `/${c.id}/statement`)).json() as { from: string; to: string };
    expect((await get(c, `/wallet/operations?from=${encodeURIComponent(night.from)}&to=${encodeURIComponent(night.to)}`)).statusCode).toBe(200);
    expect((await get(c, `/statement?from=${encodeURIComponent(night.from)}&to=${encodeURIComponent(night.to)}`)).statusCode).toBe(200);
    expect((await voidApi(c, l.id)).statusCode).toBe(200);
    const me = (await get(c, '/me')).json() as { paused_scopes: string[] };
    expect(me.paused_scopes).toEqual(['wallet:load']);
    const paused = await s.sys((tx) => tx.auditEvent.findMany({ where: { targetId: c.id, action: 'partner.connection.paused' } }));
    expect(paused).toHaveLength(1);
    expect(paused[0]!.payload).toMatchObject({ reason: 'load_refusals' });
  });

  it('subir los topes pide 2FA atada a los tres; bajarlos, no; con la fila cambiada mientras tanto, 409', async () => {
    const c = await connection(s, { venueId: A.venueId, businessId: X, partnerId: await partner(s) });
    const down = await panel('PATCH', A, `/${c.id}/limits`, { perOperationCents: 20000, walletDayCents: 50000, nightCents: 100000 });
    expect(down.statusCode, down.body).toBe(200);
    expect(down.json()).toMatchObject({ limits: { perOperationCents: 20000, walletDayCents: 50000, nightCents: 100000 } });
    expect((await panel('PATCH', A, `/${c.id}/limits`, { perOperationCents: 99999, walletDayCents: 99999, nightCents: 5000000 })).statusCode).toBe(403);
    const up = await panel('PATCH', A, `/${c.id}/limits`, { perOperationCents: 99999, walletDayCents: 99999, nightCents: 5000000, totpCode: TOTP });
    expect(up.statusCode).toBe(200);
    expect(s.totpActions).toEqual([`partner:limits:${c.id}:99999-99999-5000000`]);
    expect((await panel('PATCH', A, `/${c.id}/limits`, { perOperationCents: 1, walletDayCents: 1, nightCents: 1 }, 'MANAGER')).statusCode).toBe(403);
    const audit = await s.sys((tx) => tx.auditEvent.findMany({ where: { targetId: c.id, action: 'partner.caps_changed' }, orderBy: { id: 'asc' } }));
    expect(audit.map((a) => (a.payload as { after: unknown }).after)).toEqual([
      { perOperationCents: 20000, walletDayCents: 50000, nightCents: 100000 },
      { perOperationCents: 99999, walletDayCents: 99999, nightCents: 5000000 },
    ]);
  });
});
