import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  CASH_TOP_UP_METHODS,
  DEFAULT_PAYMENT_METHODS,
  UpdateAlertSettingsSchema,
  UpdatePaymentMethodsSchema,
  UpdateStaffPermissionsSchema,
  alertKindForIncident,
  alertSettingsOf,
  deviceCan,
  disabledMethod,
  mergeAlertSettings,
  mergePaymentMethods,
  mergeStaffPermissions,
  methodsNeededForPayment,
  paymentMethodsOf,
  staffCan,
  staffPermissionsOf,
  type JwtPayload,
} from '@nightpay/contracts';
import { payoutPermission } from '../wallets/wallet-charges.controller';
import { RequiresPermission, StaffPermissionGuard } from './staff-permission.guard';
import { assertMethodsEnabled } from './venue-methods';
import { VenueSettingsController } from './venue-settings.controller';

const MANAGER_ID = '00000000-0000-4000-8000-000000000002';
const WAITER_ID = '00000000-0000-4000-8000-000000000003';

describe('formas de cobro: lo guardado con lo de siempre donde falte', () => {
  it('sin nada guardado (o algo raro): todo encendido y las propinas de siempre', () => {
    expect(paymentMethodsOf(null)).toEqual(DEFAULT_PAYMENT_METHODS);
    expect(paymentMethodsOf('basura')).toEqual(DEFAULT_PAYMENT_METHODS);
    expect(paymentMethodsOf({ card: 'no', tipPercents: [0, 99, 'x'] })).toEqual(DEFAULT_PAYMENT_METHODS);
  });

  it('el cambio se mezcla con lo guardado; las propinas se ordenan sin repetir', () => {
    const merged = mergePaymentMethods({ nfc: false }, { pos: false, tipPercents: [15, 5, 15] });
    expect(merged).toMatchObject({ card: true, nfc: false, pos: false, tipPercents: [5, 15] });
  });

  it('recarga en efectivo: encendida por defecto; el dueño la apaga y el API la rechaza (409)', () => {
    expect(paymentMethodsOf(null).cashTopUp).toBe(true);
    expect(mergePaymentMethods(null, { cashTopUp: false })).toMatchObject({ cashTopUp: false, wallet: true });
    expect(UpdatePaymentMethodsSchema.safeParse({ cashTopUp: false }).success).toBe(true);
    expect(() => assertMethodsEnabled({ paymentMethods: { cashTopUp: false } }, CASH_TOP_UP_METHODS)).toThrow(
      /no acepta ahora recargas en efectivo/,
    );
    expect(() => assertMethodsEnabled({ paymentMethods: { wallet: false } }, CASH_TOP_UP_METHODS)).toThrow(/saldo/);
  });

  it('validación: nada que cambiar, más de 3 propinas, % fuera de rango o un campo desconocido → no vale', () => {
    expect(UpdatePaymentMethodsSchema.safeParse({}).success).toBe(false);
    expect(UpdatePaymentMethodsSchema.safeParse({ tipPercents: [5, 10, 15, 20] }).success).toBe(false);
    expect(UpdatePaymentMethodsSchema.safeParse({ tipPercents: [60] }).success).toBe(false);
    expect(UpdatePaymentMethodsSchema.safeParse({ tipFlatCents: [50] }).success).toBe(false);
    expect(UpdatePaymentMethodsSchema.safeParse({ cash: true }).success).toBe(false);
    expect(UpdatePaymentMethodsSchema.safeParse({ tips: false }).success).toBe(true);
  });

  it('qué hace falta para cada cobro y cuál está apagado', () => {
    expect(methodsNeededForPayment({ isWalletTopUp: false, isPosExternal: false })).toEqual(['card']);
    expect(methodsNeededForPayment({ isWalletTopUp: true, isPosExternal: false })).toEqual(['card', 'wallet']);
    expect(methodsNeededForPayment({ isWalletTopUp: false, isPosExternal: true })).toEqual(['pos']);
    // Recarga en la recepción del datáfono: el datáfono y el saldo (no el QR con tarjeta).
    expect(methodsNeededForPayment({ isWalletTopUp: true, isPosExternal: true })).toEqual(['pos', 'wallet']);
    expect(CASH_TOP_UP_METHODS).toEqual(['wallet', 'cashTopUp']);
    const methods = paymentMethodsOf({ wallet: false });
    expect(disabledMethod(methods, ['card', 'wallet'])).toBe('wallet');
    expect(disabledMethod(methods, ['card'])).toBeNull();
  });

  it('assertMethodsEnabled: 409 PAYMENT_METHOD_DISABLED con el método y el mensaje en castellano', () => {
    expect(() => assertMethodsEnabled({ paymentMethods: { pos: false } }, ['pos'])).toThrow(/no cobra ahora con datáfono/);
    try {
      assertMethodsEnabled({ paymentMethods: { card: false } }, ['card']);
    } catch (err) {
      expect((err as ForbiddenException).getStatus()).toBe(409);
      expect((err as ForbiddenException).getResponse()).toMatchObject({ code: 'PAYMENT_METHOD_DISABLED', method: 'card' });
    }
    expect(assertMethodsEnabled(null, ['card', 'wallet', 'nfc', 'pos'])).toEqual(DEFAULT_PAYMENT_METHODS);
  });
});

