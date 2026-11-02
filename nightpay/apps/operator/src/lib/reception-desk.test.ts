import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ReceptionDeskSaldo, ReceptionOptions } from '@nightpay/contracts';
import { ApiError, ServerUnavailableError, SessionExpiredError } from '@nightpay/api-client';
import { receptionAttempt } from './reception';
import {
  attemptOnStep,
  cashTopUpUnsure,
  cashTopUpWallet,
  cashUnsureRow,
  codeBoxes,
  codeInput,
  deskRechargeWhat,
  deskRow,
  deskTarget,
  canChoosePin,
  fichaGivenNote,
  fichaLookupText,
  fichaText,
  handOverLine,
  loadedMoneyLine,
  methodButtons,
  noPinLimitCents,
  noReaderStage,
  pinAfterLoad,
  pinAfterLoadText,
  pinNote,
  quickAmounts,
  rechargeChip,
  numberEntryProblem,
  numberMethodButtons,
  numberRow,
  rechargeProblem,
  refundDoneLine,
} from './reception-desk';

/** Recepción exprés (maquetas 4.1–4.7): lo que dice y decide cada paso. Los importes llevan un espacio que no se parte. */

const eur = (text: string) => text.split(String.fromCharCode(160)).join(' ');
const FICHA = { card: 'q3VbX9kLmN2pR7sT4wYz1A', uid: '04A23B11' };
const OPTIONS: ReceptionOptions = { card: true, cash: true, cashBlockedReason: null, nfc: true };
const NUEVO = { kind: 'new' as const, fichaNumber: 522, printedNumber: '00736903' };
const NUEVO_SIN = { kind: 'new' as const, fichaNumber: 522 };
const saldo = (o: Partial<ReceptionDeskSaldo> = {}): ReceptionDeskSaldo => ({
  kind: 'saldo',
  walletId: 'w-388',
  code: 'R3D-8LP',
  balanceCents: 3_500,
  hasPin: true,
  isHomeVenue: true,
  blocked: false,
  closeRequested: true,
  cashOutCents: 3_500,
  cashOutNote: null,
  fichaNumber: 388,
  printedNumber: '0388',
  ...o,
});

describe('el NFC leído (4.2 y 4.5)', () => {
  it('nuevo: «NFC nuevo · Ficha nº 00736903 · sin saldo»: el número impreso, tal cual', () => {
    expect(deskRow(NUEVO, 'entrada')).toEqual({ title: 'NFC nuevo', detail: 'Ficha nº 00736903 · sin saldo' });
    expect(fichaText('0007')).toBe('ficha nº 0007');
  });

  it('el número interno no se enseña como si fuera el impreso: «sin número impreso»', () => {
    expect(deskRow(NUEVO_SIN, 'entrada')).toEqual({ title: 'NFC nuevo', detail: 'Ficha sin número impreso · sin saldo' });
    expect(fichaText(null)).toBe('ficha sin número impreso');
    expect(deskRow(saldo({ printedNumber: undefined }), 'salida').title).toBe('Ficha sin número impreso');
    expect(handOverLine(NUEVO_SIN, true)).toBe('Dale el NFC · ficha sin número impreso');
  });

  it('con saldo: lo que le queda en la entrada; «leída» a la salida', () => {
    expect(eur(deskRow(saldo(), 'entrada').detail)).toBe('Le quedan 35 € · R3D-8LP');
    expect(deskRow(saldo({ balanceCents: 0 }), 'entrada').detail).toBe('Sin saldo · R3D-8LP');
    expect(deskRow(saldo(), 'salida')).toEqual({ title: 'Ficha nº 0388', detail: 'Saldo R3D-8LP · leída' });
    // Por el código (sin NFC): el saldo en el título.
    expect(deskRow(saldo({ fichaNumber: null }), 'salida')).toEqual({ title: 'Saldo R3D-8LP', detail: 'Sin NFC · por su código' });
  });

  it('el chip de 4.3: su ficha, su código o un saldo nuevo sin NFC', () => {
    expect(rechargeChip(NUEVO)).toBe('Recarga · ficha nº 00736903');
    expect(rechargeChip(saldo({ fichaNumber: null }))).toBe('Recarga · R3D-8LP');
    expect(rechargeChip(null)).toBe('Recarga · saldo nuevo');
  });

  it('un saldo bloqueado no se recarga', () => {
    expect(rechargeProblem(saldo({ blocked: true }))).toMatch(/bloqueado/);
    expect(rechargeProblem(saldo())).toBeNull();
    expect(rechargeProblem(NUEVO)).toBeNull();
  });
});

