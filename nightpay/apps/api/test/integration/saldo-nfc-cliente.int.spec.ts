// Integración (Postgres real, np_app y FORCE RLS; Redis de mentira): el cliente y su NFC.
//  - QR de activación (GET /v1/reception/wallets/:id/activation-link): recepción, encargado
//    y dueño sí; barra y chicas no; solo 15 min tras una recarga de este local; con passkey,
//    404; queda en audit_events sin el enlace.
//  - Sesión de consulta deslizante con la app Nest de verdad: desbloqueo real con passkey
//    (WebAuthn de software), se alarga con la actividad, 15 min sin ella la cierran, tope de
//    una hora y un enlace nuevo la invalida.
//  - «He perdido mi NFC»: el cliente lo bloquea con su passkey; el NFC ya no paga, el saldo
//    sí con su código + PIN (y su passkey), sale en Incidencias y recepción le da otro NFC.
import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ClsService } from 'nestjs-cls';
import { UNPREFIXED_ROUTES } from '../../src/common/http/unprefixed-routes';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { createFakeRedis } from '../../src/modules/auth/testing/fake-redis';
import { IncidentsService } from '../../src/modules/incidents/incidents.service';
import { GoogleWalletService } from '../../src/modules/wallets/google-wallet/google-wallet.service';
import { PublicWalletCardController } from '../../src/modules/wallets/public-wallet-card.controller';
import { PublicWalletController } from '../../src/modules/wallets/public-wallet.controller';
import { WalletActivationLinkService } from '../../src/modules/wallets/wallet-activation-link.service';
import { WalletCardViewService } from '../../src/modules/wallets/wallet-card-view.service';
import { WalletCardsService } from '../../src/modules/wallets/wallet-cards.service';
import { CashTopUpService } from '../../src/modules/wallets/wallet-cash-topup.service';
import { WalletChargesService } from '../../src/modules/wallets/wallet-charges.service';
import { WalletLostCardService } from '../../src/modules/wallets/wallet-lost-card.service';
import { WalletPasskeysService } from '../../src/modules/wallets/wallet-passkeys.service';
import { WalletTopUpService } from '../../src/modules/wallets/wallet-topup.service';
import { WALLET_VIEW_IDLE_S } from '../../src/modules/wallets/wallet-view-session';

// La passkey vale en el dominio común; la página está en api.
process.env.NEXT_PUBLIC_API_URL = 'https://api.paytomaxx.com';
const HOST = 'api.paytomaxx.com';
const ORIGIN = 'https://api.paytomaxx.com';
const SECRET = 'secreto-de-cookies-de-la-integracion-0123456789';
const MIN = 60_000;

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const audit = new AuditService(prisma, cls as never);
// El Redis en memoria de las pruebas de auth, con EXISTS (lo usa la passkey para sus retos).
const fakeRedis = createFakeRedis();
const redis = Object.assign(fakeRedis, { exists: async (...keys: string[]) => keys.filter((k) => fakeRedis.has(k)).length });
const totp = { isEnabled: async () => true, assertForUser: async () => undefined };
const passkeys = new WalletPasskeysService(prisma, redis as never);
const cash = new CashTopUpService(prisma, audit, totp as never);
const cards = new WalletCardsService(prisma, audit);
const charges = new WalletChargesService(prisma as never, audit, { get: () => ({}) } as never, totp as never);
const links = new WalletActivationLinkService(prisma, audit, passkeys, { get: () => ORIGIN } as never);
const lost = new WalletLostCardService(prisma, audit, passkeys);
const cardView = new WalletCardViewService(prisma, passkeys);
const incidents = new IncidentsService(prisma, audit);

const inVenue = <T>(tenantId: string | undefined, fn: () => Promise<T>): Promise<T> =>
  cls.run(async () => {
    cls.set('ctx', { tenantId, traceId: 't-nfc-cliente' });
    return fn();
  });
