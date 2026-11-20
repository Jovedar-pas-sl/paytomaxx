import { describe, expect, it } from 'vitest';
import { SepaInputError, buildPain001, sepaAmount, sepaId, sepaText, type Pain001Input } from './sepa';

/** El fichero del banco (pain.001.001.03): estructura, sumas de control y textos SEPA. */

const DEBTOR_IBAN = 'ES9121000418450200051332';
const IBAN_A = 'ES7921000813610123456789';
const IBAN_B = 'ES6000491500051234567892';
const NOW = new Date('2027-06-25T06:30:00Z');

function input(extra: Partial<Pain001Input> = {}): Pain001Input {
  return {
    messageId: 'OXP20270625063000ABC123',
    createdAt: NOW,
    executionDate: '2027-06-25',
    debtor: { name: 'Comisión de Fiestas San Juan', iban: DEBTOR_IBAN },
    transfers: [
      { endToEndId: 'OXP-001', creditorName: 'Peña El Cántaro', creditorIban: IBAN_A, amountCents: 712_800, remittance: 'OxioParty Fiestas San Juan Peña El Cántaro' },
      { endToEndId: 'OXP-002', creditorName: 'Bar Plaza & Cía <S.L.>', creditorIban: IBAN_B, amountCents: 5, remittance: 'OxioParty Fiestas San Juan Barra de la Plaza' },
    ],
    ...extra,
  };
}

