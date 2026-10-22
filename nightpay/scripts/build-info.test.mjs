import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildInfo } from './build-info.mjs';

test('automatic source identity survives line endings; code changes alter it, secrets and generated files do not', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nightpay-build-info-'));
  try {
    await mkdir(join(root, 'apps/api/src'), { recursive: true });
    await mkdir(join(root, 'packages/db/src/generated'), { recursive: true });
    const source = join(root, 'apps/api/src/main.ts');
    const dockerfile = join(root, 'apps/api/Dockerfile');
    await writeFile(source, 'export const value = 1;\n');
    await writeFile(dockerfile, 'FROM node\n');
    const first = buildInfo(root, { gitSha: '', detectGit: false });
    assert.equal(first.gitSha, null);
    assert.match(first.sourceDigest, /^[a-f0-9]{64}$/);
    await writeFile(source, 'export const value = 1;\r\n');
    await writeFile(dockerfile, 'FROM node\r\n');
    await writeFile(join(root, 'apps/api/.env'), 'SECRET=never-hash-me');
    await writeFile(join(root, 'packages/db/src/generated/client.ts'), 'generated');
    assert.equal(buildInfo(root, { detectGit: false }).sourceDigest, first.sourceDigest);
    await writeFile(source, 'export const value = 2;\n');
    assert.notEqual(buildInfo(root, { detectGit: false }).sourceDigest, first.sourceDigest);
    assert.equal(buildInfo(root, { gitSha: 'a'.repeat(40), detectGit: false }).gitSha, 'a'.repeat(40));
    assert.equal(buildInfo(root, { gitSha: 'not-a-commit', detectGit: false }).gitSha, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('does not claim the last commit when the working source is modified', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nightpay-build-info-git-'));
  try {
    await mkdir(join(root, 'apps/api/src'), { recursive: true });
    const source = join(root, 'apps/api/src/main.ts');
    await writeFile(source, 'initial');
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init'); git('add', '.');
    git('-c', 'user.name=Build test', '-c', 'user.email=build@isolated.test', 'commit', '-m', 'fixture');
    assert.equal(buildInfo(root).gitSha, git('rev-parse', 'HEAD'));
    await writeFile(source, 'changed');
    assert.equal(buildInfo(root).gitSha, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});
