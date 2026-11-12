import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { SafeBtcpayNet, BtcpayBlockedError, BtcpayResponseError } from './btcpay-net';
import { GatewayTransientError } from '../gateways/gateway-errors';

/**
 * El cliente que llama al BTCPay del local. La prueba usa un servidor http
 * local (el de verdad es https:443 y sin red interna): `transport` y
 * `connectAddress` solo existen para esto; el resto del camino (resolver, mirar
 * TODAS las direcciones, fijar la IP, no seguir redirecciones, tamaño y tiempo)
 * es el de producción.
 */

let server: http.Server;
let port = 0;
let hits: Array<{ method?: string; url?: string; auth?: string; body: string }> = [];
let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;

beforeEach(async () => {
  hits = [];
  handler = (_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks).toString('utf8') });
      handler(req, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const PUBLIC_IP = '93.184.216.34';
function netWith(opts: { resolve?: (host: string) => Promise<string[]>; timeoutMs?: number; maxBytes?: number } = {}) {
  const resolved: string[] = [];
  const net = new SafeBtcpayNet({
    resolve: async (host) => {
      resolved.push(host);
      return (opts.resolve ?? (async () => [PUBLIC_IP]))(host);
    },
    transport: http,
    port,
    connectAddress: (ip) => (ip === PUBLIC_IP ? '127.0.0.1' : ip),
    timeoutMs: opts.timeoutMs ?? 2_000,
    maxBytes: opts.maxBytes ?? 1_000,
  });
  return { net, resolved };
}

const get = (path = '/api/v1/health') => ({ origin: 'https://pay.sala-bambu.es', path, method: 'GET' as const, headers: {} });

describe('SafeBtcpayNet', () => {
  it('llama, manda cabeceras y cuerpo y devuelve estado y texto', async () => {
    const { net } = netWith();
    const res = await net.request({
      origin: 'https://pay.sala-bambu.es',
      path: '/api/v1/stores/S1/invoices',
      method: 'POST',
      headers: { Authorization: 'token K', 'Content-Type': 'application/json' },
      body: '{"amount":"1.50"}',
    });
    expect(res.status).toBe(200);
    expect(res.body.toString('utf8')).toBe('{"ok":true}');
    expect(hits).toEqual([{ method: 'POST', url: '/api/v1/stores/S1/invoices', auth: 'token K', body: '{"amount":"1.50"}' }]);
  });

  it('resuelve el nombre en CADA llamada (no se fía de la comprobación del guardado)', async () => {
    const { net, resolved } = netWith();
    await net.request(get());
    await net.request(get());
    expect(resolved).toEqual(['pay.sala-bambu.es', 'pay.sala-bambu.es']);
  });

  it('un nombre que ahora resuelve a una IP privada se rechaza sin llegar a conectar (DNS rebinding)', async () => {
    let answer = [PUBLIC_IP];
    const { net } = netWith({ resolve: async () => answer });
    await net.request(get());
    answer = ['127.0.0.1'];
    await expect(net.request(get())).rejects.toMatchObject({ name: 'BtcpayBlockedError', code: 'PRIVATE_ADDRESS' });
    expect(hits).toHaveLength(1);
  });

  it.each([
    ['loopback', ['127.0.0.1']],
    ['metadatos de la nube', ['169.254.169.254']],
    ['red privada', ['192.168.1.20']],
    ['CGNAT', ['100.64.3.3']],
    ['IPv6 local', ['fd00::5']],
    ['una pública y otra privada (basta una mala)', [PUBLIC_IP, '10.0.0.7']],
  ])('rechaza si resuelve a %s', async (_n, ips) => {
    const { net } = netWith({ resolve: async () => ips });
    await expect(net.request(get())).rejects.toBeInstanceOf(BtcpayBlockedError);
    expect(hits).toHaveLength(0);
  });

  it('rechaza si el nombre no resuelve a nada', async () => {
    const empty = netWith({ resolve: async () => [] });
    await expect(empty.net.request(get())).rejects.toMatchObject({ code: 'NO_ADDRESS' });
    const broken = netWith({
      resolve: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    await expect(broken.net.request(get())).rejects.toMatchObject({ code: 'NO_ADDRESS' });
  });

  it('no sigue redirecciones: ni a otro sitio ni a la red interna', async () => {
    handler = (_req, res) => res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' }).end();
    const { net } = netWith();
    await expect(net.request(get())).rejects.toBeInstanceOf(BtcpayResponseError);
    expect(hits).toHaveLength(1);
  });

  it('corta una respuesta más grande que el máximo', async () => {
    handler = (_req, res) => res.writeHead(200).end('x'.repeat(5_000));
    const { net } = netWith({ maxBytes: 1_000 });
    await expect(net.request(get())).rejects.toBeInstanceOf(BtcpayResponseError);
  });

  it('acepta una respuesta justo del tamaño máximo', async () => {
    handler = (_req, res) => res.writeHead(200).end('x'.repeat(1_000));
    const { net } = netWith({ maxBytes: 1_000 });
    expect((await net.request(get())).body).toHaveLength(1_000);
  });

  it('se rinde si BTCPay no contesta a tiempo (fallo pasajero)', async () => {
    handler = () => undefined; // nunca contesta
    const { net } = netWith({ timeoutMs: 150 });
    await expect(net.request(get())).rejects.toBeInstanceOf(GatewayTransientError);
  });

  it('un servidor que contesta gota a gota también se corta con el tiempo total', async () => {
    handler = (_req, res) => {
      res.writeHead(200);
      const timer = setInterval(() => res.write('x'), 40);
      res.on('close', () => clearInterval(timer));
    };
    const { net } = netWith({ timeoutMs: 200, maxBytes: 100_000 });
    await expect(net.request(get())).rejects.toBeInstanceOf(GatewayTransientError);
  });

  it('una conexión que no se puede abrir es un fallo pasajero', async () => {
    const { net } = netWith();
    await new Promise<void>((r) => server.close(() => r()));
    await expect(net.request(get())).rejects.toBeInstanceOf(GatewayTransientError);
    server = http.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  });

  it('vuelve a mirar la URL guardada: una URL tocada en la base no se llama', async () => {
    const { net } = netWith();
    for (const origin of ['http://pay.sala-bambu.es', 'https://127.0.0.1', 'https://u:p@pay.sala-bambu.es', 'https://pay.sala-bambu.es:8443']) {
      await expect(net.request({ ...get(), origin })).rejects.toBeInstanceOf(BtcpayBlockedError);
    }
    expect(hits).toHaveLength(0);
  });

  it('el camino no puede cambiar de servidor (nada de //otro o rutas con esquema)', async () => {
    const { net } = netWith();
    for (const path of ['//evil.example/x', 'http://evil.example/x', 'api/v1/health', '/a b', '/a\r\nHost: x']) {
      await expect(net.request({ ...get(), path })).rejects.toBeInstanceOf(BtcpayBlockedError);
    }
    expect(hits).toHaveLength(0);
  });

  it('checkHost: lo mismo al guardar, sin llamar a nadie', async () => {
    const ok = netWith();
    await expect(ok.net.checkHost('https://pay.sala-bambu.es')).resolves.toBeUndefined();
    const bad = netWith({ resolve: async () => ['10.1.1.1'] });
    await expect(bad.net.checkHost('https://pay.sala-bambu.es')).rejects.toMatchObject({ code: 'PRIVATE_ADDRESS' });
    await expect(bad.net.checkHost('http://pay.sala-bambu.es')).rejects.toMatchObject({ code: 'NOT_HTTPS' });
    expect(hits).toHaveLength(0);
  });
});
