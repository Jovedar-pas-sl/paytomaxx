import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ReceptionDeskSaldo, ReceptionOptions } from '@nightpay/contracts';
import { ApiError, ServerUnavailableError, SessionExpiredError } from '@nightpay/api-client';
import { cashAttemptRef, receptionAttempt } from './reception';
import {
  attemptOnStep,
  cashTopUpUnsure,
  cashTopUpWallet,
  cashUnsureRow,
  codeBoxes,
  codeInput,
  deskRechargeWhat,
  deskRow,
  entryRow,
  FICHA_IN_HAND,
  lastTopUpOf,
  readFicha,
  recentTopUpLine,
  roughBalanceQuestion,
  deskTarget,
  canChoosePin,
  canChoosePinAfterLoad,
  fichaGivenNote,
  fichaLookupText,
  fichaText,
  handOverLine,
  loadedMoneyLine,
  qrTopUpMethod,
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
    expect(handOverLine(NUEVO_SIN, true)).toBe('Dale la ficha · ficha sin número impreso');
  });

  it('con saldo: lo que le queda en la entrada; «leída» a la salida', () => {
    expect(eur(deskRow(saldo(), 'entrada').detail)).toBe('Le quedan 35 € · R3D-8LP');
    expect(deskRow(saldo({ balanceCents: 0 }), 'entrada').detail).toBe('Sin saldo · R3D-8LP');
    expect(deskRow(saldo(), 'salida')).toEqual({ title: 'Ficha nº 0388', detail: 'Saldo R3D-8LP · leída' });
    // Por el código (sin NFC): el saldo en el título.
    expect(deskRow(saldo({ fichaNumber: null }), 'salida')).toEqual({ title: 'Saldo R3D-8LP', detail: 'Sin NFC · por su código' });
  });

  it('el chip de 4.3: «Recarga» (la ficha va en grande debajo), su código o un saldo nuevo sin ficha', () => {
    expect(rechargeChip(NUEVO)).toBe('Recarga');
    expect(rechargeChip(NUEVO_SIN)).toBe('Recarga · ficha sin número impreso');
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

  it('pagada con bitcoin desde su móvil: «Bitcoin: … en la cartera del local», ni tarjeta ni caja', () => {
    const btc = loadedMoneyLine('bitcoin', 5_000, 600);
    expect({ ...btc, amount: eur(btc.amount), tail: eur(btc.tail) }).toEqual({ label: 'Bitcoin:', amount: '56 €', tail: 'en la cartera del local (con 6 € de comisión)' });
    // Lo dice el sondeo del QR; sin respuesta (o un API de antes), como siempre: tarjeta.
    expect(qrTopUpMethod({ payMethod: 'bitcoin' })).toBe('bitcoin');
    expect(qrTopUpMethod({ payMethod: 'card' })).toBe('card');
    expect(qrTopUpMethod({})).toBe('card');
    expect(qrTopUpMethod(null)).toBe('card');
  });

  it('y con la ficha: dársela (nueva), devolvérsela (la suya) o el código si no tiene (su número va en grande encima)', () => {
    expect(handOverLine(NUEVO, true)).toBe('Dale la ficha');
    expect(handOverLine(saldo(), true)).toBe('Devuélvele su ficha');
    expect(handOverLine(saldo({ fichaNumber: null }), true)).toBe('Saldo sin ficha');
    expect(handOverLine(null, false)).toBe('Sin ficha: que apunte su código');
    expect(handOverLine(saldo({ printedNumber: null }), true)).toBe('Devuélvele su ficha · ficha sin número impreso');
  });
});