describe('la recarga (4.2 y 4.3)', () => {
  it('los importes rápidos del local: sin repetir, de menor a mayor', () => {
    expect(quickAmounts([10_000, 2_000, 5_000, 2_000, 0])).toEqual([2_000, 5_000, 10_000]);
  });

  it('a qué saldo va: nuevo, el de su NFC o el de su código', () => {
    expect(deskTarget(NUEVO, FICHA)).toEqual({ kind: 'new' });
    expect(deskTarget(null, null)).toEqual({ kind: 'new' });
    expect(deskTarget(saldo(), FICHA)).toEqual({
      kind: 'card',
      card: FICHA.card,
      uid: FICHA.uid,
      view: { walletId: 'w-388', codeHint: 'R3D-8LP', hasPin: true, isHomeVenue: true },
    });
    expect(deskTarget(saldo(), null)).toMatchObject({ kind: 'code', code: 'R3D-8LP' });
  });

  it('¿cómo paga?: la de por defecto del local primero y en grande (de fábrica, efectivo)', () => {
    expect(methodButtons(OPTIONS, { kind: 'new' }, 5_000, 'cash')).toEqual([
      { method: 'cash', primary: true, problem: null },
      { method: 'card', primary: false, problem: null },
    ]);
    expect(methodButtons(OPTIONS, { kind: 'new' }, 5_000, 'card').map((b) => [b.method, b.primary])).toEqual([
      ['card', true],
      ['cash', false],
    ]);
  });

  it('el efectivo solo a quien lo cobra (recepción); hasta 999,99 €; con tarjeta, solo saldos de aquí', () => {
    // Sin efectivo (no es de recepción): ni sale el botón.
    expect(methodButtons({ ...OPTIONS, cash: false, cashBlockedReason: 'El efectivo se cobra en recepción.' }, { kind: 'new' }, 5_000, 'cash')).toEqual([
      { method: 'card', primary: true, problem: null },
    ]);
    expect(methodButtons(OPTIONS, { kind: 'new' }, 100_000, 'cash')[0]).toMatchObject({ method: 'cash', problem: expect.stringMatching(/999,99/) });
    const otroLocal = deskTarget(saldo({ isHomeVenue: false }), FICHA);
    expect(methodButtons(OPTIONS, otroLocal, 5_000, 'cash')[1]).toMatchObject({ method: 'card', problem: expect.stringMatching(/otro local/) });
  });

  it('la nota del PIN: lo elige al terminar si pasa del máximo sin PIN del local', () => {
    expect(eur(pinNote(2_000))).toBe('Si pasa de 20 €, elegirá su PIN al terminar.');
    expect(pinNote(0)).toMatch(/hace falta para pagar con la ficha/);
  });

  it('la nota del PIN no promete lo que el personal no puede: un saldo ya cargado lo pone el encargado', () => {
    expect(eur(pinNote(2_000, false))).toBe('Esta ficha no tiene PIN: solo paga hasta 20 €. Para más, que lo ponga con el encargado.');
  });
});

