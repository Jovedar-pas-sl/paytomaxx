import { describe, it, expect } from 'vitest';
import { transferConcept, transfersCsv } from './party-refund-csv';
import { refundMail } from './party-refund-email';
import { mineView, refundTotals } from './party-refunds.service';
import { partyBrand } from './party-brand';

const IBAN = 'ES9121000418450200051332';

describe('devoluciones: lo que ve el asistente y el panel', () => {
  it('el asistente ve su IBAN tapado, nunca entero', () => {
    const v = mineView({
      id: 'r-1',
      method: 'TRANSFER',
      amountCents: 500,
      status: 'PENDING',
      createdAt: new Date('2027-06-25T09:00:00Z'),
      doneAt: null,
      iban: IBAN,
    });
    expect(v).toEqual({ id: 'r-1', method: 'TRANSFER', amountCents: 500, status: 'PENDING', createdAt: '2027-06-25T09:00:00.000Z', doneAt: null, ibanHint: 'ES91 •••• •••• 1332' });
    expect(JSON.stringify(v)).not.toContain('0418');
  });

  it('los totales por estado y forma, con lo donado aparte', () => {
    const t = refundTotals([
      { status: 'PENDING', method: 'CARD', count: 2, cents: 2100 },
      { status: 'PENDING', method: 'TRANSFER', count: 1, cents: 500 },
      { status: 'DONE', method: 'CARD', count: 1, cents: 800 },
      { status: 'DONE', method: 'DONATE', count: 3, cents: 1700 },
      { status: 'CANCELED', method: 'TRANSFER', count: 1, cents: 300 },
      { status: 'CANCELED', method: 'CARD', count: 1, cents: 100 },
    ]);
    expect(t.pending.CARD).toEqual({ count: 2, cents: 2100 });
    expect(t.pending.TRANSFER).toEqual({ count: 1, cents: 500 });
    expect(t.done.CARD).toEqual({ count: 1, cents: 800 });
    expect(t.done.DONATE).toEqual({ count: 3, cents: 1700 });
    expect(t.canceled).toEqual({ count: 2, cents: 400 });
    expect(t.donatedCents).toBe(1700);
  });
});

describe('el CSV de las transferencias pendientes', () => {
  it('para Excel en español, con el IBAN entero y el concepto (sin datos del asistente)', () => {
    const csv = transfersCsv(
      [
        { id: 'abcdef12-0000-4000-8000-000000000000', createdAt: new Date('2027-06-25T09:05:00Z'), amountCents: 1250, iban: IBAN, email: 'ana@correo.es', pulsera: 'P-0412', walletCode: 'K7Q-4M2' },
        { id: '12345678-0000-4000-8000-000000000000', createdAt: new Date('2027-06-25T10:00:00Z'), amountCents: 300, iban: IBAN, email: '=HYPERLINK("x")', pulsera: null, walletCode: null },
      ],
      'OxioParty',
    );
    const lines = csv.replace('﻿', '').trim().split('\r\n');
    expect(lines[0]).toBe('Pedida el;Hora;Pulsera;Código del saldo;Importe;IBAN;Concepto;Correo;Referencia');
    // Los códigos como ="…" (Excel no les quita los ceros ni los toma por números; reports/csv.ts).
    const code = (v: string) => `"=""${v}"""`;
    expect(lines[1]).toBe(`25/06/2027;11:05;${code('P-0412')};${code('K7Q-4M2')};12,50;${code(IBAN)};Devolución OxioParty P-0412;ana@correo.es;${code('abcdef12')}`);
    // Lo que escribe una persona nunca se ejecuta como fórmula en Excel.
    expect(lines[2]).toContain(`;"'=HYPERLINK(""x"")";`);
    expect(lines[2]).toContain('Devolución OxioParty 12345678');
    expect(csv.startsWith('﻿')).toBe(true);
  });

  it('el concepto, con la pulsera o el principio de la referencia', () => {
    expect(transferConcept('OxioParty', 'P-0007', 'x')).toBe('Devolución OxioParty P-0007');
    expect(transferConcept('Peñas', null, 'abcdef1234')).toBe('Devolución Peñas abcdef12');
  });
});

describe('el justificante por correo', () => {
  const base = { to: 'ana@correo.es', brand: 'OxioParty', venueName: 'Fiestas de San Juan', amountCents: 1300, pulsera: 'P-0412', at: new Date('2027-06-25T09:00:00Z') };

  it('al pedirla: el importe, la forma y la pulsera; el IBAN, tapado', () => {
    const m = refundMail({ ...base, kind: 'asked', method: 'TRANSFER', ibanHint: 'ES91 •••• •••• 1332' });
    expect(m.subject).toBe('OxioParty · Pedido: te devolvemos 13,00 €');
    expect(m.text).toContain('por transferencia a ES91 •••• •••• 1332');
    expect(m.text).toContain('Pulsera P-0412 · Fiestas de San Juan');
    expect(m.html).not.toContain(IBAN);
  });

  it('hecha a la tarjeta y la donación', () => {
    expect(refundMail({ ...base, kind: 'done', method: 'CARD', ibanHint: null }).subject).toBe('OxioParty · Hecho: 13,00 € de vuelta');
    expect(refundMail({ ...base, kind: 'done', method: 'DONATE', ibanHint: null }).subject).toBe('OxioParty · Gracias: 13,00 € para la comisión de fiestas');
  });

  it('el nombre de la fiesta va escapado en el HTML', () => {
    expect(refundMail({ ...base, venueName: '<b>Peña</b>', kind: 'asked', method: 'CARD', ibanHint: null }).html).toContain('&lt;b&gt;Peña&lt;/b&gt;');
  });
});

describe('la marca con OxioParty', () => {
  it('BRAND_NAME si está; si no, «OxioParty»', () => {
    expect(partyBrand({})).toBe('OxioParty');
    expect(partyBrand({ BRAND_NAME: '  Peñas  ' })).toBe('Peñas');
    expect(partyBrand({ BRAND_NAME: '' })).toBe('OxioParty');
  });
});
