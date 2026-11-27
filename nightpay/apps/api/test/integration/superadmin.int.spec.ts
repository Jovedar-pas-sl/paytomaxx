// Integración (Postgres real): consola del super-admin (/v1/superadmin/*). Ver README.md.
// El super-admin tiene SU local activo en la sesión (como deja el AuthGuard):
// todo lo que cruza locales tiene que ir con acrossVenues o saldría vacío o
// en el local equivocado. client_wallets / wallet_consumptions con FORCE RLS.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { JwtService } from '@nestjs/jwt';
import * as speakeasy from 'speakeasy';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { madridDay, madridStartOfDay } from '../../src/common/time/madrid';
import { AuditService } from '../../src/modules/audit/audit.service';
import { LockoutService } from '../../src/modules/auth/lockout.service';
import { CLAIM_STEP_LUA, TotpAttemptsService } from '../../src/modules/auth/totp-attempts.service';
import { totpStepAt } from '../../src/modules/auth/totp-code';
import { sealTotpSecret } from '../../src/modules/auth/totp-crypto';
import { TotpService } from '../../src/modules/auth/totp.service';
import { claimStepScript, createFakeRedis } from '../../src/modules/auth/testing/fake-redis';
import { IncidentsService } from '../../src/modules/incidents/incidents.service';
import { idDocumentData } from '../../src/modules/operators/id-document';
import { OperatorsService } from '../../src/modules/operators/operators.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { WalletChargesService } from '../../src/modules/wallets/wallet-charges.service';
import { SuperAdminAuditLogService } from '../../src/modules/superadmin/audit-log.service';
import { SuperAdminBusinessesService } from '../../src/modules/superadmin/businesses.service';
import { SuperAdminCustomersService } from '../../src/modules/superadmin/customers.service';
import { SuperAdminOverviewService } from '../../src/modules/superadmin/overview.service';
import { SuperAdminPayoutAccountsService } from '../../src/modules/superadmin/payout-accounts.service';
import { SuperAdminStaffService } from '../../src/modules/superadmin/staff.service';
import { SuperAdminStepUpService } from '../../src/modules/superadmin/step-up.service';
import { SuperAdminAuditService } from '../../src/modules/superadmin/superadmin-audit.service';
import { SuperAdminVenuesService } from '../../src/modules/superadmin/venues.service';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const audit = new AuditService(prisma as never, cls as never);
const saAudit = new SuperAdminAuditService(audit);
const redis = createFakeRedis();
redis.defineScript(CLAIM_STEP_LUA, claimStepScript);
const totp = new TotpService(prisma as never, new TotpAttemptsService(new LockoutService(redis as never), redis as never));
/** Step-up de verdad (código de la app contra el secreto cifrado en users). */
const realStepUp = new SuperAdminStepUpService(totp, saAudit);
/** Para el resto: un código por paso de 30 s no da para todas las pruebas. */
const okStepUp = { verify: async () => undefined } as unknown as SuperAdminStepUpService;
const config = {
  get: (k: string) => ({ PAYOUT_HOLD_DAYS: '7', OPERATOR_BASE_URL: 'https://chicas.test' })[k] as string | undefined,
};
const jwt = new JwtService({ secret: 'x'.repeat(40) });
const email = { send: vi.fn(async () => ({ ok: true, delivered: false })), isEnabled: () => false };
const refreshTokens = { revokeAllForUser: vi.fn(async () => 0) };
const incidents = new IncidentsService(prisma as never, audit as never);
const overview = new SuperAdminOverviewService(prisma, incidents, config as never);
const venues = new SuperAdminVenuesService(prisma, okStepUp, saAudit, config as never);
const venuesReal = new SuperAdminVenuesService(prisma, realStepUp, saAudit, config as never);
const businesses = new SuperAdminBusinessesService(prisma, okStepUp, saAudit, venues);
const charges = new WalletChargesService(prisma as never, audit as never, { get: () => null } as never);
const customers = new SuperAdminCustomersService(prisma, okStepUp, saAudit, charges);
const operators = new OperatorsService(prisma as never, email as never, audit as never, config as never, jwt, {} as never, {} as never);
const staff = new SuperAdminStaffService(
  prisma,
  okStepUp,
  saAudit,
  operators,
  refreshTokens as never,
  totp,
  jwt,
  config as never,
  email as never,
  cls as never,
);
const accounts = new SuperAdminPayoutAccountsService(prisma, okStepUp, saAudit, audit, email as never);
const auditLog = new SuperAdminAuditLogService(prisma);
const queue = { add: vi.fn(async () => undefined) };
const payments = new PaymentsService(
  prisma as never,
  cls as never,
  queue as never,
  queue as never,
  {} as never,
  { emitPaymentUpdate: vi.fn(), emitPaymentCompleted: vi.fn() } as never,
  { paymentsCreated: { inc: vi.fn() }, paymentsTransitioned: { inc: vi.fn() }, walletCreditSkipped: { inc: vi.fn() } } as never,
  {} as never,
  {} as never,
  {} as never,
);