describe('el PIN al terminar de cargar: que una ficha cargada no se quede sin poder pagar', () => {
  const base = { hasFicha: true, canChoose: true, noPinMaxCents: 2_000 };
  const wallet = (balanceCents: number, hasPin = false) => ({ balanceCents, hasPin });

  it('pasa del tope y no tiene PIN: se le pide ya', () => {
    expect(pinAfterLoad({ ...base, wallet: wallet(5_000) })).toBe('ask');
    expect(pinAfterLoad({ ...base, wallet: wallet(2_001) })).toBe('ask');
  });

  it('hasta el tope se puede pagar sin PIN: solo se ofrece', () => {
    expect(pinAfterLoad({ ...base, wallet: wallet(2_000) })).toBe('offer');
  });

  it('con PIN, o sin saldo que mirar (por número), no se dice nada', () => {
    expect(pinAfterLoad({ ...base, wallet: wallet(5_000, true) })).toBe('none');
    expect(pinAfterLoad({ ...base, wallet: null })).toBe('none');
  });

  it('sin ficha (solo su código) no se insiste: el PIN no hace falta para acercarla', () => {
    expect(pinAfterLoad({ ...base, hasFicha: false, wallet: wallet(5_000) })).toBe('offer');
  });

  it('un saldo que ya existía: el personal no puede ponerlo, el encargado sí; no se ofrece lo que fallaría', () => {
    expect(pinAfterLoad({ ...base, canChoose: false, wallet: wallet(5_000) })).toBe('manager');
    expect(pinAfterLoad({ ...base, canChoose: false, wallet: wallet(1_000) })).toBe('none');
  });

  it('con tope 0, toda ficha sin PIN lo necesita', () => {
    expect(pinAfterLoad({ ...base, noPinMaxCents: 0, wallet: wallet(100) })).toBe('ask');
  });

  it('quién puede elegirlo ahora: un saldo nuevo, o el encargado y el dueño (lo exige el servidor)', () => {
    expect(canChoosePin(null, 'WAITER')).toBe(true);
    expect(canChoosePin(NUEVO, 'WAITER')).toBe(true);
    expect(canChoosePin(saldo(), 'WAITER')).toBe(false);
    expect(canChoosePin(saldo(), 'OPERATOR')).toBe(false);
    expect(canChoosePin(saldo(), 'MANAGER')).toBe(true);
    expect(canChoosePin(saldo(), 'OWNER')).toBe(true);
  });

  it('dice qué pasa si no lo pone (la salida también admite su Face ID)', () => {
    expect(eur(pinAfterLoadText('ask', 2_000))).toBe('Sin PIN solo paga hasta 20 €. Para devolverle el saldo hará falta su Face ID o el encargado.');
    expect(pinAfterLoadText('ask', 0)).toMatch(/no puede pagar/);
    expect(eur(pinAfterLoadText('manager', 2_000))).toMatch(/que lo ponga con el encargado/);
  });

  it('dar ficha a quien cargó desde casa sin PIN: se le dice dónde ponerlo', () => {
    expect(fichaGivenNote(true, 2_000)).toBe('Ya puede pagar acercándola.');
    expect(eur(fichaGivenNote(false, 2_000))).toBe('Sin PIN solo paga hasta 20 €. Que lo elija en su móvil, en Más → Elegir un PIN.');
    expect(fichaGivenNote(false, 0)).toBe('Sin PIN esta ficha no puede pagar. Que lo elija en su móvil, en Más → Elegir un PIN.');
  });

  it('el tope real, como el servidor: con cualquiera de los dos a 0, sin PIN no paga nada', () => {
    expect(noPinLimitCents({ nfcNoPinMaxCents: 2_000, nfcNoPinNightCapCents: 10_000 })).toBe(2_000);
    expect(noPinLimitCents({ nfcNoPinMaxCents: 2_000, nfcNoPinNightCapCents: 0 })).toBe(0);
    expect(noPinLimitCents({ nfcNoPinMaxCents: 0, nfcNoPinNightCapCents: 10_000 })).toBe(0);
    // Tope de noche a 0: 15 € de saldo ya necesitan PIN, aunque el máximo sea 20 €.
    const limit = noPinLimitCents({ nfcNoPinMaxCents: 2_000, nfcNoPinNightCapCents: 0 });
    expect(pinAfterLoad({ ...base, noPinMaxCents: limit, wallet: wallet(1_500) })).toBe('ask');
  });
});

