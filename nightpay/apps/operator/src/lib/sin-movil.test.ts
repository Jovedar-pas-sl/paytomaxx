import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { pinBody } from './api-cobro';
import { readFichaContext, saveFichaContext } from './ficha-context';
import {
  codeCheckProblem,
  fichaContextOf,
  iphoneFichaHint,
  pinDetail,
  pinProblemOf,
  scannedPassToken,
  scannedSaldo,
  showsSinMovil,
  walletCodeComplete,
  walletCodeFromText,
  walletCodeInput,
} from './sin-movil';

// «Sin móvil ni ficha» (antes, solo en la pestaña «Saldo»): el mismo cobro de
// Esperando se paga con el código del cliente o con su pase, y su PIN.

const PASS = 'a'.repeat(22) + 'B-_'.repeat(7);

describe('cuándo se ofrece', () => {
  it('con su cobro del saldo y el saldo encendido en el local', () => {
    expect(showsSinMovil({ chargeId: 'c1', wallet: true })).toBe(true);
    expect(showsSinMovil({ chargeId: null, wallet: true })).toBe(false);
    expect(showsSinMovil({ chargeId: 'c1', wallet: false })).toBe(false);
  });

  it('la ficha en iPhone: solo se dice donde la app no la lee (y con fichas y su cobro del saldo)', () => {
    expect(iphoneFichaHint({ chargeId: 'c1', venueNfc: true, webNfc: false })).toMatch(/iPhone/);
    expect(iphoneFichaHint({ chargeId: 'c1', venueNfc: true, webNfc: true })).toBeNull();
    expect(iphoneFichaHint({ chargeId: 'c1', venueNfc: false, webNfc: false })).toBeNull();
    expect(iphoneFichaHint({ chargeId: null, venueNfc: true, webNfc: false })).toBeNull();
  });
});

describe('su código (K7Q-4M2)', () => {
  it('se teclea en mayúsculas, sin espacios ni otros signos, con su guion', () => {
    expect(walletCodeInput('k7q-4m2')).toBe('K7Q-4M2');
    expect(walletCodeInput(' k7q 4m2 ')).toBe('K7Q4M2');
    expect(walletCodeInput('K7Q·4M2!')).toBe('K7Q4M2');
    expect(walletCodeInput('K7Q-4M2-ABCDEF')).toHaveLength(10);
  });

  it('se busca con 6 caracteres (el guion no cuenta)', () => {
    expect(walletCodeComplete('K7Q-4M')).toBe(false);
    expect(walletCodeComplete('K7Q-4M2')).toBe(true);
    expect(walletCodeComplete('K7Q4M2')).toBe(true);
  });

  it('sin PIN o con el PIN bloqueado no se pide (se dice por qué)', () => {
    expect(pinProblemOf({ hasPin: true, pinLocked: false })).toBeNull();
    expect(pinProblemOf({ hasPin: true, pinLocked: true })).toMatch(/bloqueado/);
    expect(pinProblemOf({ hasPin: false, pinLocked: false })).toMatch(/no tiene PIN/);
  });
});

describe('su pase de Google Wallet', () => {
  it('vale el QR del pase (…/c/<token>) o el enlace de la app (?pase=)', () => {
    expect(scannedPassToken(`https://api.oxiopay.test/c/${PASS}`)).toBe(PASS);
    expect(scannedPassToken(`https://operator.oxiopay.test/?pase=${PASS}`)).toBe(PASS);
  });

  it('el enlace del saldo (/w/…), otro QR o un texto, no', () => {
    expect(scannedPassToken(`https://api.oxiopay.test/w/${PASS}`)).toBeNull();
    expect(scannedPassToken('https://example.com/otra-cosa')).toBeNull();
    expect(scannedPassToken('K7Q-4M2')).toBeNull();
  });
});

describe('el QR de la página de su saldo (?saldo=, solo su código)', () => {
  it('con la cámara de la app o la del móvil: su código, en mayúsculas', () => {
    expect(walletCodeFromText('https://operator.oxiopay.test/?saldo=K7Q4M2')).toBe('K7Q4M2');
    expect(walletCodeFromText('https://operator.oxiopay.test/?saldo=k7q-4m2')).toBe('K7Q4M2');
    expect(walletCodeFromText('K7Q-4M2')).toBe('K7Q4M2');
  });

  it('un código corto, otro parámetro, otra web rara o un texto largo, no', () => {
    expect(walletCodeFromText('https://operator.oxiopay.test/?saldo=K7Q')).toBeNull();
    expect(walletCodeFromText('https://operator.oxiopay.test/?pase=K7Q4M2')).toBeNull();
    expect(walletCodeFromText('javascript:alert(1)?saldo=K7Q4M2')).toBeNull();
    expect(walletCodeFromText('UN TEXTO CUALQUIERA')).toBeNull();
    expect(walletCodeFromText('')).toBeNull();
  });

  it('«Escanear su pase» lee el pase o este QR; el enlace del saldo (/w/…) nunca', () => {
    expect(scannedSaldo(`https://api.oxiopay.test/c/${PASS}`)).toEqual({ kind: 'pass', token: PASS });
    expect(scannedSaldo('https://operator.oxiopay.test/?saldo=K7Q4M2')).toEqual({ kind: 'code', code: 'K7Q4M2' });
    expect(scannedSaldo(`https://api.oxiopay.test/w/${PASS}`)).toEqual({ kind: 'unknown' });
    expect(scannedSaldo('https://example.com/menu')).toEqual({ kind: 'unknown' });
  });

  it('antes de su PIN: el PIN y si le llega para el cobro abierto', () => {
    const w = { hasPin: true, pinLocked: false, balanceCents: 2000 };
    expect(codeCheckProblem(w, 1800)).toBeNull();
    expect(codeCheckProblem(w, 2000)).toBeNull();
    expect(codeCheckProblem(w, 2001)).toMatch(/No le llega/);
    expect(codeCheckProblem({ ...w, hasPin: false }, 100)).toMatch(/no tiene PIN/);
    expect(codeCheckProblem({ ...w, pinLocked: true }, 100)).toMatch(/bloqueado/);
  });
});

