import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { SuperAdminVenuesService } from './venues.service';
import { SuperAdminStaffService } from './staff.service';

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

function venuesSetup(opts: { stepUpFails?: boolean; maxOverride?: number | null } = {}) {
  const tx = {
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
  const config = { get: vi.fn().mockReturnValue('7') };
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

  it('perfil: el nombre no pide 2FA; el grupo del saldo sí', async () => {
    const plain = venuesSetup();
    await plain.svc.updateProfile(actor, 'v-1', { name: 'Luna Centro' });
    expect(plain.stepUp.verify).not.toHaveBeenCalled();
    const group = venuesSetup({ stepUpFails: true });
    await expect(group.svc.updateProfile(actor, 'v-1', { walletGroup: 'luna' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(group.tx.venue.update).not.toHaveBeenCalled();
  });

  it('pausar dos veces → 409', async () => {
    const { svc, tx } = venuesSetup();
    tx.venue.findFirst.mockResolvedValue({ ...VENUE, pausedAt: new Date() });
    await expect(svc.pause(actor, 'v-1', { reason: 'impagos', totpCode: '123456' })).rejects.toBeInstanceOf(ConflictException);
  });
});

function staffSetup(opts: { target: Record<string, unknown>; activeSuperAdmins: string[] }) {
  const tx = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) =>
      strings.join('?').includes('"isSuperAdmin" AND') ? opts.activeSuperAdmins.map((id) => ({ id })) : [opts.target],
    ),
    user: { update: vi.fn().mockResolvedValue({}) },
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
