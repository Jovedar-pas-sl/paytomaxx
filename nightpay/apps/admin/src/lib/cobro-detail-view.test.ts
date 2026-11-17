import { describe, expect, it } from 'vitest';
import type { CobroDetail, CobroDetailDevice, VenueSection } from '@nightpay/contracts';
import {
  amountRows,
  bankRows,
  cardMoreText,
  detailStatus,
  deviceRow,
  flagTexts,
  lineLabel,
  methodText,
  refFromSearch,
  shareTextOf,
  splitRows,
  undoText,
  viaWord,
  whereText,
  withoutRef,
} from './cobro-detail-view';

const eur = (c: number) => `${(c / 100).toFixed(2).replace('.', ',')} €`;
const when = (iso: string) => iso.slice(11, 16);

const detail: CobroDetail = {
  audience: 'MANAGER',
  kind: 'PAYMENT',
  id: 'p-1',
  ref: 'C-0024',
  confirmationCode: 'K7Q',
  status: 'AUTHORIZED',
  createdAt: '2026-11-08T00:58:00.000Z',
  paidAt: '2026-11-08T01:00:00.000Z',
  venueName: 'Sala Bambú',
  sections: [
    { category: 'DRINKS', amountCents: 2000 },
    { category: 'ROOMS', amountCents: 8000 },
  ],
  lines: [{ label: 'Copa', qty: 2, unitCents: 1000, amountCents: 2000, category: 'DRINKS', invitedName: 'Ana' }],
  service: 'Copa',
  isTopUp: false,
  amountCents: 10000,
  tipCents: 500,
  serviceFeeCents: 150,
  totalCents: 10650,
  chargedBy: { name: 'Ana López', role: 'OPERATOR' },
  method: { method: 'CARD', label: 'Tarjeta Visa ••4242', cardBrand: 'Visa', cardLast4: '4242', fichaNumber: null, via: 'QR', walletHint: null },
  undo: [],
  flags: ['PAID_TWICE'],
  panelUrl: 'https://admin.oxiopay.test/?s=hoy&t=cobros&ref=C-0024',
  sensitive: null,
  verify: { required: true, method: 'totp', verifiedUntil: null },
};

const sections = [
  { code: 'DRINKS', label: 'Copas' },
  { code: 'ROOMS', label: 'Habitaciones' },
] as unknown as VenueSection[];

describe('lo pagado', () => {
  it('importe, propina, comisión del servicio y total, cada uno en su línea', () => {
    expect(amountRows(detail, eur)).toEqual([
      { label: 'Importe', value: '100,00 €' },
      { label: 'Propina', value: '5,00 €' },
      { label: 'Comisión del servicio', value: '1,50 €' },
      { label: 'Total', value: '106,50 €' },
    ]);
  });

  it('una línea con su cantidad y la invitación', () => {
    expect(lineLabel(detail.lines[0]!)).toBe('2× Copa · invitación a Ana');
    expect(lineLabel({ ...detail.lines[0]!, qty: 1, invitedName: null })).toBe('Copa');
  });
});

describe('dónde y cómo', () => {
  it('el local y las secciones con su nombre', () => {
    expect(whereText(detail, sections)).toBe('Sala Bambú · Copas y Habitaciones');
    expect(whereText({ ...detail, isTopUp: true }, sections)).toBe('Sala Bambú · Recarga de saldo');
  });

  it('cómo se pagó, con «ficha» y nunca «NFC»', () => {
    expect(methodText(detail)).toBe('Tarjeta Visa ••4242 · QR');
    const saldo = { method: { ...detail.method, label: 'Saldo K7Q-•••', fichaNumber: '0522', via: 'NFC sin PIN' } };
    expect(methodText(saldo)).toBe('Saldo K7Q-••• · ficha nº 0522 · ficha sin PIN');
    expect(viaWord('NFC')).toBe('ficha');
    expect(viaWord(null)).toBeNull();
  });
});