describe('la ficha en iPhone y el pase con la cámara del móvil pagan el cobro de Esperando', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    } as Storage;
  });

  it('lo guardado lo lee la otra pestaña (FichaTapped / PassScanned) mientras el cobro vale', () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    saveFichaContext(fichaContextOf({ userId: 'u1', chargeId: 'w-1', totalCents: 1800, what: '2 copas', expiresAt }));
    expect(readFichaContext('u1')).toEqual({
      userId: 'u1',
      kind: 'cobro',
      chargeId: 'w-1',
      amountCents: 1800,
      serviceName: '2 copas',
      expiresAt,
    });
    expect(readFichaContext('u1', Date.now() + 120_000)).toBeNull();
  });

  it('sin concepto, sin nombre (la pantalla del PIN enseña solo el importe)', () => {
    const ctx = fichaContextOf({ userId: 'u1', chargeId: 'w-1', totalCents: 500, what: '  ', expiresAt: '2030-01-01T00:00:00Z' });
    expect(ctx).toMatchObject({ kind: 'cobro', serviceName: null });
  });
});

describe('el PIN', () => {
  it('dice de qué saldo es y por dónde llegó', () => {
    expect(pinDetail('2 copas', 'K7Q-4M2', 'code')).toBe('2 copas · saldo K7Q-4M2');
    expect(pinDetail('2 copas', 'K7Q-4M2', 'nfc')).toBe('2 copas · saldo K7Q-4M2');
    expect(pinDetail('2 copas', 'K7Q-•••', 'pass')).toBe('2 copas · saldo K7Q-••• · pase');
  });

  it('manda al API un solo saldo: la ficha (con su número de serie si lo hay), el código o el pase', () => {
    expect(pinBody({ card: 'tok', uid: '04:AB' }, '1234')).toEqual({ card: 'tok', uid: '04:AB', pin: '1234' });
    expect(pinBody({ card: 'tok', uid: null }, '1234')).toEqual({ card: 'tok', pin: '1234' });
    expect(pinBody({ code: 'K7Q-4M2' }, '1234')).toEqual({ code: 'K7Q-4M2', pin: '1234' });
    expect(pinBody({ walletToken: PASS }, '1234')).toEqual({ walletToken: PASS, pin: '1234' });
  });
});

describe('Esperando, la única pantalla de cobrar, lo usa', () => {
  const src = readFileSync(new URL('../components/cobrar/Esperando.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

  it('guarda el contexto de ficha solo mientras espera y se ve (y lo borra al terminar)', () => {
    expect(src).toMatch(/if \(!userId \|\| !chargeId \|\| !saldoExpiresAt \|\| !methods\.wallet \|\| !waiting \|\| !shown\) return undefined;/);
    expect(src).toMatch(/saveFichaContext\(fichaContextOf\(/);
    expect(src).toMatch(/clearFichaContext\(\(ctx\) => ctx\.kind === 'cobro' && ctx\.chargeId === chargeId\)/);
  });

  it('ofrece «Sin móvil ni ficha» y, mientras está delante, no escucha el NFC', () => {
    expect(src).toMatch(/<SinMovil\b/);
    expect(src).toMatch(/pinOpen: pin !== null \|\| sinMovil/);
  });

  it('el PIN paga con la ficha, el código o el pase (el mismo teclado)', () => {
    expect(src).toMatch(/payByPin\(chargeId, pin\.ref, value\)/);
  });
});

describe('los enlaces de la cámara del móvil abren el cobro de Inicio', () => {
  const hooks = readFileSync(new URL('../components/dashboard-hooks.ts', import.meta.url), 'utf8');
  const dash = readFileSync(new URL('../components/Dashboard.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

  it('?saldo= se lee como su código y se quita de la URL (un refresh no lo repite)', () => {
    expect(hooks).toMatch(/walletCodeFromText\(url\.toString\(\)\)/);
    expect(hooks).toMatch(/url\.searchParams\.delete\(WALLET_CODE_PARAM\)/);
  });

  it('su pase o su código: la misma pantalla que paga el cobro abierto con su PIN', () => {
    expect(dash).toMatch(/links\.pass \|\| links\.code \?/);
    expect(dash).toMatch(/<PassScanned\s+scan=/);
  });
});