const r = randomUUID().slice(0, 6);
const SECRET = speakeasy.generateSecret({ length: 20 }).base32;
let HOME: string, V1: string, V2: string, B1: string, B2: string;
let superAdmin: string, chica1: string, chica2: string, w1: string, w2: string, topUpId: string;
let ownerV1: string, ownerV2: string;
const CODE1 = randomCode();
const CODE2 = randomCode();
const CARD = randomBytes(16).toString('base64url');
let actor: { id: string; email: string };

/** Como una petición del super-admin: su local (HOME) en el contexto, como deja el AuthGuard. */
function asSuperAdmin<T>(fn: () => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { tenantId: HOME, userId: superAdmin, role: 'OWNER', traceId: `sa-${r}` });
    return fn();
  });
}
function inVenue<T>(tenantId: string | undefined, fn: () => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { tenantId, traceId: `t-${r}` });
    return fn();
  });
}
const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) =>
  inVenue(undefined, () => prisma.asSystem(fn));

function randomCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from(randomBytes(6), (b) => alphabet[b % alphabet.length]).join('');
}
function codeAt(step: number): string {
  return speakeasy.totp({ secret: SECRET, encoding: 'base32', counter: step });
}

beforeAll(async () => {
  await prisma.onModuleInit();
  await sys(async (tx) => {
    HOME = (await tx.venue.create({ data: { name: 'Casa del super', slug: `sa-home-${r}` } })).id;
    superAdmin = (
      await tx.user.create({
        data: {
          tenantId: HOME,
          email: `super-${r}@x.es`,
          passwordHash: 'x',
          role: 'OWNER',
          isSuperAdmin: true,
          totpSecret: sealTotpSecret(SECRET, process.env.ENCRYPTION_KEK),
        },
      })
    ).id;
  });
  actor = { id: superAdmin, email: `super-${r}@x.es` };

  // Dos negocios con un local cada uno, por la propia consola.
  await asSuperAdmin(async () => {
    B1 = (await businesses.create(actor, { name: `Luna Ocio ${r}`, taxId: `B${r}01` })).id;
    B2 = (await businesses.create(actor, { name: `Sol Noche ${r}`, defaultPlatformCommissionBps: 800 })).id;
    V1 = (await venues.create(actor, { name: `Luna ${r}`, slug: `sa-v1-${r}`, businessId: B1, walletGroup: `g1-${r}` })).id;
    V2 = (await venues.create(actor, { name: `Sol ${r}`, slug: `sa-v2-${r}` })).id;
    await businesses.assignVenues(actor, B2, { venueIds: [V2] });
    // Local 2: a las chicas se les paga al cierre de la noche.
    await venues.updateRules(actor, V2, { payoutHoldDays: 0, totpCode: '123456' });
  });

  const today = Math.max(Date.now() - 60_000, startOfMadridToday() + 1000);
  await sys(async (tx) => {
    // En este local las compañeras cobran desde su móvil (como los locales de antes).
    await tx.venue.update({ where: { id: V1 }, data: { operatorsChargeFromPhone: true } });
    chica1 = (
      await tx.user.create({ data: { tenantId: V1, email: `c1-${r}@x.es`, passwordHash: 'x', role: 'OPERATOR', commissionBps: 9000 } })
    ).id;
    chica2 = (
      await tx.user.create({ data: { tenantId: V2, email: `c2-${r}@x.es`, passwordHash: 'x', role: 'OPERATOR', displayName: 'Ana' } })
    ).id;
    ownerV1 = (await tx.user.create({ data: { tenantId: V1, email: `o1-${r}@x.es`, passwordHash: 'x', role: 'OWNER' } })).id;
    ownerV2 = (await tx.user.create({ data: { tenantId: V2, email: `o2-${r}@x.es`, passwordHash: 'x', role: 'OWNER' } })).id;
    const t1 = (await tx.terminal.create({ data: { tenantId: V1, externalId: `T1-${r}`, label: 'Barra' } })).id;
    const t2 = (await tx.terminal.create({ data: { tenantId: V2, externalId: `T2-${r}`, label: 'Barra' } })).id;
    let n = 0;
    const pay = async (tenantId: string, terminalId: string, o: Record<string, unknown>) => {
      n += 1;
      return tx.payment.create({
        data: {
          tenantId,
          terminalId,
          idempotencyKey: `sa-${r}-${n}`,
          qrToken: `sa-${r}-${n}`,
          qrExpiresAt: new Date(),
          status: 'AUTHORIZED',
          ...o,
          availableAmountCents: Number(o.amountCents) + Number(o.tipCents ?? 0),
        } as never,
      });
    };
    const p1 = await pay(V1, t1, { amountCents: 10_000, tipCents: 500, authorizedAt: new Date(today) });
    await pay(V1, t1, { amountCents: 5_000, authorizedAt: new Date(Date.now() - 3 * 24 * 3600_000) });
    const p2 = await pay(V2, t2, { amountCents: 20_000, authorizedAt: new Date(today) });
    await pay(V2, t2, { amountCents: 7_000, status: 'FAILED' });
    // Atascado (incidencia del local 2).
    await pay(V2, t2, { amountCents: 1_000, status: 'ORPHAN' });
    await tx.operatorEarning.create({
      data: { tenantId: V1, operatorId: chica1, paymentId: p1.id, paymentAmountCents: 10_000, commissionBps: 9000, commissionCents: 9000 },
    });
    await tx.operatorEarning.create({
      data: { tenantId: V2, operatorId: chica2, paymentId: p2.id, paymentAmountCents: 20_000, commissionBps: 4000, commissionCents: 8000 },
    });
    w1 = (
      await tx.clientWallet.create({
        data: { tenantId: V1, qrToken: `sa-w1-${r}`, balanceCents: 12_000, shortCode: CODE1, walletGroup: `g1-${r}`, identifier: 'Mesa 3' },
      })
    ).id;
    w2 = (await tx.clientWallet.create({ data: { tenantId: V2, qrToken: `sa-w2-${r}`, balanceCents: 3_000, shortCode: CODE2 } })).id;
    await tx.clientWallet.create({ data: { tenantId: V2, qrToken: `sa-w3-${r}`, balanceCents: 0, status: 'REFUNDED' } });
    // Recarga aún sin pagar (no cuenta como cobrado): basta para buscar por id de cobro.
    topUpId = (await pay(V1, t1, { amountCents: 12_000, walletId: w1, captureMethod: 'WALLET_TOPUP', status: 'CREATED' })).id;
    await tx.walletCard.create({ data: { token: CARD, uid: `04A1B2C3${r.toUpperCase().replace(/[^0-9A-F]/g, '0')}`, walletId: w1, status: 'ISSUED' } });
    await tx.walletPasskey.create({ data: { walletId: w1, credentialId: `cred-${r}`, publicKey: Buffer.from([1, 2, 3]) } });
  });
  await inVenue(V2, () => audit.log({ action: 'auth.login.ok', actorId: chica2, tenantId: V2 }));
});