/** Lo que hay entre <tag> y </tag>, todas las veces. */
function all(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}(?: [^>]*)?>([^<]*)</${tag}>`, 'g'))].map((m) => m[1] ?? '');
}

function count(xml: string, tag: string): number {
  return xml.split(`<${tag}>`).length - 1;
}

describe('buildPain001', () => {
  const xml = buildPain001(input());

  it('es un pain.001.001.03 con su cabecera, una orden y una transferencia por caseta', () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03"');
    expect(count(xml, 'CstmrCdtTrfInitn')).toBe(1);
    expect(count(xml, 'GrpHdr')).toBe(1);
    expect(count(xml, 'PmtInf')).toBe(1);
    expect(count(xml, 'CdtTrfTxInf')).toBe(2);
    expect(all(xml, 'PmtMtd')).toEqual(['TRF']);
    expect(all(xml, 'Cd')).toEqual(['SEPA']);
    expect(all(xml, 'ChrgBr')).toEqual(['SLEV']);
    expect(all(xml, 'ReqdExctnDt')).toEqual(['2027-06-25']);
    expect(all(xml, 'CreDtTm')).toEqual(['2027-06-25T06:30:00']);
    // Etiquetas abiertas = cerradas (XML bien formado a grandes rasgos).
    for (const tag of ['Document', 'PmtInf', 'CdtTrfTxInf', 'Cdtr', 'CdtrAcct', 'Dbtr', 'DbtrAcct', 'DbtrAgt', 'RmtInf']) {
      expect(xml.split(`<${tag}>`).length + xml.split(`<${tag} `).length - 2).toBe(xml.split(`</${tag}>`).length - 1);
    }
  });

  it('NbOfTxs y CtrlSum cuadran, en la cabecera y en la orden', () => {
    expect(all(xml, 'NbOfTxs')).toEqual(['2', '2']);
    expect(all(xml, 'CtrlSum')).toEqual(['7128.05', '7128.05']);
    const amounts = all(xml, 'InstdAmt');
    expect(amounts).toEqual(['7128.00', '0.05']);
    expect(xml).toContain('<InstdAmt Ccy="EUR">7128.00</InstdAmt>');
    const sumCents = amounts.reduce((a, x) => a + Math.round(Number(x) * 100), 0);
    expect(sumCents).toBe(712_805);
  });

  it('el deudor es el local (su IBAN, banco NOTPROVIDED) y cada acreedor su caseta con su IBAN', () => {
    expect(all(xml, 'IBAN')).toEqual([DEBTOR_IBAN, IBAN_A, IBAN_B]);
    expect(xml).toContain('<DbtrAgt><FinInstnId><Othr><Id>NOTPROVIDED</Id></Othr></FinInstnId></DbtrAgt>');
    expect(all(xml, 'Nm')).toEqual(['Comision de Fiestas San Juan', 'Comision de Fiestas San Juan', 'Pena El Cantaro', 'Bar Plaza Cia S.L.']);
    expect(all(xml, 'Ustrd')).toEqual(['OxioParty Fiestas San Juan Pena El Cantaro', 'OxioParty Fiestas San Juan Barra de la Plaza']);
    expect(all(xml, 'EndToEndId')).toEqual(['OXP-001', 'OXP-002']);
    expect(all(xml, 'MsgId')).toEqual(['OXP20270625063000ABC123']);
  });

  it('nada sin escapar: ni & ni < ni > sueltos dentro de los textos', () => {
    const texts = [...all(xml, 'Nm'), ...all(xml, 'Ustrd')].join(' ');
    expect(texts).not.toMatch(/[&<>]/);
  });

  it('los IBAN con espacios o en minúsculas se normalizan; uno roto, error', () => {
    const ok = buildPain001(input({ transfers: [{ ...input().transfers[0]!, creditorIban: 'es79 2100 0813 6101 2345 6789' }] }));
    expect(all(ok, 'IBAN')[1]).toBe(IBAN_A);
    expect(() => buildPain001(input({ transfers: [{ ...input().transfers[0]!, creditorIban: 'ES79 ROTO' }] }))).toThrow(SepaInputError);
    expect(() => buildPain001(input({ debtor: { name: 'X', iban: '' } }))).toThrow(SepaInputError);
  });

  it('sin transferencias, con un importe a 0 o negativo, o con la fecha mal: error', () => {
    expect(() => buildPain001(input({ transfers: [] }))).toThrow(/No hay transferencias/);
    expect(() => buildPain001(input({ transfers: [{ ...input().transfers[0]!, amountCents: 0 }] }))).toThrow(SepaInputError);
    expect(() => buildPain001(input({ transfers: [{ ...input().transfers[0]!, amountCents: -100 }] }))).toThrow(SepaInputError);
    expect(() => buildPain001(input({ executionDate: '25/06/2027' }))).toThrow(SepaInputError);
    expect(() => buildPain001(input({ messageId: '###' }))).toThrow(/identificador/);
  });

  it('con una sola transferencia, una de cada; sin concepto, sin RmtInf', () => {
    const one = buildPain001(input({ transfers: [{ ...input().transfers[0]!, remittance: '' }] }));
    expect(all(one, 'NbOfTxs')).toEqual(['1', '1']);
    expect(all(one, 'CtrlSum')).toEqual(['7128.00', '7128.00']);
    expect(one).not.toContain('<RmtInf>');
  });
});

describe('textos e importes SEPA', () => {
  it('sin acentos ni signos raros, espacios juntos y recortado', () => {
    expect(sepaText('  Peña   «La Charanga» ñandú — Ça va!  ', 70)).toBe('Pena La Charanga nandu Ca va');
    expect(sepaText('Straße', 70)).toBe('Strasse');
    expect(sepaText('x'.repeat(200), 140)).toHaveLength(140);
    expect(sepaText("O'Donnell (tesorero) 1/2 +3 ?:,.-", 70)).toBe("O'Donnell (tesorero) 1/2 +3 ?:,.-");
  });

  it('los identificadores: letras, números y guiones, como mucho 35', () => {
    expect(sepaId('OXP 2027/06-25·Peña')).toBe('OXP202706-25Pena');
    expect(sepaId('A'.repeat(50))).toHaveLength(35);
  });

  it('los importes con punto y dos decimales', () => {
    expect(sepaAmount(0)).toBe('0.00');
    expect(sepaAmount(5)).toBe('0.05');
    expect(sepaAmount(123_456)).toBe('1234.56');
    expect(() => sepaAmount(1.5)).toThrow(SepaInputError);
  });
});
