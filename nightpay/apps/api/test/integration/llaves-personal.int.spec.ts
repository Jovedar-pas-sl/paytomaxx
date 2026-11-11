// Integración (Postgres real, np_app con FORCE RLS; Redis de mentira; WebAuthn de software):
// las llaves de acceso del personal («Detalle del pago», fase 2).
//  - La migración 20261109100000: la tabla, sus reglas (CHECK) y que se borra con la persona.
//  - Dar de alta la llave con la contraseña; verificarse con ella para ver lo delicado de un
//    cobro (5 minutos); quien tiene 2FA no puede usarla.
//  - Actuar sin 2FA con la llave: anular un cobro del saldo pide la prueba de ESA acción
//    (403 PASSKEY_REQUIRED con la acción), vale una vez y no sirve para otra.
import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { ClsService } from 'nestjs-cls';
import { stepUpActions, type JwtPayload } from '@nightpay/contracts';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { createFakeRedis } from '../../src/modules/auth/testing/fake-redis';
import { StaffPasskeysService } from '../../src/modules/auth/staff-passkeys.service';
import { StepUpService } from '../../src/modules/auth/step-up.service';
import { StepUpTokens } from '../../src/modules/auth/step-up-tokens';
import { TotpService } from '../../src/modules/auth/totp.service';
import { CobroDetailService } from '../../src/modules/money-map/cobro-detail.service';
import { SoftAuthenticator } from '../../src/modules/wallets/testing/soft-authenticator';
import { WalletsService } from '../../src/modules/wallets/wallets.service';

const APP = 'https://operator.paytomaxx.com';
const PASSWORD = 'la-contraseña-de-la-dueña';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const redis = Object.assign(createFakeRedis(), {});
const audit = { log: vi.fn(async () => undefined), logInTx: vi.fn(async () => undefined) };
const tokens = new StepUpTokens(redis as never);
const attempts = { assertNotLocked: vi.fn(), claimStep: vi.fn(async () => true), clearFailures: vi.fn(), recordFailure: vi.fn(async () => false) };
const totp = new TotpService(prisma, attempts as never, tokens, cls as never);
const lockout = { reserveAttempt: vi.fn(async () => ({ allowed: true, ttlSeconds: 0 })), clear: vi.fn(async () => undefined) };
const keys = new StaffPasskeysService(prisma, redis as never, totp, lockout as never, audit as never, cls as never);
const stepUp = new StepUpService(redis as never, totp, audit as never, keys, keys, tokens);
const details = new CobroDetailService(prisma, stepUp, { get: () => undefined } as never);
const wallets = new WalletsService(prisma as never, audit as never, totp);

const r = randomUUID().slice(0, 6);
let V: string, owner: string, ownerWith2fa: string;
const SID = randomUUID();

/** Como una petición de la dueña en su sesión (con la cabecera X-Step-Up-Token si se da). */
const as = <T>(userId: string | null, fn: () => Promise<T>, stepUpToken?: string) =>
  cls.run(async () => {
    cls.set('ctx', { traceId: `t-${r}`, ...(userId ? { userId, tenantId: V, role: 'OWNER', sessionId: SID } : {}), ...(stepUpToken ? { stepUpToken } : {}) } as never);
    return fn();
  });
const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) => as(null, () => prisma.asSystem(fn));
const me = () => ({ userId: owner, sessionId: SID, tenantId: V });
const jwt = (): JwtPayload => ({ sub: owner, role: 'OWNER', tenantId: V, email: `duena-${r}@x.es`, venueSlug: 'x', sid: SID }) as JwtPayload;

