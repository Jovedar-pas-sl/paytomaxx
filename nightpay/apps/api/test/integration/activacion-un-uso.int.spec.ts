// Integración (Postgres real, np_app y FORCE RLS; Redis de mentira; WebAuthn de
// software con la verificación real): el QR de activación de un solo uso
// (03-seguridad.md M-2).
//  - Recepción enseña /w/a/<token> (nunca el enlace permanente del saldo); en la
//    base solo su sha256, 10 min, quién y dónde.
//  - Abrirlo (GET, también las vistas previas de WhatsApp) no lo gasta.
//  - El primer Face ID o el primer PIN registrado con él lo gasta: con dos a la
//    vez, gana uno. Caducado o anulado (se pidió otro), no vale.
//  - El enlace permanente /w/<qrToken> ya no registra la primera llave.
//  - Las vías de siempre siguen: el móvil que pagó la recarga, recepción o la
//    chica en sus 15 min, el encargado, /w/card y el enlace nuevo del dueño.
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ClsService } from 'nestjs-cls';
import { UNPREFIXED_ROUTES } from '../../src/common/http/unprefixed-routes';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { createFakeRedis } from '../../src/modules/auth/testing/fake-redis';
import { GoogleWalletService } from '../../src/modules/wallets/google-wallet/google-wallet.service';
import { PublicWalletActivationController } from '../../src/modules/wallets/public-wallet-activation.controller';
import { PublicWalletController } from '../../src/modules/wallets/public-wallet.controller';
import { HOST, ORIGIN, SoftAuthenticator } from '../../src/modules/wallets/testing/soft-authenticator';
import { WalletActivationLinkService } from '../../src/modules/wallets/wallet-activation-link.service';
import { WalletActivationUseService } from '../../src/modules/wallets/wallet-activation-use.service';
import { WalletCardViewService } from '../../src/modules/wallets/wallet-card-view.service';
import { WalletCardsService } from '../../src/modules/wallets/wallet-cards.service';
import { CashTopUpService } from '../../src/modules/wallets/wallet-cash-topup.service';
import { WalletChargesService } from '../../src/modules/wallets/wallet-charges.service';
import { IncidentsService } from '../../src/modules/incidents/incidents.service';
import { WalletPasskeysService } from '../../src/modules/wallets/wallet-passkeys.service';
import { WalletTopUpService } from '../../src/modules/wallets/wallet-topup.service';
import { walletStreamAccess } from '../../src/modules/wallets/wallet-view-access';

process.env.NEXT_PUBLIC_API_URL = ORIGIN;
const SECRET = 'secreto-de-cookies-de-la-integracion-0123456789';
const MIN = 60_000;

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const audit = new AuditService(prisma, cls as never);
const fakeRedis = createFakeRedis();
const redis = Object.assign(fakeRedis, { exists: async (...keys: string[]) => keys.filter((k) => fakeRedis.has(k)).length });
const totp = { isEnabled: async () => true, assertForUser: async () => undefined };
const passkeys = new WalletPasskeysService(prisma, redis as never);
const cash = new CashTopUpService(prisma, audit, totp as never);
const cards = new WalletCardsService(prisma, audit);
const charges = new WalletChargesService(prisma as never, audit, { get: () => ({}) } as never, totp as never);
const links = new WalletActivationLinkService(prisma, audit, passkeys, { get: () => ORIGIN } as never);
const uses = new WalletActivationUseService(prisma, passkeys, charges, audit);
const cardView = new WalletCardViewService(prisma, passkeys);

const inVenue = <T>(tenantId: string | undefined, fn: () => Promise<T>): Promise<T> =>
  cls.run(async () => {
    cls.set('ctx', { tenantId, traceId: 't-activacion' });
    return fn();
  });
const pub = <T>(fn: () => Promise<T>): Promise<T> => inVenue(undefined, fn);
const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) => pub(() => prisma.asSystem(fn));
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

