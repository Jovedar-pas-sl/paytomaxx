import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { deployedBuild } from './build-info';

vi.mock('node:fs', () => ({ readFileSync: vi.fn() }));
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });
describe('baked deployment identity', () => {
  it('uses the automatic source fingerprint when Docker has no commit and ignores a stale runtime SHA', () => {
    vi.stubEnv('GIT_SHA', '1234567');
    vi.stubEnv('BUILD_MARKER', '');
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ gitSha: null, sourceDigest: 'a'.repeat(64), builtAt: '2026-10-22T08:00:00.000Z' }));
    expect(deployedBuild()).toEqual({ version: `source:${'a'.repeat(64)}`, build: `source:${'a'.repeat(12)}`, sourceDigest: 'a'.repeat(64), builtAt: '2026-10-22T08:00:00.000Z' });
  });
  it('reports a commit supplied at build time and rejects corrupt metadata', () => {
    vi.stubEnv('GIT_SHA', '');
    vi.stubEnv('BUILD_MARKER', '');
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ gitSha: 'b'.repeat(40), sourceDigest: 'a'.repeat(64) }));
    expect(deployedBuild().version).toBe('b'.repeat(40));
    vi.mocked(readFileSync).mockReturnValue('not JSON');
    expect(deployedBuild()).toEqual({ version: 'unknown', build: 'unknown' });
    for (const invalid of ['null', '[]', '123', '"text"']) {
      vi.mocked(readFileSync).mockReturnValue(invalid);
      expect(deployedBuild()).toEqual({ version: 'unknown', build: 'unknown' });
    }
  });
});