/** Un cobro del saldo pagado (con su consumo), para anularlo. */
async function paidSaldoCharge(): Promise<{ requestId: string; consumptionId: string; walletId: string }> {
  return sys(async (tx) => {
    const w = await tx.clientWallet.create({
      data: { tenantId: V, balanceCents: 2_000, qrToken: `lp-${r}-${randomBytes(4).toString('hex')}`, shortCode: randomBytes(3).toString('hex').toUpperCase(), walletGroup: `glp-${r}` },
    });
    const c = await tx.walletConsumption.create({ data: { tenantId: V, walletId: w.id, amountCents: 3_000, providedByUserId: owner, category: 'VENUE_BAR', notes: 'Copa' } });
    const q = await tx.walletChargeRequest.create({
      data: { tenantId: V, walletId: w.id, requestedByUserId: owner, amountCents: 3_000, category: 'VENUE_BAR', status: 'ACCEPTED', expiresAt: new Date(Date.now() + 60_000), decidedAt: new Date(), consumptionId: c.id },
    });
    return { requestId: q.id, consumptionId: c.id, walletId: w.id };
  });
}

/** La dueña, sin 2FA, da de alta su llave y devuelve su móvil. */
async function enrolledPhone(): Promise<SoftAuthenticator> {
  const phone = new SoftAuthenticator();
  const opts = await as(owner, () => keys.registrationOptions(me(), PASSWORD, undefined, APP));
  await as(owner, () => keys.register(me(), phone.register(opts.challenge, APP), 'Mi iPhone', APP));
  return phone;
}

beforeAll(async () => {
  await prisma.onModuleInit();
  const hash = bcrypt.hashSync(PASSWORD, 4);
  await sys(async (tx) => {
    V = (await tx.venue.create({ data: { name: 'Sala Bambú (Madrid)', slug: `lp-${r}`, walletGroup: `glp-${r}` } })).id;
    owner = (await tx.user.create({ data: { tenantId: V, email: `duena-${r}@x.es`, passwordHash: hash, role: 'OWNER', displayName: 'Dueña' } })).id;
    ownerWith2fa = (
      await tx.user.create({ data: { tenantId: V, email: `socio-${r}@x.es`, passwordHash: hash, role: 'OWNER', displayName: 'Socio', totpSecret: 'JBSWY3DPEHPK3PXP' } })
    ).id;
  });
});

