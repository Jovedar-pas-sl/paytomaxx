import dns from 'node:dns';
import https from 'node:https';
import type http from 'node:http';
import { GatewayTransientError } from '../gateways/gateway-errors';
import { BTCPAY_URL_MESSAGES, isForbiddenIp, parseBtcpayUrl, type BtcpayUrlErrorCode } from './btcpay-url';

/**
 * La única puerta por la que el API llama a un BTCPay. La dirección la escribe
 * el dueño del local, así que cada llamada:
 *  - vuelve a validar la URL guardada (solo https, puerto 443, sin usuario);
 *  - resuelve el nombre y rechaza si ALGUNA dirección es privada, de loopback,
 *    link-local, CGNAT, multicast, reservada o la de metadatos de la nube;
 *  - conecta a la IP ya comprobada (no vuelve a resolver el nombre: sin DNS
 *    rebinding entre la comprobación y la conexión), con el nombre en TLS;
 *  - no sigue redirecciones, corta a los 10 s en total y a 1 MB de respuesta.
 * `fetchWithTimeout` no sirve para esto: no deja fijar la IP de la conexión.
 */

export const BTCPAY_TIMEOUT_MS = 10_000;
export const BTCPAY_MAX_RESPONSE_BYTES = 1_000_000;

export class BtcpayBlockedError extends Error {
  override readonly name = 'BtcpayBlockedError';
  constructor(readonly code: BtcpayUrlErrorCode, message?: string) {
    super(message ?? BTCPAY_URL_MESSAGES[code]);
  }
}

/** Respuesta que no se acepta (redirección, demasiado grande): no se arregla repitiendo. */
export class BtcpayResponseError extends Error {
  override readonly name = 'BtcpayResponseError';
}

export interface BtcpayHttpRequest {
  /** https://dominio (el de la base; se vuelve a validar aquí). */
  origin: string;
  /** Empieza por «/» y no cambia de servidor. */
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers: Record<string, string>;
  body?: string;
}

export interface BtcpayHttpResponse {
  status: number;
  body: Buffer;
}

export abstract class BtcpayNet {
  /** La misma comprobación de la URL y del DNS que hace cada llamada, para el guardado. */
  abstract checkHost(origin: string): Promise<void>;
  abstract request(req: BtcpayHttpRequest): Promise<BtcpayHttpResponse>;
}

export interface SafeNetOptions {
  resolve?: (host: string) => Promise<string[]>;
  timeoutMs?: number;
  maxBytes?: number;
  // Solo para las pruebas (servidor http local): en producción, https:443.
  transport?: Pick<typeof https, 'request'> | Pick<typeof http, 'request'>;
  port?: number;
  connectAddress?: (resolvedIp: string) => string;
}

const SAFE_PATH_RE = /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/?]*$/;

async function systemResolve(host: string): Promise<string[]> {
  const found = await dns.promises.lookup(host, { all: true, verbatim: true });
  return found.map((a) => a.address);
}

export class SafeBtcpayNet extends BtcpayNet {
  private readonly resolve: (host: string) => Promise<string[]>;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly transport: Pick<typeof https, 'request'> | Pick<typeof http, 'request'>;
  private readonly port: number;
  private readonly connectAddress: (ip: string) => string;

  constructor(opts: SafeNetOptions = {}) {
    super();
    this.resolve = opts.resolve ?? systemResolve;
    this.timeoutMs = opts.timeoutMs ?? BTCPAY_TIMEOUT_MS;
    this.maxBytes = opts.maxBytes ?? BTCPAY_MAX_RESPONSE_BYTES;
    this.transport = opts.transport ?? https;
    this.port = opts.port ?? 443;
    this.connectAddress = opts.connectAddress ?? ((ip) => ip);
  }

  async checkHost(origin: string): Promise<void> {
    await this.publicAddress(origin);
  }

  async request(req: BtcpayHttpRequest): Promise<BtcpayHttpResponse> {
    if (!SAFE_PATH_RE.test(req.path) || req.path.startsWith('//')) throw new BtcpayBlockedError('INVALID');
    const { host, ip } = await this.publicAddress(req.origin);
    return this.send(req, host, ip);
  }

  /** URL válida + todas las direcciones del nombre públicas. Devuelve la primera, ya comprobada. */
  private async publicAddress(origin: string): Promise<{ host: string; ip: string }> {
    const parsed = parseBtcpayUrl(origin);
    if (!parsed.ok) throw new BtcpayBlockedError(parsed.code);
    let addresses: string[];
    try {
      addresses = await this.resolve(parsed.host);
    } catch {
      throw new BtcpayBlockedError('NO_ADDRESS');
    }
    const first = addresses[0];
    if (!first) throw new BtcpayBlockedError('NO_ADDRESS');
    if (addresses.some(isForbiddenIp)) throw new BtcpayBlockedError('PRIVATE_ADDRESS');
    return { host: parsed.host, ip: first };
  }

  private send(req: BtcpayHttpRequest, host: string, ip: string): Promise<BtcpayHttpResponse> {
    const family = ip.includes(':') ? 6 : 4;
    const target = this.connectAddress(ip);
    return new Promise<BtcpayHttpResponse>((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const clientReq = (this.transport.request as typeof https.request)(
        {
          host,
          port: this.port,
          method: req.method,
          path: req.path,
          headers: { ...req.headers, ...(req.body !== undefined ? { 'Content-Length': String(Buffer.byteLength(req.body)) } : {}), Accept: 'application/json' },
          agent: false,
          servername: host,
          // La conexión va a la IP comprobada; el nombre solo viaja en TLS y en Host.
          lookup: (_name: string, options: unknown, cb: (...args: unknown[]) => void) => {
            const wantsAll = typeof options === 'object' && options !== null && (options as { all?: boolean }).all === true;
            if (wantsAll) cb(null, [{ address: target, family }]);
            else cb(null, target, family);
          },
        } as https.RequestOptions,
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            done(() => reject(new BtcpayResponseError(`BTCPay contestó con una redirección (${status}): no se sigue`)));
            res.destroy();
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > this.maxBytes) {
              done(() => reject(new BtcpayResponseError(`La respuesta de BTCPay pasa de ${this.maxBytes} bytes`)));
              res.destroy();
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => done(() => resolve({ status, body: Buffer.concat(chunks) })));
          res.on('error', (err) => done(() => reject(new GatewayTransientError(`BTCPay: ${err.message}`))));
          res.on('aborted', () => done(() => reject(new GatewayTransientError('BTCPay cortó la respuesta'))));
        },
      );
      // Tiempo TOTAL de la llamada (también para quien contesta gota a gota).
      const timer = setTimeout(() => {
        clientReq.destroy();
        done(() => reject(new GatewayTransientError(`BTCPay no contestó en ${this.timeoutMs} ms`)));
      }, this.timeoutMs);
      clientReq.on('error', (err) => done(() => reject(new GatewayTransientError(`BTCPay sin respuesta: ${err.message}`))));
      if (req.body !== undefined) clientReq.write(req.body);
      clientReq.end();
    });
  }
}
