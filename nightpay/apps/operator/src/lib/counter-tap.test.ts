import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ReceptionDeskSaldo } from '@nightpay/contracts';
import { counterFicha, counterTapText, loadedBlockedText, loadedOtherTap, needsFichaCheck, sameCounterCard } from './counter-tap';

const NUEVA = { kind: 'new' as const, fichaNumber: 7, printedNumber: '00001013' };
const SALDO = {
  kind: 'saldo',
  walletId: 'w',
  code: 'K7Q-4M2',
  balanceCents: 3_500,
  hasPin: true,
  isHomeVenue: true,
  blocked: false,
  closeRequested: false,
  cashOutCents: 0,
  cashOutNote: null,
  fichaNumber: 7,
  printedNumber: '00001013',
} satisfies ReceptionDeskSaldo;
const MIA = 'tok-mia-0123456789AB';
const OTRA = 'tok-otra-0123456789A';

describe('el lector en el mostrador (A3)', () => {
  it('la ficha leída: su código grabado y su número', () => {
    expect(counterFicha({ view: NUEVA, nfc: { card: MIA } })).toEqual({ card: MIA, printed: '00001013' });
    expect(counterFicha({ view: SALDO, nfc: null })).toEqual({ card: null, printed: '00001013' });
    expect(counterFicha({ view: null, nfc: null, number: { printedNumber: '0042' } })).toEqual({ card: null, printed: '0042' });
    // Un saldo sin ficha (por el código) o un saldo nuevo sin ficha: cualquiera es otra.
    expect(counterFicha({ view: { ...SALDO, fichaNumber: null }, nfc: null })).toEqual({ card: null, printed: null });
    expect(counterFicha({ view: null, nfc: null })).toEqual({ card: null, printed: null });
  });

  it('con la misma ficha no pasa nada (sin preguntar al servidor)', () => {
    const here = counterFicha({ view: NUEVA, nfc: { card: MIA } });
    expect(sameCounterCard(here, MIA)).toBe(true);
    expect(counterTapText(here, { token: MIA, printed: null })).toBeNull();
  });

  it('con otra, solo el aviso: «Esa es la 1014, no la 1013»', () => {
    const here = counterFicha({ view: NUEVA, nfc: { card: MIA } });
    expect(sameCounterCard(here, OTRA)).toBe(false);
    expect(counterTapText(here, { token: OTRA, printed: '00001014' })).toBe('Esa es la 1014, no la 1013');
    // Aunque lleve el mismo número impreso (otro grupo de locales), con otro código es otra ficha.
    expect(counterTapText(here, { token: OTRA, printed: '00001013' })).toBe('Esa es la 1013, no la 1013');
    // En blanco o de otro local: no se sabe su número.
    expect(counterTapText(here, { token: null, printed: null })).toBe('Esa no es la 1013');
  });

  it('por el número o por el código (sin código grabado): vale el mismo número impreso', () => {
    const here = counterFicha({ view: null, nfc: null, number: { printedNumber: '1013' } });
    expect(counterTapText(here, { token: OTRA, printed: '00001013' })).toBeNull();
    expect(counterTapText(here, { token: OTRA, printed: '00001014' })).toBe('Esa es la 1014, no la 1013');
  });

  it('sin ficha: cualquiera es otra', () => {
    expect(counterTapText({ card: null, printed: null }, { token: OTRA, printed: '0099' })).toBe('Esa es la 99: no es la de este cliente');
  });

  it('el mostrador escucha fuera de la primera pantalla sin grabar; solo carga en B2 y solo cambia de pantalla en B3', () => {
    const desk = readFileSync(new URL('../components/reception/desk/ReceptionDesk.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const handler = desk.slice(desk.indexOf('async function onCounterTap('), desk.indexOf('/** La misma ficha en el mostrador'));
    expect(handler).not.toMatch(/\bgo\(|setStep\(|restart\(|staffBackend\.(stock|cash|link)|payCash|sendCash/);
    // La misma ficha: solo carga en «Acerca otra vez la ficha» (B2), pasado el medio segundo.
    const same = desk.slice(desk.indexOf('function counterSame('), desk.indexOf('async function counterOther('));
    expect(same).toMatch(/if \(at\.kind === 'cashConfirm' && methodArmed\(stepShownAt\.current, Date\.now\(\)\)\) \{\s*void run\(\(\) => payCash\(at\.read, at\.amountCents, 'tap'\)\);/);
    expect(same.match(/payCash\(/g)).toHaveLength(1);
    // Otra ficha: solo en CARGADO abre la siguiente (B3); en lo demás, el aviso.
    const other = desk.slice(desk.indexOf('async function counterOther('), desk.indexOf('/** Qué hacer con el PIN en CARGADO'));
    expect(other).toMatch(/if \(at\.kind === 'loaded'\) \{[\s\S]*?if \(why === 'next'\) \{\s*restart\('entrada'\);/);
    expect(other.match(/restart\(/g)).toHaveLength(1);
    expect(other).not.toMatch(/payCash|sendCash|staffBackend/);
    // Solo se graba una ficha en blanco en la primera pantalla.
    expect(desk).toMatch(/useDeskNfc\([\s\S]*?mode === 'entrada' && step\.kind === 'tap'/);
  });

  it('B2: «Efectivo» con ficha espera a la misma ficha; «Cargar sin leerla» queda apuntado', () => {
    const desk = readFileSync(new URL('../components/reception/desk/ReceptionDesk.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    expect(desk).toContain("if (needsFichaCheck(counterFicha(read))) return go({ kind: 'cashConfirm', read, amountCents });");
    expect(desk).toContain("if (method === 'cash') void run(() => cashChosen(read, amountCents));");
    expect(desk).toContain("onManual={() => void run(() => payCash(step.read, step.amountCents, 'manual'))}");
    // «Mejor en efectivo» del QR, igual.
    expect(desk).toMatch(/if \(!qrSettled\) await retire\(payment\);[\s\S]*?await cashChosen\(read, amountCents\);/);
    // Cómo se confirmó va en la petición (también al comprobar una sin respuesta).
    expect(desk).toContain('const check = how ? { fichaCheck: how } : {};');
    expect(desk).toContain('void checkCash(read, amountCents, CASH_CHECK_TRIES, how);');
  });

  it('B3: el PIN pendiente o el QR de Face ID a la vista no dejan cerrar CARGADO con otra ficha', () => {
    const desk = readFileSync(new URL('../components/reception/desk/ReceptionDesk.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    expect(desk).toContain('loadedOtherTap({ pinPending: loadedPinPending(at.done), faceQrOpen })');
    expect(desk).toContain("return loadedPin(done) === 'ask' && !done.pinSkipped;");
    expect(desk).toContain('onOpen={setFaceQrOpen}');
    const qr = readFileSync(new URL('../components/reception/desk/ActivationQr.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    expect(qr).toContain('const shown = link !== null && !expired;');
    expect(qr).toContain('useEffect(() => () => onOpen?.(false), [onOpen]);');
  });
});

describe('B2 y B3: confirmar el efectivo con la misma ficha y la siguiente cierra CARGADO', () => {
  it('B2: solo se pide acercarla si hay ficha', () => {
    expect(needsFichaCheck(counterFicha({ view: NUEVA, nfc: { card: MIA } }))).toBe(true);
    expect(needsFichaCheck(counterFicha({ view: null, nfc: null, number: { printedNumber: '0042' } }))).toBe(true);
    expect(needsFichaCheck(counterFicha({ view: SALDO, nfc: null }))).toBe(true);
    expect(needsFichaCheck(counterFicha({ view: null, nfc: null }))).toBe(false);
    expect(needsFichaCheck(counterFicha({ view: { ...SALDO, fichaNumber: null }, nfc: null }))).toBe(false);
  });

  it('B3: otra ficha abre al siguiente; con el PIN pendiente o el QR de Face ID abierto, no', () => {
    expect(loadedOtherTap({ pinPending: false, faceQrOpen: false })).toBe('next');
    expect(loadedOtherTap({ pinPending: true, faceQrOpen: true })).toBe('pin');
    expect(loadedOtherTap({ pinPending: false, faceQrOpen: true })).toBe('qr');
    expect(loadedBlockedText('Esa es la 1014, no la 1013', 'pin')).toBe('Esa es la 1014, no la 1013. Antes, que este cliente elija su PIN o toque «Ahora no»');
    expect(loadedBlockedText('Esa es la 1014, no la 1013', 'qr')).toMatch(/QR de Face ID sigue abierto: cuando termine, «Siguiente cliente»$/);
  });
});
