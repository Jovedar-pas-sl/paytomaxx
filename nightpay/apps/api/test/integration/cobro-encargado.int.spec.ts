// Integración (Postgres real, FORCE RLS, rol sin superusuario): cobro por el encargado, fase 1
// (migración 20261125100000_cobro_encargado, 25-nov-2026).
//  - La casilla «Las compañeras cobran desde su móvil» (venues.operatorsChargeFromPhone): los
//    locales de antes, encendida; las altas del super-admin y de /admin/venues, apagada; el
//    super-admin la cambia con su 2FA de verdad y queda en el registro con el antes y el después.
//  - La compañera del servicio en la línea (payment_lines.serviceOperatorId): solo en Servicios
//    (CHECK), y la migración que se puede repetir sin tocar lo guardado.
//  - Con la casilla apagada, la compañera no crea cobros ni recargas por ningún canal (cobro único,
//    datáfono, cobro del saldo y recarga con tarjeta), su carta sale vacía y /venues/me se lo dice.
//  - A nombre de la compañera: el encargado, el dueño o recepción con permiso cobran el servicio con
//    su «Mi QR»; las líneas de Servicios la llevan con su %, y el resto del cobro, 0.
//  - El reparto: pagado con tarjeta, ficha o datáfono, a ella le llegan su parte y la propina
//    entera (y la devolución se la descuenta); la propina que se ofrece sigue la fila Sala.
//  - Lo que ven los demás: /pay y /s dicen «Servicio con Nerea» (con su foto en /pay) y las listas del
//    datáfono y del encargado, «Servicio de Nerea».
// Ver README.md.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ClsService } from 'nestjs-cls';
import {
  SALA_PHONE_OFF_MESSAGE,
  SECTION_NOT_ALLOWED_CODE,
  STAFF_PERMISSION_DENIED_CODE,
  TOP_UP_RECEPTION_ONLY_CODE,
  type JwtPayload,
} from '@nightpay/contracts';
import { PrismaService, type TransactionalClient } from '../../src/common/prisma/prisma.service';
import { AdminController } from '../../src/modules/admin/admin.controller';
import { AuditService } from '../../src/modules/audit/audit.service';
import { LockoutService } from '../../src/modules/auth/lockout.service';
import { claimStepScript, createFakeRedis } from '../../src/modules/auth/testing/fake-redis';
import { totpCodeAt } from '../../src/modules/auth/testing/totp-kit';
import { CLAIM_STEP_LUA, TotpAttemptsService } from '../../src/modules/auth/totp-attempts.service';
import { TotpService } from '../../src/modules/auth/totp.service';
import { CartaService } from '../../src/modules/carta/carta.service';
import { IncidentsService } from '../../src/modules/incidents/incidents.service';
import { invitationTotals } from '../../src/modules/money-map/invitation-totals';
import { MoneyMapService } from '../../src/modules/money-map/money-map.service';
import { StaffFichaService } from '../../src/modules/money-map/staff-ficha.service';
import { CloseCheckService } from '../../src/modules/nights/close-check.service';
import { NightsService } from '../../src/modules/nights/nights.service';
import { signStaffToken } from '../../src/modules/operators/staff-qr';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import type { PosDevice } from '../../src/modules/pos-device/device.guard';
import { PosDeviceService } from '../../src/modules/pos-device/pos-device.service';
import { RefundsService } from '../../src/modules/refunds/refunds.service';
import { ReportsService } from '../../src/modules/reports/reports.service';
import { SuperAdminStepUpService } from '../../src/modules/superadmin/step-up.service';
import { SuperAdminAuditService } from '../../src/modules/superadmin/superadmin-audit.service';
import { SuperAdminVenuesService } from '../../src/modules/superadmin/venues.service';
import { VenuesController } from '../../src/modules/venues/venues.controller';
import { WalletChargesService } from '../../src/modules/wallets/wallet-charges.service';

process.env.JWT_SECRET ??= 'clave-de-las-pruebas-de-integracion-0123456789';
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
const noop = () => undefined;
const queue = { add: async () => undefined };
const payments = new PaymentsService(
  prisma,
  cls as never,
  queue as never,
  queue as never,
  {} as never,
  { emitPaymentUpdate: noop, emitPaymentCompleted: noop } as never,
  { paymentsCreated: { inc: noop }, paymentsTransitioned: { inc: noop }, walletCreditSkipped: { inc: noop }, duplicateCharges: { inc: noop } } as never,
  {} as never,
  {} as never,
);
const charges = new WalletChargesService(prisma, audit, { get: () => ({}) } as never, {} as never);
const carta = new CartaService(prisma, audit);
const venuesMe = new VenuesController(prisma);

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

