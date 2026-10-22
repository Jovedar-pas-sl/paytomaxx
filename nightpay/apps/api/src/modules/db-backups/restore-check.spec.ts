import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('restore-check command with fake PostgreSQL tools', () => {
  it('rejects partial restores, protects existing databases and cleans up temporary containers', () => {
    const bash = process.platform === 'win32' && existsSync('C:/Program Files/Git/bin/bash.exe')
      ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
    const result = spawnSync(bash, ['scripts/restore-check.test.sh'], {
      cwd: resolve(__dirname, '../../../../..'), encoding: 'utf8', timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.stdout + result.stderr).not.toContain('FAIL');
    expect(result.status).toBe(0);
  }, 35_000);
});
