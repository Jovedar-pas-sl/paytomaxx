import { describe, expect, it, vi } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@nightpay/db';
import type { JwtPayload } from '@nightpay/contracts';
import { STALL_IN_USE_CODE, StallsService } from './stalls.service';
import { stallAudit, stallChange, stallCreateData, stallView } from './stall-views';

/** Casetas con la base simulada: 2FA cuando toca dinero, registro con el IBAN tapado, borrar y asignar personal. */

const T = 't-1';
const owner = { sub: 'owner-1', email: 'duena@fiesta.es', role: 'OWNER', tenantId: T, venueSlug: 'fiesta' } as JwtPayload;
const IBAN = 'ES9121000418450200051332';
const NOW = new Date('2026-11-13T10:00:00Z');

function row(extra: Record<string, unknown> = {}) {
  return {
    id: 's-1',
    name: 'Peña El Trago',
    managerName: 'Lola',
    managerContact: null,
    organizerBps: 2500,
    iban: IBAN,
    active: true,
    sortOrder: 0,
    createdAt: NOW,
    updatedAt: NOW,
    _count: { staff: 2 },
    ...extra,
  };
}

function make() {
  const tx = {
    stall: {
      findMany: vi.fn().mockResolvedValue([row()]),
      findFirst: vi.fn().mockResolvedValue(row()),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => row({ ...data, id: 's-new', _count: { staff: 0 } })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => row(data)),
      delete: vi.fn().mockResolvedValue(row()),
    },
    user: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue({ stallId: null }),
      update: vi.fn(async ({ data }: { data: { stallId: string | null } }) => ({
        id: 'u-1',
        email: 'camarero@fiesta.es',
        displayName: 'Toni',
        role: 'WAITER',
        stallId: data.stallId,
      })),
      updateMany: vi.fn().mockResolvedValue({ count: 2 }),
    },
  };
  const prisma = { withTenant: vi.fn(async (_t: string, fn: (t: typeof tx) => unknown) => fn(tx)) };
  const totp = { assertIfEnrolledForUser: vi.fn().mockResolvedValue(undefined) };
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const svc = new StallsService(prisma as never, totp as never, audit as never);
  return { svc, tx, prisma, totp, audit };
}

describe('vistas', () => {
  it('«barra propia» con el 100 % del organizador; cuántas personas tiene', () => {
    expect(stallView(row())).toMatchObject({ ownBar: false, staffCount: 2, createdAt: NOW.toISOString() });
    expect(stallView(row({ organizerBps: 10_000, _count: undefined }))).toMatchObject({ ownBar: true, staffCount: 0 });
  });

  it('solo cuenta lo que cambia; el IBAN del registro, tapado', () => {
    expect(stallChange(row(), { name: 'Peña El Trago', organizerBps: 3000 })).toEqual({ organizerBps: 3000 });
    expect(stallChange(row(), { managerContact: null, iban: IBAN })).toEqual({});
    expect(stallAudit({ iban: IBAN, name: 'X' })).toEqual({ iban: 'ES91 •••• •••• 1332', name: 'X' });
    expect(stallAudit({ iban: null })).toEqual({ iban: null });
    expect(stallAudit({ name: 'X' })).toEqual({ name: 'X' });
  });

  it('los datos de una nueva: lo que no llega, null o el de la base', () => {
    expect(stallCreateData(T, { name: 'A', managerName: 'B', organizerBps: 0 })).toEqual({
      tenantId: T,
      name: 'A',
      managerName: 'B',
      managerContact: null,
      organizerBps: 0,
      iban: null,
    });
    expect(stallCreateData(T, { name: 'A', managerName: 'B', organizerBps: 0, active: false, sortOrder: 3 })).toMatchObject({ active: false, sortOrder: 3 });
  });
});