describe('Casilla apagada: la compañera no crea cobros ni recargas por ningún canal', () => {
  /** Un local con Sala que carga saldos y el datáfono encendido, Nerea (compañera) y un «Servicio 1 h». */
  async function local(name: string, operatorsChargeFromPhone: boolean) {
    const V = await newVenue(name, {
      operatorsChargeFromPhone,
      postRules: { SALA: { topUps: true } },
      paymentMethods: { pos: true },
      walletGroup: `genc-${name}-${r}`,
    });
    return sys(async (tx) => {
      await tx.terminal.create({ data: { tenantId: V, externalId: `ENC-${name}-${r}`, label: 'Barra' } });
      const nerea = await tx.user.create({
        data: { tenantId: V, email: `nerea-${name.toLowerCase()}-${r}@x.es`, passwordHash: 'x', role: 'OPERATOR', displayName: 'Nerea' },
      });
      const servicio = await tx.serviceItem.create({ data: { tenantId: V, name: 'Servicio 1 h', priceCents: 6000, category: 'CHICA_SERVICE' } });
      return { V, name, nerea: nerea.id, servicio: servicio.id };
    });
  }
  let n = 0;
  /** Lo que puede hacer ella desde su móvil: cada canal que crea un cobro o una recarga, su carta y /venues/me. */
  function canales(l: Awaited<ReturnType<typeof local>>) {
    const pay = (body: Record<string, unknown>) =>
      inVenue(l.V, () =>
        payments.create(l.V, `enc-${r}-${(n += 1)}`, { currency: 'EUR', terminalExternalId: `ENC-${l.name}-${r}`, ...body } as never, {
          userId: l.nerea,
          role: 'OPERATOR',
        }),
      );
    return {
      cobroUnico: () => pay({ lines: [{ serviceItemId: l.servicio, qty: 1 }], withSaldo: true }),
      datafono: () => pay({ amountCents: 6000, captureMethod: 'POS_EXTERNAL' }),
      saldo: () => inVenue(l.V, () => charges.createQrCharge({ userId: l.nerea, role: 'OPERATOR', tenantId: l.V }, { amountCents: 3000 })),
      recarga: () => pay({ amountCents: 5000, wallet: { create: true } }),
      carta: () => inVenue(l.V, () => carta.listForStaff(l.V, 'OPERATOR', l.nerea)),
      me: () => inVenue(l.V, () => venuesMe.getMyVenue({ sub: l.nerea, role: 'OPERATOR', tenantId: l.V } as JwtPayload)),
    };
  }

  it('apagada: «Hoy cobra el encargado» en el cobro único, el datáfono y el saldo; no recarga; carta vacía; y no se crea nada', async () => {
    const l = await local('Apagado', false);
    const c = canales(l);
    const hoyCobraElEncargado = {
      status: 403,
      response: expect.objectContaining({ code: SECTION_NOT_ALLOWED_CODE, message: SALA_PHONE_OFF_MESSAGE }),
    };
    await expect(c.cobroUnico()).rejects.toMatchObject(hoyCobraElEncargado);
    await expect(c.datafono()).rejects.toMatchObject(hoyCobraElEncargado);
    await expect(c.saldo()).rejects.toMatchObject(hoyCobraElEncargado);
    // Aunque Sala cargue saldos en este local.
    await expect(c.recarga()).rejects.toMatchObject({ status: 403, response: expect.objectContaining({ code: TOP_UP_RECEPTION_ONLY_CODE }) });
    expect(await c.carta()).toEqual([]);
    expect((await c.me()).myRights).toEqual({ sections: [], tips: true, cash: false, topUps: false, serviceTips: true });
    const made = await sys(async (tx) => [
      await tx.payment.count({ where: { tenantId: l.V } }),
      await tx.walletChargeRequest.count({ where: { tenantId: l.V } }),
    ]);
    expect(made).toEqual([0, 0]);
  });

  it('encendida: como hoy (cobra por los tres canales, recarga si Sala carga saldos y ve su carta)', async () => {
    const l = await local('Encendido', true);
    const c = canales(l);
    await expect(c.cobroUnico()).resolves.toMatchObject({ amountCents: 6000 });
    await expect(c.datafono()).resolves.toMatchObject({ amountCents: 6000 });
    await expect(c.saldo()).resolves.toMatchObject({ amountCents: 3000 });
    await expect(c.recarga()).resolves.toMatchObject({ amountCents: 5000 });
    expect((await c.carta()).map((i) => i.id)).toEqual([l.servicio]);
    expect((await c.me()).myRights).toEqual({ sections: ['CHICA_SERVICE'], tips: true, cash: false, topUps: true, serviceTips: true });
  });
});

