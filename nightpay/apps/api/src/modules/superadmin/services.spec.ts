import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { SuperAdminVenuesService } from './venues.service';
import { SuperAdminStaffService } from './staff.service';
import { SuperAdminBusinessesService } from './businesses.service';

const actor = { id: 'sa-1', email: 'jefe@x.es' };
const VENUE = {
  id: 'v-1',
  name: 'Luna',
  slug: 'luna',
  timezone: 'Europe/Madrid',
  walletGroup: null,
  vatBps: 2100,
  vatRegime: 'GENERAL',
  operatorMaxCobroCents: 20_000,
  platformCommissionBps: 1000,
  operatorCommissionDefaults: { CHICA_SERVICE: 9000 },
  payoutHoldDays: null,
  refundApprovalThresholdCents: 10_000,
  payoutRequiresApproval: true,
  settlementIban: null,
  settlementHolder: null,
  pausedAt: null,
  pausedReason: null,
  businessId: null,
  business: null,
  createdAt: new Date('2026-10-01T00:00:00Z'),
};

function venuesSetup(opts: { stepUpFails?: boolean; maxOverride?: number | null; provider?: string; peanpeFormat?: string } = {}) {
  const tx = {
    gatewayCredential: { findFirst: vi.fn().mockResolvedValue(opts.provider ? { provider: opts.provider } : null) },
    venue: {
      findFirst: vi.fn().mockResolvedValue(VENUE),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...VENUE, ...data })),
    },
    user: {
      aggregate: vi.fn().mockResolvedValue({ _max: { commissionBps: opts.maxOverride ?? null } }),
      count: vi.fn().mockResolvedValue(0),
    },
    terminal: { count: vi.fn().mockResolvedValue(0) },
  };
  const prisma = { acrossVenues: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const stepUp = {
    verify: opts.stepUpFails
      ? vi.fn().mockRejectedValue(new ForbiddenException({ message: 'Código 2FA incorrecto o caducado', code: 'TOTP_INVALID' }))
      : vi.fn().mockResolvedValue(undefined),
  };
  const audit = { write: vi.fn().mockResolvedValue(undefined) };
  const config = { get: vi.fn((k: string) => (k === 'PEANPE_AMOUNT_FORMAT_VERIFIED' ? opts.peanpeFormat : '7')) };
  const svc = new SuperAdminVenuesService(prisma as never, stepUp as never, audit as never, config as never);
  return { svc, tx, stepUp, audit };
}