const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) =>
  inVenue(undefined, () => prisma.asSystem(fn));

// ─── Un móvil con su passkey (ES256), como en wallet-passkeys.service.spec ──
const b64u = (b: Uint8Array | Buffer): string => Buffer.from(b).toString('base64url');
function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
}
type Cbor = number | string | Uint8Array | Map<number | string, Cbor>;
function cbor(v: Cbor): Buffer {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  const parts: Buffer[] = [head(5, v.size)];
  for (const [k, val] of v) parts.push(cbor(k), cbor(val));
  return Buffer.concat(parts);
}
class Phone {
  readonly credentialId = randomBytes(16);
  private readonly key: { privateKey: KeyObject; publicKey: KeyObject } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  private count = 0;
  private readonly rpIdHash = createHash('sha256').update('paytomaxx.com').digest();

  register(challenge: string): unknown {
    const jwk = this.key.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    const cose = cbor(new Map<number, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
    const authData = Buffer.concat([this.rpIdHash, Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), Buffer.from([0, this.credentialId.length]), this.credentialId, cose]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin: ORIGIN, crossOrigin: false }));
    const attestationObject = cbor(new Map<string, Cbor>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    return { id: b64u(this.credentialId), rawId: b64u(this.credentialId), type: 'public-key', response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ['internal'] }, clientExtensionResults: {} };
  }

  assert(challenge: string): unknown {
    this.count += 1;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.count);
    const authData = Buffer.concat([this.rpIdHash, Buffer.from([0x05]), counter]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: ORIGIN, crossOrigin: false }));
    const signature = sign('sha256', Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()]), this.key.privateKey);
    return { id: b64u(this.credentialId), rawId: b64u(this.credentialId), type: 'public-key', response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(signature) }, clientExtensionResults: {} };
  }
}

const r = randomUUID().slice(0, 6);
let V: string; // el local
let O: string; // un local de otro grupo
let rx: string; // recepción
let barra: string;
let manager: string;
let owner: string;
let chica: string;
let rxOther: string;
const PIN = '4827';
const actor = (userId: string, role: 'WAITER' | 'MANAGER' | 'OWNER' | 'OPERATOR', tenantId = V) => ({ userId, role, tenantId });

beforeAll(async () => {
  await prisma.onModuleInit();
  await sys(async (tx) => {
    V = (await tx.venue.create({ data: { name: 'Sala Medianoche', slug: `nfc-cli-${r}`, walletGroup: `grupo-${r}` } })).id;
    O = (await tx.venue.create({ data: { name: 'Otro grupo', slug: `nfc-otro-${r}`, walletGroup: `otro-${r}` } })).id;
    const user = async (tenantId: string, name: string, role: string, post: string | null = null) =>
      (await tx.user.create({ data: { tenantId, email: `${name}-${r}@test.local`, passwordHash: 'test', role: role as never, post, displayName: name } })).id;
    rx = await user(V, 'rocio', 'WAITER', 'RECEPCION');
    barra = await user(V, 'pablo', 'WAITER', 'BARRA');
    manager = await user(V, 'javi', 'MANAGER');
    owner = await user(V, 'marta', 'OWNER');
    chica = await user(V, 'lola', 'OPERATOR');
    rxOther = await user(O, 'eva', 'WAITER', 'RECEPCION');
  });
});
afterAll(async () => {
  vi.useRealTimers();
  await prisma.$disconnect();
});
afterEach(() => { vi.useRealTimers(); });

