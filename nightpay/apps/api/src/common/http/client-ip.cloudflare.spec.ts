import { describe, it, expect } from 'vitest';
import {
  clientIp,
  isCloudflareAddress,
  isInternalAddress,
  isOriginVerified,
  markOriginVerified,
  normalizeIp,
  trustInternalProxy,
} from './client-ip';

/** Camino de producción: cliente → Cloudflare → Traefik (10.0.1.7) → API. */
const TRAEFIK = '10.0.1.7';
const CF_EDGE_V4 = '162.158.94.21'; // 162.158.0.0/15
const CF_EDGE_V6 = '2a06:98c0:3600::103'; // 2a06:98c0::/29
const CLIENTE_V4 = '83.45.120.7'; // cliente en España
const CLIENTE_V6 = '2a0c:5a80:1f02:7700::1d';
const ATACANTE = '188.26.211.99';

type Headers = Record<string, string | string[]>;

function viaTraefik(headers: Headers, peer = TRAEFIK) {
  return { headers, raw: { socket: { remoteAddress: peer } } };
}

describe('normalizeIp — formatos raros', () => {
  it('IPv4 mapeada en IPv6 en mayúsculas o con espacios', () => {
    expect(normalizeIp('::FFFF:83.45.120.7')).toBe(CLIENTE_V4);
    expect(normalizeIp('  ::ffff:10.0.1.7  ')).toBe(TRAEFIK);
  });

  it('IP con puerto, entre corchetes, vacía o con texto → null', () => {
    expect(normalizeIp('83.45.120.7:443')).toBeNull();
    expect(normalizeIp('[2a0c:5a80::1]')).toBeNull();
    expect(normalizeIp('   ')).toBeNull();
    expect(normalizeIp('unknown')).toBeNull();
    expect(normalizeIp(null)).toBeNull();
  });
});

describe('rangos: bordes de red interna y de Cloudflare', () => {
  it('172.16.0.0/12 es interna; 172.15.x y 172.32.x no', () => {
    expect(isInternalAddress('172.16.0.0')).toBe(true);
    expect(isInternalAddress('172.31.255.255')).toBe(true);
    expect(isInternalAddress('172.15.255.255')).toBe(false);
    expect(isInternalAddress('172.32.0.1')).toBe(false);
  });

  it('link-local (169.254, fe80::) y ULA (fc00::/7) son internas; lo que no es IP, no', () => {
    expect(isInternalAddress('169.254.169.254')).toBe(true);
    expect(isInternalAddress('fe80::1')).toBe(true);
    expect(isInternalAddress('fc00::7')).toBe(true);
    expect(isInternalAddress('no-es-ip')).toBe(false);
    expect(isInternalAddress(undefined)).toBe(false);
  });

  it('bordes de los rangos de Cloudflare (104.16/13, 104.24/14, 131.0.72/22)', () => {
    expect(isCloudflareAddress('104.23.255.255')).toBe(true);
    expect(isCloudflareAddress('104.27.255.255')).toBe(true);
    expect(isCloudflareAddress('104.28.0.1')).toBe(false);
    expect(isCloudflareAddress('131.0.75.255')).toBe(true);
    expect(isCloudflareAddress('131.0.76.0')).toBe(false);
  });

  it('IPv6 e IPv4 mapeada de Cloudflare se reconocen', () => {
    expect(isCloudflareAddress('2606:4700:10::6816:1')).toBe(true);
    expect(isCloudflareAddress('2400:cb00:2049::1')).toBe(true);
    expect(isCloudflareAddress('::ffff:162.158.94.21')).toBe(true);
    expect(isCloudflareAddress(CLIENTE_V6)).toBe(false);
  });

  it('Fastify se fía de Traefik también si el socket viene como IPv4 mapeada', () => {
    expect(trustInternalProxy('::ffff:172.18.0.2')).toBe(true);
    expect(trustInternalProxy('::ffff:162.158.94.21')).toBe(false);
  });
});

