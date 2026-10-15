import { describe, it, expect, vi } from 'vitest';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { DebugEndpointsGuard } from './debug-endpoints.guard';

const SUPER = 'a1a1a1a1-0000-4000-8000-000000000001';
const NORMAL = 'b2b2b2b2-0000-4000-8000-000000000002';

function makeGuard(env: Record<string, unknown>) {
  const config = { get: vi.fn().mockImplementation((k: string) => env[k]) };
  const findUnique = vi.fn().mockImplementation(({ where }: { where: { id: string } }) =>
    Promise.resolve(
      where.id === SUPER
        ? { isSuperAdmin: true, deletedAt: null }
        : where.id === NORMAL
          ? { isSuperAdmin: false, deletedAt: null }
          : null,
    ),
  );
  const prisma = { acrossVenues: vi.fn((fn: (tx: unknown) => unknown) => fn({ user: { findUnique } })) };
  return { guard: new DebugEndpointsGuard(config as never, prisma as never), findUnique };
}

function ctx(userId?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        url: '/v1/debug/redsys/keycheck',
        headers: {},
        raw: { socket: { remoteAddress: '81.0.0.7' } },
        user: userId ? { sub: userId } : undefined,
      }),
    }),
  } as unknown as ExecutionContext;
}

describe('DebugEndpointsGuard', () => {
  it.each(['development', 'test', 'production'])('%s: con el interruptor y superadmin, pasa', async (nodeEnv) => {
    const { guard } = makeGuard({ NODE_ENV: nodeEnv, DEBUG_ENDPOINTS_ENABLED: true });
    await expect(guard.canActivate(ctx(SUPER))).resolves.toBe(true);
  });

  it.each(['development', 'test', 'production'])(
    '%s: cualquier usuario con sesión que no sea superadmin → 403 (antes bastaba la sesión fuera de producción)',
    async (nodeEnv) => {
      const { guard } = makeGuard({ NODE_ENV: nodeEnv, DEBUG_ENDPOINTS_ENABLED: true });
      await expect(guard.canActivate(ctx(NORMAL))).rejects.toThrow(ForbiddenException);
      await expect(guard.canActivate(ctx())).rejects.toThrow(ForbiddenException);
    },
  );

  it.each(['development', 'production'])('%s: sin DEBUG_ENDPOINTS_ENABLED, cerrado aunque sea superadmin', async (nodeEnv) => {
    const { guard, findUnique } = makeGuard({ NODE_ENV: nodeEnv, DEBUG_ENDPOINTS_ENABLED: false });
    await expect(guard.canActivate(ctx(SUPER))).rejects.toThrow(ForbiddenException);
    // Ni se consulta la base de datos.
    expect(findUnique).not.toHaveBeenCalled();
  });
});