/** El cliente que paga en efectivo en recepción: saldo nuevo, su NFC y su PIN. */
async function client(amountCents = 5_000) {
  const { card } = await inVenue(V, () => cards.newStockToken(V, { userId: rx }));
  const uid = randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase();
  await inVenue(V, () => cards.stock(V, { userId: rx }, { card, uid }));
  const topUp = await inVenue(V, () => cash.topUp(V, { userId: rx, role: 'WAITER' }, { amountCents, idempotencyKey: randomUUID(), wallet: { create: true } }));
  await inVenue(V, () => charges.linkCard(actor(rx, 'WAITER'), { code: topUp.code, card, uid }));
  await inVenue(undefined, () => charges.setPinFromPayer(topUp.walletId, PIN));
  const wallet = await sys((tx) => tx.clientWallet.findUniqueOrThrow({ where: { id: topUp.walletId } }));
  return { walletId: topUp.walletId, code: topUp.code, card, uid, qrToken: wallet.qrToken };
}

/** El cliente activa Face ID desde su enlace privado (el flujo de verdad). */
async function activate(walletId: string, shortCode: string | null = null): Promise<Phone> {
  const phone = new Phone();
  const options = await inVenue(undefined, () => passkeys.registrationOptions({ id: walletId, shortCode }, HOST));
  await inVenue(undefined, () => passkeys.register(walletId, HOST, phone.register(options.challenge)));
  return phone;
}

async function auditRows(action: string, targetId: string) {
  return sys((tx) => tx.auditEvent.findMany({ where: { action, targetId }, orderBy: { occurredAt: 'asc' } }));
}

describe('QR de activación (recepción, Postgres real)', () => {
  it('recepción, justo tras cobrar en efectivo: el enlace privado y hasta cuándo, en el registro sin el enlace', async () => {
    const c = await client();
    const before = Date.now();
    const link = await inVenue(V, () => links.link(actor(rx, 'WAITER'), c.walletId));
    expect(link.url).toBe(`${ORIGIN}/w/${c.qrToken}`);
    const expires = new Date(link.expiresAt).getTime();
    expect(expires).toBeGreaterThan(before + 14 * MIN);
    expect(expires).toBeLessThanOrEqual(Date.now() + 15 * MIN);
    const rows = await auditRows('wallet.activation_link', c.walletId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenantId: V, actorId: rx, targetType: 'ClientWallet' });
    expect(rows[0]!.payload).toMatchObject({ expiresAt: link.expiresAt });
    expect(JSON.stringify(rows[0]!.payload)).not.toContain(c.qrToken);
  });

  it('el encargado y el dueño también; la barra y las chicas no (403, como recargar); otro grupo, 404', async () => {
    const c = await client();
    for (const who of [actor(manager, 'MANAGER'), actor(owner, 'OWNER')]) {
      await expect(inVenue(V, () => links.link(who, c.walletId))).resolves.toMatchObject({ url: `${ORIGIN}/w/${c.qrToken}` });
    }
    for (const who of [actor(barra, 'WAITER'), actor(chica, 'OPERATOR')]) {
      await expect(inVenue(V, () => links.link(who, c.walletId))).rejects.toMatchObject({ status: 403, response: { code: 'TOP_UP_RECEPTION_ONLY' } });
    }
    await expect(inVenue(O, () => links.link(actor(rxOther, 'WAITER', O), c.walletId))).rejects.toMatchObject({ status: 404, response: { reason: 'NOT_FOUND' } });
    expect(await auditRows('wallet.activation_link', c.walletId)).toHaveLength(2);
  });

  it('pasados los 15 minutos de la recarga, ya no (404 NO_RECENT_TOP_UP)', async () => {
    const c = await client();
    await expect(inVenue(V, () => links.link(actor(rx, 'WAITER'), c.walletId, new Date(Date.now() + 16 * MIN))))
      .rejects.toMatchObject({ status: 404, response: { code: 'ACTIVATION_LINK_UNAVAILABLE', reason: 'NO_RECENT_TOP_UP' } });
    expect(await auditRows('wallet.activation_link', c.walletId)).toHaveLength(0);
  });

  it('con passkey ya activada (con el QR, en su móvil): 404 FACE_ID_SET y nada en el registro', async () => {
    const c = await client();
    await activate(c.walletId);
    await expect(inVenue(V, () => links.link(actor(rx, 'WAITER'), c.walletId))).rejects.toMatchObject({ status: 404, response: { reason: 'FACE_ID_SET' } });
    expect(await auditRows('wallet.activation_link', c.walletId)).toHaveLength(0);
    // Y desde ese momento /w/card ya no dice «pide el QR»: pide su passkey.
    await expect(inVenue(undefined, () => cardView.pageView(c.card))).resolves.toEqual({ kind: 'locked', codeHint: `${c.code.slice(0, 3)}-•••` });
  });

  it('sin passkey, /w/card dice cómo activarla desde el principio', async () => {
    const c = await client();
    await expect(inVenue(undefined, () => cardView.pageView(c.card))).resolves.toEqual({ kind: 'setup', codeHint: `${c.code.slice(0, 3)}-•••` });
  });
});

