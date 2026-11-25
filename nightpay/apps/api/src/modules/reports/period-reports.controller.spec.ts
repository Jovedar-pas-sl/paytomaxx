import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { StaffPermissionGuard } from '../venues/staff-permission.guard';
import { PeriodReportsController } from './period-reports.controller';

/** El guard de permisos de verdad sobre la ruta del Z, con los permisos que tenga guardados el local. */
function canSeeZ(role: 'OWNER' | 'MANAGER', staffPermissions: unknown): Promise<boolean> {
  const venue = { findUnique: async () => ({ staffPermissions }) };
  const prisma = { asSystem: async (fn: (tx: unknown) => unknown) => fn({ venue }) };
  const ctx = {
    getHandler: () => PeriodReportsController.prototype.zReport,
    switchToHttp: () => ({ getRequest: () => ({ user: { sub: 'u-1', role, tenantId: 't-1' } }) }),
  } as unknown as ExecutionContext;
  return new StaffPermissionGuard(new Reflector(), prisma as never).canActivate(ctx);
}

describe('GET /v1/admin/reports/z (el Z de cualquier periodo)', () => {
  it('el dueño, y el encargado solo si el dueño le deja ver los informes', async () => {
    const handler = PeriodReportsController.prototype.zReport;
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(['OWNER', 'MANAGER']);
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual([StaffPermissionGuard]);
    await expect(canSeeZ('OWNER', null)).resolves.toBe(true);
    // De serie el encargado no tiene «Informes».
    await expect(canSeeZ('MANAGER', null)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'STAFF_PERMISSION_DENIED', permission: 'reports' }),
    });
    await expect(canSeeZ('MANAGER', { roles: { MANAGER: { reports: true } } })).resolves.toBe(true);
  });
});