beforeEach(() => {
  vi.stubEnv('CORS_ORIGINS', 'https://admin.paytomaxx.com,https://operator.paytomaxx.com');
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('PASSKEY_RP_ID', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('la tabla de las llaves (migración 20261109100000)', () => {
  it('sus reglas: nombre de 1 a 80, credencial en base64url y contador no negativo; se borra con la persona', async () => {
    const base = { userId: ownerWith2fa, publicKey: Buffer.from('clave'), name: 'Móvil' };
    await expect(sys((tx) => tx.staffPasskey.create({ data: { ...base, credentialId: 'corta' } }))).rejects.toThrow();
    await expect(sys((tx) => tx.staffPasskey.create({ data: { ...base, credentialId: 'a'.repeat(22), name: '' } }))).rejects.toThrow();
    await expect(sys((tx) => tx.staffPasskey.create({ data: { ...base, credentialId: 'b'.repeat(22), counter: -1n } }))).rejects.toThrow();
    const temp = await sys((tx) => tx.user.create({ data: { tenantId: V, email: `temp-${r}@x.es`, passwordHash: 'x', role: 'WAITER' } }));
    await sys((tx) => tx.staffPasskey.create({ data: { ...base, userId: temp.id, credentialId: 'c'.repeat(22) } }));
    await sys((tx) => tx.user.delete({ where: { id: temp.id } }));
    expect(await sys((tx) => tx.staffPasskey.count({ where: { userId: temp.id } }))).toBe(0);
  });
});

describe('verificarse con la llave para ver lo delicado', () => {
  it('sin 2FA: la llave da 5 minutos y el detalle trae lo delicado; antes, null', async () => {
    const phone = await enrolledPhone();
    const { requestId } = await paidSaldoCharge();
    const before = await as(null, () => details.forManager(jwt(), 'SALDO', requestId));
    expect(before.sensitive).toBeNull();
    expect(before.verify).toMatchObject({ required: true, method: 'passkey' });
    const opts = await as(owner, () => stepUp.passkeyOptions(me(), undefined, APP));
    const out = await as(owner, () => stepUp.verifyWithPasskey(me(), phone.assert(opts.challenge, { origin: APP }), undefined, APP));
    expect(out).toMatchObject({ verifiedWith: 'passkey', proof: null });
    const after = await as(null, () => details.forManager(jwt(), 'SALDO', requestId));
    expect(after.sensitive).not.toBeNull();
    expect(after.verify).toMatchObject({ required: false, method: 'passkey' });
  });

  it('quien tiene 2FA no se verifica con la llave (403 TOTP_REQUIRED)', async () => {
    const socio = { userId: ownerWith2fa, sessionId: randomUUID(), tenantId: V };
    await expect(as(ownerWith2fa, () => stepUp.passkeyOptions(socio, undefined, APP))).rejects.toMatchObject({ response: { code: 'TOTP_REQUIRED' } });
  });
});

describe('actuar sin 2FA con la llave: anular un cobro del saldo', () => {
  it('sin prueba: 403 PASSKEY_REQUIRED con la acción; con la prueba de esa acción, se anula una vez', async () => {
    const phone = await enrolledPhone();
    const charge = await paidSaldoCharge();
    const reverse = (token?: string) =>
      as(
        owner,
        () => wallets.reverseConsumption({ tenantId: V, walletId: charge.walletId, consumptionId: charge.consumptionId, actorUserId: owner, reason: 'Cobrado por error' }),
        token,
      );
    const action = stepUpActions.reverseConsumption(charge.consumptionId);
    await expect(reverse()).rejects.toMatchObject({ response: { code: 'PASSKEY_REQUIRED', stepUpAction: action } });
    // La prueba de otra acción no vale.
    const otherAction = stepUpActions.reverseConsumption(randomUUID());
    const otherOpts = await as(owner, () => stepUp.passkeyOptions(me(), otherAction, APP));
    const other = await as(owner, () => stepUp.verifyWithPasskey(me(), phone.assert(otherOpts.challenge, { origin: APP }), otherAction, APP));
    await expect(reverse(other.proof!.token)).rejects.toMatchObject({ response: { code: 'PASSKEY_REQUIRED' } });
    // La de esta acción: se anula (y el saldo vuelve).
    const opts = await as(owner, () => stepUp.passkeyOptions(me(), action, APP));
    const ok = await as(owner, () => stepUp.verifyWithPasskey(me(), phone.assert(opts.challenge, { origin: APP }), action, APP));
    await expect(reverse(ok.proof!.token)).resolves.toMatchObject({ refundedCents: 3_000, newBalanceCents: 5_000 });
    const c = await sys((tx) => tx.walletConsumption.findUniqueOrThrow({ where: { id: charge.consumptionId } }));
    expect(c.reversedByUserId).toBe(owner);
    // El detalle dice quién y por qué.
    const d = await as(null, () => details.forManager(jwt(), 'SALDO', charge.requestId));
    expect(d.undo).toEqual([expect.objectContaining({ kind: 'VOID', reason: 'Cobrado por error', by: 'Dueña' })]);
  });

  it('la prueba vale una sola vez', async () => {
    const phone = await enrolledPhone();
    const first = await paidSaldoCharge();
    const action = stepUpActions.reverseConsumption(first.consumptionId);
    const opts = await as(owner, () => stepUp.passkeyOptions(me(), action, APP));
    const ok = await as(owner, () => stepUp.verifyWithPasskey(me(), phone.assert(opts.challenge, { origin: APP }), action, APP));
    const run = () =>
      as(
        owner,
        () => wallets.reverseConsumption({ tenantId: V, walletId: first.walletId, consumptionId: first.consumptionId, actorUserId: owner, reason: 'Error' }),
        ok.proof!.token,
      );
    await run();
    // Otra petición con la misma prueba: ya se gastó.
    await expect(as(owner, () => totp.assertForUser(owner, undefined, action), ok.proof!.token)).rejects.toMatchObject({
      response: { code: 'PASSKEY_REQUIRED', stepUpAction: action },
    });
  });
});
