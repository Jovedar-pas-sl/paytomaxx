import { clientIp, normalizeIp, type ClientIpRequest } from './client-ip';

/** Límite global por IP (@fastify/rate-limit). Lo sensible tiene además su @IpRateLimit. */
export const GLOBAL_RATE_LIMIT_MAX = 100;
export const GLOBAL_RATE_LIMIT_WINDOW = '1 minute';

const HEALTH_PATHS = ['/v1/health', '/v1/health/live'];
/** La página del saldo consulta su estado cada pocos segundos: va con su propio @IpRateLimit. */
const WALLET_STATE_POLL = /^\/w\/[^/]+\/state(\?|$)/;
/**
 * Las páginas de /pay (pago, «Comprobando» que se refresca cada 3-5 s, vuelta
 * del banco, formulario y justificante): con el wifi del local muchos clientes
 * comparten IP y el límite global les cortaba el pago con un JSON. Van con su
 * @IpRateLimit holgado y, si se pasa, una página que espera (PayPageFilter).
 */
const PAY_PAGES = /^\/pay\/[^/?]+(\/(checkout|receipt))?(\?|$)/;
const LOOPBACK = new Set(['127.0.0.1', '::1']);

interface LimitedRequest extends ClientIpRequest {
  method: string;
  url: string;
}

/**
 * Fuera del límite global: el sondeo del saldo, las páginas GET de /pay y el healthcheck del propio
 * contenedor. Antes, todo lo que llegaba por loopback quedaba exento: con un
 * proxy en la misma máquina (p. ej. un túnel de Cloudflare) no habría límite.
 */
export function isGlobalRateLimitExempt(req: LimitedRequest): boolean {
  if (req.method === 'GET' && (WALLET_STATE_POLL.test(req.url) || PAY_PAGES.test(req.url))) return true;
  const peer = normalizeIp(req.raw?.socket?.remoteAddress ?? req.socket?.remoteAddress);
  const path = req.url.split('?')[0] ?? req.url;
  return peer !== null && LOOPBACK.has(peer) && HEALTH_PATHS.includes(path);
}

/** Misma IP de fiar que el login y los @IpRateLimit (ver client-ip.ts). */
export function globalRateLimitKey(req: LimitedRequest): string {
  return clientIp(req) ?? 'desconocida';
}
