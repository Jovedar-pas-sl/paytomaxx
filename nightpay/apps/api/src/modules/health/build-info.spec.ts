import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('node:fs', () => ({ readFileSync: vi.fn() }));

const DIGEST = 'a'.repeat(64);
const env = (over: Record<string, string> = {}) => ({ BUILD_INFO_PATH: '/repo/apps/api/build-info.json', ...over }) as NodeJS.ProcessEnv;
const file = (content: unknown) => vi.mocked(readFileSync).mockReturnValue(typeof content === 'string' ? content : JSON.stringify(content));

afterEach(() => {
  vi.resetAllMocks();
  vi.resetModules();
});

describe('identidad de lo construido (build-info.json de la imagen)', () => {
  it('sin commit al construir: la huella del código, aunque el entorno traiga un GIT_SHA (puede ser de otro despliegue)', async () => {
    const { readDeployedBuild } = await import('./build-info');
    file({ gitSha: null, sourceDigest: DIGEST, builtAt: '2026-10-22T08:00:00.000Z' });
    expect(readDeployedBuild(env({ GIT_SHA: '1234567' }))).toEqual({
      version: `source:${DIGEST}`,
      build: `source:${'a'.repeat(12)}`,
      sourceDigest: DIGEST,
      builtAt: '2026-10-22T08:00:00.000Z',
    });
    expect(readFileSync).toHaveBeenCalledWith('/repo/apps/api/build-info.json', 'utf8');
  });

  it('con commit al construir (GIT_SHA / DOKPLOY_COMMIT_HASH): ese; BUILD_MARKER es opcional', async () => {
    const { readDeployedBuild } = await import('./build-info');
    file({ gitSha: 'B'.repeat(40), sourceDigest: DIGEST });
    expect(readDeployedBuild(env())).toMatchObject({ version: 'b'.repeat(40), build: `source:${'a'.repeat(12)}` });
    expect(readDeployedBuild(env({ BUILD_MARKER: '  noche-viernes  ' }))).toMatchObject({ version: 'b'.repeat(40), build: 'noche-viernes' });
  });

  it('sin fichero (desarrollo): el GIT_SHA del entorno o «unknown», nunca una marca fija antigua', async () => {
    const { readDeployedBuild } = await import('./build-info');
    vi.mocked(readFileSync).mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    expect(readDeployedBuild(env({ GIT_SHA: '3ea5019' }))).toEqual({ version: '3ea5019', build: 'unknown' });
    expect(readDeployedBuild(env())).toEqual({ version: 'unknown', build: 'unknown' });
    expect(readDeployedBuild(env({ GIT_SHA: 'revision3-2026-10-20' }))).toEqual({ version: 'unknown', build: 'unknown' });
  });

  it('fichero roto o con valores que no son lo que dicen: desconocido', async () => {
    const { readDeployedBuild } = await import('./build-info');
    for (const bad of ['not JSON', 'null', '[]', '123', '"text"', { gitSha: 'no-es-un-commit', sourceDigest: 'corta', builtAt: 'ayer' }]) {
      file(bad);
      expect(readDeployedBuild(env())).toEqual({ version: 'unknown', build: 'unknown' });
    }
  });

  it('deployedBuild: se lee una vez (al arrancar) y después no se vuelve a abrir el fichero', async () => {
    const { deployedBuild } = await import('./build-info');
    file({ gitSha: 'c'.repeat(40), sourceDigest: DIGEST });
    const first = deployedBuild();
    file({ gitSha: 'd'.repeat(40), sourceDigest: DIGEST });
    expect(deployedBuild()).toBe(first);
    expect(deployedBuild().version).toBe('c'.repeat(40));
    expect(readFileSync).toHaveBeenCalledTimes(1);
  });
});