afterAll(async () => {
  await prisma.$disconnect();
});

function startOfMadridToday(): number {
  return madridStartOfDay(madridDay()).getTime();
}

describe('vista general: dos locales de dos negocios (Postgres real)', () => {
  it('cobrado hoy/semana, a pagar a las chicas con los días de cada local, saldo vivo e incidencias', async () => {
    const view = await asSuperAdmin(() => overview.overview());
    const b1 = view.businesses.find((b) => b.businessId === B1)!;
    const b2 = view.businesses.find((b) => b.businessId === B2)!;
    expect(b1.name).toBe(`Luna Ocio ${r}`);
    const v1 = b1.venues.find((v) => v.venueId === V1)!;
    const v2 = b2.venues.find((v) => v.venueId === V2)!;
    expect(v1).toMatchObject({
      chargedTodayCents: 10_500,
      paymentsToday: 1,
      chargedWeekCents: 15_500,
      // 7 días de espera (entorno): lo de hoy sigue en espera.
      pendingToChicasCents: 0,
      heldForChicasCents: 9_000,
      liveCustomerBalanceCents: 12_000,
      liveCustomerWallets: 1,
      openIncidents: 0,
      payoutHoldDays: 7,
      paused: false,
    });
    expect(v2).toMatchObject({
      chargedTodayCents: 20_000,
      chargedWeekCents: 20_000,
      // 0 días (regla del local): se le puede pagar ya.
      pendingToChicasCents: 8_000,
      heldForChicasCents: 0,
      liveCustomerBalanceCents: 3_000,
      liveCustomerWallets: 1,
      openIncidents: 1,
      payoutHoldDays: 0,
    });
    expect(b1.totals).toMatchObject({ chargedTodayCents: 10_500, venues: 1 });
    expect(b2.totals).toMatchObject({ pendingToChicasCents: 8_000, venues: 1 });
    // El local del super-admin (sin negocio) también sale.
    expect(view.businesses.find((b) => b.businessId === null)?.venues.some((v) => v.venueId === HOME)).toBe(true);
  });
});