describe('un móvil que no lee fichas (iPhone)', () => {
  it('no pide acercar nada y dice qué se puede hacer ahí', () => {
    expect(noReaderStage('entrada').title).toBe('Este móvil no lee fichas');
    expect(noReaderStage('entrada').text).toMatch(/Android de recepción/);
    expect(noReaderStage('entrada').text).toMatch(/código o su número/);
    expect(noReaderStage('salida').text).toMatch(/devolver efectivo/);
  });

  it('una ficha sin saldo abierta desde el iPhone no dice «Ficha no encontrado»', () => {
    expect(fichaLookupText('Ficha no encontrado.')).toBe('Esta ficha aún no tiene saldo. Para cargarla, usa el Android de recepción.');
    expect(fichaLookupText('Demasiados intentos')).toBe('Demasiados intentos');
  });
});

describe('CARGADO (4.4)', () => {
  it('lo que hace recepción con el dinero', () => {
    const cash = loadedMoneyLine('cash', 5_000);
    expect({ ...cash, amount: eur(cash.amount) }).toEqual({ label: 'Efectivo:', amount: '50 €', tail: 'a la caja' });
    expect(loadedMoneyLine('card', 5_000)).toMatchObject({ label: 'Tarjeta:', tail: 'en su móvil' });
  });

  it('con la comisión del servicio: lo que pagó el cliente (saldo + comisión), no solo el saldo', () => {
    // Antes: «Efectivo: 50 € a la caja» cuando el cliente había pagado 56 €.
    const cash = loadedMoneyLine('cash', 5_000, 600);
    expect({ ...cash, amount: eur(cash.amount), tail: eur(cash.tail) }).toEqual({ label: 'Efectivo:', amount: '56 €', tail: 'a la caja (con 6 € de comisión)' });
    const card = loadedMoneyLine('card', 3_300, 347);
    expect({ ...card, amount: eur(card.amount), tail: eur(card.tail) }).toEqual({ label: 'Tarjeta:', amount: '36,47 €', tail: 'en su móvil (con 3,47 € de comisión)' });
    // Sin comisión (o a 0), como siempre.
    expect(loadedMoneyLine('cash', 5_000, 0)).toEqual(loadedMoneyLine('cash', 5_000));
  });

  it('y con el NFC: dárselo (nuevo), devolvérselo (el suyo) o el código si no tiene', () => {
    expect(handOverLine(NUEVO, true)).toBe('Dale el NFC · ficha nº 00736903');
    expect(handOverLine(saldo(), true)).toBe('Devuélvele su NFC · ficha nº 0388');
    expect(handOverLine(saldo({ fichaNumber: null }), true)).toBe('Saldo R3D-8LP');
    expect(handOverLine(null, false)).toMatch(/Sin NFC/);
  });
});

describe('la salida (4.5)', () => {
  it('devuelto: el NFC al stock, o lo que le queda (con tarjeta) y quién lo devuelve', () => {
    expect(refundDoneLine(0)).toMatch(/vuelve al stock/);
    expect(eur(refundDoneLine(1_500))).toMatch(/^Le quedan 15 € \(con tarjeta\)/);
  });
});

