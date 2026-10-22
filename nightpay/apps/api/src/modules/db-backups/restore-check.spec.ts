import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Git Bash en Windows arranca procesos despacio (y la suite corre en paralelo): margen amplio.
const SCRIPT_TIMEOUT_MS = 120_000;

describe('restore-check con psql, pg_restore y docker de mentira (scripts/restore-check.test.sh)', () => {
  it('rechaza restauraciones a medias, migraciones que faltan y copias incoherentes; no restaura encima de una base con datos', () => {
    const bash = process.platform === 'win32' && existsSync('C:/Program Files/Git/bin/bash.exe')
      ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
    const result = spawnSync(bash, ['scripts/restore-check.test.sh'], {
      cwd: resolve(__dirname, '../../../../..'), encoding: 'utf8', timeout: SCRIPT_TIMEOUT_MS,
    });
    expect(result.error).toBeUndefined();
    const output = result.stdout + result.stderr;
    expect(output).not.toContain('FAIL');
    expect(output.match(/^PASS /gm)?.length ?? 0).toBeGreaterThanOrEqual(11);
    expect(result.status).toBe(0);
  }, SCRIPT_TIMEOUT_MS + 5_000);
});
