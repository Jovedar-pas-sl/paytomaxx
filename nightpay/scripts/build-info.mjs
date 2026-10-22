import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const omitted = new Set(['node_modules', 'generated', 'dist', 'coverage', 'test', 'tests', '.verification', '.next', '.turbo']);
const validSha = (value) => /^[a-f0-9]{7,40}$/i.test(value ?? '') ? value.toLowerCase() : null;

/** Identity of the API's build inputs, even when Docker has no .git directory. */
export function buildInfo(root, { gitSha, detectGit = true } = {}) {
  const hash = createHash('sha256');
  const files = [];
  function visit(path) {
    if (!existsSync(path)) return;
    for (const item of readdirSync(path, { withFileTypes: true })) {
      if (omitted.has(item.name) || item.name.startsWith('.env') || item.name === 'seed.ts') continue;
      const name = join(path, item.name);
      if (item.isDirectory()) visit(name);
      else if (item.isFile() && !/\.(?:spec|test)\.[cm]?[jt]sx?$|\.md$|\.log$|\.tsbuildinfo$/.test(item.name)) files.push(name);
    }
  }
  visit(join(root, 'apps/api/src'));
  visit(join(root, 'packages'));
  for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'apps/api/package.json', 'apps/api/tsconfig.json', 'apps/api/Dockerfile', 'scripts/build-info.mjs']) {
    const path = join(root, file);
    if (existsSync(path)) files.push(path);
  }
  const fileKey = (path) => relative(root, path).replaceAll('\\', '/');
  for (const path of files.sort((a, b) => fileKey(a) < fileKey(b) ? -1 : fileKey(a) > fileKey(b) ? 1 : 0)) {
    const name = relative(root, path).replaceAll('\\', '/');
    const bytes = readFileSync(path);
    const content = isUtf8(bytes) && !bytes.includes(0) ? Buffer.from(bytes.toString('utf8').replaceAll('\r\n', '\n')) : bytes;
    hash.update(`${Buffer.byteLength(name)}:${name}:${content.length}:`).update(content);
  }
  let revision = validSha(gitSha);
  if (!revision && detectGit) {
    try {
      const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (!git(['status', '--porcelain', '--untracked-files=normal', '--', '.'])) revision = validSha(git(['rev-parse', 'HEAD']));
    } catch { /* Docker context may omit Git metadata. */ }
  }
  return { gitSha: revision, sourceDigest: hash.digest('hex'), builtAt: new Date().toISOString() };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const info = buildInfo(root, { gitSha: process.env.GIT_SHA || process.env.DOKPLOY_COMMIT_HASH });
  if (!process.argv.includes('--print')) writeFileSync(join(root, 'apps/api/build-info.json'), JSON.stringify(info) + '\n');
  process.stdout.write(JSON.stringify(info) + '\n');
}