describe('por el número impreso (sin acercar el NFC)', () => {
  const porNumero = { kind: 'saldo' as const, printedNumber: '00017', codeHint: 'K7Q-•••', balanceCents: 3_500, cashOutCents: 3_500, cashOutNote: null,
    hasPin: true, blocked: false, closeRequested: false, isHomeVenue: true };
  it('una ficha nueva no se carga por número: se acerca', () => {
    expect(numberEntryProblem({ kind: 'new', printedNumber: '00017' })).toBe('Para cargar una ficha nueva, acércala');
    expect(numberEntryProblem({ ...porNumero, blocked: true })).toMatch(/bloqueado/);
    expect(numberEntryProblem(porNumero)).toBeNull();
  });
  it('por número, solo en efectivo', () => {
    expect(numberMethodButtons(OPTIONS)).toEqual([
      { method: 'cash', primary: true, problem: null },
      { method: 'card', primary: false, problem: 'Con tarjeta, acerca su NFC o escribe su código.' },
    ]);
    expect(numberMethodButtons({ ...OPTIONS, cash: false, cashBlockedReason: 'No' })[0]?.problem).toBe('No');
    expect(numberMethodButtons(null)).toEqual([]);
  });
  it('su saldo, con el código tapado', () => {
    expect(eur(numberRow(porNumero).detail)).toBe('Le quedan 35 € · K7Q-•••');
    expect(numberRow(porNumero).title).toBe('Ficha nº 00017');
  });
});

describe('el código tecleado (4.6)', () => {
  it('seis letras o cifras en mayúscula, sin guion; seis casillas', () => {
    expect(codeInput('k7q-4m2x')).toBe('K7Q4M2');
    expect(codeInput(' r3d 8')).toBe('R3D8');
    expect(codeBoxes('K7Q4')).toEqual(['K', '7', 'Q', '4', '', '']);
  });
});

describe('la clave de la recarga va con el cliente (A2-04)', () => {
  const OTRA = { card: 'Zz9yX8wV7uT6sR5qP4oN3m', uid: '04FFEE00' };

  it('dos clientes con ficha nueva, mismo importe y misma forma de pago: claves distintas (la ficha va en la clave)', () => {
    const a = deskRechargeWhat(2_000, 'cash', { view: NUEVO, nfc: FICHA });
    const b = deskRechargeWhat(2_000, 'cash', { view: NUEVO, nfc: OTRA });
    expect(a).not.toBe(b);
    expect(a).toBe(`2000|cash|nuevo:ficha:${FICHA.card}`);
    // La misma ficha (un corte, un doble toque): lo mismo.
    expect(deskRechargeWhat(2_000, 'cash', { view: NUEVO, nfc: FICHA })).toBe(a);
  });

  it('lo demás, como antes: su NFC con saldo, su código, un saldo nuevo sin NFC o por el número', () => {
    expect(deskRechargeWhat(5_000, 'card', { view: saldo(), nfc: FICHA })).toBe(`5000|card|ficha:${FICHA.card}`);
    expect(deskRechargeWhat(5_000, 'cash', { view: saldo(), nfc: null })).toBe('5000|cash|codigo:R3D-8LP');
    expect(deskRechargeWhat(5_000, 'cash', { view: null, nfc: null })).toBe('5000|cash|nuevo');
    const number = { kind: 'saldo', printedNumber: '0388' } as unknown as Parameters<typeof deskRechargeWhat>[2]['number'];
    expect(deskRechargeWhat(5_000, 'cash', { view: null, nfc: null, number })).toBe('5000|cash|numero:0388');
  });

  it('volver a leer (la flecha atrás hasta el NFC, el código o el número) renueva la clave; dentro de la misma recarga, no', () => {
    const attempt = receptionAttempt(null, deskRechargeWhat(2_000, 'cash', { view: null, nfc: null }));
    for (const kind of ['tap', 'code', 'number'] as const) expect(attemptOnStep(attempt, kind)).toBeNull();
    for (const kind of ['amount', 'keypad', 'method', 'card', 'loaded'] as const) expect(attemptOnStep(attempt, kind)).toBe(attempt);
  });

  it('el escenario: A sin respuesta, atrás hasta el NFC, llega B (saldo nuevo sin NFC, mismo importe): otra clave', () => {
    const what = deskRechargeWhat(2_000, 'cash', { view: null, nfc: null });
    const a = receptionAttempt(null, what);
    const afterBack = attemptOnStep(a, 'tap');
    const b = receptionAttempt(afterBack, what);
    expect(b.key).not.toBe(a.key);
  });
});