describe('permisos del personal: por defecto, lo de hoy', () => {
  const manager = { role: 'MANAGER', userId: MANAGER_ID };

  it('sin nada guardado: el encargado devuelve, da efectivo, cierra y paga; los informes, no', () => {
    const perms = staffPermissionsOf(null);
    expect(staffCan(perms, manager, 'refund')).toBe(true);
    expect(staffCan(perms, manager, 'cash')).toBe(true);
    expect(staffCan(perms, manager, 'closeNight')).toBe(true);
    expect(staffCan(perms, manager, 'payouts')).toBe(true);
    expect(staffCan(perms, manager, 'reports')).toBe(false);
  });

  it('el dueño siempre; la chica y el camarero, nunca (ni aunque se guarde que sí)', () => {
    const perms = staffPermissionsOf({ roles: { WAITER: { refund: true } }, people: { [WAITER_ID]: { refund: true } } });
    expect(staffCan(perms, { role: 'OWNER', userId: 'x' }, 'reports')).toBe(true);
    expect(staffCan(perms, { role: 'WAITER', userId: WAITER_ID }, 'refund')).toBe(false);
    expect(staffCan(perms, { role: 'OPERATOR', userId: 'x' }, 'refund')).toBe(false);
  });

  it('la excepción de una persona manda sobre su rol, en los dos sentidos', () => {
    const perms = mergeStaffPermissions(null, {
      roles: { MANAGER: { refund: false, reports: true } },
      people: { [MANAGER_ID]: { refund: true, reports: false } },
    });
    expect(staffCan(perms, manager, 'refund')).toBe(true);
    expect(staffCan(perms, manager, 'reports')).toBe(false);
    expect(staffCan(perms, { role: 'MANAGER', userId: 'otro' }, 'refund')).toBe(false);
    // null quita la excepción: vuelve a lo del rol.
    const cleared = mergeStaffPermissions(perms, { people: { [MANAGER_ID]: null } });
    expect(cleared.people).toEqual({});
    expect(staffCan(cleared, manager, 'reports')).toBe(true);
  });

  it('validación: ids de persona que no son uuid o permisos desconocidos → no vale', () => {
    expect(UpdateStaffPermissionsSchema.safeParse({ people: { 'no-uuid': { refund: true } } }).success).toBe(false);
    expect(UpdateStaffPermissionsSchema.safeParse({ roles: { MANAGER: { borrar: true } } }).success).toBe(false);
    expect(UpdateStaffPermissionsSchema.safeParse({ roles: { OWNER: { refund: false } } }).success).toBe(false);
    expect(UpdateStaffPermissionsSchema.safeParse({}).success).toBe(false);
  });

  it('cobrar recargas en efectivo: el encargado sí, el camarero y el datáfono no (el dueño se lo puede dar)', () => {
    const perms = staffPermissionsOf(null);
    expect(staffCan(perms, manager, 'cashTopUp')).toBe(true);
    expect(staffCan(perms, { role: 'WAITER', userId: WAITER_ID }, 'cashTopUp')).toBe(false);
    expect(deviceCan(perms, 'cashTopUp')).toBe(false);
    const given = mergeStaffPermissions(null, { roles: { WAITER: { cashTopUp: true }, DEVICE: { cashTopUp: true } } });
    expect(staffCan(given, { role: 'WAITER', userId: WAITER_ID }, 'cashTopUp')).toBe(true);
    expect(deviceCan(given, 'cashTopUp')).toBe(true);
    // Al camarero y al datáfono, solo eso: nada por encima de su techo.
    const tooMuch = staffPermissionsOf({ roles: { WAITER: { refund: true }, DEVICE: { refund: true, cash: true } } });
    expect(staffCan(tooMuch, { role: 'WAITER', userId: WAITER_ID }, 'refund')).toBe(false);
    expect(deviceCan(tooMuch, 'refund')).toBe(false);
    expect(deviceCan(tooMuch, 'cash')).toBe(false);
    // El datáfono no es una persona: ni con su rol en el token valdría por staffCan.
    expect(staffCan(given, { role: 'DEVICE', userId: 'terminal' }, 'cashTopUp')).toBe(false);
    expect(UpdateStaffPermissionsSchema.safeParse({ roles: { DEVICE: { cashTopUp: true } } }).success).toBe(true);
  });

  it('devolver saldo: en efectivo pide «dar efectivo»; a la tarjeta, «devolver»', () => {
    expect(payoutPermission({ body: { method: 'CASH' } })).toBe('cash');
    expect(payoutPermission({ body: { method: 'CARD' } })).toBe('refund');
    expect(payoutPermission({})).toBe('cash');
  });
});

