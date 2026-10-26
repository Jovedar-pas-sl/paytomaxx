import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { CLIENT_ERROR_JS, CLIENT_ERROR_TEXT, clientErrorConfig } from './client-errors';

/**
 * Errores del API en las páginas del cliente: el `code` se enseña en el
 * idioma de la página; sin `code` conocido, en inglés nunca sale castellano.
 * npErr es el JS de verdad de las páginas (ejecutado aquí).
 */
type ErrLike = { status?: number; code?: string; reason?: string; message?: string; name?: string };
const npErr = new Function(`${CLIENT_ERROR_JS}\nreturn npErr;`)() as (e: ErrLike | null, E: Record<string, unknown>) => string;
const ES = clientErrorConfig('es');
const EN = clientErrorConfig('en');

describe('npErr — el error del API en el idioma de la página', () => {
  it('code conocido → su texto en el idioma de la página, aunque el API conteste en castellano', () => {
    const e = { status: 409, code: 'FACE_ID_TIMEOUT', message: 'Ha tardado demasiado: vuelve a intentarlo' };
    expect(npErr(e, EN)).toBe('That took too long: try again.');
    expect(npErr(e, ES)).toBe('Ha tardado demasiado: vuelve a intentarlo.');
    expect(npErr({ status: 409, code: 'WALLET_TOPUP_DAILY_LIMIT', message: 'x' }, EN)).toMatch(/today's limit/);
  });

  it('recarga no disponible → por su motivo (bloqueado, cerrado…) o «en este local»', () => {
    expect(npErr({ status: 409, code: 'WALLET_TOPUP_UNAVAILABLE', reason: 'blocked' }, EN)).toBe(EN.TOPUP_blocked);
    expect(npErr({ status: 409, code: 'WALLET_TOPUP_UNAVAILABLE', reason: 'leaving' }, ES)).toBe(ES.TOPUP_leaving);
    expect(npErr({ status: 409, code: 'WALLET_TOPUP_UNAVAILABLE', reason: 'no-gateway' }, EN)).toBe(EN.TOPUP_venue);
  });

  it('sin code: 429 → «demasiados intentos»; en castellano el texto del API; en inglés uno genérico', () => {
    expect(npErr({ status: 429, message: 'Too Many Requests' }, ES)).toBe(ES.RATE_LIMITED);
    expect(npErr({ status: 409, message: 'Algo que dice el API' }, ES)).toBe('Algo que dice el API');
    expect(npErr({ status: 409, message: 'Algo que dice el API' }, EN)).toBe(EN.generic);
    expect(npErr({ status: 500, message: 'Error' }, ES)).toBe(ES.generic);
    expect(npErr(null, EN)).toBe(EN.generic);
  });

  it('sin respuesta: la red (TypeError de fetch) o un error del navegador', () => {
    expect(npErr({ name: 'TypeError', message: 'Failed to fetch' }, EN)).toBe(EN.network);
    expect(npErr({ name: 'InvalidStateError', message: 'The authenticator was previously registered' }, EN)).toBe(EN.generic);
  });
});

describe('textos de los errores', () => {
  it('los mismos codes en castellano y en inglés, ninguno vacío', () => {
    expect(Object.keys(CLIENT_ERROR_TEXT.en).sort()).toEqual(Object.keys(CLIENT_ERROR_TEXT.es).sort());
    for (const lang of ['es', 'en'] as const) {
      for (const text of Object.values(CLIENT_ERROR_TEXT[lang])) expect(text.trim()).not.toBe('');
    }
  });

  it('cada code que dan las rutas del cliente tiene su texto', () => {
    const dir = __dirname;
    const files = [
      'wallet-passkeys.service.ts',
      'wallet-topup.service.ts',
      'wallet-charges.service.ts',
      'public-wallet.controller.ts',
      'public-wallet-card.controller.ts',
      'wallet-card-view.service.ts',
      'public-saldo.controller.ts',
      'client-pin.ts',
      'wallet-blocked.ts',
      join('google-wallet', 'google-wallet.service.ts'),
      join('..', 'payments', 'public-pay.controller.ts'),
      join('..', '..', 'common', 'guards', 'ip-rate-limit.guard.ts'),
    ];
    // Con su propio texto por motivo (TOPUP_<reason>) o el de las apps del personal
    // (PAYOUT_AMOUNT_CHANGED: «Devolver saldo» del panel, que enseña el texto del API).
    const handledElsewhere = new Set(['WALLET_TOPUP_UNAVAILABLE', 'PAYOUT_AMOUNT_CHANGED']);
    const codes = new Set<string>(['PIN_FORMAT', 'PIN_OBVIOUS', 'MERGE_NOT_ALLOWED']);
    for (const file of files) {
      const src = readFileSync(join(dir, file), 'utf8');
      for (const m of src.matchAll(/code: '([A-Z][A-Z_]+)'/g)) codes.add(m[1]!);
      // Tablas de codes (p. ej. 'not-pending': 'CHARGE_NOT_PENDING').
      for (const m of src.matchAll(/^\s+'?[\w-]+'?: '([A-Z]+_[A-Z_]+)',\s*$/gm)) codes.add(m[1]!);
    }
    expect(codes.size).toBeGreaterThan(25);
    const missing = [...codes].filter((c) => !handledElsewhere.has(c) && !(c in CLIENT_ERROR_TEXT.es));
    expect(missing).toEqual([]);
  });
});
