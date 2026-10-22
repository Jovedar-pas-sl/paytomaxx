import { describe, expect, it } from 'vitest';
import type { ReceptionDeskSaldo, ReceptionOptions } from '@nightpay/contracts';
import {
  codeBoxes,
  codeInput,
  deskRow,
  deskTarget,
  fichaText,
  handOverLine,
  loadedMoneyLine,
  methodButtons,
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

  it('la nota del PIN: se pone luego; hace falta desde el máximo sin PIN del local', () => {
    expect(eur(pinNote(2_000))).toBe('El PIN lo pone luego, solo hace falta para más de 20 €.');
    expect(pinNote(0)).toMatch(/hace falta para pagar con el NFC/);
  });
});

describe('CARGADO (4.4)', () => {
  it('lo que hace recepción con el dinero', () => {
    const cash = loadedMoneyLine('cash', 5_000);
    expect({ ...cash, amount: eur(cash.amount) }).toEqual({ label: 'Efectivo:', amount: '50 €', tail: 'a la caja' });
    expect(loadedMoneyLine('card', 5_000)).toMatchObject({ label: 'Tarjeta:', tail: 'en su móvil' });
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
