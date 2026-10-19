import { describe, expect, it } from 'vitest';
import { readCookie, serializeCookie } from './cookies';

describe('readCookie', () => {
  it('la busca por nombre exacto entre varias', () => {
    expect(readCookie('a=1; np_rt_x=tok.en; b=2', 'np_rt_x')).toBe('tok.en');
    expect(readCookie('np_rt_xy=otra; np_rt_x=la-buena', 'np_rt_x')).toBe('la-buena');
  });

  it('sin cabecera o sin esa cookie → null', () => {
    expect(readCookie(undefined, 'np_rt_x')).toBeNull();
    expect(readCookie('a=1', 'np_rt_x')).toBeNull();
  });

  it('cabecera repetida (array) también vale', () => {
    expect(readCookie(['a=1', 'np_rt_x=v'], 'np_rt_x')).toBe('v');
  });
});

describe('serializeCookie', () => {
  it('atributos en orden y sin Domain', () => {
    expect(
      serializeCookie('n', 'v', { path: '/v1/auth', maxAgeSeconds: 60, httpOnly: true, secure: true, sameSite: 'Strict' }),
    ).toBe('n=v; Path=/v1/auth; Max-Age=60; HttpOnly; Secure; SameSite=Strict');
  });

  it('Max-Age nunca negativo', () => {
    expect(
      serializeCookie('n', '', { path: '/', maxAgeSeconds: -5, httpOnly: false, secure: false, sameSite: 'Lax' }),
    ).toBe('n=; Path=/; Max-Age=0; SameSite=Lax');
  });
});