describe('StaffPermissionGuard', () => {
  class Routes {
    @RequiresPermission('closeNight')
    close(): void {}
    open(): void {}
  }

  function run(handler: keyof Routes, user: Partial<JwtPayload> | undefined, staffPermissions: unknown) {
    const findUnique = vi.fn(async () => ({ staffPermissions }));
    const prisma = { asSystem: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ venue: { findUnique } })) };
    const guard = new StaffPermissionGuard(new Reflector(), prisma as never);
    const ctx = {
      getHandler: () => Routes.prototype[handler],
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    } as unknown as ExecutionContext;
    return { result: guard.canActivate(ctx), findUnique };
  }

  const manager = { sub: MANAGER_ID, role: 'MANAGER', tenantId: 't-1' } as JwtPayload;

  it('ruta sin permiso o el dueño: pasa sin mirar la base', async () => {
    const free = run('open', manager, null);
    await expect(free.result).resolves.toBe(true);
    const owner = run('close', { ...manager, role: 'OWNER' }, { roles: { MANAGER: { closeNight: false } } });
    await expect(owner.result).resolves.toBe(true);
    expect(owner.findUnique).not.toHaveBeenCalled();
  });

  it('el encargado sin «cerrar la noche»: 403 STAFF_PERMISSION_DENIED; con él, pasa', async () => {
    const denied = run('close', manager, { roles: { MANAGER: { closeNight: false } } });
    await expect(denied.result).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'STAFF_PERMISSION_DENIED', permission: 'closeNight' }),
    });
    expect(denied.findUnique).toHaveBeenCalledWith({ where: { id: 't-1' }, select: { staffPermissions: true } });
    await expect(run('close', manager, null).result).resolves.toBe(true);
  });

  it('sin sesión: 403', async () => {
    await expect(run('close', undefined, null).result).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('avisos de Telegram: grupos, chat del local y nombres', () => {
  it('por defecto: todo sale, al chat del entorno y sin nombres', () => {
    const s = alertSettingsOf(null);
    expect(Object.values(s.kinds).every(Boolean)).toBe(true);
    expect(s).toMatchObject({ chatId: null, includeNames: false });
  });

  it('cada incidencia cae en su grupo (una nueva, en «cobros»)', () => {
    expect(alertKindForIncident('pos_unmatched_op')).toBe('pos');
    expect(alertKindForIncident('approval_pending')).toBe('approvals');
    expect(alertKindForIncident('algo_nuevo')).toBe('payments');
  });

  it('chat: número (también de grupo, en negativo) o @canal; null vuelve al del entorno', () => {
    expect(UpdateAlertSettingsSchema.safeParse({ chatId: '-1001234567890' }).success).toBe(true);
    expect(UpdateAlertSettingsSchema.safeParse({ chatId: '@avisos_luna' }).success).toBe(true);
    expect(UpdateAlertSettingsSchema.safeParse({ chatId: 'hola; DROP' }).success).toBe(false);
    const merged = mergeAlertSettings({ chatId: '-1001234567890', kinds: { pos: false } }, { chatId: null, includeNames: true });
    expect(merged).toMatchObject({ chatId: null, includeNames: true, kinds: expect.objectContaining({ pos: false, bank: true }) });
  });
});

describe('VenueSettingsController', () => {
  const owner = { sub: 'own-1', email: 'dueno@local.es', role: 'OWNER', tenantId: 't-1' } as JwtPayload;

  function make(stored: Record<string, unknown> = {}) {
    const venue = { paymentMethods: null, staffPermissions: null, alertSettings: null, ...stored };
    const people = [
      { id: MANAGER_ID, email: 'enc@local.es', displayName: null, role: 'MANAGER' },
      { id: WAITER_ID, email: 'cam@local.es', displayName: 'Pablo', role: 'WAITER' },
    ];
    const tx = {
      venue: {
        findUniqueOrThrow: vi.fn(async () => venue),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(venue, data)),
      },
      user: { findMany: vi.fn(async () => people) },
    };
    const prisma = { asSystem: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
    const audit = { log: vi.fn().mockResolvedValue(undefined) };
    const config = { get: (key: string) => (key === 'TELEGRAM_BOT_TOKEN' ? 'bot' : undefined) };
    const ctrl = new VenueSettingsController(prisma as never, audit as never, config as never);
    return { ctrl, tx, audit };
  }

  it('formas de cobro: se guardan completas y queda en el registro lo de antes y lo de después', async () => {
    const { ctrl, tx, audit } = make();
    const res = await ctrl.updatePaymentMethods(owner, { card: false });
    expect(res).toMatchObject({ card: false, wallet: true });
    expect(tx.venue.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 't-1' }, data: { paymentMethods: expect.objectContaining({ card: false }) } }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'venue.payment_methods.updated',
        payload: { before: expect.objectContaining({ card: true }), after: expect.objectContaining({ card: false }) },
      }),
    );
    await expect(ctrl.paymentMethods(owner)).resolves.toMatchObject({ card: false });
  });

  it('permisos: la lista de encargados y camareros; una excepción para alguien de fuera del local → 400', async () => {
    const { ctrl, tx } = make();
    const view = await ctrl.permissions(owner);
    expect(view.people.map((p) => p.id)).toEqual([MANAGER_ID, WAITER_ID]);
    await expect(
      ctrl.updatePermissions(owner, { people: { '00000000-0000-4000-8000-0000000000ff': { refund: false } } }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.venue.update).not.toHaveBeenCalled();
    const saved = await ctrl.updatePermissions(owner, { people: { [MANAGER_ID]: { refund: false } } });
    expect(saved.people[MANAGER_ID]).toEqual({ refund: false });
  });

  it('mis permisos: lo que puede el encargado que mira (con su excepción)', async () => {
    const { ctrl } = make({ staffPermissions: { people: { [MANAGER_ID]: { reports: true } } } });
    await expect(ctrl.myPermissions({ ...owner, sub: MANAGER_ID, role: 'MANAGER' })).resolves.toEqual({
      refund: true,
      cash: true,
      closeNight: true,
      payouts: true,
      reports: true,
      cashTopUp: true,
    });
  });

  it('avisos: con si hay bot y chat por defecto; el cambio se guarda', async () => {
    const { ctrl } = make();
    await expect(ctrl.alerts(owner)).resolves.toMatchObject({ botConfigured: true, defaultChatConfigured: false, chatId: null });
    const res = await ctrl.updateAlerts(owner, { chatId: '-1001234567890', kinds: { summary: false } });
    expect(res).toMatchObject({ chatId: '-1001234567890', kinds: expect.objectContaining({ summary: false, payments: true }) });
  });
});
