import { describe, expect, it } from 'vitest';
import { HOME_TOPUP_CODE_RE } from '@nightpay/contracts';
import {
  HOME_TOPUP_START_LIMIT,
  REMEMBER_COOKIE,
  REMEMBER_MAX_WALLETS,
  homeTopUpKey,
  homeTopUpProblem,
  isHomeTopUpCode,
  isHomeTopUpKey,
  newHomeTopUpCode,
  rememberSetCookie,
  rememberValid,
  rememberedEntries,
  venueThrottleKey,
  walletWelcomeHref,
} from './home-topup-rules';

const SECRET = 'secreto-de-cookies-de-prueba-0123456789';
const W1 = '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d';
const W2 = '3b4c5d6e-7f8a-4b9c-8d1e-2f3a4b5c6d7e';
const ok = { paused: false, card: true, wallet: true, hasGateway: true, hasTerminal: true };

/** El valor de la cookie tal cual la manda el navegador de vuelta. */
function sent(setCookie: string | null): string {
  if (!setCookie) throw new Error('sin cookie');
  return setCookie.split(';')[0] ?? '';
}

describe('código del enlace del local', () => {
  it('16 letras de base64url al azar (96 bits): nunca dos iguales y con la forma que exige la base', () => {
    const codes = new Set(Array.from({ length: 2000 }, () => newHomeTopUpCode()));
    expect(codes.size).toBe(2000);
    for (const c of codes) {
      expect(c).toMatch(HOME_TOPUP_CODE_RE);
      expect(isHomeTopUpCode(c)).toBe(true);
    }
  });

  it('lo que no tiene su forma no llega a la base (ni un uuid, ni un número, ni más corto)', () => {
    for (const bad of ['', 'abc', W1, '1234567890123456789', 'aaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaa/', 'aaaa aaaaaaaaaaa', null, 12, undefined]) {
      expect(isHomeTopUpCode(bad)).toBe(false);
    }
  });
});

describe('por qué el enlace encendido no deja cargar', () => {
  it('pausa, formas de cobro (tarjeta y saldo), pasarela y terminal, en ese orden', () => {
    expect(homeTopUpProblem(ok)).toBeNull();
    expect(homeTopUpProblem({ ...ok, paused: true, card: false })).toBe('paused');
    expect(homeTopUpProblem({ ...ok, card: false })).toBe('methods');
    expect(homeTopUpProblem({ ...ok, wallet: false })).toBe('methods');
    expect(homeTopUpProblem({ ...ok, hasGateway: false, hasTerminal: false })).toBe('gateway');
    expect(homeTopUpProblem({ ...ok, hasTerminal: false })).toBe('terminal');
  });
});

describe('Idempotency-Key de la carga', () => {
  it('wcasa: + HMAC: la misma clave del navegador en el mismo local, la misma; en otro local o con otra clave, otra', () => {
    const a = homeTopUpKey(SECRET, 'venue-a', 'k1234567890123456');
    expect(a).toMatch(/^wcasa:[0-9a-f]{64}$/);
    expect(homeTopUpKey(SECRET, 'venue-a', 'k1234567890123456')).toBe(a);
    expect(homeTopUpKey(SECRET, 'venue-b', 'k1234567890123456')).not.toBe(a);
    expect(homeTopUpKey(SECRET, 'venue-a', 'k1234567890123457')).not.toBe(a);
    expect(homeTopUpKey('otro-secreto', 'venue-a', 'k1234567890123456')).not.toBe(a);
    expect(isHomeTopUpKey(a)).toBe(true);
  });

  it('solo las suyas: ni las de «Recargar» en /w ni las del personal ni una a medias', () => {
    for (const k of ['wtopup:' + 'a'.repeat(64), 'wcasa:' + 'a'.repeat(63), 'wcasa:' + 'A'.repeat(64), 'abcdefgh12345678', null, undefined]) {
      expect(isHomeTopUpKey(k)).toBe(false);
    }
  });

  it('el freno por IP: por IP y local (el código del enlace) más bajo que por IP', () => {
    expect(HOME_TOPUP_START_LIMIT.perKey).toEqual({ param: 'code', max: 6 });
    expect(HOME_TOPUP_START_LIMIT.max).toBeGreaterThan(HOME_TOPUP_START_LIMIT.perKey!.max);
    expect(HOME_TOPUP_START_LIMIT.failOpen).toBeUndefined();
  });
});