describe('sesión de consulta deslizante (app Nest, Postgres real)', () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    const ref = await Test.createTestingModule({
      controllers: [PublicWalletController, PublicWalletCardController],
      providers: [
        { provide: WalletChargesService, useValue: charges },
        { provide: WalletPasskeysService, useValue: passkeys },
        { provide: WalletCardViewService, useValue: cardView },
        { provide: WalletTopUpService, useValue: { options: async () => null, paidProof: async () => null } },
        { provide: GoogleWalletService, useValue: { enabled: false } },
        { provide: ConfigService, useValue: { get: (k: string) => (k === 'COOKIE_SECRET' ? SECRET : undefined) } },
      ],
    }).compile();
    app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('v1', { exclude: [...UNPREFIXED_ROUTES] });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => { await app?.close(); });

  const get = (url: string, cookie?: string) => app.inject({ method: 'GET', url, headers: { host: HOST, ...(cookie ? { cookie } : {}) } });
  const cookieOf = (setCookie: unknown): string => String((setCookie as string[])[0]).split(';')[0]!;
  /** Acerca su NFC al móvil y desbloquea con su passkey: la cookie de la sesión. */
  async function unlock(card: string, phone: Phone): Promise<{ cookie: string; setCookie: string[]; url: string }> {
    const options = (await app.inject({ method: 'POST', url: `/w/card/${card}/view/challenge`, headers: { host: HOST } })).json() as { challenge: string };
    const res = await app.inject({ method: 'POST', url: `/w/card/${card}/view`, headers: { host: HOST }, payload: { response: phone.assert(options.challenge) } });
    expect(res.statusCode).toBe(200);
    const setCookie = res.headers['set-cookie'] as string[];
    return { cookie: cookieOf(setCookie), setCookie, url: (res.json() as { url: string }).url };
  }

  it('desbloqueo real con la passkey: la sesión va solo en las rutas de ese saldo, HttpOnly y Strict', async () => {
    const c = await client();
    const phone = await activate(c.walletId);
    const page = await get(`/w/card/${c.card}`);
    expect(page.body).toContain('Ver mi saldo');
    expect(page.body).not.toContain(c.qrToken);
    const s = await unlock(c.card, phone);
    expect(s.url).toBe(`/w/${c.qrToken}`);
    expect(s.setCookie).toHaveLength(2);
    expect(s.setCookie[0]).toContain(`Path=/w/${c.qrToken}; Max-Age=${WALLET_VIEW_IDLE_S}; HttpOnly; SameSite=Strict`);
    expect(s.setCookie[1]).toContain(`Path=/v1/wallets/public/${c.qrToken};`);
    const state = await get(`/w/${c.qrToken}/state`, s.cookie);
    expect(state.statusCode).toBe(200);
    expect(state.json()).toMatchObject({ balanceCents: 5_000, hasFaceId: true, hasCard: true, venueName: 'Sala Medianoche' });
    expect((await get(`/w/${c.qrToken}/state`)).statusCode).toBe(401);
  });

  it('mirando su saldo, la sesión se alarga; 15 minutos sin actividad la cierran; nunca pasa de una hora', async () => {
    const c = await client();
    const phone = await activate(c.walletId);
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);
    let { cookie } = await unlock(c.card, phone);
    // Antes, a los 5 minutos la página recibía un 401 mientras el cliente miraba.
    for (const minute of [14, 28, 42, 56]) {
      vi.setSystemTime(t0 + minute * MIN);
      const res = await get(`/w/${c.qrToken}/state`, cookie);
      expect(res.statusCode, `minuto ${minute}`).toBe(200);
      cookie = cookieOf(res.headers['set-cookie']);
    }
    vi.setSystemTime(t0 + 60 * MIN - 1000);
    const last = await get(`/w/${c.qrToken}/state`, cookie);
    expect(last.statusCode).toBe(200);
    expect(last.headers['set-cookie']).toBeUndefined();
    vi.setSystemTime(t0 + 60 * MIN);
    expect((await get(`/w/${c.qrToken}/state`, cookie)).statusCode).toBe(401);
    expect((await get(`/w/${c.qrToken}`, cookie)).body).toContain('Consulta tu saldo');

    // Otra vez Face ID; esta vez deja el móvil 15 minutos sin mirar.
    const t1 = t0 + 61 * MIN;
    vi.setSystemTime(t1);
    ({ cookie } = await unlock(c.card, phone));
    vi.setSystemTime(t1 + 10 * MIN);
    expect((await get(`/w/${c.qrToken}/state`, cookie)).statusCode).toBe(200);
    vi.setSystemTime(t1 + (WALLET_VIEW_IDLE_S + 1) * 1000);
    expect((await get(`/w/${c.qrToken}/state`, cookie)).statusCode).toBe(401);
  });

  it('un enlace nuevo del saldo invalida la sesión del anterior', async () => {
    const c = await client();
    const phone = await activate(c.walletId);
    const { cookie } = await unlock(c.card, phone);
    expect((await get(`/w/${c.qrToken}/state`, cookie)).statusCode).toBe(200);
    const { path } = await inVenue(V, () => charges.relink(actor(owner, 'OWNER'), c.walletId));
    expect((await get(`/w/${c.qrToken}/state`, cookie)).statusCode).toBe(404);
    // La firma iba atada al enlace anterior: con el nuevo no sirve (vuelve a pedir Face ID tras activarlo).
    const fresh = await activate(c.walletId);
    expect((await get(`${path}/state`, cookie)).statusCode).toBe(401);
    expect(fresh).toBeDefined();
  });
});

