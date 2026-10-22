import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe('HealthController: qué código corre (leído al arrancar)', () => {
  const deps = [
    { $queryRaw: vi.fn().mockResolvedValue([{ ok: 1 }]) } as never,
    { ping: vi.fn().mockResolvedValue('PONG') } as never,
  ] as const;
  /** Un proceso nuevo: build-info se vuelve a leer (en el API, una vez al arrancar). */
  const boot = async () => {
    vi.resetModules();
    const { HealthController: Fresh } = await import('./health.controller');
    return new Fresh(...deps);
  };
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nightpay-health-'));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('con build-info.json: su commit o su huella, y BUILD_MARKER si se puso', async () => {
    const path = join(dir, 'build-info.json');
    writeFileSync(path, JSON.stringify({ gitSha: '3ea5019', sourceDigest: 'f'.repeat(64), builtAt: '2026-10-22T08:00:00.000Z' }));
    vi.stubEnv('BUILD_INFO_PATH', path);
    vi.stubEnv('BUILD_MARKER', 'plataforma-2026-10-15');
    const result = await (await boot()).get();
    expect(result).toMatchObject({ version: '3ea5019', build: 'plataforma-2026-10-15', sourceDigest: 'f'.repeat(64), builtAt: '2026-10-22T08:00:00.000Z' });
  });

  it('el fichero se lee al arrancar: cambiarlo después no cambia lo que dice /v1/health', async () => {
    const path = join(dir, 'build-info.json');
    writeFileSync(path, JSON.stringify({ gitSha: null, sourceDigest: 'a'.repeat(64) }));
    vi.stubEnv('BUILD_INFO_PATH', path);
    vi.stubEnv('BUILD_MARKER', '');
    const controller = await boot();
    writeFileSync(path, JSON.stringify({ gitSha: 'b'.repeat(40), sourceDigest: 'b'.repeat(64) }));
    for (const result of [await controller.get(), await controller.get()]) {
      expect(result).toMatchObject({ version: `source:${'a'.repeat(64)}`, build: `source:${'a'.repeat(12)}` });
    }
  });

  it('sin metadatos no anuncia una versión ni la marca antigua (revision3-…)', async () => {
    vi.stubEnv('GIT_SHA', '');
    vi.stubEnv('BUILD_MARKER', '');
    vi.stubEnv('npm_package_version', '1.2.3');
    vi.stubEnv('BUILD_INFO_PATH', join(dir, 'no-existe.json'));
    const result = await (await boot()).get();
    expect(result.version).toBe('unknown');
    expect(result.build).toBe('unknown');
    expect(JSON.stringify(result)).not.toContain('revision3');
  });
});