describe('«Ya tienes un saldo aquí»: la cookie del navegador', () => {
  const w1 = { id: W1, qrToken: 'enlace-1' };
  const w2 = { id: W2, qrToken: 'enlace-2' };
  /** Los saldos de la cookie cuya firma vale con su enlace de ahora. */
  const valid = (cookie: string, wallets: Array<{ id: string; qrToken: string }>, secret = SECRET) =>
    rememberedEntries(cookie)
      .filter((e) => wallets.some((w) => w.id === e.walletId && rememberValid(secret, e, w.qrToken)))
      .map((e) => e.walletId);

  it('guarda el id del saldo firmado con su enlace (nunca el enlace), solo para /r y sin JS', () => {
    const set = rememberSetCookie(SECRET, w1, undefined);
    expect(set).toContain(`${REMEMBER_COOKIE}=${W1}.`);
    expect(set).not.toContain('enlace-1');
    expect(set).toContain('Path=/r;');
    expect(set).toContain('HttpOnly');
    expect(set).toContain('SameSite=Lax');
    expect(valid(sent(set), [w1])).toEqual([W1]);
  });

  it('el más reciente primero, sin repetir y como mucho unos pocos', () => {
    const one = sent(rememberSetCookie(SECRET, w1, undefined));
    const two = sent(rememberSetCookie(SECRET, w2, one));
    expect(valid(two, [w1, w2])).toEqual([W2, W1]);
    const again = sent(rememberSetCookie(SECRET, w1, two));
    expect(valid(again, [w1, w2])).toEqual([W1, W2]);
    let many = again;
    for (let i = 0; i < 10; i += 1) {
      many = sent(rememberSetCookie(SECRET, { id: `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`, qrToken: `q${i}` }, many));
    }
    expect(rememberedEntries(many)).toHaveLength(REMEMBER_MAX_WALLETS);
  });

  it('tras un enlace nuevo del dueño (otro qrToken), la firma ya no vale', () => {
    const cookie = sent(rememberSetCookie(SECRET, w1, undefined));
    expect(valid(cookie, [{ id: W1, qrToken: 'enlace-nuevo' }])).toEqual([]);
  });

  it('una firma cambiada, de otro secreto o un id que no es de saldo: no vale', () => {
    const good = sent(rememberSetCookie(SECRET, w1, undefined));
    expect(valid(good.replace(W1, W2), [w1, { id: W2, qrToken: 'enlace-1' }])).toEqual([]);
    expect(valid(good, [w1], 'otro-secreto-de-cookies-0123456789')).toEqual([]);
    expect(rememberedEntries(`${REMEMBER_COOKIE}=nada.aaaaaaaaaaaaaaaaaaaaaa`)).toEqual([]);
    expect(rememberedEntries(`${REMEMBER_COOKIE}=${W1}.corta`)).toEqual([]);
    expect(rememberedEntries('otra=1')).toEqual([]);
    expect(rememberedEntries(undefined)).toEqual([]);
    // Sin secreto, nada (ni se pone ni vale).
    expect(rememberSetCookie('', w1, undefined)).toBeNull();
    expect(valid(good, [w1], '')).toEqual([]);
  });

  it('Secure salvo en desarrollo y en las pruebas (como la sesión del saldo)', () => {
    const before = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      expect(rememberSetCookie(SECRET, w1, undefined)).toContain('; Secure');
      process.env.NODE_ENV = 'staging';
      expect(rememberSetCookie(SECRET, w1, undefined)).toContain('; Secure');
      process.env.NODE_ENV = 'test';
      expect(rememberSetCookie(SECRET, w1, undefined)).not.toContain('Secure');
    } finally {
      process.env.NODE_ENV = before;
    }
  });
});

describe('el contador del local', () => {
  it('una clave por ventana de 15 min: si su caducidad fallara, la ventana siguiente empieza de cero', () => {
    const t = Date.UTC(2026, 9, 30, 22, 0, 0);
    expect(venueThrottleKey('v1', t)).toBe(venueThrottleKey('v1', t + 14 * 60_000));
    expect(venueThrottleKey('v1', t)).not.toBe(venueThrottleKey('v1', t + 15 * 60_000));
    expect(venueThrottleKey('v1', t)).toMatch(/^np:home-topup:venue:v1:[0-9]+$/);
  });
});

describe('tras pagar, a su saldo nuevo', () => {
  it('la página del saldo con la bienvenida de ese cobro, en su idioma', () => {
    expect(walletWelcomeHref('wTok/1', 'pay 2', 'fr')).toBe('/w/wTok%2F1?lang=fr&nuevo=pay%202');
  });
});