describe('A nombre de una compañera: su «Mi QR» en el cobro y las líneas de Servicios con su %', () => {
  /** Un local con Nerea (compañera, sin % propio: el del local, 90 %), el encargado, el dueño, dos de recepción y la carta. */
  async function local(name: string, operatorsChargeFromPhone: boolean) {
    const V = await newVenue(name, { operatorsChargeFromPhone, walletGroup: `gsrv-${name}-${r}` });
    return sys(async (tx) => {
      await tx.terminal.create({ data: { tenantId: V, externalId: `SRV-${name}-${r}`, label: 'Barra' } });
      const user = async (who: string, role: string, extra: Record<string, unknown> = {}) =>
        (await tx.user.create({ data: { tenantId: V, email: `${who}-${name.toLowerCase()}-${r}@x.es`, passwordHash: 'x', role, ...extra } as never })).id;
      const item = async (itemName: string, priceCents: number, category: string, components?: unknown) =>
        (await tx.serviceItem.create({ data: { tenantId: V, name: itemName, priceCents, category, components: components as never } })).id;
      const recepcion = await user('recepcion', 'WAITER', { post: 'RECEPCION' });
      // Solo a esta persona de recepción le da el dueño el permiso.
      await tx.venue.update({ where: { id: V }, data: { staffPermissions: { people: { [recepcion]: { chargeForOperator: true } } } } });
      return {
        V,
        name,
        nerea: await user('nerea', 'OPERATOR', { displayName: 'Nerea' }),
        encargado: await user('encargado', 'MANAGER'),
        dueno: await user('dueno', 'OWNER'),
        recepcion,
        recepcionSinPermiso: await user('recepcion2', 'WAITER', { post: 'RECEPCION' }),
        servicio: await item('Servicio 1 h', 6000, 'CHICA_SERVICE'),
        copa: await item('Copa', 1000, 'VENUE_BAR'),
        pack: await item('Habitación + Servicio', 13_000, 'VENUE_ROOM', [
          { category: 'VENUE_ROOM', amountCents: 8000 },
          { category: 'CHICA_SERVICE', amountCents: 5000 },
        ]),
      };
    });
  }
  type Local = Awaited<ReturnType<typeof local>>;
  const qrOf = (userId: string, tenantId: string, now = Date.now()) =>
    `https://operator.local/?invita=${signStaffToken({ userId, tenantId }, now, process.env.JWT_SECRET!).token}`;
  let k = 0;
  /** El cobro único de «Cobrar» (líneas de la carta y el del saldo enlazado), como la app. */
  const cobro = (l: Local, who: { userId: string; role: string }, items: string[], extra: Record<string, unknown> = {}) =>
    inVenue(l.V, () =>
      payments.create(
        l.V,
        `srv-${r}-${(k += 1)}`,
        {
          currency: 'EUR',
          terminalExternalId: `SRV-${l.name}-${r}`,
          lines: items.map((serviceItemId) => ({ serviceItemId, qty: 1 })),
          withSaldo: true,
          ...extra,
        } as never,
        who,
      ),
    );
  const lineas = (where: { paymentId?: string; walletChargeId?: string }) =>
    sys((tx) =>
      tx.paymentLine.findMany({
        where,
        orderBy: { amountCents: 'desc' },
        select: { category: true, amountCents: true, serviceOperatorId: true, operatorCommissionBps: true },
      }),
    );
  const error = (status: number, code: string) => ({ status, response: expect.objectContaining({ code }) });

  let L: Local;
  beforeAll(async () => {
    L = await local('SrvApagado', false);
  });

  it('el encargado cobra [Servicio 60 €, Copa 10 €] con el QR de Nerea: el servicio es suyo al 90 %, la copa a 0, el cobro al 77,14 %', async () => {
    const p = await cobro(L, { userId: L.encargado, role: 'MANAGER' }, [L.servicio, L.copa], { serviceStaffToken: qrOf(L.nerea, L.V) });
    expect(await lineas({ paymentId: p.id })).toEqual([
      { category: 'CHICA_SERVICE', amountCents: 6000, serviceOperatorId: L.nerea, operatorCommissionBps: 9000 },
      { category: 'VENUE_BAR', amountCents: 1000, serviceOperatorId: null, operatorCommissionBps: 0 },
    ]);
    const pago = await sys((tx) => tx.payment.findUniqueOrThrow({ where: { id: p.id }, select: { operatorCommissionBps: true } }));
    expect(pago.operatorCommissionBps).toBe(7714);
  });

  it('lo mismo con el cobro del saldo (su QR): las líneas, en el cobro del saldo', async () => {
    const c = await inVenue(L.V, () =>
      charges.createQrCharge(
        { userId: L.encargado, role: 'MANAGER', tenantId: L.V },
        {
          lines: [
            { serviceItemId: L.servicio, qty: 1 },
            { serviceItemId: L.copa, qty: 1 },
          ],
          serviceStaffToken: qrOf(L.nerea, L.V),
        },
      ),
    );
    expect(await lineas({ walletChargeId: c.id })).toEqual([
      { category: 'CHICA_SERVICE', amountCents: 6000, serviceOperatorId: L.nerea, operatorCommissionBps: 9000 },
      { category: 'VENUE_BAR', amountCents: 1000, serviceOperatorId: null, operatorCommissionBps: 0 },
    ]);
  });

  it('con un % propio, el suyo', async () => {
    await sys((tx) => tx.user.update({ where: { id: L.nerea }, data: { commissionBps: 8000 } }));
    try {
      const p = await cobro(L, { userId: L.encargado, role: 'MANAGER' }, [L.servicio], { serviceStaffToken: qrOf(L.nerea, L.V) });
      expect(await lineas({ paymentId: p.id })).toEqual([
        { category: 'CHICA_SERVICE', amountCents: 6000, serviceOperatorId: L.nerea, operatorCommissionBps: 8000 },
      ]);
    } finally {
      await sys((tx) => tx.user.update({ where: { id: L.nerea }, data: { commissionBps: null } }));
    }
  });

  it('recepción con el permiso cobra el pack «Habitación + Servicio»: la habitación a 0 y el servicio, de Nerea', async () => {
    const p = await cobro(L, { userId: L.recepcion, role: 'WAITER' }, [L.pack], { serviceStaffToken: qrOf(L.nerea, L.V) });
    expect(await lineas({ paymentId: p.id })).toEqual([
      { category: 'VENUE_ROOM', amountCents: 8000, serviceOperatorId: null, operatorCommissionBps: 0 },
      { category: 'CHICA_SERVICE', amountCents: 5000, serviceOperatorId: L.nerea, operatorCommissionBps: 9000 },
    ]);
  });

  it('el dueño también', async () => {
    await expect(
      cobro(L, { userId: L.dueno, role: 'OWNER' }, [L.servicio], { serviceStaffToken: qrOf(L.nerea, L.V) }),
    ).resolves.toMatchObject({ amountCents: 6000 });
  });

  it('errores: sin QR, QR sin servicio, caducado, de otro local o que no es de una compañera, y recepción sin permiso; no se crea nada', async () => {
    const encargado = { userId: L.encargado, role: 'MANAGER' };
    const count = () => sys((tx) => Promise.all([tx.payment.count({ where: { tenantId: L.V } }), tx.walletChargeRequest.count({ where: { tenantId: L.V } })]));
    const antes = await count();
    await expect(cobro(L, encargado, [L.servicio, L.copa])).rejects.toMatchObject(error(400, 'SERVICE_OPERATOR_REQUIRED'));
    await expect(cobro(L, encargado, [L.copa], { serviceStaffToken: qrOf(L.nerea, L.V) })).rejects.toMatchObject(
      error(400, 'SERVICE_OPERATOR_NOT_NEEDED'),
    );
    const caducado = qrOf(L.nerea, L.V, Date.now() - 11 * 60_000);
    await expect(cobro(L, encargado, [L.servicio], { serviceStaffToken: caducado })).rejects.toMatchObject(
      error(400, 'SERVICE_OPERATOR_INVALID'),
    );
    const otro = await local('SrvOtro', false);
    await expect(cobro(L, encargado, [L.servicio], { serviceStaffToken: qrOf(otro.nerea, otro.V) })).rejects.toMatchObject(
      error(400, 'SERVICE_OPERATOR_INVALID'),
    );
    await expect(cobro(L, encargado, [L.servicio], { serviceStaffToken: qrOf(L.recepcion, L.V) })).rejects.toMatchObject(
      error(400, 'SERVICE_OPERATOR_INVALID'),
    );
    // Recepción sin el permiso: el motivo (403), no «escanea su QR».
    const sinPermiso = { userId: L.recepcionSinPermiso, role: 'WAITER' };
    await expect(cobro(L, sinPermiso, [L.pack])).rejects.toMatchObject(error(403, STAFF_PERMISSION_DENIED_CODE));
    await expect(cobro(L, sinPermiso, [L.pack], { serviceStaffToken: qrOf(L.nerea, L.V) })).rejects.toMatchObject(
      error(403, STAFF_PERMISSION_DENIED_CODE),
    );
    // Lo mismo en el cobro del saldo.
    await expect(
      inVenue(L.V, () =>
        charges.createQrCharge({ userId: L.encargado, role: 'MANAGER', tenantId: L.V }, { lines: [{ serviceItemId: L.servicio, qty: 1 }] }),
      ),
    ).rejects.toMatchObject(error(400, 'SERVICE_OPERATOR_REQUIRED'));
    expect(await count()).toEqual(antes);
  });

  it('casilla encendida: el encargado cobra el servicio sin QR, como hoy (sin compañera ni %)', async () => {
    const on = await local('SrvEncendido', true);
    const p = await cobro(on, { userId: on.encargado, role: 'MANAGER' }, [on.servicio]);
    expect(await lineas({ paymentId: p.id })).toEqual([
      { category: 'CHICA_SERVICE', amountCents: 6000, serviceOperatorId: null, operatorCommissionBps: null },
    ]);
  });
});