describe('clientes con saldo: búsqueda en todos los locales (FORCE RLS vía acrossVenues)', () => {
  it('sin bypass, desde el local del super-admin, el saldo de otro local no se ve', async () => {
    const rows = await asSuperAdmin(() =>
      prisma.$transaction((tx) => tx.$queryRaw<unknown[]>`SELECT id FROM client_wallets WHERE id = ${w1}::uuid`),
    );
    expect(rows).toHaveLength(0);
  });

  it('por código, ficha NFC (código y número de serie), id del saldo e id de un cobro', async () => {
    const byCode = await asSuperAdmin(() => customers.search(`${CODE2.slice(0, 3)}-${CODE2.slice(3)}`));
    expect(byCode).toEqual([expect.objectContaining({ walletId: w2, matchedBy: 'shortCode', homeVenue: { id: V2, name: `Sol ${r}` } })]);
    expect(await asSuperAdmin(() => customers.search(CARD))).toEqual([expect.objectContaining({ walletId: w1, matchedBy: 'cardToken' })]);
    const card = await sys((tx) => tx.walletCard.findUnique({ where: { token: CARD } }));
    expect(await asSuperAdmin(() => customers.search(card!.uid!.toLowerCase()))).toEqual([
      expect.objectContaining({ walletId: w1, matchedBy: 'cardUid' }),
    ]);
    expect(await asSuperAdmin(() => customers.search(w1))).toEqual([expect.objectContaining({ walletId: w1, matchedBy: 'walletId' })]);
    expect(await asSuperAdmin(() => customers.search(topUpId))).toEqual([expect.objectContaining({ walletId: w1, matchedBy: 'paymentId' })]);
  });

  it('ficha: saldo, grupo, local de origen, movimientos, llaves y PIN', async () => {
    const d = await asSuperAdmin(() => customers.detail(w1));
    expect(d).toMatchObject({
      walletId: w1,
      balanceCents: 12_000,
      walletGroup: `g1-${r}`,
      homeVenue: { id: V1, name: `Luna ${r}` },
      passkeysCount: 1,
      cards: { active: 1, blocked: 0 },
      pin: { hasPin: false, locked: false },
      blocked: false,
    });
    expect(d.movements.map((m) => m.kind)).toContain('topup');
  });

  it('saldo bloqueado: no paga un cobro con QR; desbloqueado, sí', async () => {
    await asSuperAdmin(() => customers.block(actor, w1, { reason: 'posible fraude' }));
    const actorChica = { userId: chica1, role: 'OPERATOR' as const, tenantId: V1 };
    const qr = await inVenue(V1, () => charges.createQrCharge(actorChica, { amountCents: 2_000 }));
    await expect(inVenue(undefined, () => charges.payQrCharge(qr.payToken, w1))).rejects.toThrow(/bloqueado/);
    await asSuperAdmin(() => customers.unblock(actor, w1, { reason: 'aclarado', totpCode: '123456' }));
    const paid = await inVenue(undefined, () => charges.payQrCharge(qr.payToken, w1));
    expect(paid.balanceCents).toBe(10_000);
  });
});

