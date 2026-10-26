import { BlockList, isIP, isIPv4, isIPv6 } from 'node:net';

/**
 * La IP real del cliente, con la que se cuentan los límites de peticiones y
 * los intentos de login / PIN / códigos de saldo.
 *
 * Camino en producción: cliente → Cloudflare → Traefik (Dokploy) → API. El
 * socket del API es Traefik (red interna de Docker) y Traefik AÑADE al final
 * de X-Forwarded-For la IP que le conectó: ese último salto no lo puede
 * inventar el cliente. CF-Connecting-IP (la IP del cliente según Cloudflare)
 * solo vale si la petición pasó de verdad por Cloudflare:
 *  - la cabecera X-Origin-Auth era correcta (ORIGIN_AUTH_SECRET, ver
 *    origin-guard.ts y main.ts), o
 *  - el último salto es una IP de Cloudflare (rangos publicados).
 * Si no, quien habla directo con el servidor podría poner la IP que quisiera
 * en cada intento y no llenar nunca el contador; entonces cuenta el último
 * salto (su IP real).
 */

/** https://www.cloudflare.com/ips-v4/ y /ips-v6/ (revisados el 2026-10-15). */
const CLOUDFLARE_V4 = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
];
const CLOUDFLARE_V6 = [
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];
/** Red interna: loopback, redes privadas (Docker) y link-local. */
const INTERNAL_V4 = ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16'];
const INTERNAL_V6 = ['::1/128', 'fc00::/7', 'fe80::/10'];

function blockList(v4: ReadonlyArray<string>, v6: ReadonlyArray<string>): BlockList {
  const list = new BlockList();
  for (const cidr of v4) addCidr(list, cidr, 'ipv4');
  for (const cidr of v6) addCidr(list, cidr, 'ipv6');
  return list;
}

function addCidr(list: BlockList, cidr: string, type: 'ipv4' | 'ipv6'): void {
  const [net, prefix] = cidr.split('/');
  list.addSubnet(net!, Number(prefix), type);
}

const CLOUDFLARE = blockList(CLOUDFLARE_V4, CLOUDFLARE_V6);
const INTERNAL = blockList(INTERNAL_V4, INTERNAL_V6);

/** IP limpia (sin prefijo ::ffff: de IPv4 en IPv6) o null si no es una IP. */
export function normalizeIp(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(trimmed);
  const ip = mapped ? mapped[1]! : trimmed;
  return isIP(ip) === 0 ? null : ip;
}

function inList(list: BlockList, value: string | undefined | null): boolean {
  const ip = normalizeIp(value);
  if (!ip) return false;
  return list.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4');
}

export function isInternalAddress(value: string | undefined | null): boolean {
  return inList(INTERNAL, value);
}

export function isCloudflareAddress(value: string | undefined | null): boolean {
  return inList(CLOUDFLARE, value);
}

/** Para `trustProxy` de Fastify: solo se cree a las cabeceras de proxy que vienen de la red interna. */
export function trustInternalProxy(address: string): boolean {
  return isInternalAddress(address);
}

/** Peticiones con X-Origin-Auth correcta (las marca el hook de main.ts). */
const originVerified = new WeakSet<object>();

/** Clave de la petición: el IncomingMessage de Node, sea cual sea el envoltorio. */
function requestKey(req: object): object {
  const raw = (req as { raw?: unknown }).raw;
  return typeof raw === 'object' && raw !== null ? raw : req;
}

export function markOriginVerified(req: object): void {
  originVerified.add(requestKey(req));
}

export function isOriginVerified(req: object): boolean {
  return originVerified.has(requestKey(req));
}

export interface ClientIpRequest {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  socket?: { remoteAddress?: string };
  raw?: { socket?: { remoteAddress?: string } };
}

function headerValues(headers: ClientIpRequest['headers'], name: string): string[] {
  const value = headers[name];
  const list = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return list.flatMap((v) => v.split(',')).map((v) => v.trim()).filter((v) => v.length > 0);
}

export function clientIp(req: ClientIpRequest): string | null {
  const peer = normalizeIp(req.raw?.socket?.remoteAddress ?? req.socket?.remoteAddress);
  if (!peer) return normalizeIp(req.ip);
  // Sin proxy delante (dev, o alguien conectando directo): no hay cabecera fiable.
  if (!isInternalAddress(peer)) return peer;
  const hop = normalizeIp(headerValues(req.headers, 'x-forwarded-for').at(-1));
  // Tráfico interno sin proxy (healthcheck de Docker, scrape de métricas).
  if (!hop) return peer;
  const viaCloudflare = isOriginVerified(req) || isCloudflareAddress(hop);
  const cf = viaCloudflare ? normalizeIp(headerValues(req.headers, 'cf-connecting-ip')[0]) : null;
  return cf ?? hop;
}

/**
 * La clave de los límites por IP (global, @IpRateLimit, bloqueos del login).
 * En IPv6 cualquier conexión tiene al menos una red /64 entera (2^64
 * direcciones): si cada dirección contase por separado, rotando dentro de su
 * /64 se saltarían todos los topes. Se agrupa por /64; IPv4, tal cual. La IP
 * entera se sigue registrando donde se registra (logs, auditoría).
 */
export function rateLimitIpKey(ip: string): string {
  if (ip.startsWith('::ffff:') && isIPv4(ip.slice(7))) return ip.slice(7);
  const groups = ipv6Groups(ip.split('%')[0] ?? '');
  if (!groups) return ip;
  const prefix = groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16));
  return `${prefix.join(':')}::/64`;
}

/** Los 8 grupos de una IPv6 ('::' expandido), o null si no es IPv6. */
function ipv6Groups(ip: string): string[] | null {
  if (!isIPv6(ip)) return null;
  const [head = '', tail] = ip.toLowerCase().split('::');
  const left = splitGroups(head);
  if (tail === undefined) return left;
  const right = splitGroups(tail);
  const zeros = Array.from({ length: 8 - left.length - right.length }, () => '0');
  return [...left, ...zeros, ...right];
}

/** Una IPv4 al final (p. ej. 64:ff9b::1.2.3.4) ocupa dos grupos. */
function splitGroups(part: string): string[] {
  if (!part) return [];
  return part.split(':').flatMap((g) => (g.includes('.') ? ['0', '0'] : [g]));
}
