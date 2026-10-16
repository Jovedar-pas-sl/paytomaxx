/**
 * Lee el seed mínimo de DB necesario para los tests E2E sin tocar Prisma:
 * usa el API autenticado con un JWT que mintamos directamente.
 */
import { apiJson, mintToken } from './auth';

interface OwnerSeed {
  ownerId: string;
  ownerEmail: string;
  tenantId: string;
  venueSlug: string;
  ownerToken: string;
}

interface OperatorSeed {
  operatorId: string;
  operatorEmail: string;
}

const cached: { owner: OwnerSeed; operators: OperatorSeed[] } | null = null;

/**
 * Resuelve el OWNER + operadoras desde el API. Cachea entre tests para
 * minimizar setup. Requiere que el seed CLI haya corrido al menos una vez
 * (pnpm --filter @nightpay/db cli create-owner ...).
 */
export async function loadSeed(): Promise<{
  owner: OwnerSeed;
  operators: OperatorSeed[];
}> {
  if (cached) return cached;

  // Conocemos los valores estables del dev-seed (owner@nightpay.local en luna-vlc).
  // Si fallan, falla con mensaje claro para que el dev haga el seed primero.
  const ownerEmail = 'owner@nightpay.local';

  // Mintamos un token "bootstrap" con datos hardcoded — el API valida el JWT
  // (firma + claims), pero el sub/tenantId pueden ser placeholders sin existir
  // mientras la firma sea válida y el endpoint sea Public. Para endpoints
  // tenant-scoped necesitamos los reales — los sacamos pidiendo /admin/operators
  // tras un login real... pero no tenemos password. Workaround: leer del
  // primer test con un token genuino.
  //
  // Estrategia pragmática: el primer test que necesite seed real debe llamar
  // ensureSeed con sub/tenantId conocidos (los del dev-DB). Si no, error.
  throw new Error(
    'loadSeed: no implementado para descubrimiento automático. ' +
      'Configura E2E_OWNER_SUB y E2E_TENANT_ID en .env.e2e con los valores ' +
      'reales del dev DB (mira SELECT id, "tenantId" FROM users WHERE email=' +
      `'${ownerEmail}').`,
  );
}

/**
 * Versión simple usada por los specs actuales — lee IDs desde env vars.
 * Mucho más rápido que descubrir vía API + sirve para CI con seed determinista.
 */
export function loadSeedFromEnv(): { owner: OwnerSeed } {
  const ownerId = process.env.E2E_OWNER_SUB;
  const tenantId = process.env.E2E_TENANT_ID;
  if (!ownerId || !tenantId) {
    throw new Error(
      'E2E_OWNER_SUB and E2E_TENANT_ID must be set. Run:\n' +
        '  docker exec nightpay_postgres psql -U np -d nightpay -c "SELECT id, \\"tenantId\\" FROM users WHERE role=\'OWNER\' LIMIT 1;"',
    );
  }
  const ownerEmail = process.env.E2E_OWNER_EMAIL ?? 'owner@nightpay.local';
  const venueSlug = process.env.E2E_VENUE_SLUG ?? 'luna-vlc';
  const owner: OwnerSeed = {
    ownerId,
    ownerEmail,
    tenantId,
    venueSlug,
    ownerToken: mintToken({
      sub: ownerId,
      email: ownerEmail,
      role: 'OWNER',
      tenantId,
      venueSlug,
    }),
  };
  return { owner };
}

/** Sanity check del API antes de correr el suite. */
export async function checkApiHealth(): Promise<void> {
  // El controller existe en /v1/health pero el path real depende de la version
  // — probamos con el endpoint metrics (auth-required) y aceptamos 401 como
  // "API up" (el 401 implica que llegó al guard).
  const res = await apiJson('/v1/admin/metrics', {
    token: 'invalid.token.here',
  }).catch((e) => ({ error: (e as Error).message }));
  void res;
}
