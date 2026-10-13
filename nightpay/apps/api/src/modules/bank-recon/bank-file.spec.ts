import { describe, it, expect } from 'vitest';
import { BankFileError, normalizeHeader, parseAmount, parseBankFile, parseDateTime } from './bank-file';

/** Exportación de Canales (Redsys), como la descarga el portal: ";" y ";" final. */
const REDSYS_SEMICOLON = [
  'Fecha;Hora;Tipo operación;Cód. pedido;Resultado operación y código;Importe;Moneda;Importe Euros;Tipo de pago;Tipo pago original;N.º tarjeta;Titular;',
  '13/10/2026;23:18:59;Autorización;2610MLbhyfNg;Autorizada 741936;60.00;EUR;60.00;Challenge Visa;;415006******2715;;',
  '13/10/2026;23:40:02;Autorización;2610Zx81kQpa;Denegada 190;45,00;EUR;45,00;Visa;;415006******2715;;',
  '14/10/2026;1:05:10;Devolución;2610MLbhyfNg;Autorizada 098692;20;EUR;20;;;;;',
  '14/10/2026;2:00:00;Autorización;2610Ab12Cd34;Sin Finalizar 9998;10.00;EUR;10.00;;;;;',
].join('\r\n');

/** Variante con "," y número de terminal. */
const REDSYS_COMMA = [
  'Fecha,Hora,N.º terminal,Tipo operación,Cód. pedido,Resultado operación y código,Importe,Moneda,Importe Euros,Cierre de sesión,Tipo de pago,Tipo pago original,N.º tarjeta',
  '18/05/2026,9:07:38,1,Autorización,0001ABCDEFGH,Autorizada KD7NA5,"1.234,56",EUR,"1.234,56",,Visa,,',
  '18/05/2026,9:30:00,1,Anulación,0001ABCDEFGH,Autorizada KD7NA5,"1.234,56",EUR,"1.234,56",,Visa,,',
].join('\n');

describe('fichero de operaciones de Redsys (Canales)', () => {
  it('lee el CSV con ";": venta, denegada, devolución (positiva) y sin finalizar', () => {
    const out = parseBankFile('REDSYS', Buffer.from(REDSYS_SEMICOLON, 'utf8'));
    expect(out.rows).toHaveLength(4);
    expect(out.rows[0]).toMatchObject({
      kind: 'SALE',
      approved: true,
      amountCents: 6000,
      reference: '2610MLbhyfNg',
      authCode: '741936',
    });
    expect(out.rows[0]!.at!.toISOString()).toBe('2026-10-13T21:18:59.000Z');
    expect(out.rows[1]).toMatchObject({ approved: false, amountCents: 4500 });
    expect(out.rows[2]).toMatchObject({ kind: 'REFUND', approved: true, amountCents: 2000, authCode: '098692' });
    expect(out.rows[3]).toMatchObject({ approved: false });
    expect(out).toMatchObject({ periodFrom: '2026-10-13', periodTo: '2026-10-14' });
    expect(out.columns).toMatchObject({ reference: 'Cód. pedido', amount: 'Importe Euros' });
  });

  it('lee la variante con "," (comillas, miles con punto) y las anulaciones', () => {
    const out = parseBankFile('REDSYS', Buffer.from(REDSYS_COMMA, 'utf8'));
    expect(out.rows[0]).toMatchObject({ kind: 'SALE', amountCents: 123456, terminal: '1', authCode: 'KD7NA5' });
    expect(out.rows[1]).toMatchObject({ kind: 'VOID', reference: '0001ABCDEFGH' });
  });

  it('acepta BOM y ficheros en Latin-1 (Windows)', () => {
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(REDSYS_SEMICOLON, 'utf8')]);
    expect(parseBankFile('REDSYS', bom).rows).toHaveLength(4);
    const latin1 = Buffer.from(REDSYS_SEMICOLON, 'latin1');
    const out = parseBankFile('REDSYS', latin1);
    expect(out.rows[2]!.kind).toBe('REFUND');
  });

  it('"Excel" que en realidad es una tabla HTML', () => {
    const html = `<html><body><table>
      <tr><th>Fecha</th><th>Tipo operaci&oacute;n</th><th>N&uacute;mero de pedido</th><th>Importe</th><th>Resultado</th></tr>
      <tr><td>13-10-2026 22:10:00</td><td>Autorización</td><td>0412ABCD1234</td><td>75,00 EUR</td><td>Autorizada 123456</td></tr>
      <tr><td colspan="4">Total</td><td>75,00</td></tr>
    </table></body></html>`;
    const out = parseBankFile('REDSYS', Buffer.from(html, 'utf8'));
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({ reference: '0412ABCD1234', amountCents: 7500, approved: true });
    // La fila de totales no es una operación: ni se lee ni cuenta como no leída.
    expect(out.skipped).toBe(0);
  });

  it('Excel .xlsx o sin columnas reconocibles → mensaje claro', () => {
    expect(() => parseBankFile('REDSYS', Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toThrow(/guárdalo como CSV/);
    expect(() => parseBankFile('REDSYS', Buffer.from('a;b;c\n1;2;3', 'utf8'))).toThrow(BankFileError);
    expect(() => parseBankFile('REDSYS', Buffer.from('a;b;c\n1;2;3', 'utf8'))).toThrow(/Primera línea del fichero: a \| b \| c/);
  });
});