describe('«He perdido mi NFC» (Postgres real)', () => {
  it('lo bloquea con su passkey: el NFC ya no paga; el saldo sí, con su código + PIN y con su passkey; sale en Incidencias', async () => {
    const c = await client(5_000);
    const phone = await activate(c.walletId);
    const options = await inVenue(undefined, () => lost.challenge(c.walletId, HOST)) as { challenge: string };
    await expect(inVenue(undefined, () => lost.block(c.walletId, HOST, phone.assert(options.challenge)))).resolves.toEqual({ blockedCards: 1 });

    const card = await sys((tx) => tx.walletCard.findUniqueOrThrow({ where: { token: c.card } }));
    expect(card).toMatchObject({ status: 'BLOCKED', walletId: c.walletId });
    expect(card.blockedAt).toBeInstanceOf(Date);
    expect(await sys((tx) => tx.walletCardEvent.count({ where: { cardId: card.id, kind: 'BLOCKED', venueId: V, byUserId: null } }))).toBe(1);
    const rows = await auditRows('wallet.card_blocked_by_client', c.walletId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenantId: V, actorId: null });
    const inbox = await inVenue(V, () => incidents.list(V));
    const incident = inbox.find((i) => i.kind === 'wallet_card_lost' && i.refId === String(rows[0]!.id));
    expect(incident).toMatchObject({ title: 'Un cliente ha bloqueado su NFC', amountCents: 5_000, ackable: true });
    expect(incident!.detail).toContain(c.code);

    // El NFC ya no paga (ni se encuentra al acercarlo) y su página lo dice.
    await expect(inVenue(V, () => charges.lookupCard(V, { card: c.card, uid: c.uid }))).rejects.toThrow();
    const charge = await inVenue(V, () => charges.createQrCharge(actor(chica, 'OPERATOR'), { amountCents: 1_000 }));
    await expect(inVenue(V, () => charges.payQrChargeWithPin(actor(chica, 'OPERATOR'), charge.id, { card: c.card, uid: c.uid, pin: PIN }))).rejects.toThrow();
    await expect(inVenue(undefined, () => cardView.pageView(c.card))).resolves.toEqual({ kind: 'blocked' });

    // El saldo sigue: código + PIN paga.
    const paid = await inVenue(V, () => charges.payQrChargeWithPin(actor(chica, 'OPERATOR'), charge.id, { code: c.code, pin: PIN }));
    expect(paid).toMatchObject({ status: 'ACCEPTED', newBalanceCents: 4_000 });
    // Y su passkey lo sigue abriendo desde su enlace privado.
    const view = await inVenue(undefined, () => passkeys.challenge(`view:${c.walletId}`, HOST));
    await expect(inVenue(undefined, () => passkeys.verify(`view:${c.walletId}`, HOST, phone.assert(view.challenge)))).resolves.toBe(c.walletId);
    const state = await inVenue(undefined, () => charges.clientState(c.qrToken));
    expect(state).toMatchObject({ hasCard: false, fichaNumber: null, balanceCents: 4_000 });

    // Otra vez: ya no tiene NFC activo (409) y no se apunta dos veces.
    const again = await inVenue(undefined, () => lost.challenge(c.walletId, HOST)) as { challenge: string };
    await expect(inVenue(undefined, () => lost.block(c.walletId, HOST, phone.assert(again.challenge)))).rejects.toMatchObject({ status: 409, response: { code: 'WALLET_NO_CARD' } });
    expect(await auditRows('wallet.card_blocked_by_client', c.walletId)).toHaveLength(1);

    // En recepción le dan un NFC nuevo con su código; el bloqueado no vuelve a darse.
    const { card: nuevo } = await inVenue(V, () => cards.newStockToken(V, { userId: rx }));
    await inVenue(V, () => charges.linkCard(actor(manager, 'MANAGER'), { code: c.code, card: nuevo }));
    expect(await inVenue(undefined, () => charges.clientState(c.qrToken))).toMatchObject({ hasCard: true });
    await expect(inVenue(undefined, () => cardView.pageView(nuevo))).resolves.toMatchObject({ kind: 'locked' });
    await expect(inVenue(V, () => charges.linkCard(actor(manager, 'MANAGER'), { code: c.code, card: c.card }))).rejects.toThrow(/bloqueada/);
  });

  it('sin passkey no se bloquea desde el móvil; la passkey de otro saldo tampoco', async () => {
    const a = await client();
    await expect(inVenue(undefined, () => lost.challenge(a.walletId, HOST))).rejects.toMatchObject({ status: 409, response: { code: 'FACE_ID_NOT_SET' } });
    const b = await client();
    const phoneB = await activate(b.walletId);
    await activate(a.walletId);
    const options = await inVenue(undefined, () => lost.challenge(a.walletId, HOST)) as { challenge: string };
    // Firma buena, pero de la llave de otro saldo y con el reto de este: no vale.
    await expect(inVenue(undefined, () => lost.block(a.walletId, HOST, phoneB.assert(options.challenge)))).rejects.toMatchObject({ status: 403 });
    expect((await sys((tx) => tx.walletCard.findUniqueOrThrow({ where: { token: a.card } }))).status).toBe('ISSUED');
  });
});