const r = randomUUID().slice(0, 6);
let V: string, rx: string, barra: string, manager: string, owner: string, chica: string;
const actor = (userId: string, role: 'WAITER' | 'MANAGER' | 'OWNER' | 'OPERATOR') => ({ userId, role, tenantId: V });

beforeAll(async () => {
  await prisma.onModuleInit();
  await sys(async (tx) => {
    V = (await tx.venue.create({ data: { name: 'Sala Activa', slug: `act-${r}`, walletGroup: `gact-${r}` } })).id;
    const user = async (name: string, role: string, post: string | null = null) =>
      (await tx.user.create({ data: { tenantId: V, email: `${name}-${r}@test.local`, passwordHash: 'test', role: role as never, post, displayName: name } })).id;
    rx = await user('rocio', 'WAITER', 'RECEPCION');
    barra = await user('pablo', 'WAITER', 'BARRA');
    manager = await user('javi', 'MANAGER');
    owner = await user('marta', 'OWNER');
    chica = await user('lola', 'OPERATOR');
  });
});
afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

/** El cliente que acaba de recargar en efectivo en recepción (saldo nuevo, sin Face ID ni PIN). */
async function client(amountCents = 5_000) {
  const topUp = await inVenue(V, () => cash.topUp(V, { userId: rx, role: 'WAITER' }, { amountCents, idempotencyKey: randomUUID(), wallet: { create: true } }));
  const wallet = await sys((tx) => tx.clientWallet.findUniqueOrThrow({ where: { id: topUp.walletId } }));
  return { walletId: topUp.walletId, code: topUp.code, qrToken: wallet.qrToken, shortCode: wallet.shortCode };
}

/** Recepción enseña el QR: el token es lo que va detrás de /w/a/. */
async function issue(walletId: string, who = actor(rx, 'WAITER')) {
  const link = await inVenue(V, () => links.link(who, walletId));
  const token = link.url.split('/w/a/')[1]!;
  return { ...link, token };
}

const tokenRow = (token: string) => sys((tx) => tx.walletActivationToken.findUnique({ where: { tokenHash: sha256(token) } }));
const keysOf = (walletId: string) => sys((tx) => tx.walletPasskey.count({ where: { walletId } }));
const pinOf = async (walletId: string) => (await sys((tx) => tx.clientWallet.findUniqueOrThrow({ where: { id: walletId }, select: { pinHash: true } }))).pinHash;
const auditRows = (action: string, targetId: string) =>
  sys((tx) => tx.auditEvent.findMany({ where: { action, targetId }, orderBy: { occurredAt: 'asc' } }));

/** El cliente activa Face ID en SU móvil con el QR. */
async function activateWith(token: string, phone = new SoftAuthenticator(), pin?: string) {
  const options = await pub(() => uses.passkeyOptions(token, HOST, pin));
  return pub(() => uses.registerPasskey(token, HOST, phone.register(options.challenge), pin));
}

/** El saldo ya tiene su edad: la recarga que lo creó fue hace horas. */
async function older(walletId: string) {
  await sys((tx) => tx.$executeRaw`UPDATE wallet_cash_topups SET "createdAt" = NOW() - INTERVAL '10 hours' WHERE "walletId" = ${walletId}::uuid`);
}

/** Otra recarga en efectivo a un saldo que ya existe, por su código (un céntimo basta). */
async function topUpByCode(code: string, amountCents = 1) {
  return inVenue(V, () => cash.topUp(V, { userId: rx, role: 'WAITER' }, { amountCents, idempotencyKey: randomUUID(), wallet: { code } }));
}