describe('pausa: un local o su negocio en pausa no cobra (423) y queda en el registro', () => {
  const body = (tenantSuffix: string) => ({ amountCents: 3_000, currency: 'EUR', terminalExternalId: `${tenantSuffix}-${r}` }) as never;
  const owner = (venueId: string) => ({ userId: venueId === V1 ? ownerV1 : ownerV2, role: 'OWNER' });

  it('código 2FA malo: 403 TOTP_INVALID, no se pausa y el intento queda registrado', async () => {
    const step = totpStepAt(Date.now());
    const wrong = codeAt(step - 5);
    await expect(
      asSuperAdmin(() => venuesReal.pause(actor, V1, { reason: 'impagos', totpCode: wrong })),
    ).rejects.toMatchObject({ status: 403, response: expect.objectContaining({ code: 'TOTP_INVALID' }) });
    const v = await sys((tx) => tx.venue.findUnique({ where: { id: V1 } }));
    expect(v?.pausedAt).toBeNull();
    const failed = await sys((tx) =>
      tx.auditEvent.findFirst({ where: { action: 'superadmin.step_up.failed', actorId: superAdmin }, orderBy: { id: 'desc' } }),
    );
    expect(failed?.payload).toMatchObject({ attempted: 'venue.pause', code: 'TOTP_INVALID' });
  });

  it('con 2FA buena se pausa: cobros y cobros del saldo nuevos → 423 VENUE_PAUSED; el cambio queda en audit_events', async () => {
    const step = totpStepAt(Date.now());
    await asSuperAdmin(() => venuesReal.pause(actor, V1, { reason: 'impagos', totpCode: codeAt(step) }));
    await expect(inVenue(V1, () => payments.create(V1, `sa-k1-${r}`, body('T1'), owner(V1)))).rejects.toMatchObject({
      status: 423,
      response: expect.objectContaining({ code: 'VENUE_PAUSED', pausedBy: 'venue' }),
    });
    const actorChica = { userId: chica1, role: 'OPERATOR' as const, tenantId: V1 };
    await expect(inVenue(V1, () => charges.createQrCharge(actorChica, { amountCents: 1_000 }))).rejects.toMatchObject({ status: 423 });

    const row = await sys((tx) =>
      tx.auditEvent.findFirst({ where: { action: 'superadmin.venue.paused', targetId: V1 }, orderBy: { id: 'desc' } }),
    );
    expect(row).toMatchObject({ tenantId: V1, actorId: superAdmin, actorEmail: `super-${r}@x.es`, targetType: 'Venue' });
    expect(row?.payload).toMatchObject({ reason: 'impagos', before: { pausedAt: null } });

    // Quitar la pausa (otro código: el mismo no vale dos veces) y vuelve a cobrar.
    await asSuperAdmin(() => venuesReal.resume(actor, V1, { totpCode: codeAt(step + 1) }));
    const created = await inVenue(V1, () => payments.create(V1, `sa-k2-${r}`, body('T1'), owner(V1)));
    expect(created.id).toBeTruthy();
  });

  it('negocio en pausa: su local no cobra (pausedBy business); al reanudar, sí', async () => {
    await asSuperAdmin(() => businesses.pause(actor, B2, { reason: 'contrato vencido', totpCode: '123456' }));
    await expect(inVenue(V2, () => payments.create(V2, `sa-k3-${r}`, body('T2'), owner(V2)))).rejects.toMatchObject({
      status: 423,
      response: expect.objectContaining({ pausedBy: 'business' }),
    });
    const list = await asSuperAdmin(() => venues.list({ paused: 'true' }));
    expect(list.map((v) => v.id)).toContain(V2);
    await asSuperAdmin(() => businesses.resume(actor, B2, { totpCode: '123456' }));
    await expect(inVenue(V2, () => payments.create(V2, `sa-k4-${r}`, body('T2'), owner(V2)))).resolves.toBeTruthy();
  });
});

