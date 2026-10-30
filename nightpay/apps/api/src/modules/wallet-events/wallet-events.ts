import type { ChargeRequestStatus } from '../wallets/wallet-rules';

/**
 * «Saldo al momento»: avisos de que un saldo o un cobro del saldo cambió,
 * para no preguntar cada pocos segundos.
 *
 * Fuente: los triggers de Postgres de la migración 20261102100000_saldo_al_momento
 * hacen pg_notify en este canal cuando cambia un saldo (client_wallets:
 * saldo, estado, «Me voy», PIN, enlace…), una devolución del saldo
 * (wallet_payouts) o el estado de un cobro del saldo (wallet_charge_requests).
 * Postgres solo los entrega al hacer COMMIT (un cobro deshecho no avisa) y a
 * TODAS las conexiones que escuchan: cada réplica del API escucha con una
 * (WalletEventsListener) y reparte a lo suyo (sus páginas abiertas por SSE y
 * sus sockets del personal). Así ningún camino que escriba se escapa: cobros,
 * recargas, devoluciones, fusiones, la consola o un UPDATE a mano.
 *
 * El mensaje es corto y sin datos del cliente:
 *   w:<id del saldo>              → la página de ese saldo vuelve a pedir su estado
 *   c:<id del cobro>:<estado>     → la app del personal vuelve a pedir ese cobro
 */
export const WALLET_EVENTS_CHANNEL = 'np_wallet_events';

export type WalletEvent =
  | { kind: 'wallet'; walletId: string }
  | { kind: 'charge'; chargeId: string; status: ChargeRequestStatus };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHARGE_STATUSES: ReadonlySet<string> = new Set<ChargeRequestStatus>(['PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELED']);

/** El aviso del trigger; null si no tiene la forma (se ignora). */
export function parseWalletEvent(payload: unknown): WalletEvent | null {
  if (typeof payload !== 'string') return null;
  const parts = payload.split(':');
  const id = parts[1] ?? '';
  if (!UUID_RE.test(id)) return null;
  if (parts[0] === 'w' && parts.length === 2) return { kind: 'wallet', walletId: id.toLowerCase() };
  if (parts[0] === 'c' && parts.length === 3 && CHARGE_STATUSES.has(parts[2] ?? '')) {
    return { kind: 'charge', chargeId: id.toLowerCase(), status: parts[2] as ChargeRequestStatus };
  }
  return null;
}

/** Parámetros de DATABASE_URL que solo entiende Prisma (el driver de Postgres no). */
const PRISMA_ONLY_PARAMS = [
  'connection_limit',
  'pool_timeout',
  'pgbouncer',
  'schema',
  'statement_cache_size',
  'socket_timeout',
  'connect_timeout',
  'sslaccept',
  'sslidentity',
  'sslpassword',
  'single_use_connections',
] as const;

/** Nombre de la conexión en pg_stat_activity: se ve quién escucha. */
export const LISTENER_APPLICATION_NAME = 'oxiopay-avisos-saldo';

/** La URL de la base para la conexión del LISTEN: sin lo de Prisma y con su nombre. */
export function listenerConnectionString(url: string): string {
  const u = new URL(url);
  for (const key of PRISMA_ONLY_PARAMS) u.searchParams.delete(key);
  if (!u.searchParams.has('application_name')) u.searchParams.set('application_name', LISTENER_APPLICATION_NAME);
  return u.toString();
}
