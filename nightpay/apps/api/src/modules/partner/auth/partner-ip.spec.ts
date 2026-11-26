import { describe, it, expect } from 'vitest';
import { rateLimitIpKey } from '../../../common/http/client-ip';
import { entryWiderThanAddress, ipEntryProblem, ipInList, normalizeIpEntry } from './partner-ip';

describe('IP de una conexión (la lista del dueño)', () => {
  it('direcciones sueltas: IPv4, o IPv6 de /64 a /128', () => {
    for (const ok of ['203.0.113.7', '203.0.113.7/32', '2001:db8:1:2::5', '2001:db8:1:2::/64', '2001:db8:1:2::/96']) {
      expect(ipEntryProblem(ok, 'connection')).toBeNull();
    }
  });

  it('un /24 o un /48 no valen (demasiado anchos para una clave)', () => {
    expect(ipEntryProblem('203.0.113.0/24', 'connection')).toMatch(/no vale/);
    expect(ipEntryProblem('2001:db8:abcd::/48', 'connection')).toMatch(/no vale/);
    expect(ipEntryProblem('2001:db8:1:2::/63', 'connection')).toMatch(/no vale/);
  });

  it('otra /64 queda fuera; y otra dirección de la misma /64 también, aunque rateLimitIpKey las junte', () => {
    expect(ipInList('2001:db8:1:3::1', ['2001:db8:1:2::/64'])).toBe(false);
    expect(ipInList('2001:db8:1:2::abcd', ['2001:db8:1:2::/64'])).toBe(true);
    expect(rateLimitIpKey('2001:db8:1:2::5')).toBe(rateLimitIpKey('2001:db8:1:2::6'));
    expect(ipInList('2001:db8:1:2::6', ['2001:db8:1:2::5'])).toBe(false);
    expect(ipInList('2001:db8:1:2::5', ['2001:db8:1:2::5'])).toBe(true);
  });

  it('IPv4: la dirección entera; null (IP desconocida) nunca está', () => {
    expect(ipInList('203.0.113.7', ['203.0.113.7'])).toBe(true);
    expect(ipInList('203.0.113.8', ['203.0.113.7'])).toBe(false);
    expect(ipInList('::ffff:203.0.113.7', ['203.0.113.7'])).toBe(true);
    expect(ipInList(null, ['203.0.113.7'])).toBe(false);
    expect(ipInList('203.0.113.7', [])).toBe(false);
  });

  it('nunca las de Cloudflare (2a06:98c0:3600::103), internas, 100.64/10, multidifusión ni sin especificar', () => {
    const forbidden = [
      '2a06:98c0:3600::103',
      '104.16.0.1',
      '10.0.0.5',
      '127.0.0.1',
      '172.16.4.2',
      '192.168.1.10',
      '169.254.1.1',
      '::1',
      'fd00::1',
      'fe80::1',
      '100.64.0.1',
      '224.0.0.1',
      'ff02::1',
      '0.0.0.0',
      '::',
      '::ffff:10.0.0.1',
    ];
    for (const ip of forbidden) expect(ipEntryProblem(ip, 'connection'), ip).toMatch(/no vale/);
  });

  it('lo que no es una IP, tampoco', () => {
    for (const bad of ['hola', '1.2.3.4/33', '1.2.3', '2001:db8::/129', '']) expect(ipEntryProblem(bad, 'connection')).not.toBeNull();
  });

  it('se guarda limpia: sin /32 ni /128 sueltos y en minúsculas', () => {
    expect(normalizeIpEntry(' 203.0.113.7/32 ')).toBe('203.0.113.7');
    expect(normalizeIpEntry('2001:DB8:1:2::/64')).toBe('2001:db8:1:2::/64');
    expect(normalizeIpEntry('2001:db8:1:2::5/128')).toBe('2001:db8:1:2::5');
  });
});

describe('IP que declara un socio (la consola)', () => {
  it('hasta un /24 o un /48; más ancho, no', () => {
    expect(ipEntryProblem('203.0.113.0/24', 'partner')).toBeNull();
    expect(ipEntryProblem('2001:db8:abcd::/48', 'partner')).toBeNull();
    expect(ipEntryProblem('203.0.112.0/23', 'partner')).toMatch(/no vale/);
    expect(ipEntryProblem('2001:db8::/47', 'partner')).toMatch(/no vale/);
    expect(ipEntryProblem('10.0.0.0/24', 'partner')).toMatch(/no vale/);
  });

  it('un rango de más de una dirección se marca (necesita motivo)', () => {
    expect(entryWiderThanAddress('203.0.113.0/24')).toBe(true);
    expect(entryWiderThanAddress('2001:db8:1:2::/64')).toBe(true);
    expect(entryWiderThanAddress('203.0.113.7')).toBe(false);
    expect(entryWiderThanAddress('2001:db8:1:2::5')).toBe(false);
  });
});
