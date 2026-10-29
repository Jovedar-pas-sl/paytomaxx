// Integración (Postgres real): ajustes del local que pone el dueño — formas de
// cobro, permisos del personal y avisos — guardados en venues y aplicados por
// el API (cobros, saldo, guard de permisos), con np_app y FORCE RLS. Ver README.md.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import 'reflect-metadata';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import type { JwtPayload } from '@nightpay/contracts';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { RequiresPermission, StaffPermissionGuard } from '../../src/modules/venues/staff-permission.guard';
import { VenueSettingsController } from '../../src/modules/venues/venue-settings.controller';
import { WalletChargesService } from '../../src/modules/wallets/wallet-charges.service';

const cls = new ClsService(new AsyncLocalStorage());

const prisma = new PrismaService(cls as any);
const audit = { log: vi.fn(async () => undefined) };
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
const charges = new WalletChargesService(prisma as never, audit as never, { get: () => ({}) } as never);
const settings = new VenueSettingsController(prisma as never, audit as never, { get: () => undefined } as never);
const guard = new StaffPermissionGuard(new Reflector(), prisma);

const inVenue = <T>(tenantId: string | undefined, fn: () => Promise<T>, extra: Record<string, unknown> = {}): Promise<T> =>
  cls.run(async () => {
    cls.set('ctx', { tenantId, traceId: 't', ...extra });
    return fn();
  });
const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) =>
  inVenue(undefined, () => prisma.asSystem(fn));

const r = randomUUID().slice(0, 6);
let A: string, owner: string, manager: string, manager2: string, chica: string;
let n = 0;

const ownerJwt = (): JwtPayload => ({ sub: owner, email: `own-${r}@x.es`, role: 'OWNER', tenantId: A, venueSlug: `aj-${r}` }) as JwtPayload;

beforeAll(async () => {
  await prisma.onModuleInit();
  await sys(async (tx) => {
    A = (await tx.venue.create({ data: { name: 'Local Ajustes', slug: `aj-${r}`, walletGroup: `ga-${r}` } })).id;
    owner = (await tx.user.create({ data: { tenantId: A, email: `own-${r}@x.es`, passwordHash: 'x', role: 'OWNER' } })).id;
    manager = (await tx.user.create({ data: { tenantId: A, email: `man-${r}@x.es`, passwordHash: 'x', role: 'MANAGER' } })).id;
    manager2 = (await tx.user.create({ data: { tenantId: A, email: `man2-${r}@x.es`, passwordHash: 'x', role: 'MANAGER' } })).id;
    chica = (
      await tx.user.create({ data: { tenantId: A, email: `op-${r}@x.es`, passwordHash: 'x', role: 'OPERATOR', displayName: 'Ana' } })
    ).id;
    await tx.terminal.create({ data: { tenantId: A, externalId: `AJ-${r}`, label: 'Barra', zone: 'BARRA' } });
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

function createCharge(extra: Record<string, unknown> = {}) {
  n += 1;
  return inVenue(A, () =>
    payments.create(
      A,
      `aj-${r}-${n}`,
      { amountCents: 5_000, currency: 'EUR', terminalExternalId: `AJ-${r}`, ...extra } as never,
      { userId: owner, role: 'OWNER' },
    ),
  );
}

describe('formas de cobro: se guardan en el local y el API las aplica (Postgres real)', () => {
  it('sin ajustes: todo encendido menos el datáfono (apagado de fábrica desde el 20-10-2026)', async () => {
    await expect(inVenue(A, () => settings.paymentMethods(ownerJwt()))).resolves.toMatchObject({
      card: true,
      wallet: true,
      nfc: true,
      pos: false,
      tips: true,
    });
    await expect(createCharge()).resolves.toMatchObject({ amountCents: 5_000 });
    // Un cobro por datáfono en un local que nunca guardó sus formas de cobro: 409.
    await expect(createCharge({ captureMethod: 'POS_EXTERNAL' })).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'PAYMENT_METHOD_DISABLED', method: 'pos' }),
    });
  });

  it('el dueño enciende el datáfono: queda guardado y el cobro por datáfono se crea; cambiar otra cosa no lo apaga', async () => {
    await inVenue(A, () => settings.updatePaymentMethods(ownerJwt(), { pos: true }));
    await expect(createCharge({ captureMethod: 'POS_EXTERNAL' })).resolves.toMatchObject({ amountCents: 5_000 });
    await inVenue(A, () => settings.updatePaymentMethods(ownerJwt(), { tips: true }));
    const stored = await sys((tx) => tx.venue.findUnique({ where: { id: A }, select: { paymentMethods: true } }));
    expect(stored?.paymentMethods).toMatchObject({ pos: true });
  });

  it('QR con tarjeta apagado: 409 al cobrar con QR; el datáfono sigue; queda en el registro', async () => {
    await inVenue(A, () => settings.updatePaymentMethods(ownerJwt(), { card: false }));
    const stored = await sys((tx) => tx.venue.findUnique({ where: { id: A }, select: { paymentMethods: true } }));
    expect(stored?.paymentMethods).toMatchObject({ card: false, wallet: true });
    await expect(createCharge()).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'PAYMENT_METHOD_DISABLED', method: 'card' }),
    });
    await expect(createCharge({ captureMethod: 'POS_EXTERNAL' })).resolves.toMatchObject({ amountCents: 5_000 });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'venue.payment_methods.updated', tenantId: A }));
  });

  it('saldo apagado: la chica no puede hacer un cobro del saldo con QR (409) y no se crea nada', async () => {
    await inVenue(A, () => settings.updatePaymentMethods(ownerJwt(), { card: true, wallet: false }));
    const before = await sys((tx) => tx.walletChargeRequest.count({ where: { tenantId: A } }));
    await expect(
      inVenue(A, () => charges.createQrCharge({ userId: chica, role: 'OPERATOR', tenantId: A }, { amountCents: 3_000 })),
    ).rejects.toMatchObject({ status: 409, response: expect.objectContaining({ method: 'wallet' }) });
    expect(await sys((tx) => tx.walletChargeRequest.count({ where: { tenantId: A } }))).toBe(before);
  });

  it('propinas apagadas: una propina al crear el cobro → 409 TIPS_DISABLED', async () => {
    await inVenue(A, () => settings.updatePaymentMethods(ownerJwt(), { wallet: true, tips: false }));
    await expect(createCharge({ tipCents: 500 })).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'TIPS_DISABLED' }),
    });
  });

  it('la columna solo guarda objetos (CHECK en la base)', async () => {
    await expect(sys((tx) => tx.$executeRaw`UPDATE venues SET "paymentMethods" = '[]'::jsonb WHERE id = ${A}::uuid`)).rejects.toThrow(
      /venues_settings_are_objects/,
    );
  });
});

