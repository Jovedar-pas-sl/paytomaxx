import { describe, expect, it } from 'vitest';
import { clampEmail, ipLockKey, loginLockKeys, MAX_EMAIL_LENGTH } from './login-keys';

describe('ipLockKey — una IP (o una red IPv6 /64) es un solo atacante', () => {
  it('IPv4 tal cual', () => {
    expect(ipLockKey('203.0.113.7')).toBe('203.0.113.7');
  });

  it('IPv4 dentro de IPv6 (::ffff:) cuenta como la IPv4', () => {
    expect(ipLockKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('IPv6: todas las direcciones del mismo /64 dan la misma clave', () => {
    const a = ipLockKey('2001:db8:abcd:12::1');
    const b = ipLockKey('2001:0db8:abcd:0012:ffff:eeee:dddd:cccc');
    expect(a).toBe('2001:db8:abcd:12::/64');
    expect(b).toBe(a);
  });

  it('IPv6 de otra red /64 da otra clave', () => {
    expect(ipLockKey('2001:db8:abcd:13::1')).not.toBe(ipLockKey('2001:db8:abcd:12::1'));
  });

  it('IPv6 comprimida al principio y con zona', () => {
    expect(ipLockKey('::1')).toBe('0:0:0:0::/64');
    expect(ipLockKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  });

  it('sin IP o con basura → undefined / tal cual', () => {
    expect(ipLockKey(undefined)).toBeUndefined();
    expect(ipLockKey('')).toBeUndefined();
    expect(ipLockKey('no-es-ip')).toBe('no-es-ip');
  });
});

describe('clampEmail', () => {
  it('recorta a 254 caracteres lo que mande el atacante', () => {
    const long = `${'a'.repeat(400)}@x.es`;
    expect(clampEmail(long)).toHaveLength(MAX_EMAIL_LENGTH);
    expect(clampEmail('dueno@local.es')).toBe('dueno@local.es');
  });
});

describe('loginLockKeys', () => {
  it('email en minúsculas y sin espacios en todas las claves', () => {
    const keys = loginLockKeys('  Dueno@Local.ES ', '203.0.113.7');
    expect(keys).toEqual({
      ip: 'dueno@local.es|203.0.113.7',
      account: 'cuenta:dueno@local.es',
      trusted: 'dueno@local.es|203.0.113.7',
    });
  });

  it('IPv6 agrupada por /64 en la clave por IP', () => {
    expect(loginLockKeys('a@b.es', '2001:db8:1:2:3:4:5:6').ip).toBe('a@b.es|2001:db8:1:2::/64');
  });

  it('sin IP: clave por IP con "-" y nunca "de confianza"', () => {
    expect(loginLockKeys('a@b.es')).toEqual({ ip: 'a@b.es|-', account: 'cuenta:a@b.es', trusted: null });
  });
});
