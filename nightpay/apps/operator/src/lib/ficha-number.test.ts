import { describe, expect, it } from 'vitest';
import { fichaDigits, fichaShort, followsPrevious, nextPrintedNumber, notFollowingText, photoHint, wrongFichaText } from './ficha-number';

const plain = (printed: string) =>
  fichaDigits(printed)
    .map((p) => p.text)
    .join('');
const strong = (printed: string) =>
  fichaDigits(printed)
    .filter((p) => p.strong)
    .map((p) => p.text)
    .join('');

describe('el número de la ficha en grande (A1)', () => {
  it('en grupos de 4 desde la derecha, con la parte que importa en negrita', () => {
    expect(plain('00001013')).toBe('0000 1013');
    expect(strong('00001013')).toBe('1013');
    expect(plain('00736903')).toBe('0073 6903');
    expect(strong('00736903')).toBe('73 6903');
  });
  it('sin ceros delante, todo en negrita; corto, sin espacios', () => {
    expect(plain('1013')).toBe('1013');
    expect(strong('1013')).toBe('1013');
    expect(plain('017')).toBe('017');
    expect(strong('017')).toBe('17');
    expect(plain('123456789012')).toBe('1234 5678 9012');
  });
  it('todo ceros: el último cero importa (es el número 0)', () => {
    expect(strong('0000')).toBe('0');
  });
  it('sin número impreso: nada', () => {
    expect(fichaDigits(null)).toEqual([]);
    expect(fichaDigits('')).toEqual([]);
  });
  it('el corto, sin ceros delante (como se dice en voz alta)', () => {
    expect(fichaShort('00001013')).toBe('1013');
    expect(fichaShort(null)).toBeNull();
  });
});

describe('otra ficha en el mostrador (A3)', () => {
  it('«Esa es la 1014, no la 1013»', () => {
    expect(wrongFichaText('00001013', '00001014')).toBe('Esa es la 1014, no la 1013');
  });
  it('sin saber el número de la acercada (en blanco, de otro local…)', () => {
    expect(wrongFichaText('00001013', null)).toBe('Esa no es la 1013');
  });
  it('sin número la de este cliente', () => {
    expect(wrongFichaText(null, '00001014')).toBe('Esa es la 1014: no es la de este cliente');
    expect(wrongFichaText(null, null)).toBe('Esa no es la ficha de este cliente');
  });
});

describe('preparar fichas: ¿sigue a la anterior? (A12)', () => {
  it('la siguiente, con o sin ceros delante', () => {
    expect(followsPrevious('00001012', '00001013')).toBe(true);
    expect(followsPrevious('1012', '00001013')).toBe(true);
    expect(followsPrevious('00000999', '00001000')).toBe(true);
  });
  it('una cifra de más, de menos o repetida: no', () => {
    expect(followsPrevious('00001012', '00001015')).toBe(false);
    expect(followsPrevious('00001012', '00001012')).toBe(false);
    expect(followsPrevious('00001012', '00010130')).toBe(false);
    expect(followsPrevious('00001012', '00001011')).toBe(false);
  });
  it('sin anterior, o con lo que no son cifras: no se avisa', () => {
    expect(followsPrevious(null, '00001013')).toBeNull();
    expect(followsPrevious('00001012', '')).toBeNull();
  });
  it('B11: la app propone el siguiente, con los mismos ceros delante', () => {
    expect(nextPrintedNumber('00001012')).toBe('00001013');
    expect(nextPrintedNumber('0999')).toBe('1000');
    expect(nextPrintedNumber('9999')).toBe('10000');
    expect(nextPrintedNumber('17')).toBe('18');
    expect(nextPrintedNumber(null)).toBeNull();
    expect(nextPrintedNumber('999999999999')).toBeNull();
    // Lo propuesto sigue a la anterior: sin aviso de A12.
    expect(followsPrevious('00001012', nextPrintedNumber('00001012')!)).toBe(true);
  });
  it('el aviso: cuál debería ser, para compararlo con la ficha', () => {
    expect(notFollowingText('00001012', '00001015')).toBe('La anterior era la 1012: esta debería ser la 1013. Compruébalo con la ficha.');
    expect(notFollowingText('00001012', '00001013')).toBeNull();
    expect(notFollowingText(null, '00001013')).toBeNull();
  });
  it('números largos sin perder cifras', () => {
    expect(followsPrevious('999999999999', '1000000000000')).toBeNull();
    expect(followsPrevious('123456789011', '123456789012')).toBe(true);
  });
});

describe('CARGADO: la foto (A11)', () => {
  it('a la ficha, al código o a las dos', () => {
    expect(photoHint({ ficha: true, code: true })).toBe('Haz una foto a tu ficha o a tu código');
    expect(photoHint({ ficha: true, code: false })).toBe('Haz una foto a tu ficha');
    expect(photoHint({ ficha: false, code: true })).toBe('Haz una foto a tu código');
    expect(photoHint({ ficha: false, code: false })).toBeNull();
  });
});
