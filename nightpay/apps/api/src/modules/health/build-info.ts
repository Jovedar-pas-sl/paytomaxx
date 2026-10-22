import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Qué código corre: lo grabó scripts/build-info.mjs al construir la imagen
 * (apps/api/build-info.json, ver el Dockerfile) y /v1/health lo enseña.
 *
 *  - version: el commit si se pasó al construir (GIT_SHA o
 *    DOKPLOY_COMMIT_HASH como Build Arg); si no, `source:<huella>` del código
 *    construido (la misma huella que da `node scripts/build-info.mjs --print`
 *    en una copia limpia de ese commit). Sin fichero (desarrollo), el GIT_SHA
 *    del entorno o `unknown`: nunca una marca fija que parezca otra versión.
 *  - build: BUILD_MARKER si se puso (opcional); si no, la huella corta.
 */
export interface DeployedBuild {
  version: string;
  build: string;
  sourceDigest?: string;
  builtAt?: string;
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const sha = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[a-f0-9]{7,40}$/i.test(value.trim()) ? value.trim().toLowerCase() : undefined;

/** Lee build-info.json y el entorno. Para el API, deployedBuild() (una vez al arrancar). */
export function readDeployedBuild(env: NodeJS.ProcessEnv = process.env): DeployedBuild {
  let info: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(env.BUILD_INFO_PATH ?? resolve(process.cwd(), 'build-info.json'), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) info = parsed as Record<string, unknown>;
  } catch {
    /* Sin construir (desarrollo, pruebas) o ilegible: explícitamente desconocido. */
  }
  const sourceDigest = typeof info.sourceDigest === 'string' && /^[a-f0-9]{64}$/.test(info.sourceDigest) ? info.sourceDigest : undefined;
  const builtAt = typeof info.builtAt === 'string' && Number.isFinite(Date.parse(info.builtAt)) ? info.builtAt : undefined;
  // Con fichero, manda lo que se grabó al construir: un GIT_SHA puesto a mano
  // en el entorno de ejecución puede ser de otro despliegue.
  const version = sha(info.gitSha) ?? (sourceDigest ? `source:${sourceDigest}` : (sha(env.GIT_SHA) ?? 'unknown'));
  return {
    version,
    build: text(env.BUILD_MARKER) ?? (sourceDigest ? `source:${sourceDigest.slice(0, 12)}` : 'unknown'),
    ...(sourceDigest ? { sourceDigest } : {}),
    ...(builtAt ? { builtAt } : {}),
  };
}

let atBoot: DeployedBuild | undefined;

/** La identidad de este proceso: se lee la primera vez (al arrancar) y no cambia. */
export function deployedBuild(): DeployedBuild {
  atBoot ??= readDeployedBuild();
  return atBoot;
}
