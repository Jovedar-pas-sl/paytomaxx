import { describe, it, expect } from 'vitest';
import {
  clientIp,
  isCloudflareAddress,
  isInternalAddress,
  markOriginVerified,
  ipPrefixKey,
  normalizeIp,
  rateLimitIpKey,
  trustInternalProxy,
} from './client-ip';

const TRAEFIK = '10.0.1.7';
const CF_EDGE = '172.70.1.2'; // 172.64.0.0/13
const CLIENTE = '81.0.0.7';

function req(peer: string | undefined, headers: Record<string, string> = {}) {
  return { headers, raw: { socket: { remoteAddress: peer } } };
}

describe('normalizeIp / rangos', () => {
  it('quita el prefijo IPv4-mapped y descarta lo que no es una IP', () => {
    expect(normalizeIp('::ffff:10.0.0.1')).toBe('10.0.0.1');
    expect(normalizeIp(' 2606:4700::1 ')).toBe('2606:4700::1');
    expect(normalizeIp('no-es-ip')).toBeNull();
    expect(normalizeIp(undefined)).toBeNull();
  });

  it('red interna (Docker/loopback) vs internet', () => {
    expect(isInternalAddress('10.0.1.7')).toBe(true);
    expect(isInternalAddress('172.18.0.3')).toBe(true);
    expect(isInternalAddress('192.168.1.10')).toBe(true);
    expect(isInternalAddress('127.0.0.1')).toBe(true);
    expect(isInternalAddress('::1')).toBe(true);
    expect(isInternalAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isInternalAddress('fd00::5')).toBe(true);
    expect(isInternalAddress('81.0.0.7')).toBe(false);
    expect(isInternalAddress('172.70.1.2')).toBe(false);
  });

  it('rangos publicados de Cloudflare', () => {
    expect(isCloudflareAddress('172.70.1.2')).toBe(true);
    expect(isCloudflareAddress('104.16.5.5')).toBe(true);
    expect(isCloudflareAddress('2a06:98c1::1')).toBe(true);
    expect(isCloudflareAddress('81.0.0.7')).toBe(false);
    expect(isCloudflareAddress('10.0.0.1')).toBe(false);
  });

  it('Fastify solo se fía de cabeceras de proxy que vienen de la red interna', () => {
    expect(trustInternalProxy(TRAEFIK)).toBe(true);
    expect(trustInternalProxy(CF_EDGE)).toBe(false);
    expect(trustInternalProxy(CLIENTE)).toBe(false);
  });
});

describe('clientIp (la IP con la que se cuentan límites e intentos)', () => {
  it('conexión directa desde internet: la del socket, aunque traiga cabeceras inventadas', () => {
    expect(clientIp(req(CLIENTE, { 'cf-connecting-ip': '9.9.9.9', 'x-forwarded-for': '8.8.8.8' }))).toBe(CLIENTE);
  });

  it('Cloudflare → Traefik: CF-Connecting-IP, porque el último salto (lo añade Traefik) es de Cloudflare', () => {
    const r = req(TRAEFIK, { 'cf-connecting-ip': CLIENTE, 'x-forwarded-for': `1.2.3.4, ${CLIENTE}, ${CF_EDGE}` });
    expect(clientIp(r)).toBe(CLIENTE);
  });

  it('directo a la IP del servidor (saltándose Cloudflare): CF-Connecting-IP inventada no cuenta', () => {
    const r = req(TRAEFIK, { 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': `5.5.5.5, ${CLIENTE}` });
    expect(clientIp(r)).toBe(CLIENTE);
  });

  it('con la cabecera de origen de Cloudflare verificada se cree a CF-Connecting-IP', () => {
    const r = req(TRAEFIK, { 'cf-connecting-ip': CLIENTE, 'x-forwarded-for': '203.0.113.9' });
    markOriginVerified(r);
    expect(clientIp(r)).toBe(CLIENTE);
  });

  it('tráfico interno sin proxy (healthcheck, scrape): la del socket', () => {
    expect(clientIp(req('127.0.0.1'))).toBe('127.0.0.1');
    expect(clientIp(req('::ffff:10.0.0.9'))).toBe('10.0.0.9');
  });

  it('X-Forwarded-For con varios valores en cabeceras repetidas: cuenta el último', () => {
    const r = { headers: { 'x-forwarded-for': ['6.6.6.6', `7.7.7.7, ${CLIENTE}`] }, raw: { socket: { remoteAddress: TRAEFIK } } };
    expect(clientIp(r)).toBe(CLIENTE);
  });

  it('sin socket (no debería pasar): la IP que calculó Fastify', () => {
    expect(clientIp({ headers: {}, ip: '203.0.113.5' })).toBe('203.0.113.5');
    expect(clientIp({ headers: {} })).toBeNull();
  });

  it('acepta también la petición de Fastify con socket directo', () => {
    expect(clientIp({ headers: {}, socket: { remoteAddress: CLIENTE } })).toBe(CLIENTE);
  });
});

describe('rateLimitIpKey (la clave de los límites por IP)', () => {
  it('IPv4 tal cual (también la que llega como ::ffff:)', () => {
    expect(rateLimitIpKey('203.0.113.7')).toBe('203.0.113.7');
    expect(rateLimitIpKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('IPv6: todo el /64 es una sola clave (cualquier conexión tiene 2^64 direcciones para rotar)', () => {
    const a = rateLimitIpKey('2001:db8:abcd:12::1');
    expect(a).toBe('2001:db8:abcd:12::/64');
    expect(rateLimitIpKey('2001:0db8:abcd:0012:ffff:eeee:dddd:cccc')).toBe(a);
    expect(rateLimitIpKey('2001:db8:abcd:13::1')).not.toBe(a);
  });

  it('lo que no es una IP, tal cual', () => {
    expect(rateLimitIpKey('desconocida')).toBe('desconocida');
  });
});

describe('ipPrefixKey (la red de una IP, para los topes)', () => {
  it('IPv6 por el prefijo pedido (/48 en los fallos de la API de socios, /64 en rateLimitIpKey); IPv4 tal cual', () => {
    expect(ipPrefixKey('2001:db8:abcd:12::1', 48)).toBe('2001:db8:abcd::/48');
    expect(ipPrefixKey('2001:db8:abcd:ffff::9', 48)).toBe('2001:db8:abcd::/48');
    expect(ipPrefixKey('2001:db8:abcd:12::1', 64)).toBe(rateLimitIpKey('2001:db8:abcd:12::1'));
    expect(ipPrefixKey('203.0.113.7', 48)).toBe('203.0.113.7');
    expect(ipPrefixKey('::ffff:203.0.113.7', 48)).toBe('203.0.113.7');
  });
});