describe('la recarga del datáfono y de «Recargar saldo» (ReceptionFlow), igual (A2-04)', () => {
  const src = readFileSync(new URL('../components/reception/ReceptionFlow.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

  it('volver al importe (el primer paso: otro cliente) renueva la clave', () => {
    expect(src).toMatch(/attempt\.current = null;\s*setStep\(\{ kind: 'amount' \}\);\s*\}\}\s*>\s*Cambiar el importe/);
  });

  it('en ReceptionDesk, toda vuelta a leer pasa por go(), que renueva la clave', () => {
    const desk = readFileSync(new URL('../components/reception/desk/ReceptionDesk.tsx', import.meta.url), 'utf8');
    expect(desk).toMatch(/attempt\.current = attemptOnStep\(attempt\.current, next\.kind\)/);
    expect(desk).not.toMatch(/setStep\(\{ kind: '(tap|code|number)' \}\)/);
  });
});

describe('recarga en efectivo a una ficha nueva con la respuesta perdida (prueba real)', () => {
  const NFC = { card: 'tok-AbCdEf0123456789', uid: '04A1B2C3D4E5F6' };

  it('el saldo nuevo va con su ficha en la misma petición (el servidor la da al cargar)', () => {
    expect(cashTopUpWallet(deskTarget({ kind: 'new', fichaNumber: 12 } as never, NFC), NFC)).toEqual({ create: true, card: NFC.card, uid: NFC.uid });
    expect(cashTopUpWallet(deskTarget({ kind: 'new', fichaNumber: 12 } as never, { card: NFC.card, uid: null }), { card: NFC.card, uid: null })).toEqual({ create: true, card: NFC.card });
    // Sin ficha (por el código, «saldo nuevo sin NFC»): como siempre.
    expect(cashTopUpWallet(deskTarget(null, null), null)).toEqual({ create: true });
    // Un saldo que ya existe: el de siempre.
    const saldo = { kind: 'saldo', walletId: 'w1', code: 'K7Q-4M2', hasPin: true, isHomeVenue: true } as never;
    expect(cashTopUpWallet(deskTarget(saldo, NFC), NFC)).toEqual({ card: NFC.card, uid: NFC.uid });
  });

  it('sin respuesta, con 5xx o 408 no se sabe si se cargó: se comprueba con la misma clave; un 4xx del API, no', () => {
    expect(cashTopUpUnsure(new ServerUnavailableError('sin red', 0, 'network'))).toBe(true);
    expect(cashTopUpUnsure(new ServerUnavailableError('tarda', 0, 'timeout'))).toBe(true);
    expect(cashTopUpUnsure(new ApiError('El servidor está teniendo problemas', 503))).toBe(true);
    expect(cashTopUpUnsure(new ApiError('Tarda', 408))).toBe(true);
    expect(cashTopUpUnsure(new TypeError('Failed to fetch'))).toBe(true);
    expect(cashTopUpUnsure(new SyntaxError('Unexpected end of JSON input'))).toBe(true);
    // El datáfono: estado 0 = sin conexión.
    expect(cashTopUpUnsure(Object.assign(new Error('No se pudo conectar'), { status: 0 }))).toBe(true);
    // Rechazos del API (no se cargó): tope de efectivo, saldo bloqueado, demasiados intentos, sesión.
    expect(cashTopUpUnsure(new ApiError('Tope de efectivo', 409, 'CASH_LIMIT'))).toBe(false);
    expect(cashTopUpUnsure(new ApiError('Bloqueado', 403))).toBe(false);
    expect(cashTopUpUnsure(new ServerUnavailableError('Demasiados intentos', 429, 'too-many'))).toBe(false);
    expect(cashTopUpUnsure(new SessionExpiredError('Vuelve a entrar'))).toBe(false);
    expect(cashTopUpUnsure(Object.assign(new Error('cancelado'), { name: 'AbortError' }))).toBe(false);
  });
});

