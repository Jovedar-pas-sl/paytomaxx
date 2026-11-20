import { describe, expect, it } from 'vitest';
import { PAY_LANGUAGES } from '../payments/customer-lang';
import {
  QUEUE_DEVICE_COOKIE,
  QUEUE_PAGE_TEXT,
  newQueueDevice,
  queueDeviceCookie,
  queueDeviceId,
  queueKeys,
  queueToken,
  queueTokenValid,
  queueUrl,
  queueValidUntil,
} from './home-topup-queue';

// El QR de la cola (B16): de un local y de una noche, firmado; el móvil, con su cookie firmada.

const SECRET = 'test-only-cookie-secret-with-32-characters';
const VENUE = '00000000-0000-4000-8000-0000000000b1';
const CODE = 'AbCdEfGhIjKlMnOp';
// 22:00 UTC del 10-nov (la noche del 10: el «día» de /r empieza a las 10:00 UTC).
const NIGHT = Date.parse('2026-11-10T22:00:00Z');

describe('el QR del cartel', () => {
  it('vale toda esa noche (hasta las 10:00 UTC) y solo en ese local y con ese enlace', () => {
    const token = queueToken(SECRET, VENUE, CODE, NIGHT);
    expect(token).toMatch(/^[0-9]+\.[A-Za-z0-9_-]{22}$/);
    expect(queueTokenValid(SECRET, VENUE, CODE, token, NIGHT)).toBe(true);
    expect(queueTokenValid(SECRET, VENUE, CODE, token, Date.parse('2026-11-11T09:59:00Z'))).toBe(true);
    // Otra noche, otro local, el enlace cambiado («Enlace nuevo») u otro secreto: no.
    expect(queueTokenValid(SECRET, VENUE, CODE, token, Date.parse('2026-11-11T10:00:00Z'))).toBe(false);
    expect(queueTokenValid(SECRET, '00000000-0000-4000-8000-0000000000b2', CODE, token, NIGHT)).toBe(false);
    expect(queueTokenValid(SECRET, VENUE, 'OtroEnlace123456', token, NIGHT)).toBe(false);
    expect(queueTokenValid(`${SECRET}x`, VENUE, CODE, token, NIGHT)).toBe(false);
  });

  it('lo que no es un QR del cartel, no (ni con un secreto corto)', () => {
    for (const bad of [undefined, '', 'x', '123.abc', `${queueToken(SECRET, VENUE, CODE, NIGHT)}x`]) {
      expect(queueTokenValid(SECRET, VENUE, CODE, bad, NIGHT)).toBe(false);
    }
    expect(queueTokenValid('corto', VENUE, CODE, queueToken('corto', VENUE, CODE, NIGHT), NIGHT)).toBe(false);
  });

  it('hasta cuándo vale y su enlace (el de /r con ?cola=)', () => {
    expect(queueValidUntil(NIGHT).toISOString()).toBe('2026-11-11T10:00:00.000Z');
    expect(queueUrl('https://api.test/r/AbCd', '20.xyz')).toBe('https://api.test/r/AbCd?cola=20.xyz');
    expect(queueUrl('https://api.test/r/AbCd?lang=en', '20.xyz')).toBe('https://api.test/r/AbCd?lang=en&cola=20.xyz');
  });
});

describe('el móvil (cookie firmada)', () => {
  it('se reconoce con su firma; una cookie inventada o tocada, no', () => {
    const value = newQueueDevice(SECRET);
    const id = queueDeviceId(SECRET, `otra=1; ${QUEUE_DEVICE_COOKIE}=${value}`);
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    // Tocada de verdad: si la firma ya acababa en «A», cambiarla por «A» no la tocaba (fallaba 1 de cada 64 veces).
    const touched = `${value.slice(0, -1)}${value.endsWith('A') ? 'B' : 'A'}`;
    expect(queueDeviceId(SECRET, `${QUEUE_DEVICE_COOKIE}=${touched}`)).toBeNull();
    expect(queueDeviceId(SECRET, undefined)).toBeNull();
    expect(queueDeviceId(SECRET, `${QUEUE_DEVICE_COOKIE}=nada`)).toBeNull();
  });

  it('la cookie: un día, HttpOnly y solo para /r', () => {
    const c = queueDeviceCookie('a.b', true);
    expect(c).toContain('Path=/r;');
    expect(c).toContain('HttpOnly');
    expect(c).toContain('Secure');
    expect(c).toContain('Max-Age=86400');
  });

  it('los topes, por móvil y por local, de esa noche', () => {
    expect(queueKeys(VENUE, 'dev1', NIGHT)).toEqual(queueKeys(VENUE, 'dev1', Date.parse('2026-11-11T05:00:00Z')));
    expect(queueKeys(VENUE, 'dev1', NIGHT).device).not.toBe(queueKeys(VENUE, 'dev1', Date.parse('2026-11-11T22:00:00Z')).device);
    expect(queueKeys(VENUE, 'dev1', NIGHT).night).not.toContain('dev1');
  });
});

describe('los textos de la página con el QR del cartel', () => {
  it('en los 4 idiomas, sin «NFC»', () => {
    for (const lang of PAY_LANGUAGES) {
      for (const text of Object.values(QUEUE_PAGE_TEXT[lang])) {
        expect(text.length).toBeGreaterThan(10);
        expect(text).not.toMatch(/NFC/);
      }
    }
  });
});