describe('StallsService', () => {
  it('lista las del local dentro de withTenant (FORCE RLS)', async () => {
    const { svc, prisma, tx } = make();
    const list = await svc.list(T);
    expect(list).toHaveLength(1);
    expect(prisma.withTenant).toHaveBeenCalledWith(T, expect.any(Function));
    expect(tx.stall.findMany.mock.calls[0]![0]).toMatchObject({ where: { tenantId: T } });
  });

  it('crear pide la 2FA (si la tiene) y queda en el registro con el IBAN tapado', async () => {
    const { svc, totp, audit, tx } = make();
    const created = await svc.create(owner, { name: 'Falla Centro', managerName: 'Pep', organizerBps: 10_000, iban: IBAN, totpCode: '123456' });
    expect(totp.assertIfEnrolledForUser).toHaveBeenCalledWith('owner-1', '123456');
    expect(tx.stall.create.mock.calls[0]![0].data).toMatchObject({ tenantId: T, organizerBps: 10_000, iban: IBAN });
    expect(created).toMatchObject({ id: 's-new', ownBar: true });
    const logged = audit.log.mock.calls[0]![0];
    expect(logged).toMatchObject({ action: 'party.stall.created', tenantId: T, targetType: 'Stall', targetId: 's-new' });
    expect(JSON.stringify(logged.payload)).not.toContain(IBAN);
  });

  it('con la 2FA mal, no se crea nada', async () => {
    const { svc, totp, tx } = make();
    totp.assertIfEnrolledForUser.mockRejectedValueOnce(new Error('TOTP_INVALID'));
    await expect(svc.create(owner, { name: 'A', managerName: 'B', organizerBps: 0 })).rejects.toThrow('TOTP_INVALID');
    expect(tx.stall.create).not.toHaveBeenCalled();
  });

  it('cambiar el nombre no pide 2FA; la parte del organizador o el IBAN, sí', async () => {
    const { svc, totp, audit } = make();
    await svc.update(owner, 's-1', { name: 'Peña Nueva' });
    expect(totp.assertIfEnrolledForUser).not.toHaveBeenCalled();
    expect(audit.log.mock.calls[0]![0]).toMatchObject({ action: 'party.stall.updated', payload: { before: { name: 'Peña El Trago' }, after: { name: 'Peña Nueva' } } });
    await svc.update(owner, 's-1', { organizerBps: 0, totpCode: '654321' });
    expect(totp.assertIfEnrolledForUser).toHaveBeenCalledWith('owner-1', '654321');
    await svc.update(owner, 's-1', { iban: null });
    expect(totp.assertIfEnrolledForUser).toHaveBeenCalledTimes(2);
  });

  it('sin cambios de verdad: ni 2FA, ni escritura, ni registro', async () => {
    const { svc, totp, tx, audit } = make();
    const same = await svc.update(owner, 's-1', { organizerBps: 2500, iban: IBAN });
    expect(same.id).toBe('s-1');
    expect(totp.assertIfEnrolledForUser).not.toHaveBeenCalled();
    expect(tx.stall.update).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('una caseta de otro local (o que no existe): 404', async () => {
    const { svc, tx } = make();
    tx.stall.findFirst.mockResolvedValue(null);
    await expect(svc.update(owner, 's-x', { name: 'X' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.remove(owner, 's-x')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('borrar: su personal se queda sin caseta en la misma transacción', async () => {
    const { svc, tx, audit } = make();
    await expect(svc.remove(owner, 's-1')).resolves.toEqual({ deleted: true, unassignedStaff: 2 });
    expect(tx.user.updateMany).toHaveBeenCalledWith({ where: { tenantId: T, stallId: 's-1' }, data: { stallId: null } });
    expect(tx.stall.delete).toHaveBeenCalledWith({ where: { id: 's-1' } });
    expect(audit.log.mock.calls[0]![0]).toMatchObject({ action: 'party.stall.deleted', payload: { unassignedStaff: 2 } });
  });

  it('borrar una con cobros: 409 STALL_IN_USE (se desactiva) y sin registro', async () => {
    const { svc, tx, audit } = make();
    tx.stall.delete.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Foreign key constraint failed', { code: 'P2003', clientVersion: 'x' }),
    );
    const err = await svc.remove(owner, 's-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: STALL_IN_USE_CODE });
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('otro error al borrar sale tal cual', async () => {
    const { svc, tx } = make();
    tx.stall.delete.mockRejectedValueOnce(new Error('se cayó la base'));
    await expect(svc.remove(owner, 's-1')).rejects.toThrow('se cayó la base');
  });

  it('el personal del local con su caseta (sin el dueño)', async () => {
    const { svc, tx } = make();
    await svc.staff(T);
    expect(tx.user.findMany.mock.calls[0]![0].where).toEqual({ tenantId: T, deletedAt: null, role: { in: ['MANAGER', 'WAITER', 'OPERATOR'] } });
  });

  it('asignar: a una caseta activa del local; queda en el registro', async () => {
    const { svc, tx, audit } = make();
    const person = await svc.assign(owner, 'u-1', { stallId: 's-1' });
    expect(person.stallId).toBe('s-1');
    expect(tx.user.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'u-1' }, data: { stallId: 's-1' } }));
    expect(audit.log.mock.calls[0]![0]).toMatchObject({ action: 'party.staff.stall_updated', targetType: 'User', payload: { before: null, after: 's-1' } });
  });

  it('quitar la caseta (null) no mira casetas; lo mismo que había no se registra', async () => {
    const { svc, tx, audit } = make();
    await svc.assign(owner, 'u-1', { stallId: null });
    expect(tx.stall.findFirst).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('asignar a una desactivada (409), de otro local (404) o a quien no es del personal (404): nada cambia', async () => {
    const { svc, tx } = make();
    tx.stall.findFirst.mockResolvedValueOnce({ active: false });
    await expect(svc.assign(owner, 'u-1', { stallId: 's-1' })).rejects.toBeInstanceOf(ConflictException);
    tx.stall.findFirst.mockResolvedValueOnce(null);
    await expect(svc.assign(owner, 'u-1', { stallId: 's-x' })).rejects.toBeInstanceOf(NotFoundException);
    tx.user.findFirst.mockResolvedValueOnce(null);
    await expect(svc.assign(owner, 'owner-1', { stallId: 's-1' })).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.user.update).not.toHaveBeenCalled();
  });
});
