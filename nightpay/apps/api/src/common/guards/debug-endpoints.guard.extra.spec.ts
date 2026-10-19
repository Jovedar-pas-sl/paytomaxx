import { describe, it, expect, vi } from 'vitest';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { DebugEndpointsGuard } from './debug-endpoints.guard';

const SUPER = 'a1a1a1a1-0000-4000-8000-000000000001';

function setup(enabled: unknown, dbUser: Record<string, unknown> | null | Error = { isSuperAdmin: true, deletedAt: null }) {
  const config = { get: vi.fn((k: string) => (k === 'DEBUG_ENDPOINTS_ENABLED' ? enabled : 'production')) };
  const findUnique =
    dbUser instanceof Error ? vi.fn().mockRejectedValue(dbUser) : vi.fn().mockResolvedValue(dbUser);
  const prisma = { acrossVenues: vi.fn((fn: (tx: unknown) => unknown) => fn({ user: { findUnique } })) };
  return { guard: new DebugEndpointsGuard(config as never, prisma as never), findUnique };
}

function ctx(req: Record<string, unknown> = {}): ExecutionContext {
  const request = {
    url: '/v1/debug/peanpe/calls',
    headers: {},
    raw: { socket: { remoteAddress: '83.45.120.7' } },
    user: { sub: SUPER },
    ...req,
  };
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

describe('DebugEndpointsGuard — interruptor DEBUG_ENDPOINTS_ENABLED', () => {
  it.each([true, 'true', '1'])('%j → abierto para el superadmin', async (value) => {
    await expect(setup(value).guard.canActivate(ctx())).resolves.toBe(true);
  });

  it.each([false, 'false', '0', 'TRUE', 'yes', 'on', '', undefined, 1])('%j → cerrado sin mirar la base', async (value) => {
    const { guard, findUnique } = setup(value);
    await expect(guard.canActivate(ctx())).rejects.toThrow(ForbiddenException);
    expect(findUnique).not.toHaveBeenCalled();
  });
});

describe('DebugEndpointsGuard — superadmin leído de la base', () => {
  it('superadmin dado de baja → 403', async () => {
    const { guard } = setup(true, { isSuperAdmin: true, deletedAt: new Date('2026-09-01T00:00:00Z') });
    await expect(guard.canActivate(ctx())).rejects.toThrow(/Solo superadmin/);
  });

  it('usuario inexistente → 403', async () => {
    await expect(setup(true, null).guard.canActivate(ctx())).rejects.toThrow(ForbiddenException);
  });

  it('sesión sin sub (o un sub vacío) → 403 sin consultar la base', async () => {
    const { guard, findUnique } = setup(true);
    await expect(guard.canActivate(ctx({ user: { sub: '' } }))).rejects.toThrow(ForbiddenException);
    await expect(guard.canActivate(ctx({ user: undefined }))).rejects.toThrow(ForbiddenException);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('cabeceras que dicen ser superadmin no cuentan', async () => {
    const { guard } = setup(true, { isSuperAdmin: false, deletedAt: null });
    await expect(guard.canActivate(ctx({ headers: { 'x-superadmin': 'true' } }))).rejects.toThrow(ForbiddenException);
  });

  it('si la base falla, se corta (no deja pasar)', async () => {
    const { guard } = setup(true, new Error('timeout'));
    await expect(guard.canActivate(ctx())).rejects.toThrow(/timeout/);
  });

  it('petición sin url ni IP conocidas: sigue cerrando (el aviso no rompe)', async () => {
    const { guard } = setup(false);
    await expect(guard.canActivate(ctx({ url: undefined, raw: undefined }))).rejects.toThrow(ForbiddenException);
  });
});
