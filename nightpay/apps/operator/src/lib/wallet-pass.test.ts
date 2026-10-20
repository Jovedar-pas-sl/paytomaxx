import { describe, expect, it } from 'vitest';
import { WALLET_PASS_PARAM, isPassChargeToken, passChargeTokenFromText } from '@nightpay/contracts';
import { passCheckProblem } from './wallet-pass';

// Un token de cobro del pase: id del saldo + firma, 43 caracteres base64url.
const TOKEN = '1OX2p7jJTQ6PGisrPE1ecFqIwmK2Pzc0lXyBqzy3pXc';
const ok = { codeHint: 'K7Q-•••', hasPin: true, pinLocked: false, ownPin: false, enough: true };

describe('el QR del pase leído o pegado', () => {
  it('…/c/<token> y ?pase=<token>: el token de cobro', () => {
    expect(isPassChargeToken(TOKEN)).toBe(true);
    expect(passChargeTokenFromText(`https://api.oxiopay.es/c/${TOKEN}`)).toBe(TOKEN);
    expect(passChargeTokenFromText(` https://api.oxiopay.es/c/${TOKEN}/ `)).toBe(TOKEN);
    expect(passChargeTokenFromText(`https://chicas.oxiopay.es/?${WALLET_PASS_PARAM}=${TOKEN}`)).toBe(TOKEN);
  });

  it('el enlace del saldo (/w/…), el cobro de la chica (/s/…), otra ruta o basura: nada', () => {
    expect(passChargeTokenFromText(`https://api.oxiopay.es/w/${TOKEN}`)).toBeNull();
    expect(passChargeTokenFromText(`https://api.oxiopay.es/s/${TOKEN}`)).toBeNull();
    expect(passChargeTokenFromText(`https://api.oxiopay.es/c/${TOKEN}/pagar`)).toBeNull();
    expect(passChargeTokenFromText(`https://api.oxiopay.es/c/${TOKEN.slice(1)}`)).toBeNull();
    expect(passChargeTokenFromText(`javascript:alert(1)//c/${TOKEN}`)).toBeNull();
    expect(passChargeTokenFromText(TOKEN)).toBeNull();
    expect(passChargeTokenFromText('')).toBeNull();
    expect(passChargeTokenFromText(`https://x.es/c/${'a'.repeat(3000)}`)).toBeNull();
  });
});

describe('antes del PIN: por qué no se puede pagar con el pase', () => {
  it('todo bien: que teclee su PIN', () => {
    expect(passCheckProblem(ok)).toBeNull();
  });

  it('bloqueado, sin PIN, PIN puesto por quien cobra o no le llega', () => {
    expect(passCheckProblem({ ...ok, pinLocked: true })).toMatch(/bloqueado/);
    expect(passCheckProblem({ ...ok, hasPin: false })).toMatch(/aún no tiene PIN/);
    expect(passCheckProblem({ ...ok, ownPin: true })).toMatch(/otra persona/);
    expect(passCheckProblem({ ...ok, enough: false })).toMatch(/No le llega/);
  });
});