describe('El reparto: su parte y la propina entera (tarjeta, ficha y datáfono), y la propina con la regla de Sala', () => {
  const quiet = { log: async () => undefined };
  const config = { get: () => undefined, getOrThrow: () => undefined };
  const reports = new ReportsService(prisma);
  const moneyMap = new MoneyMapService(prisma, reports, config as never);
  const fichas = new StaffFichaService(prisma, moneyMap);
  const checks = new CloseCheckService(prisma, new IncidentsService(prisma, quiet as never), config as never);
  const nights = new NightsService(prisma, reports, quiet as never, checks, undefined, moneyMap);
  vi.spyOn(nights as unknown as { safeAutoClose(t: string): Promise<void> }, 'safeAutoClose').mockResolvedValue(undefined);
  const gateways = { get: () => ({ refund: async () => ({ status: 'SUCCEEDED', providerRefundId: `DEV-${randomUUID().slice(0, 8)}` }) }) };
  const refunds = new RefundsService(prisma, cls as never, gateways as never, payments, {} as never, quiet as never, {
    refundsCreated: { inc: noop },
    earningReversalFailed: { inc: noop },
  } as never);
  // Paytef confirma lo que dice el datáfono.
  const prover = { prove: async (claim: { amountCents: number }) => ({ kind: 'confirmed' as const, amountCents: claim.amountCents, currency: 'EUR' }) };
  const pax = new PosDeviceService(prisma, payments, quiet as never, cls as never, prover as never);
  const HOUR = 60 * 60_000;
  const soon = () => new Date(Date.now() + 1_000);

  /** Casilla apagada; Nerea sin % propio (Servicios, el 90 % del local); Redsys, la noche abierta y recepción con permiso. */
  async function local(name: string, salaTips = true) {
    const V = await newVenue(name, {
      operatorsChargeFromPhone: false,
      walletGroup: `grep-${name}-${r}`,
      platformCommissionBps: 0,
      payoutHoldDays: 0,
      paymentMethods: { pos: true },
      ...(salaTips ? {} : { postRules: { SALA: { tips: false } } }),
    });
    return sys(async (tx) => {
      const term = await tx.terminal.create({ data: { tenantId: V, externalId: `REP-${name}-${r}`, label: 'Barra', zone: 'BARRA' } });
      await tx.gatewayCredential.create({
        data: { tenantId: V, provider: 'REDSYS', encKey: Buffer.from('k'), encNonce: Buffer.from('n'), encTag: Buffer.from('t'), kekVersion: 1 },
      });
      const user = async (who: string, role: string, extra: Record<string, unknown> = {}) =>
        (await tx.user.create({ data: { tenantId: V, email: `${who}-${name.toLowerCase()}-${r}@x.es`, passwordHash: 'x', role, ...extra } as never })).id;
      const item = async (itemName: string, priceCents: number, category: string) =>
        (await tx.serviceItem.create({ data: { tenantId: V, name: itemName, priceCents, category } })).id;
      const dueno = await user('dueno', 'OWNER');
      const recepcion = await user('recepcion', 'WAITER', { post: 'RECEPCION' });
      await tx.venue.update({ where: { id: V }, data: { staffPermissions: { people: { [recepcion]: { chargeForOperator: true } } } } });
      await tx.venueNight.create({ data: { tenantId: V, openedAt: new Date(Date.now() - 2 * HOUR), openingFloatCents: 0, openedBy: dueno } });
      return {
        V,
        name,
        term: term.id,
        dueno,
        recepcion,
        nerea: await user('nerea', 'OPERATOR', { displayName: 'Nerea' }),
        encargado: await user('encargado', 'MANAGER'),
        servicio: await item('Servicio 1 h', 6000, 'CHICA_SERVICE'),
        copa: await item('Copa', 1000, 'VENUE_BAR'),
      };
    });
  }
  type Local = Awaited<ReturnType<typeof local>>;
  const qrOf = (userId: string, tenantId: string) =>
    `https://operator.local/?invita=${signStaffToken({ userId, tenantId }, Date.now(), process.env.JWT_SECRET!).token}`;
  let k = 0;
  /** El cobro único de «Cobrar» a nombre de Nerea (su «Mi QR»), como la app. */
  const cobro = (l: Local, who: { userId: string; role: string }, items: string[], extra: Record<string, unknown> = {}) =>
    inVenue(l.V, () =>
      payments.create(
        l.V,
        `rep-${r}-${(k += 1)}`,
        {
          currency: 'EUR',
          terminalExternalId: `REP-${l.name}-${r}`,
          lines: items.map((serviceItemId) => ({ serviceItemId, qty: 1 })),
          withSaldo: true,
          serviceStaffToken: qrOf(l.nerea, l.V),
          ...extra,
        } as never,
        who,
      ),
    );
  const encargadoOf = (l: Local) => ({ userId: l.encargado, role: 'MANAGER' as const });
  /** Pagado con tarjeta en el banco (Redsys), con la propina que cobró el banco. */
  async function paidByCard(l: Local, paymentId: string, amountCents: number, tipCents = 0): Promise<void> {
    const order = `RP${randomBytes(4).toString('hex')}`;
    await sys(async (tx) => {
      await tx.payment.update({ where: { id: paymentId }, data: { status: 'AUTHORIZING', provider: 'REDSYS', providerTxId: order } });
      await tx.paymentAttempt.create({ data: { paymentId, tenantId: l.V, provider: 'REDSYS', providerTxId: order, amountCents: amountCents + tipCents, tipCents } });
    });
    await inVenue(undefined, () => payments.transition(paymentId, { type: 'AUTHORIZED', provider: 'REDSYS', providerTxId: order }));
  }
  /** Un saldo del cliente con su ficha (NFC) y su PIN 4827. */
  async function wallet(l: Local, balanceCents: number) {
    const card = randomBytes(16).toString('base64url');
    const uid = randomBytes(7).toString('hex').toUpperCase();
    const id = await sys(async (tx) => {
      const w = await tx.clientWallet.create({
        data: {
          tenantId: l.V,
          balanceCents,
          status: 'ACTIVE',
          qrToken: `rep-${randomBytes(6).toString('hex')}-abcdefgh`,
          shortCode: randomBytes(3).toString('hex').toUpperCase(),
          walletGroup: `grep-${l.name}-${r}`,
        },
      });
      await tx.walletCard.create({ data: { token: card, uid, walletId: w.id, status: 'ISSUED', venueId: l.V } });
      return w.id;
    });
    await inVenue(undefined, () => charges.setPinFromPayer(id, '4827'));
    return { id, card, uid };
  }
  const payWithPin = (l: Local, who: string, role: string, chargeId: string, w: { card: string; uid: string }, tipCents: number) =>
    inVenue(l.V, () =>
      charges.payQrChargeWithPin({ userId: who, role, tenantId: l.V } as never, chargeId, { card: w.card, uid: w.uid, pin: '4827', tipCents }),
    );
  const earningsOf = (where: { paymentId?: string; consumptionId?: string }) =>
    sys((tx) =>
      tx.operatorEarning.findMany({
        where,
        select: { operatorId: true, paymentAmountCents: true, commissionCents: true, tipCents: true, paymentLineId: true, reversedCents: true },
      }),
    );
  const consumptionOf = (chargeId: string) =>
    sys((tx) => tx.walletConsumption.findFirstOrThrow({ where: { idempotencyKey: `charge-request:${chargeId}` } }));
  const pagoOf = (id: string) => sys((tx) => tx.payment.findUniqueOrThrow({ where: { id }, select: { tipCents: true, tipGoesTo: true } }));
  const payTokenOf = async (chargeId: string) =>
    (await sys((tx) => tx.walletChargeRequest.findUniqueOrThrow({ where: { id: chargeId } }))).payToken!;
  /** El mapa del dinero, la ficha de Nerea y el Z dicen lo mismo de lo suyo. */
  async function cuadra(l: Local, chicasCents: number) {
    const m = await inVenue(l.V, () => moneyMap.forQuery(l.V, {}, soon()));
    expect(m.split.chicasCents).toBe(chicasCents);
    expect((await inVenue(l.V, () => fichas.ficha(l.V, l.nerea, soon()))).stats.shareCents).toBe(chicasCents);
    expect((await inVenue(l.V, () => nights.current(l.V)))!.z.summary.chicaNetCents).toBe(chicasCents);
  }

  describe('con tarjeta (y la devolución de la mitad)', () => {
    let L: Local, pagado: string;
    beforeAll(async () => {
      L = await local('RepTarjeta');
    });

    it('[Servicio 60 €, Copa 10 €] con propina de 5 €: una sola ganancia, de Nerea (54 € + 5 €); ninguna del encargado; todo cuadra', async () => {
      const p = await cobro(L, encargadoOf(L), [L.servicio, L.copa]);
      pagado = p.id;
      expect((await pagoOf(p.id)).tipGoesTo).toBe('operator');
      await paidByCard(L, p.id, 7000, 500);
      expect(await pagoOf(p.id)).toEqual({ tipCents: 500, tipGoesTo: 'operator' });
      expect(await earningsOf({ paymentId: p.id })).toEqual([
        { operatorId: L.nerea, paymentAmountCents: 7000, commissionCents: 5400, tipCents: 500, paymentLineId: null, reversedCents: 0 },
      ]);
      await cuadra(L, 5900);
    });

    it('devolver la mitad (37,50 €) le descuenta la mitad de lo suyo: 27 € + 2,50 €', async () => {
      await inVenue(L.V, () =>
        refunds.refund({ paymentId: pagado, amountCents: 3750, reason: 'No era su servicio', idempotencyKey: randomUUID() }, {
          userId: L.dueno,
          role: 'OWNER',
          tenantId: L.V,
        } as never),
      );
      expect((await earningsOf({ paymentId: pagado }))[0]).toMatchObject({ commissionCents: 5400, tipCents: 500, reversedCents: 2950 });
      await cuadra(L, 2950);
    });

    it('no cuenta como invitación: «Mi noche» y su contador de invitaciones siguen en 0', async () => {
      expect((await inVenue(L.V, () => nights.mine(L.V, L.nerea))).invitations).toEqual({ count: 0, shareCents: 0 });
      expect(await inVenue(L.V, () => prisma.withTenant(L.V, (tx) => invitationTotals(tx, L.V, L.nerea)))).toMatchObject({
        count: 0,
        shareCents: 0,
      });
    });
  });

  it('con la ficha y su PIN, propina de 3 €: la ganancia del consumo es de Nerea (54 € + 3 €) y la propina, suya', async () => {
    const L = await local('RepFicha');
    const w = await wallet(L, 20_000);
    const p = await cobro(L, encargadoOf(L), [L.servicio, L.copa]);
    await payWithPin(L, L.encargado, 'MANAGER', p.saldo!.chargeId, w, 300);
    const consumo = await consumptionOf(p.saldo!.chargeId);
    expect(consumo).toMatchObject({ amountCents: 7000, tipCents: 300, tipGoesTo: 'operator', providedByUserId: L.encargado });
    expect(await earningsOf({ consumptionId: consumo.id })).toEqual([
      { operatorId: L.nerea, paymentAmountCents: 7000, commissionCents: 5400, tipCents: 300, paymentLineId: null, reversedCents: 0 },
    ]);
  });

  it('«Tarjeta en el datáfono»: cobrado en el PAX con propina de 6 €, la propina es suya; confirmado a mano, su parte sin propina', async () => {
    const L = await local('RepPax');
    const device = { terminalId: L.term, tenantId: L.V, label: 'Barra', zone: 'BARRA', tokenHash: 'x' } as PosDevice;
    const p = await cobro(L, encargadoOf(L), [L.servicio], { captureMethod: 'POS_EXTERNAL' });
    const started = await inVenue(L.V, () => pax.start(device, p.id));
    const sale = {
      approved: true,
      authorisationCode: '047215',
      paytefOperationNumber: `OP${r}`,
      transactionReference: started.reference,
      requestedAmount: 6000,
      tipAmount: 600,
    };
    await expect(inVenue(L.V, () => pax.reportResult(device, p.id, sale as never))).resolves.toMatchObject({ status: 'PAID' });
    expect(await pagoOf(p.id)).toEqual({ tipCents: 600, tipGoesTo: 'operator' });
    expect(await earningsOf({ paymentId: p.id })).toEqual([
      { operatorId: L.nerea, paymentAmountCents: 6000, commissionCents: 5400, tipCents: 600, paymentLineId: null, reversedCents: 0 },
    ]);

    const q = await cobro(L, encargadoOf(L), [L.servicio], { captureMethod: 'POS_EXTERNAL' });
    await inVenue(L.V, () =>
      payments.confirmPosPayment(q.id, { userId: L.encargado, role: 'MANAGER', tenantId: L.V } as never, {
        posReceiptRef: 'AB12CD',
        chargedCents: 6000,
      }),
    );
    expect(await earningsOf({ paymentId: q.id })).toEqual([
      { operatorId: L.nerea, paymentAmountCents: 6000, commissionCents: 5400, tipCents: 0, paymentLineId: null, reversedCents: 0 },
    ]);
  });

  it('recepción con permiso cobra el servicio: /pay, /s y el PIN ofrecen la propina (la de Sala) y va para ella', async () => {
    const L = await local('RepRecepcion');
    const p = await cobro(L, { userId: L.recepcion, role: 'WAITER' }, [L.servicio]);
    expect(await inVenue(undefined, () => payments.getPayPage(p.qrToken))).toMatchObject({ kind: 'choose', tipMaxCents: 6000, tipToStaff: true });
    const s = await inVenue(undefined, async () => charges.qrChargeForClient(await payTokenOf(p.saldo!.chargeId)));
    expect(s.tip).toMatchObject({ baseCents: 6000, maxCents: 6000, toStaff: true });
    const w = await wallet(L, 10_000);
    await payWithPin(L, L.recepcion, 'WAITER', p.saldo!.chargeId, w, 200);
    const consumo = await consumptionOf(p.saldo!.chargeId);
    expect(consumo).toMatchObject({ tipCents: 200, tipGoesTo: 'operator' });
    expect(await earningsOf({ consumptionId: consumo.id })).toMatchObject([{ operatorId: L.nerea, commissionCents: 5400, tipCents: 200 }]);
  });

  it('con Sala sin propinas, aunque cobre el encargado: ni /pay ni /s la ofrecen, el PIN con propina da 400 y /venues/me lo dice', async () => {
    const L = await local('RepSinPropina', false);
    const p = await cobro(L, encargadoOf(L), [L.servicio]);
    expect(await inVenue(undefined, () => payments.getPayPage(p.qrToken))).toMatchObject({ kind: 'choose', tipMaxCents: 0 });
    const s = await inVenue(undefined, async () => charges.qrChargeForClient(await payTokenOf(p.saldo!.chargeId)));
    expect(s.tip).toBeUndefined();
    const w = await wallet(L, 10_000);
    await expect(payWithPin(L, L.encargado, 'MANAGER', p.saldo!.chargeId, w, 200)).rejects.toMatchObject({
      status: 400,
      response: expect.objectContaining({ code: 'TIP_NOT_VALID' }),
    });
    const me = await inVenue(L.V, () => venuesMe.getMyVenue({ sub: L.encargado, role: 'MANAGER', tenantId: L.V } as JwtPayload));
    expect(me.myRights).toMatchObject({ tips: true, serviceTips: false });
  });

  describe('Lo que ven los demás: «Servicio con Nerea», su foto y las listas del datáfono', () => {
    let L: Local;
    const foto = (who: string) => Buffer.from(`RIFF-foto-de-${who}`);
    beforeAll(async () => {
      L = await local('Ven');
      // Las fotos de Mi perfil de Nerea y del encargado (con nombre): la página enseña la de ella.
      await sys(async (tx) => {
        await tx.user.update({ where: { id: L.encargado }, data: { displayName: 'Javi' } });
        for (const [userId, who, hash] of [[L.nerea, 'nerea', 'a'], [L.encargado, 'javi', 'b']] as const) {
          await tx.userPhoto.create({
            data: { userId, tenantId: L.V, contentType: 'image/webp', data: foto(who), contentHash: hash.repeat(64), width: 64, height: 64 },
          });
        }
      });
    });

    it('/pay: «Servicio con Nerea» con su nombre y su foto, no los del encargado ni ningún correo', async () => {
      const p = await cobro(L, encargadoOf(L), [L.servicio]);
      const view = await inVenue(undefined, () => payments.getPayPage(p.qrToken));
      expect(view).toMatchObject({
        kind: 'choose',
        staffName: 'Nerea',
        served: true,
        staffPhoto: `data:image/webp;base64,${foto('nerea').toString('base64')}`,
      });
      expect(JSON.stringify(view)).not.toContain('Javi');
      expect(JSON.stringify(view)).not.toContain('@x.es');
    });

    it('/s: requestedByName Nerea y served; el que cobra el encargado sin compañera, como hoy', async () => {
      const p = await cobro(L, encargadoOf(L), [L.servicio]);
      const s = await inVenue(undefined, async () => charges.qrChargeForClient(await payTokenOf(p.saldo!.chargeId)));
      expect(s).toMatchObject({ requestedByName: 'Nerea', served: true });
      const copa = await inVenue(L.V, () =>
        payments.create(
          L.V,
          `ven-${r}-copa`,
          { currency: 'EUR', terminalExternalId: `REP-${L.name}-${r}`, lines: [{ serviceItemId: L.copa, qty: 1 }], withSaldo: true } as never,
          encargadoOf(L),
        ),
      );
      const sin = await inVenue(undefined, async () => charges.qrChargeForClient(await payTokenOf(copa.saldo!.chargeId)));
      expect(sin.requestedByName).toBe('Javi');
      expect(sin).not.toHaveProperty('served');
    });

    it('el PAX y las listas: «Servicio de Nerea» en sus cobros y en los del saldo; la del personal, «Nerea»', async () => {
      const p = await cobro(L, encargadoOf(L), [L.servicio], { captureMethod: 'POS_EXTERNAL' });
      const device = { terminalId: L.term, tenantId: L.V, label: 'Barra', zone: 'BARRA', tokenHash: 'x' } as PosDevice;
      expect((await inVenue(L.V, () => pax.pending(device))).find((c) => c.id === p.id)?.createdByName).toBe('Servicio de Nerea');
      expect((await inVenue(L.V, () => payments.listPendingPos(L.V))).find((c) => c.id === p.id)?.createdByName).toBe('Nerea');

      const q = await cobro(L, encargadoOf(L), [L.servicio]);
      const terminal = { terminalId: L.term, tenantId: L.V };
      const enPax = (await inVenue(L.V, () => charges.pendingQrChargesForTerminal(terminal))).find((c) => c.id === q.saldo!.chargeId);
      expect(enPax?.requestedByName).toBe('Servicio de Nerea');
      const dueno = { userId: L.dueno, role: 'OWNER', tenantId: L.V } as never;
      expect((await inVenue(L.V, () => charges.pendingQrCharges(dueno))).find((c) => c.id === q.saldo!.chargeId)?.requestedByName).toBe(
        'Servicio de Nerea',
      );
    });
  });
});