describe('clientIp — detrás de Cloudflare', () => {
  it('cliente IPv6 por un borde IPv6 de Cloudflare → CF-Connecting-IP', () => {
    const r = viaTraefik({ 'cf-connecting-ip': CLIENTE_V6, 'x-forwarded-for': `${CLIENTE_V6}, ${CF_EDGE_V6}` });
    expect(clientIp(r)).toBe(CLIENTE_V6);
  });

  it('borde de Cloudflare como IPv4 mapeada en X-Forwarded-For → se reconoce', () => {
    const r = viaTraefik({ 'cf-connecting-ip': CLIENTE_V4, 'x-forwarded-for': `::ffff:${CF_EDGE_V4}` });
    expect(clientIp(r)).toBe(CLIENTE_V4);
  });

  it('CF-Connecting-IP como IPv4 mapeada → se limpia', () => {
    const r = viaTraefik({ 'cf-connecting-ip': `::ffff:${CLIENTE_V4}`, 'x-forwarded-for': CF_EDGE_V4 });
    expect(clientIp(r)).toBe(CLIENTE_V4);
  });

  it('por Cloudflare pero sin CF-Connecting-IP o con basura → el borde (nunca la basura)', () => {
    expect(clientIp(viaTraefik({ 'x-forwarded-for': CF_EDGE_V4 }))).toBe(CF_EDGE_V4);
    expect(clientIp(viaTraefik({ 'cf-connecting-ip': 'unknown', 'x-forwarded-for': CF_EDGE_V4 }))).toBe(CF_EDGE_V4);
    expect(clientIp(viaTraefik({ 'cf-connecting-ip': `${CLIENTE_V4}:51234`, 'x-forwarded-for': CF_EDGE_V4 }))).toBe(
      CF_EDGE_V4,
    );
  });

  it('CF-Connecting-IP repetida o con lista: cuenta la primera', () => {
    expect(clientIp(viaTraefik({ 'cf-connecting-ip': [CLIENTE_V4, ATACANTE], 'x-forwarded-for': CF_EDGE_V4 }))).toBe(
      CLIENTE_V4,
    );
    expect(clientIp(viaTraefik({ 'cf-connecting-ip': `${CLIENTE_V4}, ${ATACANTE}`, 'x-forwarded-for': CF_EDGE_V4 }))).toBe(
      CLIENTE_V4,
    );
  });
});

describe('clientIp — cabeceras inventadas sin pasar por Cloudflare', () => {
  it('poner una IP de Cloudflare en X-Forwarded-For no sirve: Traefik añade la real al final', () => {
    const r = viaTraefik({ 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': `${CF_EDGE_V4}, ${ATACANTE}` });
    expect(clientIp(r)).toBe(ATACANTE);
  });

  it('cada intento con otra CF-Connecting-IP inventada da la misma IP (el contador se llena)', () => {
    const ips = ['9.9.9.9', '8.8.8.8', '2001:db8::1'].map((fake) =>
      clientIp(viaTraefik({ 'cf-connecting-ip': fake, 'x-forwarded-for': ATACANTE })),
    );
    expect(new Set(ips)).toEqual(new Set([ATACANTE]));
  });

  it('conexión directa desde un borde de Cloudflare (sin Traefik): la del socket, no CF-Connecting-IP', () => {
    expect(clientIp(viaTraefik({ 'cf-connecting-ip': CLIENTE_V4 }, CF_EDGE_V4))).toBe(CF_EDGE_V4);
  });

  it('conexión directa por IPv6 o IPv4 mapeada desde internet: la del socket', () => {
    expect(clientIp(viaTraefik({ 'x-forwarded-for': '10.0.0.1', 'cf-connecting-ip': '10.0.0.1' }, CLIENTE_V6))).toBe(
      CLIENTE_V6,
    );
    expect(clientIp(viaTraefik({ 'cf-connecting-ip': '1.1.1.1' }, `::ffff:${ATACANTE}`))).toBe(ATACANTE);
  });

  it('con socket, la IP que calculó Fastify (req.ip) no cuenta', () => {
    expect(clientIp({ headers: {}, ip: '1.1.1.1', socket: { remoteAddress: ATACANTE } })).toBe(ATACANTE);
  });

  it('Traefik por IPv6 interna o IPv4 mapeada: se usa el último salto', () => {
    expect(clientIp(viaTraefik({ 'x-forwarded-for': ATACANTE }, 'fd00:dead::7'))).toBe(ATACANTE);
    expect(clientIp(viaTraefik({ 'x-forwarded-for': ATACANTE }, `::ffff:${TRAEFIK}`))).toBe(ATACANTE);
  });

  it('último salto que no es una IP → la del socket (no se cree nada)', () => {
    expect(clientIp(viaTraefik({ 'x-forwarded-for': `${CLIENTE_V4}, unknown`, 'cf-connecting-ip': CLIENTE_V4 }))).toBe(
      TRAEFIK,
    );
  });
});

describe('clientIp — marca de origen verificado (X-Origin-Auth)', () => {
  it('túnel interno (cloudflared en la red Docker) con origen verificado → CF-Connecting-IP', () => {
    const r = viaTraefik({ 'cf-connecting-ip': CLIENTE_V4, 'x-forwarded-for': '172.18.0.5' });
    markOriginVerified(r);
    expect(clientIp(r)).toBe(CLIENTE_V4);
  });

  it('la marca va con la petición de Node (raw), no con el envoltorio', () => {
    const raw = { socket: { remoteAddress: TRAEFIK } };
    markOriginVerified({ raw });
    const otroEnvoltorio = { headers: { 'cf-connecting-ip': CLIENTE_V4, 'x-forwarded-for': '203.0.113.9' }, raw };
    expect(isOriginVerified(otroEnvoltorio)).toBe(true);
    expect(clientIp(otroEnvoltorio)).toBe(CLIENTE_V4);
  });

  it('la marca de una petición no vale para otra', () => {
    markOriginVerified(viaTraefik({}));
    const otra = viaTraefik({ 'cf-connecting-ip': '9.9.9.9', 'x-forwarded-for': ATACANTE });
    expect(isOriginVerified(otra)).toBe(false);
    expect(clientIp(otra)).toBe(ATACANTE);
  });
});