describe('permisos del personal: el guard los lee de la base en cada petición (Postgres real)', () => {
  class Routes {
    @RequiresPermission('refund')
    refund(): void {}
  }
  const canRefund = (user: Partial<JwtPayload>) =>
    inVenue(A, () =>
      guard.canActivate({
        getHandler: () => Routes.prototype.refund,
        switchToHttp: () => ({ getRequest: () => ({ user: { tenantId: A, ...user } }) }),
      } as unknown as ExecutionContext),
    );

  it('por defecto el encargado devuelve; el dueño se lo quita a todos menos a uno; el dueño siempre', async () => {
    await expect(canRefund({ sub: manager, role: 'MANAGER' })).resolves.toBe(true);
    await inVenue(A, () =>
      settings.updatePermissions(ownerJwt(), { roles: { MANAGER: { refund: false } }, people: { [manager2]: { refund: true } } }),
    );
    await expect(canRefund({ sub: manager, role: 'MANAGER' })).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'STAFF_PERMISSION_DENIED', permission: 'refund' }),
    });
    await expect(canRefund({ sub: manager2, role: 'MANAGER' })).resolves.toBe(true);
    await expect(canRefund({ sub: owner, role: 'OWNER' })).resolves.toBe(true);
  });

  it('una excepción para alguien que no es encargado ni camarero del local → 400 y no se guarda', async () => {
    await expect(
      inVenue(A, () => settings.updatePermissions(ownerJwt(), { people: { [chica]: { refund: true } } })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('«mis permisos» del encargado salen de lo guardado', async () => {
    await expect(
      inVenue(A, () => settings.myPermissions({ ...ownerJwt(), sub: manager, role: 'MANAGER' } as JwtPayload)),
    ).resolves.toMatchObject({ refund: false, closeNight: true, reports: false });
  });
});

describe('avisos de Telegram: chat del local y sin nombres por defecto (Postgres real)', () => {
  it('se guarda el chat y los grupos; los nombres siguen apagados', async () => {
    const view = await inVenue(A, () =>
      settings.updateAlerts(ownerJwt(), { chatId: '-1001234567890', kinds: { backups: false } }),
    );
    expect(view).toMatchObject({ chatId: '-1001234567890', includeNames: false, kinds: expect.objectContaining({ backups: false }) });
    const stored = await sys((tx) => tx.venue.findUnique({ where: { id: A }, select: { alertSettings: true } }));
    expect(stored?.alertSettings).toMatchObject({ chatId: '-1001234567890' });
  });
});