describe('personal, cuentas de cobro y registro (todos los locales)', () => {
  it('alta de encargado y de chica en otros locales: cada uno en el suyo (no en el del super-admin)', async () => {
    const manager = await asSuperAdmin(() =>
      staff.create(actor, { venueId: V2, role: 'MANAGER', email: `enc-${r}@x.es`, totpCode: '123456' }),
    );
    expect(manager.user).toMatchObject({ role: 'MANAGER', venue: { id: V2 }, invitePending: true, active: true });
    expect(manager.inviteUrl).toMatch(/^https:\/\/chicas\.test\/accept-invite\?token=/);
    expect(manager).not.toHaveProperty('password');
    const chica = await asSuperAdmin(() =>
      staff.create(actor, { venueId: V1, role: 'OPERATOR', email: `nueva-${r}@x.es`, displayName: 'Nueva', totpCode: '123456' }),
    );
    expect(chica.user).toMatchObject({ role: 'OPERATOR', venue: { id: V1 } });
    await expect(
      asSuperAdmin(() => staff.create(actor, { venueId: V1, role: 'WAITER', email: `ENC-${r}@x.es`, totpCode: '123456' })),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('baja de una compañera desde la consola: su documento se borra y su ficha NFC viva queda anulada', async () => {
    const leaving = await sys(async (tx) => {
      const u = await tx.user.create({ data: { tenantId: V1, email: `baja-${r}@x.es`, passwordHash: 'x', role: 'OPERATOR' } });
      await tx.user.update({ where: { id: u.id }, data: idDocumentData(u.id, { type: 'DNI', number: '12345678Z' }) });
      const [{ n }] = await tx.$queryRaw<Array<{ n: number }>>`SELECT nextval('wallet_cards_number_seq')::int AS n`;
      await tx.staffCard.create({ data: { tenantId: V1, userId: u.id, token: randomBytes(16).toString('base64url'), uid: `04${r}`, number: n! } });
      return u.id;
    });
    const view = await asSuperAdmin(() => staff.disable(actor, leaving, { reason: 'deja el local', totpCode: '123456' }));
    expect(view.active).toBe(false);
    const row = await sys((tx) =>
      tx.user.findUniqueOrThrow({ where: { id: leaving }, select: { idDocumentType: true, idDocumentNumber: true, deletedAt: true } }),
    );
    expect(row).toMatchObject({ idDocumentType: null, idDocumentNumber: null, deletedAt: expect.any(Date) });
    const cards = await sys((tx) => tx.staffCard.findMany({ where: { userId: leaving }, select: { revokedAt: true, revokedReason: true } }));
    expect(cards).toEqual([{ revokedAt: expect.any(Date), revokedReason: 'offboarded' }]);
  });

  it('lista por local y rol con último login y 2FA; reset de contraseña de una cuenta activa', async () => {
    const page = await asSuperAdmin(() => staff.list({ venueId: V2, role: 'OPERATOR', limit: 50 }));
    expect(page.items).toEqual([expect.objectContaining({ id: chica2, totpEnabled: false, isSuperAdmin: false, active: true })]);
    expect(page.items[0]!.lastLoginAt).not.toBeNull();
    const reset = await asSuperAdmin(() => staff.resetPassword(actor, chica2, { reason: 'la olvidó', totpCode: '123456' }));
    expect(reset.kind).toBe('password');
    const audited = await sys((tx) =>
      tx.auditEvent.findFirst({ where: { action: 'superadmin.user.password_reset', targetId: chica2 }, orderBy: { id: 'desc' } }),
    );
    expect(JSON.stringify(audited?.payload)).not.toContain(reset.kind === 'password' ? reset.password : 'x');
  });

  it('cuenta de cobro: se guarda normalizada y cifrada, la lista va tapada y verla entera queda registrado', async () => {
    const account = {
      payoutMethod: 'SEPA_IBAN' as const,
      payoutAddress: 'es91 2100 0418 4502 0005 1332',
      reason: 'cambio de banco',
      totpCode: '123456',
    };
    // En SEPA, con su titular.
    await expect(asSuperAdmin(() => accounts.update(actor, chica1, account))).rejects.toThrow('Falta el titular de la cuenta');
    email.send.mockClear();
    const updated = await asSuperAdmin(() => accounts.update(actor, chica1, { ...account, payoutMetadata: { accountHolder: 'Carla Pons' } }));
    expect(updated).toMatchObject({ payoutAddressMasked: 'ES91 •••• •••• 1332', payoutHolderMasked: 'C••• P•••' });
    // En la base, cifrada (ni el IBAN ni el titular en claro).
    const stored = await sys((tx) => tx.user.findUniqueOrThrow({ where: { id: chica1 }, select: { payoutAddress: true, payoutMetadata: true } }));
    expect(stored.payoutAddress).toMatch(/^pa1:/);
    expect(JSON.stringify(stored)).not.toContain('ES9121000418450200051332');
    expect(JSON.stringify(stored)).not.toContain('Pons');
    const full = await asSuperAdmin(() => accounts.reveal(actor, chica1, { reason: 'verificar', totpCode: '123456' }));
    expect(full).toMatchObject({ payoutAddress: 'ES9121000418450200051332', payoutMetadata: { accountHolder: 'Carla Pons' } });
    const rows = await sys((tx) => tx.auditEvent.findMany({ where: { targetId: chica1, action: { contains: 'payout_account' } } }));
    // El de la consola y, para el local (Incidencias, Telegram), el cambio «por OxioPay».
    expect(rows.map((a) => a.action).sort()).toEqual([
      'operator.payout_account_changed',
      'superadmin.payout_account.revealed',
      'superadmin.payout_account.updated',
    ]);
    expect(rows.find((a) => a.action === 'operator.payout_account_changed')).toMatchObject({ tenantId: V1, payload: { via: 'oxiopay' } });
    expect(JSON.stringify(rows.map((a) => a.payload))).not.toContain('ES9121000418450200051332');
    expect(JSON.stringify(rows.map((a) => a.payload))).not.toContain('Pons');
    // Y un correo a ella, con la cuenta tapada.
    expect(email.send).toHaveBeenCalledWith(expect.objectContaining({ to: `c1-${r}@x.es`, text: expect.stringContaining('ES91 •••• •••• 1332') }));
    expect(JSON.stringify(email.send.mock.calls)).not.toContain('ES9121000418450200051332');
  });

  it('registro: filtro por local y prefijo de acción, paginado, sin secretos', async () => {
    const page = await asSuperAdmin(() => auditLog.list({ venueId: V1, action: 'superadmin.venue.', limit: 1 }));
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.venue).toEqual({ id: V1, name: `Luna ${r}` });
    expect(page.nextCursor).not.toBeNull();
    const next = await asSuperAdmin(() => auditLog.list({ venueId: V1, action: 'superadmin.venue.', limit: 50, cursor: page.nextCursor! }));
    expect(next.items.every((i) => BigInt(i.id) < BigInt(page.items[0]!.id))).toBe(true);
  });
});

describe('grupo del saldo: solo entre locales del mismo negocio', () => {
  const totpCode = '123456';
  const venueRow = (id: string) => sys((tx) => tx.venue.findUniqueOrThrow({ where: { id } }));
  const newVenue = (name: string, extra: { businessId?: string; walletGroup: string }) => {
    const slug = `sa-${name.toLowerCase().replace(/ /g, '-')}-${r}`;
    return asSuperAdmin(() => venues.create(actor, { name: `${name} ${r}`, slug, ...extra, totpCode }));
  };

  it('alta y perfil con el grupo de un local de otro negocio: 409 con su nombre y no se guarda', async () => {
    // g1 es de Luna (V1, Luna Ocio); el alta nueva y Sol (V2) son de Sol Noche.
    await expect(newVenue('Mar', { businessId: B2, walletGroup: `g1-${r}` })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining(`Luna ${r}`),
    });
    expect(await sys((tx) => tx.venue.findUnique({ where: { slug: `sa-mar-${r}` } }))).toBeNull();
    await expect(asSuperAdmin(() => venues.updateProfile(actor, V2, { walletGroup: `g1-${r}`, totpCode }))).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining(`Luna ${r}`),
    });
    expect((await venueRow(V2)).walletGroup).toBeNull();
  });

  it('del mismo negocio, sí; sin negocio cuenta como otro negocio, en los dos sentidos', async () => {
    expect((await newVenue('Luna Norte', { businessId: B1, walletGroup: `g1-${r}` })).walletGroup).toBe(`g1-${r}`);
    // «Sin negocio» (lo que viene puesto en el alta) con el grupo de Luna Ocio: no.
    await expect(newVenue('Suelto', { walletGroup: `g1-${r}` })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining(`Luna ${r}`),
    });
    expect(await sys((tx) => tx.venue.findUnique({ where: { slug: `sa-suelto-${r}` } }))).toBeNull();
    // Un grupo que no usa nadie, sí; ese grupo en otro local sin negocio o en uno de Sol Noche, no.
    const loose = await newVenue('Suelto', { walletGroup: `g2-${r}` });
    await expect(newVenue('Suelto Bis', { walletGroup: `g2-${r}` })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining(loose.name),
    });
    await expect(asSuperAdmin(() => venues.updateProfile(actor, V2, { walletGroup: `g2-${r}`, totpCode }))).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining(loose.name),
    });
    expect((await venueRow(V2)).walletGroup).toBeNull();
  });

  it('meter en un negocio un local con el grupo de otro negocio: 409 y no se mueve; los del grupo, juntos, sí', async () => {
    // Un local de antes, sin negocio, con el grupo de uno de Sol Noche: a Luna Ocio, no; a Sol Noche, sí.
    await newVenue('Sol Sur', { businessId: B2, walletGroup: `g4-${r}` });
    const loose = (await sys((tx) => tx.venue.create({ data: { name: `Suelto Dos ${r}`, slug: `sa-suelto-dos-${r}`, walletGroup: `g4-${r}` } }))).id;
    await expect(asSuperAdmin(() => businesses.assignVenues(actor, B1, { venueIds: [loose], totpCode }))).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining(`Sol Sur ${r}`),
    });
    expect((await venueRow(loose)).businessId).toBeNull();
    await asSuperAdmin(() => businesses.assignVenues(actor, B2, { venueIds: [loose], totpCode }));
    expect((await venueRow(loose)).businessId).toBe(B2);

    // Dos locales de Luna Ocio con g3: uno solo a Sol Noche o fuera del negocio, no (el otro se queda); los dos juntos, sí.
    const a = (await newVenue('Par A', { businessId: B1, walletGroup: `g3-${r}` })).id;
    const b = (await newVenue('Par B', { businessId: B1, walletGroup: `g3-${r}` })).id;
    await expect(asSuperAdmin(() => businesses.unassignVenue(actor, B1, a, { totpCode }))).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining(`Par B ${r}`),
    });
    await expect(asSuperAdmin(() => businesses.assignVenues(actor, B2, { venueIds: [a], totpCode }))).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining(`Par B ${r}`),
    });
    expect((await venueRow(a)).businessId).toBe(B1);
    await asSuperAdmin(() => businesses.assignVenues(actor, B2, { venueIds: [a, b], totpCode }));
    expect((await venueRow(a)).businessId).toBe(B2);
  });
});