describe('¿Cuánto carga? con el número de la ficha en grande (A1)', () => {
  it('la leída: su número aparte, para verlo en grande, y que mire la que tiene en la mano', () => {
    expect(entryRow({ view: NUEVO, nfc: FICHA })).toEqual({ title: 'Ficha nueva', ficha: '00736903', detail: 'Sin saldo', hint: FICHA_IN_HAND });
    const suya = entryRow({ view: saldo(), nfc: FICHA });
    expect({ ...suya, detail: eur(suya.detail) }).toEqual({ title: 'Ficha', ficha: '0388', detail: 'Le quedan 35 € · R3D-8LP', hint: FICHA_IN_HAND });
  });
  it('por el código no la tienen delante: el número, sin «la que tienes en la mano»', () => {
    expect(entryRow({ view: saldo(), nfc: null }).hint).toBeNull();
    expect(entryRow({ view: saldo(), nfc: null }).ficha).toBe('0388');
  });
  it('sin número impreso, sin ficha o saldo nuevo sin ficha: sin número en grande', () => {
    expect(entryRow({ view: NUEVO_SIN, nfc: FICHA })).toEqual({ title: 'Ficha nueva', detail: 'Sin número impreso · sin saldo', ficha: null, hint: null });
    expect(entryRow({ view: saldo({ fichaNumber: null }), nfc: null })).toMatchObject({ title: 'Saldo R3D-8LP', ficha: null });
    expect(entryRow({ view: saldo({ fichaNumber: null }), nfc: null }).detail).toMatch(/sin ficha$/);
    expect(entryRow({ view: null, nfc: null })).toEqual({ title: 'Saldo nuevo', detail: 'Sin ficha: se queda con su código', ficha: null, hint: null });
  });
  it('lo que se enseña en grande en «¿Cómo paga?» y en CARGADO', () => {
    expect(readFicha({ view: NUEVO })).toBe('00736903');
    expect(readFicha({ view: NUEVO_SIN })).toBeNull();
    expect(readFicha({ view: saldo({ fichaNumber: null }) })).toBeNull();
    expect(readFicha({ view: null })).toBeNull();
  });
  it('la última recarga, durante 10 min en la fila de la ficha (A4)', () => {
    const now = Date.parse('2026-11-10T01:00:00Z');
    const at = (min: number) => new Date(now - min * 60_000).toISOString();
    const sergio = { at: at(2), amountCents: 5_000, method: 'cash' as const, byName: 'Sergio' };
    expect(eur(recentTopUpLine(sergio, now) ?? '')).toBe('Cargada hace 2 min: 50 € en efectivo (Sergio)');
    expect(eur(recentTopUpLine({ ...sergio, method: 'card', byName: null }, now) ?? '')).toBe('Cargada hace 2 min: 50 € con tarjeta');
    expect(eur(recentTopUpLine({ ...sergio, method: 'bitcoin', byName: null }, now) ?? '')).toBe('Cargada hace 2 min: 50 € con bitcoin');
    expect(eur(recentTopUpLine({ ...sergio, at: at(0) }, now, false) ?? '')).toBe('Cargado hace un momento: 50 € en efectivo (Sergio)');
    // El reloj del móvil algo atrasado: «hace un momento», nunca «hace -1 min».
    expect(recentTopUpLine({ ...sergio, at: at(-1) }, now)).toMatch(/hace un momento/);
    expect(recentTopUpLine({ ...sergio, at: at(10) }, now)).toBeNull();
    expect(recentTopUpLine(null, now)).toBeNull();
    expect(lastTopUpOf({ view: saldo({ lastTopUp: sergio }) })).toBe(sergio);
    expect(lastTopUpOf({ view: NUEVO })).toBeNull();
  });

  it('por su número: el número en grande, «Compruébalo con la ficha» y «¿Le quedan unos 35 €?» (A6)', () => {
    const porNumero = {
      kind: 'saldo' as const, printedNumber: '00001013', codeHint: 'K7Q-•••', balanceCents: 3_540, cashOutCents: 0, cashOutNote: null,
      hasPin: true, blocked: false, closeRequested: false, isHomeVenue: true,
    };
    const row = entryRow({ view: null, nfc: null, number: porNumero });
    expect({ ...row, detail: eur(row.detail), ask: eur(row.ask ?? '') }).toEqual({
      title: 'Ficha', ficha: '00001013', detail: 'Le quedan 35,40 € · K7Q-•••', hint: 'Compruébalo con la ficha', ask: '¿Le quedan unos 35 €?',
    });
    const ask = (cents: number) => eur(roughBalanceQuestion(cents));
    expect(ask(3_740)).toBe('¿Le quedan unos 35 €?');
    expect(ask(3_760)).toBe('¿Le quedan unos 40 €?');
    expect(ask(1_000)).toBe('¿Le quedan unos 10 €?');
    expect(ask(740)).toBe('¿Le quedan unos 7 €?');
    expect(ask(40)).toBe('¿Le queda menos de 1 €?');
    expect(ask(0)).toBe('¿Ya no le queda nada?');
    // Leída o por su código, no se pregunta.
    expect(entryRow({ view: saldo(), nfc: FICHA }).ask).toBeUndefined();
  });

  it('B10: recepción pone el PIN a un saldo que ya existía tras recargarlo, solo con su ficha leída', () => {
    expect(canChoosePin(saldo({ hasPin: false }), 'WAITER')).toBe(false);
    expect(canChoosePinAfterLoad(saldo({ hasPin: false }), 'WAITER', true)).toBe(true);
    // Por su código o por su número (sin la ficha delante), no: el encargado.
    expect(canChoosePinAfterLoad(saldo({ hasPin: false }), 'WAITER', false)).toBe(false);
    expect(canChoosePinAfterLoad(saldo({ hasPin: false }), 'MANAGER', false)).toBe(true);
    expect(canChoosePinAfterLoad(NUEVO, 'WAITER', true)).toBe(true);
  });

  it('nunca «NFC» en lo que ve el personal', () => {
    for (const row of [entryRow({ view: NUEVO, nfc: FICHA }), entryRow({ view: null, nfc: null }), entryRow({ view: saldo({ fichaNumber: null }), nfc: null })]) {
      expect(`${row.title} ${row.detail} ${row.hint ?? ''}`).not.toMatch(/NFC/);
    }
  });
});