let app: NestFastifyApplication;
async function httpApp(): Promise<NestFastifyApplication> {
  if (app) return app;
  const ref = await Test.createTestingModule({
    controllers: [PublicWalletController, PublicWalletActivationController],
    providers: [
      { provide: WalletChargesService, useValue: charges },
      { provide: WalletPasskeysService, useValue: passkeys },
      { provide: WalletActivationUseService, useValue: uses },
      { provide: WalletTopUpService, useValue: { options: async () => null, paidProof: async () => null } },
      { provide: GoogleWalletService, useValue: { enabled: false } },
      { provide: ConfigService, useValue: { get: (k: string) => (k === 'COOKIE_SECRET' ? SECRET : undefined) } },
    ],
  }).compile();
  app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.setGlobalPrefix('v1', { exclude: [...UNPREFIXED_ROUTES] });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

describe('QR de activación de un solo uso (M-2, Postgres real)', () => {
  it('recepción lo emite: /w/a/<token>, nunca el enlace del saldo; en la base solo su sha256, 10 min, quién y dónde', async () => {
    const c = await client();
    const before = Date.now();
    const link = await issue(c.walletId);
    expect(link.url).toBe(`${ORIGIN}/w/a/${link.token}`);
    expect(link.url).not.toContain(c.qrToken);
    expect(link.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const expires = new Date(link.expiresAt).getTime();
    expect(expires).toBeGreaterThanOrEqual(before + 10 * MIN - 1_000);
    expect(expires).toBeLessThanOrEqual(Date.now() + 10 * MIN);
    const row = await tokenRow(link.token);
    expect(row).toMatchObject({ walletId: c.walletId, venueId: V, issuedById: rx, via: 'reception', usedAt: null, revokedAt: null });
    // Ni el token ni el enlace del saldo en la base: solo el hash.
    const stored = await sys((tx) => tx.$queryRaw<Array<{ t: string }>>`SELECT row_to_json(w)::text AS t FROM wallet_activation_tokens w WHERE "walletId" = ${c.walletId}::uuid`);
    expect(stored.map((s) => s.t).join()).not.toContain(link.token);
  });

  it('abrirlo (GET, como hacen las vistas previas de WhatsApp) no lo gasta: sigue valiendo', async () => {
    const c = await client();
    const link = await issue(c.walletId);
    const http = await httpApp();
    for (let i = 0; i < 3; i += 1) {
      const page = await http.inject({ method: 'GET', url: `/w/a/${link.token}`, headers: { host: HOST } });
      expect(page.statusCode).toBe(200);
      expect(page.headers['cache-control']).toContain('no-store');
      expect(page.body).not.toContain(c.qrToken);
    }
    await expect(pub(() => uses.view(link.token))).resolves.toMatchObject({ state: 'ok', hasPin: false });
    expect((await tokenRow(link.token))?.usedAt).toBeNull();
    // Y se puede usar después.
    await activateWith(link.token);
    expect(await keysOf(c.walletId)).toBe(1);
  });

  it('dos móviles registran su Face ID a la vez con el mismo QR: gana uno; el otro, «Este enlace ya se ha usado»', async () => {
    const c = await client();
    const link = await issue(c.walletId);
    const [a, b] = [new SoftAuthenticator(), new SoftAuthenticator()];
    const oa = await pub(() => uses.passkeyOptions(link.token, HOST));
    const ob = await pub(() => uses.passkeyOptions(link.token, HOST));
    const res = await Promise.allSettled([
      pub(() => uses.registerPasskey(link.token, HOST, a.register(oa.challenge))),
      pub(() => uses.registerPasskey(link.token, HOST, b.register(ob.challenge))),
    ]);
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const lost = res.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ status: 409, response: { code: 'ACTIVATION_USED', message: 'Este enlace ya se ha usado. Pide otro en recepción.' } });
    expect(await keysOf(c.walletId)).toBe(1);
    expect(await tokenRow(link.token)).toMatchObject({ usedFor: 'passkey' });
    await expect(pub(() => uses.view(link.token))).resolves.toEqual({ state: 'used' });
  });

  it('dos PIN a la vez con el mismo QR: gana uno; y después, ni otro PIN ni un Face ID con ese QR', async () => {
    const c = await client();
    const link = await issue(c.walletId);
    const res = await Promise.allSettled([pub(() => uses.setPin(link.token, '4827')), pub(() => uses.setPin(link.token, '7395'))]);
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect((res.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ response: { code: 'ACTIVATION_USED' } });
    expect(await pinOf(c.walletId)).not.toBeNull();
    expect(await tokenRow(link.token)).toMatchObject({ usedFor: 'pin' });
    await expect(pub(() => uses.passkeyOptions(link.token, HOST))).rejects.toMatchObject({ response: { code: 'ACTIVATION_USED' } });
    expect(await keysOf(c.walletId)).toBe(0);
  });

  it('caduca a los 10 min: «Este enlace ha caducado» y no se registra nada', async () => {
    const c = await client();
    const link = await issue(c.walletId);
    const options = await pub(() => uses.passkeyOptions(link.token, HOST));
    await sys((tx) => tx.walletActivationToken.update({ where: { tokenHash: sha256(link.token) }, data: { expiresAt: new Date(Date.now() - 1_000), createdAt: new Date(Date.now() - 11 * MIN) } }));
    await expect(pub(() => uses.view(link.token))).resolves.toEqual({ state: 'expired' });
    await expect(pub(() => uses.registerPasskey(link.token, HOST, new SoftAuthenticator().register(options.challenge)))).rejects.toMatchObject({
      status: 410,
      response: { code: 'ACTIVATION_EXPIRED', message: 'Este enlace ha caducado. Pide otro en recepción.' },
    });
    await expect(pub(() => uses.setPin(link.token, '4827'))).rejects.toMatchObject({ response: { code: 'ACTIVATION_EXPIRED' } });
    expect(await keysOf(c.walletId)).toBe(0);
    expect(await pinOf(c.walletId)).toBeNull();
  });

  it('pedir otro anula el anterior sin usar: el viejo «ha caducado», el nuevo vale', async () => {
    const c = await client();
    const old = await issue(c.walletId);
    const fresh = await issue(c.walletId, actor(manager, 'MANAGER'));
    expect(fresh.token).not.toBe(old.token);
    expect((await tokenRow(old.token))?.revokedAt).not.toBeNull();
    await expect(pub(() => uses.view(old.token))).resolves.toEqual({ state: 'expired' });
    await expect(pub(() => uses.setPin(old.token, '4827'))).rejects.toMatchObject({ response: { code: 'ACTIVATION_EXPIRED' } });
    await expect(pub(() => uses.setPin(fresh.token, '4827'))).resolves.toMatchObject({ walletId: c.walletId });
  });

  it('un QR que no es nuestro (forma rara o desconocido): «ha caducado», sin tocar nada', async () => {
    for (const token of ['x', '../../w/abc', 'A'.repeat(32)]) {
      await expect(pub(() => uses.view(token))).resolves.toEqual({ state: 'expired' });
      await expect(pub(() => uses.setPin(token, '4827'))).rejects.toMatchObject({ response: { code: 'ACTIVATION_EXPIRED' } });
    }
  });

  it('tras activar: su móvil sigue a su saldo (/w/<enlace> con su sesión), sin que el enlace salga en la pantalla del personal', async () => {
    const c = await client();
    const link = await issue(c.walletId);
    const http = await httpApp();
    const phone = new SoftAuthenticator();
    const options = (await http.inject({ method: 'POST', url: `/w/a/${link.token}/passkey/options`, headers: { host: HOST } })).json() as { challenge: string };
    const res = await http.inject({ method: 'POST', url: `/w/a/${link.token}/passkey`, headers: { host: HOST }, payload: { response: phone.register(options.challenge) } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ url: `/w/${c.qrToken}`, hadPin: false });
    const cookie = String((res.headers['set-cookie'] as string[])[0]).split(';')[0]!;
    const access = await pub(() =>
      walletStreamAccess({ walletRefByToken: (t) => charges.walletRefByToken(t), hasPasskey: (id) => passkeys.hasPasskey(id), secret: SECRET }, c.qrToken, cookie),
    );
    expect(access).toMatchObject({ allowed: true, walletId: c.walletId });
    const page = await http.inject({ method: 'GET', url: `/w/${c.qrToken}`, headers: { host: HOST, cookie } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('id="balance"');
  });

  it('saldo con PIN: el QR de recepción lo pide para activar Face ID; sin él o con otro, nada', async () => {
    const c = await client();
    await pub(() => charges.setPinFromPayer(c.walletId, '4827'));
    const link = await issue(c.walletId);
    await expect(pub(() => uses.view(link.token))).resolves.toMatchObject({ state: 'ok', hasPin: true, pinRequired: true });
    await expect(activateWith(link.token)).rejects.toMatchObject({ response: { code: 'PIN_FORMAT' } });
    await expect(activateWith(link.token, new SoftAuthenticator(), '0000')).rejects.toMatchObject({ response: { code: 'PIN_WRONG' } });
    expect(await keysOf(c.walletId)).toBe(0);
    expect((await tokenRow(link.token))?.usedAt).toBeNull();
    await expect(activateWith(link.token, new SoftAuthenticator(), '4827')).resolves.toMatchObject({ qrToken: c.qrToken, hadPin: true });
    expect(await keysOf(c.walletId)).toBe(1);
    await expect(pub(() => uses.setPin(link.token, '7395'))).rejects.toMatchObject({ response: { code: 'ACTIVATION_USED' } });
  });

  it('el céntimo no abre un saldo ajeno: sin PIN ni ficha no hay QR; con PIN, sale y lo pide', async () => {
    const c = await client();
    await older(c.walletId);
    await topUpByCode(c.code);
    await expect(issue(c.walletId)).rejects.toMatchObject({ status: 404, response: { reason: 'NEEDS_PROOF' } });
    await pub(() => charges.setPinFromPayer(c.walletId, '4827'));
    const link = await issue(c.walletId);
    await expect(activateWith(link.token)).rejects.toMatchObject({ response: { code: 'PIN_FORMAT' } });
    await activateWith(link.token, new SoftAuthenticator(), '4827');
    // Queda para Incidencias: un saldo que ya tenía dinero ha pasado a un móvil.
    expect(await auditRows('wallet.activation_not_new', c.walletId)).toHaveLength(1);
    const incidents = new IncidentsService(prisma as never, { log: async () => undefined } as never);
    const inbox = await pub(() => incidents.list(V));
    expect(inbox.filter((i) => i.kind === 'sensitive_action' && i.title === 'Saldo con dinero activado en un móvil')).not.toHaveLength(0);
  });

  it('activar un saldo recién creado no sale en Incidencias', async () => {
    const c = await client();
    const link = await issue(c.walletId);
    await activateWith(link.token);
    expect(await auditRows('wallet.activation_not_new', c.walletId)).toHaveLength(0);
  });

  it('activar con PIN cambia el enlace: el que se vio antes deja de abrir la página', async () => {
    const c = await client();
    const link = await issue(c.walletId);
    const http = await httpApp();
    const out = await pub(() => uses.setPin(link.token, '4827'));
    expect(out.qrToken).not.toBe(c.qrToken);
    expect((await http.inject({ method: 'GET', url: `/w/${c.qrToken}`, headers: { host: HOST } })).statusCode).toBe(404);
    expect((await http.inject({ method: 'GET', url: `/w/${out.qrToken}`, headers: { host: HOST } })).statusCode).toBe(200);
  });

  it('juntar saldos con solo el enlace no se lleva el dinero: pide el PIN del saldo de origen', async () => {
    const victim = await client(20_000);
    const mine = await client(1_000);
    const phone = new SoftAuthenticator();
    await activateWith((await issue(mine.walletId)).token, phone);
    const http = await httpApp();
    const attempt = async (pin?: string) => {
      const reto = (await http.inject({ method: 'POST', url: `/w/${victim.qrToken}/merge/challenge`, headers: { host: HOST } })).json() as { challenge: string };
      return http.inject({ method: 'POST', url: `/w/${victim.qrToken}/merge`, headers: { host: HOST }, payload: { response: phone.assert(reto.challenge), ...(pin ? { pin } : {}) } });
    };
    const noPin = await attempt();
    expect(noPin.statusCode).toBe(403);
    expect(noPin.json()).toMatchObject({ code: 'MERGE_PROOF_REQUIRED' });
    const balance = async (id: string) => (await sys((tx) => tx.clientWallet.findUniqueOrThrow({ where: { id } }))).balanceCents;
    expect(await balance(victim.walletId)).toBe(20_000);

    // Con PIN: otro PIN no vale; el suyo, sí.
    await pub(() => charges.setPinFromPayer(victim.walletId, '4827'));
    const wrong = await attempt('0000');
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json()).toMatchObject({ code: 'PIN_WRONG' });
    expect(await balance(victim.walletId)).toBe(20_000);
    const right = await attempt('4827');
    expect(right.statusCode).toBe(200);
    expect(await balance(mine.walletId)).toBe(21_000);
  });

  it('el enlace permanente /w/<qrToken> ya no registra el primer Face ID ni el primer PIN (403 ACTIVATION_REQUIRED)', async () => {
    const c = await client();
    const http = await httpApp();
    for (const url of [`/w/${c.qrToken}/passkey/options`, `/w/${c.qrToken}/passkey`]) {
      const res = await http.inject({ method: 'POST', url, headers: { host: HOST }, payload: {} });
      expect(res.statusCode, url).toBe(403);
      expect(res.json()).toMatchObject({ code: 'ACTIVATION_REQUIRED' });
    }
    const pin = await http.inject({ method: 'POST', url: `/w/${c.qrToken}/pin`, headers: { host: HOST }, payload: { pin: '4827', pin2: '4827' } });
    expect(pin.statusCode).toBe(403);
    expect(pin.json()).toMatchObject({ code: 'ACTIVATION_REQUIRED' });
    expect(await keysOf(c.walletId)).toBe(0);
    expect(await pinOf(c.walletId)).toBeNull();
    // Con su Face ID ya activado (con el QR), elegir PIN en /w sigue: con su llave.
    const link = await issue(c.walletId);
    const phone = new SoftAuthenticator();
    await activateWith(link.token, phone);
    const challenge = await pub(() => passkeys.challenge(`pin:${c.walletId}`, HOST));
    await expect(
      http.inject({ method: 'POST', url: `/w/${c.qrToken}/pin`, headers: { host: HOST }, payload: { pin: '4827', pin2: '4827', response: phone.assert(challenge.challenge) } }),
    ).resolves.toMatchObject({ statusCode: 200 });
    expect(await pinOf(c.walletId)).not.toBeNull();
  });

  it('las vías de siempre siguen: el móvil que pagó la recarga (/pay), recepción o la chica que la cobró en sus 15 min, y el encargado', async () => {
    // El móvil que pagó la recarga que creó el saldo: /pay/:token/passkey y /pay/:token/pin llaman a esto.
    const paid = await client();
    const phone = new SoftAuthenticator();
    const options = await pub(() => passkeys.registrationOptions({ id: paid.walletId, shortCode: paid.shortCode }, HOST));
    await pub(() => passkeys.register(paid.walletId, HOST, phone.register(options.challenge)));
    expect(await keysOf(paid.walletId)).toBe(1);
    const payerPin = await client();
    await pub(() => charges.setPinFromPayer(payerPin.walletId, '4827'));
    expect(await pinOf(payerPin.walletId)).not.toBeNull();
    // Quien cobró la recarga, en sus 15 minutos (aquí recepción), con el cliente delante.
    const fresh = await client();
    await inVenue(V, () => charges.setPin(actor(rx, 'WAITER'), { code: fresh.code, pin: '4827' }));
    expect(await pinOf(fresh.walletId)).not.toBeNull();
    // Otra persona (la barra) no: que lo elija con el encargado.
    const other = await client();
    await expect(inVenue(V, () => charges.setPin(actor(barra, 'WAITER'), { code: other.code, pin: '4827' }))).rejects.toMatchObject({ status: 422 });
    await inVenue(V, () => charges.setPin(actor(manager, 'MANAGER'), { code: other.code, pin: '4827' }));
    expect(await pinOf(other.walletId)).not.toBeNull();
    expect(chica).toBeTruthy();
  });

  it('la página del saldo ofrece la vía del móvil que pagó solo si el saldo nació de una recarga con tarjeta cobrada, y mientras vale su cookie (7 días)', async () => {
    const made = await sys(async (tx) => {
      const term = await tx.terminal.create({ data: { tenantId: V, externalId: `T-${randomUUID().slice(0, 8)}`, label: 'Barra', zone: 'BARRA' } });
      const w = await tx.clientWallet.create({
        data: { tenantId: V, balanceCents: 5_000, qrToken: randomBytes(18).toString('base64url'), walletGroup: `gact-${r}` },
      });
      const p = await tx.payment.create({
        data: {
          tenantId: V, terminalId: term.id, walletId: w.id, idempotencyKey: `pb-${randomUUID()}`, amountCents: 5_000, availableAmountCents: 5_000,
          qrToken: `qr-pb-${randomUUID()}`, qrExpiresAt: new Date(Date.now() + 3_600_000), status: 'AUTHORIZED', authorizedAt: new Date(),
          provider: 'REDSYS', providerTxId: `PB${randomUUID().slice(0, 8)}`,
        },
      });
      return { walletId: w.id, paymentId: p.id, payToken: p.qrToken };
    });
    expect(await pub(() => uses.payerBase(made.walletId))).toBe(`/pay/${made.payToken}`);
    // Pasada la vida de la cookie del pago (7 días), su navegador ya no puede: ni se ofrece ni sale el enlace del pago.
    await sys((tx) => tx.payment.update({ where: { id: made.paymentId }, data: { authorizedAt: new Date(Date.now() - 8 * 24 * 3_600_000) } }));
    expect(await pub(() => uses.payerBase(made.walletId))).toBeNull();
    // Nacido en efectivo: no hay móvil que pagara.
    expect(await pub(async () => uses.payerBase((await client()).walletId))).toBeNull();
  });

  it('el dueño da un enlace nuevo: va por /w/a/<token> de un solo uso (el enlace viejo deja de valer)', async () => {
    const c = await client();
    await activateWith((await issue(c.walletId)).token);
    const { path } = await inVenue(V, () => charges.relink(actor(owner, 'OWNER'), c.walletId));
    expect(path).toMatch(/^\/w\/a\/[A-Za-z0-9_-]{32}$/);
    const token = path.split('/w/a/')[1]!;
    expect(await tokenRow(token)).toMatchObject({ walletId: c.walletId, via: 'relink', issuedById: owner, venueId: V });
    // Llaves borradas y enlace nuevo: el viejo ya no lleva a ningún saldo.
    expect(await keysOf(c.walletId)).toBe(0);
    await expect(pub(() => charges.walletRefByToken(c.qrToken))).rejects.toMatchObject({ status: 404 });
    const out = await activateWith(token);
    expect(out.qrToken).not.toBe(c.qrToken);
    expect(await keysOf(c.walletId)).toBe(1);
  });

  it('en el registro: al emitir y al usar, sin el token ni el enlace', async () => {
    const c = await client();
    const link = await issue(c.walletId);
    await activateWith(link.token);
    const issued = await auditRows('wallet.activation_link', c.walletId);
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({ tenantId: V, actorId: rx, targetType: 'ClientWallet' });
    expect(issued[0]!.payload).toMatchObject({ via: 'reception', expiresAt: link.expiresAt });
    const used = await auditRows('wallet.activation_used', c.walletId);
    expect(used).toHaveLength(1);
    expect(used[0]!.payload).toMatchObject({ usedFor: 'passkey', hadPin: false, via: 'reception' });
    const all = JSON.stringify([...issued, ...used].map((x) => x.payload));
    expect(all).not.toContain(link.token);
    expect(all).not.toContain(c.qrToken);
    // Con el QR ya usado, /w/card ya no dice «pide el QR»: pide su Face ID.
    expect(cards).toBeTruthy();
    expect(cardView).toBeTruthy();
  });
});
