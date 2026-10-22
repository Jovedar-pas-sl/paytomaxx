import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const sha = (value: unknown): string | undefined => typeof value === 'string' && /^[a-f0-9]{7,40}$/i.test(value) ? value : undefined;

/** Read-only metadata baked into the image, never a mutable package version. */
export function deployedBuild(): { version: string; build: string; sourceDigest?: string; builtAt?: string } {
  let info: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(process.env.BUILD_INFO_PATH ?? resolve(process.cwd(), 'build-info.json'), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) info = parsed as Record<string, unknown>;
  } catch { /* Explicitly unknown in unbuilt local checkouts. */ }
  const sourceDigest = typeof info.sourceDigest === 'string' && /^[a-f0-9]{64}$/.test(info.sourceDigest) ? info.sourceDigest : undefined;
  const builtAt = typeof info.builtAt === 'string' && Number.isFinite(Date.parse(info.builtAt)) ? info.builtAt : undefined;
  return {
    version: sha(info.gitSha) ?? (sourceDigest ? `source:${sourceDigest}` : sha(process.env.GIT_SHA) ?? 'unknown'),
    build: text(process.env.BUILD_MARKER) ?? (sourceDigest ? `source:${sourceDigest.slice(0, 12)}` : 'unknown'),
    ...(sourceDigest ? { sourceDigest } : {}),
    ...(builtAt ? { builtAt } : {}),
  };
}