describe('la salida (4.5)', () => {
  it('devuelto: el NFC al stock, o lo que le queda (con tarjeta) y quién lo devuelve', () => {
    expect(refundDoneLine(0)).toMatch(/vuelve al stock/);
    expect(eur(refundDoneLine(1_500))).toMatch(/^Le quedan 15 € \(con tarjeta\)/);
    // Lo que entró con bitcoin: ni efectivo ni tarjeta, con el encargado.
    expect(eur(refundDoneLine(1_500, 1_500))).toBe(
      'Le quedan 15 € (con bitcoin): se quedan como saldo para otra noche, no se devuelven. Se lleva su NFC.',
    );
    expect(eur(refundDoneLine(5_000, 2_000))).toMatch(/^Le quedan 50 €: 30 € con tarjeta \(los devuelve el dueño «A la tarjeta»\) y 20 € con bitcoin \(se quedan como saldo para otra noche/);
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
    expect(a).toBe(`2000|cash|ficha:${FICHA.card}`);
    // La misma ficha (un corte, un doble toque): lo mismo.
    expect(deskRechargeWhat(2_000, 'cash', { view: NUEVO, nfc: FICHA })).toBe(a);
  });

  it('S-4: ficha nueva → recarga hecha → la misma ficha leída ya con saldo: la misma clave (no se carga dos veces)', () => {
    const storage = new Map<string, string>();
    const tab = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) };
    const before = cashAttemptRef(tab, () => 1_000);
    before.current = receptionAttempt(before.current, deskRechargeWhat(5_000, 'cash', { view: NUEVO, nfc: FICHA }));
    const key = before.current.key;
    // El servidor la cargó y la pantalla falló: la app vuelve a empezar y la ficha ya es un saldo.
    const after = cashAttemptRef(tab, () => 61_000);
    expect(receptionAttempt(after.current, deskRechargeWhat(5_000, 'cash', { view: saldo(), nfc: FICHA })).key).toBe(key);
  });

  it('dos recargas a propósito a la misma ficha no se juntan: al terminar una (o con «Siguiente cliente») la clave se borra', () => {
    const ref = cashAttemptRef(null);
    ref.current = receptionAttempt(ref.current, deskRechargeWhat(5_000, 'cash', { view: NUEVO, nfc: FICHA }));
    const first = ref.current.key;
    ref.current = null; // finish() o restart()
    ref.current = receptionAttempt(ref.current, deskRechargeWhat(5_000, 'cash', { view: saldo(), nfc: FICHA }));
    expect(ref.current.key).not.toBe(first);
    const desk = readFileSync(new URL('../components/reception/desk/ReceptionDesk.tsx', import.meta.url), 'utf8');
    expect(desk).toMatch(/function restart\([^)]*\): void \{\s*attempt\.current = null;/);
    expect(desk).toMatch(/attempt\.current = null;\s*go\(\{ kind: 'loaded'/);
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
