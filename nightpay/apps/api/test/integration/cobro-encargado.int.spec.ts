// Integración (Postgres real, FORCE RLS, rol sin superusuario): cobro por el encargado, fase 1
// (migración 20261125100000_cobro_encargado, 25-nov-2026).
//  - La casilla «Las compañeras cobran desde su móvil» (venues.operatorsChargeFromPhone): los
//    locales de antes, encendida; las altas del super-admin y de /admin/venues, apagada; el
//    super-admin la cambia con su 2FA de verdad y queda en el registro con el antes y el después.
//  - La compañera del servicio en la línea (payment_lines.serviceOperatorId): solo en Servicios
//    (CHECK), y la migración que se puede repetir sin tocar lo guardado.
// Ver README.md.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ClsService } from 'nestjs-cls';
import type { JwtPayload } from '@nightpay/contracts';
import { PrismaService, type TransactionalClient } from '../../src/common/prisma/prisma.service';
import { AdminController } from '../../src/modules/admin/admin.controller';
import { AuditService } from '../../src/modules/audit/audit.service';
import { LockoutService } from '../../src/modules/auth/lockout.service';
import { claimStepScript, createFakeRedis } from '../../src/modules/auth/testing/fake-redis';
import { totpCodeAt } from '../../src/modules/auth/testing/totp-kit';
import { CLAIM_STEP_LUA, TotpAttemptsService } from '../../src/modules/auth/totp-attempts.service';
import { TotpService } from '../../src/modules/auth/totp.service';
import { SuperAdminStepUpService } from '../../src/modules/superadmin/step-up.service';
import { SuperAdminAuditService } from '../../src/modules/superadmin/superadmin-audit.service';
import { SuperAdminVenuesService } from '../../src/modules/superadmin/venues.service';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const audit = new AuditService(prisma, cls as never);
const redis = createFakeRedis();
redis.defineScript(CLAIM_STEP_LUA, claimStepScript);
const totp = new TotpService(prisma, new TotpAttemptsService(new LockoutService(redis as never), redis as never));
const saAudit = new SuperAdminAuditService(audit);
/** La consola con la 2FA de verdad (el código de la app contra el secreto cifrado del super-admin). */
const venues = new SuperAdminVenuesService(prisma, new SuperAdminStepUpService(totp, saAudit), saAudit, { get: () => '7' } as never);
const admin = new AdminController(prisma, {} as never, audit, {} as never, {} as never, cls as never, {} as never, {} as never);

const DB_PKG = join(__dirname, '../../../../packages/db');
const MIGRATION = join(DB_PKG, 'prisma/migrations/20261125100000_cobro_encargado/migration.sql');

const r = randomUUID().slice(0, 6);
let HOME: string; // el local del super-admin
let superAdmin: string;
let secret: string;
let actor: { id: string; email: string };

/** Con ese local en el contexto (el del super-admin, como deja el AuthGuard), o sin local. */
function inVenue<T>(tenantId: string | undefined, fn: () => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { tenantId, traceId: `t-enc-${r}` });
    return fn();
  });
}
const sys = <T>(fn: (tx: TransactionalClient) => Promise<T>) => inVenue(undefined, () => prisma.asSystem(fn));
const newVenue = (name: string, data: Record<string, unknown> = {}) =>
  sys(async (tx) => (await tx.venue.create({ data: { name: `${name} ${r}`, slug: `enc-${name.toLowerCase()}-${r}`, ...data } })).id);
const casillaOf = async (venueId: string) =>
  (await sys((tx) => tx.venue.findUniqueOrThrow({ where: { id: venueId }, select: { operatorsChargeFromPhone: true } })))
    .operatorsChargeFromPhone;

beforeAll(async () => {
  await prisma.onModuleInit();
  HOME = await newVenue('Casa');
  secret = totp.newSecret();
  superAdmin = await sys(async (tx) =>
    (
      await tx.user.create({
        data: { tenantId: HOME, email: `super-${r}@x.es`, passwordHash: 'x', role: 'OWNER', isSuperAdmin: true, totpSecret: totp.sealSecret(secret) },
      })
    ).id,
  );
  actor = { id: superAdmin, email: `super-${r}@x.es` };
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('La casilla «Las compañeras cobran desde su móvil»', () => {
  it('un local de antes (creado sin decir nada) la tiene encendida: sigue como hoy', async () => {
    expect(await casillaOf(await newVenue('Antes'))).toBe(true);
  });

  it('el alta por /admin/venues la deja apagada', async () => {
    const created = await inVenue(HOME, () =>
      admin.createVenue({ sub: superAdmin } as JwtPayload, { name: `Alta ${r}`, slug: `enc-alta-${r}` }),
    );
    expect(await casillaOf(created.id)).toBe(false);
  });

  it('el super-admin la apaga con su 2FA y el registro lleva el antes y el después', async () => {
    const V = await newVenue('Luna');
    const detail = await inVenue(HOME, () =>
      venues.updateRules(actor, V, { operatorsChargeFromPhone: false, totpCode: totpCodeAt(secret) }),
    );
    expect(detail.rules.operatorsChargeFromPhone).toBe(false);
    expect(await casillaOf(V)).toBe(false);
    const row = await sys((tx) =>
      tx.auditEvent.findFirst({ where: { action: 'superadmin.venue.rules_updated', targetId: V }, orderBy: { id: 'desc' } }),
    );
    expect(row).toMatchObject({ tenantId: V, actorId: superAdmin, targetType: 'Venue' });
    expect(row?.payload).toEqual({ before: { operatorsChargeFromPhone: true }, after: { operatorsChargeFromPhone: false } });
  });
});

describe('La compañera del servicio en la línea (payment_lines.serviceOperatorId)', () => {
  it('solo en una línea de Servicios: en otra sección, la base no la guarda (CHECK)', async () => {
    const V = await newVenue('Lineas');
    const { payment, nerea } = await sys(async (tx) => {
      const term = await tx.terminal.create({ data: { tenantId: V, externalId: `ENC-${r}`, label: 'Barra' } });
      const p = await tx.payment.create({
        data: {
          tenantId: V,
          terminalId: term.id,
          idempotencyKey: `enc-${r}`,
          amountCents: 7000,
          availableAmountCents: 0,
          qrToken: `enc-${r}`,
          qrExpiresAt: new Date(Date.now() + 60_000),
        } as never,
      });
      const u = await tx.user.create({ data: { tenantId: V, email: `nerea-${r}@x.es`, passwordHash: 'x', role: 'OPERATOR', displayName: 'Nerea' } });
      return { payment: p.id, nerea: u.id };
    });
    const line = (category: string, amountCents: number) =>
      sys((tx) =>
        tx.paymentLine.create({
          data: { tenantId: V, paymentId: payment, category, label: category, qty: 1, unitCents: amountCents, amountCents, serviceOperatorId: nerea },
        }),
      );
    await expect(line('CHICA_SERVICE', 6000)).resolves.toMatchObject({ serviceOperatorId: nerea });
    await expect(line('VENUE_BAR', 1000)).rejects.toThrow(/payment_lines_service_operator_in_services/);
  });

  it('la migración se puede repetir y no vuelve a encender un local apagado', async () => {
    const V = await newVenue('Repetir', { operatorsChargeFromPhone: false });
    const res = spawnSync(
      process.execPath,
      [join(DB_PKG, 'node_modules/prisma/build/index.js'), 'db', 'execute', '--url', String(process.env.DATABASE_URL), '--file', MIGRATION],
      { encoding: 'utf8', env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: '1' } },
    );
    expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0);
    expect(await casillaOf(V)).toBe(false);
  });
});