describe('palabras únicas', () => {
  it('lo pagado que vuelve es «Devuelto»; lo no pagado, «Cancelado»', () => {
    const at = '2026-11-08T01:10:00.000Z';
    expect(undoText({ kind: 'REFUND', at, amountCents: 1000, by: 'Javi', reason: 'Copa derramada', status: 'SUCCEEDED' }, eur, when)).toBe(
      'Devuelto a la tarjeta: 10,00 € · 01:10 · Javi · «Copa derramada» · hecha',
    );
    expect(undoText({ kind: 'VOID', at, amountCents: 1000, by: null, reason: null, status: null }, eur, when)).toBe('Devuelto al saldo: 10,00 € · 01:10');
    expect(undoText({ kind: 'CANCEL', at, amountCents: null, by: 'Ana', reason: null, status: null }, eur, when)).toBe('Cancelado sin pagar · 01:10 · Ana');
  });

  it('lo pagado con bitcoin devuelto en efectivo dice «Devuelto en efectivo», no «a la tarjeta»', () => {
    const at = '2026-11-08T01:10:00.000Z';
    expect(undoText({ kind: 'REFUND', at, amountCents: 1000, by: 'Javi', reason: null, status: 'SUCCEEDED', paidInCash: true }, eur, when)).toBe(
      'Devuelto en efectivo: 10,00 € · 01:10 · Javi · hecha',
    );
    expect(undoText({ kind: 'REFUND', at, amountCents: 1000, by: null, reason: null, status: null, paidInCash: false }, eur, when)).toBe(
      'Devuelto a la tarjeta: 10,00 € · 01:10',
    );
  });

  it('un consumo del saldo deshecho sale «Devuelto», no «Anulado»', () => {
    expect(detailStatus({ kind: 'SALDO', status: 'REVERSED' }).label).toBe('Devuelto');
    expect(detailStatus({ kind: 'SALDO', status: 'ACCEPTED' }).label).toBe('Pagado');
    expect(detailStatus({ kind: 'PAYMENT', status: 'AUTHORIZED' })).toEqual({ label: 'Pagado', tone: 'success' });
  });

  it('las señales en castellano llano, sin «Cobrado»', () => {
    expect(flagTexts(detail)).toEqual(['Pagado dos veces']);
    expect(flagTexts({ flags: ['NFC_NO_PIN'] })).toEqual(['Ficha sin PIN']);
  });
});

describe('reparto, banco y lo delicado', () => {
  it('lo vendido, lo devuelto, cada persona, OxioPay y el local', () => {
    const rows = splitRows(
      {
        soldCents: 10500,
        refundedCents: 1000,
        staff: [{ personId: 'u1', name: 'Ana', role: 'OPERATOR', commissionCents: 2000, tipCents: 500, invitationCents: 0, reversedCents: 0, totalCents: 2500 }],
        oxioPay: { serviceFeeCents: 150, platformCents: 300 },
        venueCents: 6700,
      },
      eur,
    );
    expect(rows.map((r) => r.label)).toEqual(['Vendido (importe y propina)', 'Devuelto', 'Ana', 'OxioPay: comisión del servicio', 'OxioPay: su %', 'Para el local']);
    expect(rows[1]!.value).toBe('−10,00 €');
  });

  it('el banco: autorización, 3DS y el país de la tarjeta', () => {
    expect(bankRows({ authCode: '123456', secure3ds: true, cardCountry: '724', provider: 'REDSYS', bankOrder: '0001' })).toEqual([
      { label: 'Autorización', value: '123456' },
      { label: '3DS', value: 'Sí' },
      { label: 'País de la tarjeta', value: 'España (724)' },
    ]);
    expect(bankRows({ authCode: null, secure3ds: null, cardCountry: null, provider: null, bankOrder: null }).map((r) => r.value)).toEqual(['—', 'No se sabe', '—']);
  });

  it('un dispositivo: de quién, en qué paso y su IP (o que se borró)', () => {
    const d: CobroDetailDevice = {
      who: 'client',
      step: 'card',
      at: '2026-11-08T01:00:00.000Z',
      label: 'iPhone · iOS 18.1 · Safari',
      ip: null,
      ipErased: true,
      personName: null,
      model: 'iPhone',
      os: 'iOS',
      osVersion: '18.1',
      browser: 'Safari',
      mobile: true,
      inApp: null,
    };
    expect(deviceRow(d)).toEqual({ who: 'El cliente', step: 'Al pagar con tarjeta', device: 'iPhone · iOS 18.1 · Safari', ip: 'IP borrada (a los 90 días)' });
    expect(deviceRow({ ...d, who: 'staff', personName: 'Ana', step: 'create', ip: '203.0.113.7', ipErased: false })).toMatchObject({ who: 'Ana', step: 'Al crear el cobro', ip: '203.0.113.7' });
  });

  it('la tarjeta, tras verificarse', () => {
    expect(cardMoreText({ type: 'Crédito', payMethodCode: null, expiry: '12/28', tokenized: true })).toBe('tipo Crédito · caduca 12/28 · guardada para cobros');
    expect(cardMoreText({ type: null, payMethodCode: null, expiry: null, tokenized: false })).toBe('—');
  });
});

describe('compartir y el enlace', () => {
  it('el texto lleva la referencia y el enlace, nunca el móvil, la IP ni el id', () => {
    const text = shareTextOf(detail, eur, when);
    expect(text).toContain('C-0024');
    expect(text).toContain(detail.panelUrl!);
    expect(text).not.toContain('p-1');
    expect(text).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });

  it('la referencia del enlace (?ref=C-0024), y la URL sin ella', () => {
    expect(refFromSearch('?s=hoy&t=cobros&ref=c-0024')).toBe('C-0024');
    expect(refFromSearch('?ref=1%3B%20drop')).toBeNull();
    expect(refFromSearch('')).toBeNull();
    expect(withoutRef('?s=hoy&t=cobros&ref=C-0024')).toBe('?s=hoy&t=cobros');
    expect(withoutRef('?ref=C-0024')).toBe('');
  });
});
