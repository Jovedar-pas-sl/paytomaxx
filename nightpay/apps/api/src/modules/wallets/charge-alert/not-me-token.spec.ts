import { describe, expect, it } from 'vitest';
import { NOT_ME_TTL_MS, notMeChargeId, notMePath, notMeSecret, signNotMeToken, verifyNotMeToken } from './not-me-token';

const SECRET = 'x'.repeat(48);
const CHARGE = '11111111-2222-4333-8444-555555555555';
const WALLET = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER_WALLET = 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const NOW = 1_800_000_000_000;

describe('enlace «No he sido yo»', () => {
  it('vale para ese cobro de ese saldo hasta que caduca', () => {
    const token = signNotMeToken({ chargeId: CHARGE, walletId: WALLET }, NOW, SECRET);
    expect(notMeChargeId(token)).toBe(CHARGE);
    expect(verifyNotMeToken(token, WALLET, NOW + 1_000, SECRET)).toBe('ok');
    expect(verifyNotMeToken(token, WALLET, NOW + NOT_ME_TTL_MS, SECRET)).toBe('expired');
  });

  it('no sirve para otro saldo (la firma cubre el saldo del cobro)', () => {
    const token = signNotMeToken({ chargeId: CHARGE, walletId: WALLET }, NOW, SECRET);
    expect(verifyNotMeToken(token, OTHER_WALLET, NOW, SECRET)).toBe('invalid');
  });

  it('cambiar el cobro del enlace rompe la firma', () => {
    const token = signNotMeToken({ chargeId: CHARGE, walletId: WALLET }, NOW, SECRET);
    const [, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ c: '99999999-2222-4333-8444-555555555555', e: NOW + NOT_ME_TTL_MS }), 'utf8').toString('base64url');
    expect(verifyNotMeToken(`${forged}.${sig}`, WALLET, NOW, SECRET)).toBe('invalid');
    // Ni alargar la caducidad.
    const later = Buffer.from(JSON.stringify({ c: CHARGE, e: NOW + 10 * NOT_ME_TTL_MS }), 'utf8').toString('base64url');
    expect(verifyNotMeToken(`${later}.${sig}`, WALLET, NOW, SECRET)).toBe('invalid');
  });

  it('con otra clave del servidor no vale', () => {
    const token = signNotMeToken({ chargeId: CHARGE, walletId: WALLET }, NOW, SECRET);
    expect(verifyNotMeToken(token, WALLET, NOW, 'y'.repeat(48))).toBe('invalid');
  });

  it('en la URL no va nada del cliente: solo el cobro y la caducidad', () => {
    const token = signNotMeToken({ chargeId: CHARGE, walletId: WALLET }, NOW, SECRET);
    expect(notMePath(token)).toBe(`/w/no/${token}`);
    expect(token).not.toContain(WALLET);
    const payload = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['c', 'e']);
  });

  it('lo que no tiene la forma se descarta antes de tocar la base', () => {
    for (const bad of [undefined, '', 'abc', 'a.b', `${'a'.repeat(30)}.${'b'.repeat(10)}`, 123]) {
      expect(notMeChargeId(bad)).toBeNull();
    }
    const notUuid = `${Buffer.from(JSON.stringify({ c: 'x', e: 1 })).toString('base64url')}.${'a'.repeat(43)}`;
    expect(notMeChargeId(notUuid)).toBeNull();
    expect(verifyNotMeToken('nada', WALLET, NOW, SECRET)).toBe('invalid');
  });

  it('sin JWT_SECRET (o corto) no se firma', () => {
    expect(() => notMeSecret({})).toThrow(/JWT_SECRET/);
    expect(() => notMeSecret({ JWT_SECRET: 'corto' })).toThrow(/JWT_SECRET/);
    expect(notMeSecret({ JWT_SECRET: SECRET })).toBe(SECRET);
  });
});
