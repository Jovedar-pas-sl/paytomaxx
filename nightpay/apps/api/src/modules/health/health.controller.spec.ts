import { afterEach, describe, it, expect, vi } from 'vitest';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('returns ok status when DB and Redis respond', async () => {
    const prisma = { $queryRaw: vi.fn().mockResolvedValue([{ ok: 1 }]) };
    const config = {
      getOrThrow: vi.fn().mockReturnValue('redis://localhost:9'), // puerto cerrado -> redis fail
    };
     
    const controller = new HealthController(prisma as any, config as any);
    const result = await controller.get();
    // db debe estar OK; redis falla por puerto cerrado
    expect(result.checks.api).toBe('ok');
    expect(result.checks.db).toBe('ok');
    expect(result.checks.redis).toBe('fail');
    expect(result.status).toBe('degraded');
    expect(typeof result.timestamp).toBe('string');
  });

  it('algo caído → 503 (para los monitores); el proceso vivo → /live responde ok', async () => {
    const prisma = { $queryRaw: vi.fn().mockRejectedValue(new Error('db down')) };
    const redis = { ping: vi.fn().mockResolvedValue('PONG') };
     
    const controller = new HealthController(prisma as any, redis as any);
    const res = { status: vi.fn() };
    const result = await controller.get(res as never);
    expect(result.status).toBe('degraded');
    expect(res.status).toHaveBeenCalledWith(503);
    expect(controller.live()).toEqual({ status: 'ok' });
  });

  it('todo bien → sin 503', async () => {
    const prisma = { $queryRaw: vi.fn().mockResolvedValue([{ ok: 1 }]) };
    const redis = { ping: vi.fn().mockResolvedValue('PONG') };
     
    const controller = new HealthController(prisma as any, redis as any);
    const res = { status: vi.fn() };
    const result = await controller.get(res as never);
    expect(result.status).toBe('ok');
    expect(res.status).not.toHaveBeenCalled();
  });

  it('marks db fail when prisma rejects', async () => {
    const prisma = { $queryRaw: vi.fn().mockRejectedValue(new Error('db down')) };
    const config = {
      getOrThrow: vi.fn().mockReturnValue('redis://localhost:9'),
    };
     
    const controller = new HealthController(prisma as any, config as any);
    const result = await controller.get();
    expect(result.checks.db).toBe('fail');
    expect(result.status).toBe('degraded');
  });
});

describe('HealthController: versión y marca del despliegue', () => {
  const ok = () =>
    new HealthController(
      { $queryRaw: vi.fn().mockResolvedValue([{ ok: 1 }]) } as never,
      { ping: vi.fn().mockResolvedValue('PONG') } as never,
    );

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('version = GIT_SHA (lo pone el Dockerfile) y build = BUILD_MARKER', async () => {
    vi.stubEnv('GIT_SHA', '3ea5019');
    vi.stubEnv('BUILD_MARKER', 'plataforma-2026-10-15');
    const result = (await ok().get()) as Awaited<ReturnType<HealthController['get']>> & { build: string };
    expect(result.version).toBe('3ea5019');
    expect(result.build).toBe('plataforma-2026-10-15');
  });

  it('sin ellas: la versión del paquete y la marca de siempre', async () => {
    vi.stubEnv('GIT_SHA', '');
    vi.stubEnv('BUILD_MARKER', '');
    vi.stubEnv('npm_package_version', '1.2.3');
    const result = (await ok().get()) as Awaited<ReturnType<HealthController['get']>> & { build: string };
    expect(result.version).toBe('1.2.3');
    expect(result.build).toBe('revision3-2026-10-20');
  });
});