describe('SuperAdminVenuesService — 2FA antes de tocar nada', () => {
  it('reglas con 2FA mala: 403 y no se escribe nada ni se registra un cambio', async () => {
    const { svc, tx, audit } = venuesSetup({ stepUpFails: true });
    await expect(svc.updateRules(actor, 'v-1', { payoutHoldDays: 0, totpCode: '000000' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.venue.update).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('reglas: días de espera 0 guardados y el cambio queda en el registro con antes/después', async () => {
    const { svc, tx, audit, stepUp } = venuesSetup();
    const out = await svc.updateRules(actor, 'v-1', { payoutHoldDays: 0, totpCode: '123456' });
    expect(stepUp.verify).toHaveBeenCalledWith(actor, '123456', 'venue.rules');
    expect(tx.venue.update).toHaveBeenCalledWith(expect.objectContaining({ data: { payoutHoldDays: 0 } }));
    expect(audit.write).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        action: 'venue.rules_updated',
        tenantId: 'v-1',
        before: { payoutHoldDays: null },
        after: { payoutHoldDays: 0 },
      }),
    );
    expect(out.rules).toMatchObject({ payoutHoldDays: null, effectivePayoutHoldDays: 7 });
  });

  it('comisiones que pasan del 100 % (con el % propio de una chica): 400 sin escribir', async () => {
    const { svc, tx } = venuesSetup({ maxOverride: 9500 });
    await expect(svc.updateRules(actor, 'v-1', { platformCommissionBps: 1000, totpCode: '123456' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(tx.venue.update).not.toHaveBeenCalled();
  });

  it('Peanpe en euros enteros: no se puede encender la comisión del servicio (y la ficha lo dice)', async () => {
    const { svc, tx } = venuesSetup({ provider: 'PEANPE', peanpeFormat: 'euros' });
    const err = await svc.updateRules(actor, 'v-1', { serviceFeeEnabled: true, totpCode: '123456' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(String((err as Error).message)).toMatch(/Peanpe/);
    expect(tx.venue.update).not.toHaveBeenCalled();
    expect((await svc.get('v-1')).rules.serviceFeeBlockedReason).toMatch(/euros enteros/);
    // Otra pasarela: se enciende y la ficha no dice nada.
    const ok = venuesSetup({ provider: 'REDSYS', peanpeFormat: 'euros' });
    await ok.svc.updateRules(actor, 'v-1', { serviceFeeEnabled: true, totpCode: '123456' });
    expect(ok.tx.venue.update).toHaveBeenCalled();
    expect((await ok.svc.get('v-1')).rules.serviceFeeBlockedReason).toBeNull();
  });

  it('perfil: el nombre no pide 2FA; el grupo del saldo sí', async () => {
    const plain = venuesSetup();
    await plain.svc.updateProfile(actor, 'v-1', { name: 'Luna Centro' });
    expect(plain.stepUp.verify).not.toHaveBeenCalled();
    const group = venuesSetup({ stepUpFails: true });
    await expect(group.svc.updateProfile(actor, 'v-1', { walletGroup: 'luna' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(group.tx.venue.update).not.toHaveBeenCalled();
  });

  it('alta con grupo del saldo o comisión: 2FA mala → 403 sin crear nada; sin ellos, sin 2FA', async () => {
    const { svc, stepUp } = venuesSetup({ stepUpFails: true });
    await expect(
      svc.create(actor, { name: 'Luna', slug: 'luna', walletGroup: 'g1', totpCode: '000000' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(stepUp.verify).toHaveBeenCalledWith(actor, '000000', 'venue.create');
    await expect(svc.create(actor, { name: 'Luna', slug: 'luna', platformCommissionBps: 0 })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('pausar dos veces → 409', async () => {
    const { svc, tx } = venuesSetup();
    tx.venue.findFirst.mockResolvedValue({ ...VENUE, pausedAt: new Date() });
    await expect(svc.pause(actor, 'v-1', { reason: 'impagos', totpCode: '123456' })).rejects.toBeInstanceOf(ConflictException);
  });
});

function businessesSetup(opts: { stepUpFails?: boolean } = {}) {
  const BUSINESS = {
    id: 'b-1',
    name: 'Luna Ocio',
    taxId: null,
    contactName: null,
    contactEmail: null,
    contactPhone: null,
    notes: null,
    status: 'PAUSED',
    pausedAt: new Date('2026-10-10T00:00:00Z'),
    pausedReason: 'impagos',
    defaultPlatformCommissionBps: 800,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    _count: { venues: 1 },
  };
  const tx = {
    business: {
      findUnique: vi.fn().mockResolvedValue(BUSINESS),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...BUSINESS, ...data })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...BUSINESS, ...data })),
    },
    venue: {
      findMany: vi.fn().mockResolvedValue([{ id: 'v-1', businessId: 'b-2' }]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const prisma = { acrossVenues: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const stepUp = {
    verify: opts.stepUpFails
      ? vi.fn().mockRejectedValue(new ForbiddenException({ message: 'Pon el código', code: 'TOTP_REQUIRED' }))
      : vi.fn().mockResolvedValue(undefined),
  };
  const audit = { write: vi.fn().mockResolvedValue(undefined) };
  const venues = { list: vi.fn().mockResolvedValue([]) };
  const svc = new SuperAdminBusinessesService(prisma as never, stepUp as never, audit as never, venues as never);
  return { svc, tx, stepUp, audit };
}

describe('SuperAdminBusinessesService — 2FA en lo que saca locales de una pausa o cambia la comisión', () => {
  it('sacar un local o meter locales sin 2FA: 403 y no se mueve nada', async () => {
    const { svc, tx, audit, stepUp } = businessesSetup({ stepUpFails: true });
    await expect(svc.unassignVenue(actor, 'b-1', 'v-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(stepUp.verify).toHaveBeenCalledWith(actor, undefined, 'business.unassign_venue');
    await expect(svc.assignVenues(actor, 'b-1', { venueIds: ['v-1'] })).rejects.toBeInstanceOf(ForbiddenException);
    expect(stepUp.verify).toHaveBeenCalledWith(actor, undefined, 'business.assign_venues');
    expect(tx.venue.updateMany).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('con 2FA buena: se mueven y queda en el registro', async () => {
    const { svc, tx, stepUp } = businessesSetup();
    await svc.unassignVenue(actor, 'b-1', 'v-1', { totpCode: '123456' });
    expect(stepUp.verify).toHaveBeenCalledWith(actor, '123456', 'business.unassign_venue');
    expect(tx.venue.updateMany).toHaveBeenCalledWith({ where: { id: 'v-1', businessId: 'b-1' }, data: { businessId: null } });
  });

  it('cambiar la comisión por defecto pide 2FA (y el código no llega a la base); los demás datos, no', async () => {
    const failing = businessesSetup({ stepUpFails: true });
    await expect(failing.svc.update(actor, 'b-1', { defaultPlatformCommissionBps: 0 })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(failing.tx.business.update).not.toHaveBeenCalled();

    const ok = businessesSetup();
    await ok.svc.update(actor, 'b-1', { defaultPlatformCommissionBps: 500, totpCode: '123456' });
    expect(ok.stepUp.verify).toHaveBeenCalledWith(actor, '123456', 'business.commission');
    expect(ok.tx.business.update).toHaveBeenCalledWith(expect.objectContaining({ data: { defaultPlatformCommissionBps: 500 } }));

    const plain = businessesSetup({ stepUpFails: true });
    await plain.svc.update(actor, 'b-1', { name: 'Luna Ocio SL', defaultPlatformCommissionBps: 800 });
    expect(plain.stepUp.verify).not.toHaveBeenCalled();
  });

  it('alta con comisión por defecto propia: 2FA (mala → 403 sin crear); sin comisión, sin 2FA', async () => {
    const failing = businessesSetup({ stepUpFails: true });
    await expect(failing.svc.create(actor, { name: 'Sol Noche', defaultPlatformCommissionBps: 0 })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(failing.stepUp.verify).toHaveBeenCalledWith(actor, undefined, 'business.create_commission');
    expect(failing.tx.business.create).not.toHaveBeenCalled();

    const ok = businessesSetup();
    await ok.svc.create(actor, { name: 'Sol Noche', defaultPlatformCommissionBps: 500, totpCode: '123456' });
    expect(ok.stepUp.verify).toHaveBeenCalledWith(actor, '123456', 'business.create_commission');
    const data = ok.tx.business.create.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data).toMatchObject({ name: 'Sol Noche', defaultPlatformCommissionBps: 500 });
    expect(data).not.toHaveProperty('totpCode');

    const plain = businessesSetup({ stepUpFails: true });
    await plain.svc.create(actor, { name: 'Sol Noche', defaultPlatformCommissionBps: null });
    expect(plain.stepUp.verify).not.toHaveBeenCalled();
  });
});

function staffSetup(opts: { target: Record<string, unknown>; activeSuperAdmins: string[] }) {
  const tx = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) =>
      strings.join('?').includes('"isSuperAdmin" AND') ? opts.activeSuperAdmins.map((id) => ({ id })) : [opts.target],
    ),
    user: {
      update: vi.fn().mockResolvedValue({}),
      // La ficha que se devuelve al terminar.
      findUnique: vi.fn(async () => ({
        email: 'x@x.es',
        displayName: null,
        invitedAt: null,
        totpSecret: null,
        venue: null,
        createdAt: new Date(),
        ...opts.target,
      })),
    },
  };
  const prisma = { acrossVenues: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const stepUp = { verify: vi.fn().mockResolvedValue(undefined) };
  const audit = { write: vi.fn().mockResolvedValue(undefined) };
  const refreshTokens = { revokeAllForUser: vi.fn().mockResolvedValue(0) };
  const svc = new SuperAdminStaffService(
    prisma as never,
    stepUp as never,
    audit as never,
    {} as never,
    refreshTokens as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { svc, tx, audit, refreshTokens };
}

describe('SuperAdminStaffService — nunca sin super-admins', () => {
  const dto = { enabled: false, reason: 'ya no lleva la plataforma', totpCode: '123456' };

  it('quitarse el permiso siendo el último: 409 y no se cambia nada', async () => {
    const { svc, tx, audit } = staffSetup({
      target: { id: 'sa-1', tenantId: 'v-1', role: 'OWNER', isSuperAdmin: true, deletedAt: null },
      activeSuperAdmins: ['sa-1'],
    });
    await expect(svc.setSuperAdmin(actor, 'sa-1', dto)).rejects.toThrow(/Eres el último super-admin/);
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('dar de baja al último super-admin (otro): 409', async () => {
    const { svc, tx } = staffSetup({
      target: { id: 'sa-2', tenantId: 'v-1', role: 'OWNER', isSuperAdmin: true, deletedAt: null },
      activeSuperAdmins: ['sa-2'],
    });
    await expect(svc.disable(actor, 'sa-2', { reason: 'baja', totpCode: '123456' })).rejects.toThrow(/Es el último super-admin/);
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('a uno mismo no se da de baja (400); dar super-admin solo a un dueño activo', async () => {
    const self = staffSetup({ target: { id: 'sa-1' }, activeSuperAdmins: ['sa-1', 'sa-2'] });
    await expect(self.svc.disable(actor, 'sa-1', { reason: 'x'.repeat(3), totpCode: '123456' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const waiter = staffSetup({
      target: { id: 'u-9', tenantId: 'v-1', role: 'WAITER', isSuperAdmin: false, deletedAt: null },
      activeSuperAdmins: ['sa-1'],
    });
    await expect(waiter.svc.setSuperAdmin(actor, 'u-9', { ...dto, enabled: true })).rejects.toThrow(/Solo un dueño/);
    expect(waiter.tx.user.update).not.toHaveBeenCalled();
  });
});

describe('SuperAdminStaffService — quitar el permiso de super-admin', () => {
  const target = { id: 'sa-2', tenantId: 'v-1', role: 'OWNER', isSuperAdmin: true, deletedAt: null };
  const dto = { enabled: false, reason: 'ya no lleva la plataforma', totpCode: '123456' };

  it('cierra sus sesiones al momento, ya quitado (el pase que tenía para un local ajeno deja de valer); darlo, no', async () => {
    const revoke = staffSetup({ target, activeSuperAdmins: ['sa-1', 'sa-2'] });
    await revoke.svc.setSuperAdmin(actor, 'sa-2', dto);
    expect(revoke.refreshTokens.revokeAllForUser).toHaveBeenCalledWith('sa-2');
    expect(revoke.tx.user.update.mock.invocationCallOrder[0]!).toBeLessThan(
      revoke.refreshTokens.revokeAllForUser.mock.invocationCallOrder[0]!,
    );

    const grant = staffSetup({ target: { ...target, isSuperAdmin: false }, activeSuperAdmins: ['sa-1'] });
    await grant.svc.setSuperAdmin(actor, 'sa-2', { ...dto, enabled: true });
    expect(grant.tx.user.update).toHaveBeenCalled();
    expect(grant.refreshTokens.revokeAllForUser).not.toHaveBeenCalled();
  });
});