describe('fichero de Paytef (datáfonos)', () => {
  it('número de operación, terminal y autorización', () => {
    const csv = [
      'Fecha;Hora;Terminal;Nº Operación;Tipo;Importe;Autorización;Resultado',
      '13/10/2026;23:59:01;TPV01;000077;Venta;50,00;A1B2C3;Aprobada',
      '14/10/2026;00:10:00;TPV01;000078;Devolución;-10,00;Z9Y8X7;Aprobada',
    ].join('\n');
    const out = parseBankFile('PAYTEF', Buffer.from(csv, 'utf8'));
    expect(out.rows[0]).toMatchObject({ kind: 'SALE', reference: '000077', terminal: 'TPV01', authCode: 'A1B2C3' });
    expect(out.rows[1]).toMatchObject({ kind: 'REFUND', amountCents: 1000 });
  });
});

describe('piezas', () => {
  it('importes', () => {
    expect(parseAmount('60.00')).toBe(6000);
    expect(parseAmount('20')).toBe(2000);
    expect(parseAmount('75,00 EUR')).toBe(7500);
    expect(parseAmount('1.234,56')).toBe(123456);
    expect(parseAmount('1,234.56')).toBe(123456);
    expect(parseAmount('1.234')).toBe(123400);
    expect(parseAmount('-10,50')).toBe(-1050);
    expect(parseAmount('Total')).toBeNull();
    expect(parseAmount('')).toBeNull();
  });

  it('fechas en hora de Madrid (verano e invierno)', () => {
    expect(parseDateTime('13/10/2026', '23:18:59')!.toISOString()).toBe('2026-10-13T21:18:59.000Z');
    expect(parseDateTime('15/01/2026 9:05', '')!.toISOString()).toBe('2026-01-15T08:05:00.000Z');
    expect(parseDateTime('2026-10-13', '')!.toISOString()).toBe('2026-10-12T22:00:00.000Z');
    expect(parseDateTime('Total', '')).toBeNull();
  });

  it('cabeceras sin acentos ni signos', () => {
    expect(normalizeHeader('N.º terminal')).toBe('numeroterminal');
    expect(normalizeHeader('Nº de terminal')).toBe('numerodeterminal');
    expect(normalizeHeader('Cód. pedido')).toBe('codpedido');
    expect(normalizeHeader('Nombre')).toBe('nombre');
  });
});

describe('lo que no se puede leer no desaparece', () => {
  const HEADER = 'Fecha;Hora;Tipo operación;Cód. pedido;Resultado operación y código;Importe';

  it('una operación ilegible se cuenta y se dice en qué línea está', () => {
    const csv = [
      HEADER,
      '13/10/2026;23:00:00;Autorización;A1;Autorizada 111111;10.00',
      '13/10/2026;23:05:00;Autorización;A2;Autorizada 222222;??',
      ...Array.from({ length: 20 }, (_, i) => `13/10/2026;23:10:00;Autorización;B${i};Autorizada 333333;5.00`),
    ].join('\n');
    const out = parseBankFile('REDSYS', Buffer.from(csv, 'utf8'));
    expect(out.rows).toHaveLength(21);
    expect(out).toMatchObject({ skipped: 1, skippedLines: [3] });
  });

  it('si son muchas, el fichero no se acepta', () => {
    const csv = [
      HEADER,
      '13/10/2026;23:00:00;Autorización;A1;Autorizada 111111;10.00',
      '13/10/2026;23:01:00;Autorización;A2;Autorizada 111111;xx',
      '13/10/2026;23:02:00;Autorización;A3;Autorizada 111111;xx',
      '13/10/2026;23:03:00;Autorización;A4;Autorizada 111111;xx',
    ].join('\n');
    expect(() => parseBankFile('REDSYS', Buffer.from(csv, 'utf8'))).toThrow(/No se pudieron leer 3 operaciones/);
  });

  it('confirmación de preautorización = cobro; anulación de devolución = anulación; autorización que acaba en KO', () => {
    const csv = [
      HEADER,
      '13/10/2026;23:00:00;Confirmación de preautorización;C1;Autorizada 111111;30.00',
      '13/10/2026;23:01:00;Preautorización;C2;Autorizada 111111;30.00',
      '13/10/2026;23:02:00;Anulación de devolución;C3;Autorizada 111111;5.00',
      '13/10/2026;23:03:00;Autorización;C4;Autorizada A1B2KO;7.00',
      '13/10/2026;23:04:00;Autorización;C5;KO;7.00',
    ].join('\n');
    const rows = parseBankFile('REDSYS', Buffer.from(csv, 'utf8')).rows;
    expect(rows.map((r) => [r.reference, r.kind, r.approved])).toEqual([
      ['C1', 'SALE', true],
      ['C2', 'OTHER', true],
      ['C3', 'VOID', true],
      ['C4', 'SALE', true],
      ['C5', 'SALE', false],
    ]);
    expect(rows[3]!.authCode).toBe('A1B2KO');
  });
});