describe('4.3 con la «Comisión del servicio»: el tope del efectivo es lo que paga (saldo + comisión)', () => {
  const ON: ReceptionOptions = { ...OPTIONS, serviceFee: { enabled: true, cardBps: 1000, topUpBps: 1200 } };
  it('900 € + 12 % = 1.008 €: en efectivo no; 890 € + 106,80 € = 996,80 €: sí', () => {
    expect(methodButtons(ON, { kind: 'new' }, 90_000, 'cash')[0]).toMatchObject({
      method: 'cash',
      problem: expect.stringMatching(/999,99 € por pago \(saldo \+ comisión del servicio\)/),
    });
    expect(methodButtons(ON, { kind: 'new' }, 89_000, 'cash')[0]).toMatchObject({ method: 'cash', problem: null });
  });
});

describe('la fila de arriba mientras no se sabe si se cargó (prueba real: con «No sabemos si se han cargado» seguía diciendo «sin saldo»)', () => {
  const row = (read: Parameters<typeof cashUnsureRow>[0], checking: boolean) => {
    const r = cashUnsureRow(read, 5_000, checking);
    return { title: r.title, detail: eur(r.detail) };
  };

  it('ficha nueva: ni «sin saldo» (el servidor puede haberla cargado ya) ni nada que no se sepa: que se está comprobando', () => {
    expect(row({ view: NUEVO, nfc: FICHA }, true)).toEqual({ title: 'NFC nuevo', detail: 'Ficha nº 00736903 · comprobando la recarga de 50 €' });
    expect(row({ view: NUEVO, nfc: FICHA }, false)).toEqual({ title: 'NFC nuevo', detail: 'Ficha nº 00736903 · recarga de 50 € por comprobar' });
    expect(row({ view: NUEVO_SIN, nfc: FICHA }, true).detail).toBe('Ficha sin número impreso · comprobando la recarga de 50 €');
  });

  it('un saldo que ya tenía: tampoco «Le quedan 35 €» (puede que ya sean 85 €)', () => {
    expect(row({ view: saldo(), nfc: FICHA }, true)).toEqual({ title: 'Ficha nº 0388', detail: 'Comprobando la recarga de 50 € · R3D-8LP' });
    expect(row({ view: saldo({ fichaNumber: null }), nfc: null }, false)).toEqual({ title: 'Saldo R3D-8LP', detail: 'Recarga de 50 € por comprobar' });
  });

  it('por el número impreso (código tapado) y el saldo nuevo sin NFC', () => {
    const porNumero = { kind: 'saldo' as const, printedNumber: '00017', codeHint: 'K7Q-•••', balanceCents: 3_500, cashOutCents: 3_500, cashOutNote: null,
      hasPin: true, blocked: false, closeRequested: false, isHomeVenue: true };
    expect(row({ view: null, nfc: null, number: porNumero }, true)).toEqual({ title: 'Ficha nº 00017', detail: 'Comprobando la recarga de 50 € · K7Q-•••' });
    expect(row({ view: null, nfc: null }, true)).toEqual({ title: 'Saldo nuevo', detail: 'Sin NFC · comprobando la recarga de 50 €' });
  });

  it('nunca «sin saldo» ni «Le quedan»', () => {
    for (const checking of [true, false]) {
      for (const read of [{ view: NUEVO, nfc: FICHA }, { view: saldo(), nfc: FICHA }, { view: null, nfc: null }]) {
        expect(row(read, checking).detail).not.toMatch(/sin saldo|Le quedan/i);
      }
    }
  });

  it('ReceptionDesk la usa en la pantalla «Comprobando» / «No sabemos si se han cargado»', () => {
    const desk = readFileSync(new URL('../components/reception/desk/ReceptionDesk.tsx', import.meta.url), 'utf8');
    const unsure = desk.slice(desk.indexOf('function renderCashUnsure'), desk.indexOf('function renderLoaded'));
    expect(unsure).toMatch(/<DeskRowView \{\.\.\.cashUnsureRow\(read, amountCents, checking\)\} \/>/);
    expect(unsure).not.toMatch(/readRow\(read\)/);
  });
});
