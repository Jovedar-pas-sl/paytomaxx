import { describe, expect, it } from 'vitest';
import {
  cobroPanelUrl,
  cobroShareText,
  CobroKindParamSchema,
  detailAmountRows,
  deviceLabel,
  firstNameOf,
  formatMoney,
  parseCobroSearch,
  type CobroDetail,
} from '@nightpay/contracts';

const ID = '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b';
const fmt = { eur: (c: number) => formatMoney(c), when: () => 'sáb 8 nov, 01:23' };

const detail = (over: Partial<CobroDetail> = {}): CobroDetail => ({
  audience: 'MANAGER',
  kind: 'PAYMENT',
  id: ID,
  ref: 'C-0024',
  confirmationCode: 'A6B',
  status: 'AUTHORIZED',
  createdAt: '2026-11-08T00:20:00.000Z',
  paidAt: '2026-11-08T00:23:00.000Z',
  venueName: 'Sala Bambú',
  sections: [{ category: 'VENUE_BAR', amountCents: 4500 }],
  lines: [],
  service: '2× Copa',
  isTopUp: false,
  amountCents: 4500,
  tipCents: 200,
  serviceFeeCents: 450,
  totalCents: 5150,
  chargedBy: { name: 'Carlos Pérez', role: 'WAITER' },
  method: { method: 'CARD', label: 'Tarjeta Visa ••4242', cardBrand: 'Visa', cardLast4: '4242', fichaNumber: null, via: 'QR', walletHint: null },
  undo: [],
  flags: ['FOREIGN_CARD'],
  panelUrl: cobroPanelUrl('https://admin.paytomaxx.com/', 'C-0024'),
  sensitive: {
    devices: [
      {
        who: 'client',
        step: 'card',
        at: '2026-11-08T00:22:00.000Z',
        label: 'SM-S918B · Android 14 · Chrome 130',
        model: 'SM-S918B',
        os: 'Android',
        osVersion: '14',
        browser: 'Chrome 130',
        mobile: true,
        inApp: null,
        ip: '83.45.120.7',
        ipErased: false,
        personName: null,
      },
    ],
    card: { type: 'D', payMethodCode: 'C', expiry: '2812', tokenized: true },
    history: [{ at: '2026-11-08T00:23:00.000Z', what: 'Pagado', detail: 'Pedido 1108A6B' }],
  },
  ...over,
});

describe('Compartir: un texto corto con lo básico y el enlace al panel', () => {
  it('referencia, importe, estado, cuándo, dónde, qué, cómo, el código y el enlace', () => {
    expect(cobroShareText(detail(), fmt)).toBe(
      [
        `Cobro C-0024 · ${formatMoney(5150)} · Pagado`,
        'sáb 8 nov, 01:23 · Sala Bambú · 2× Copa',
        'Tarjeta Visa ••4242 · código A6B',
        'https://admin.paytomaxx.com/?s=hoy&t=cobros&ref=C-0024',
      ].join('\n'),
    );
  });

  it('nunca el móvil, la IP, la tarjeta más allá de los 4 últimos, el historial, el id del cobro ni un token', () => {
    const text = cobroShareText(detail(), fmt);
    for (const secret of ['83.45.120.7', 'SM-S918B', 'Android', '2812', 'Pedido', ID, 'token', 'Carlos']) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });

  it('del saldo: el saldo y la ficha (sin el código entero); sin referencia, sin enlace', () => {
    const saldo = detail({
      kind: 'SALDO',
      ref: null,
      panelUrl: cobroPanelUrl('https://admin.paytomaxx.com', null),
      method: { method: 'SALDO', label: 'Saldo K7Q-•••', cardBrand: null, cardLast4: null, fichaNumber: '0522', via: 'NFC sin PIN', walletHint: 'K7Q-•••' },
      confirmationCode: null,
    });
    const text = cobroShareText(saldo, fmt);
    expect(text).toContain('Saldo · ficha nº 0522');
    expect(text).not.toContain('http');
  });
});

describe('el enlace al panel', () => {
  it('por la referencia, sin barra de más; sin panel o sin referencia, nada', () => {
    expect(cobroPanelUrl('https://admin.paytomaxx.com///', 'C-0001')).toBe('https://admin.paytomaxx.com/?s=hoy&t=cobros&ref=C-0001');
    expect(cobroPanelUrl(null, 'C-0001')).toBeNull();
    expect(cobroPanelUrl('https://admin.paytomaxx.com', null)).toBeNull();
  });
});

describe('buscar un pago: lo tecleado', () => {
  it('«0C1»: el código de confirmación', () => {
    expect(parseCobroSearch('0c1')).toEqual({ text: '0c1', code: '0C1', cardLast4: null, ficha: null });
  });

  it('«4242»: los últimos 4 de la tarjeta y también la ficha nº 4242', () => {
    expect(parseCobroSearch(' 4242 ')).toEqual({ text: '4242', code: null, cardLast4: '4242', ficha: { number: 4242, printedNorm: '4242' } });
  });

  it('«••4242» o «*4242»: solo la tarjeta', () => {
    expect(parseCobroSearch('••4242')).toMatchObject({ cardLast4: '4242', ficha: null });
    expect(parseCobroSearch('*4242')).toMatchObject({ cardLast4: '4242', ficha: null });
    expect(parseCobroSearch('tarjeta 4242')).toMatchObject({ cardLast4: '4242', ficha: null });
  });

  it('«ficha 522», «F-0522», «nº 00736903»: solo la ficha (el impreso, sin ceros delante)', () => {
    expect(parseCobroSearch('ficha 522')).toEqual({ text: 'ficha 522', code: null, cardLast4: null, ficha: { number: 522, printedNorm: '522' } });
    expect(parseCobroSearch('F-0522')).toMatchObject({ cardLast4: null, ficha: { number: 522, printedNorm: '522' } });
    expect(parseCobroSearch('nº 00736903')).toMatchObject({ ficha: { number: 736903, printedNorm: '736903' } });
  });

  it('«F52» es un código, no la ficha 52; un pedido del banco, tal cual', () => {
    expect(parseCobroSearch('F52')).toMatchObject({ code: 'F52', ficha: null });
    expect(parseCobroSearch('RS1108A6B')).toEqual({ text: 'RS1108A6B', code: null, cardLast4: null, ficha: null });
  });
});

describe('las cifras del detalle (propina y comisión del servicio aparte: opcional)', () => {
  const d = { amountCents: 4500, tipCents: 200, serviceFeeCents: 450, totalCents: 5150 };

  it('encendido: importe, propina, comisión y total', () => {
    expect(detailAmountRows(d, true).map((r) => [r.key, r.cents])).toEqual([
      ['amount', 4500],
      ['tip', 200],
      ['serviceFee', 450],
      ['total', 5150],
    ]);
  });

  it('apagado (o sin propina ni comisión): solo el total', () => {
    expect(detailAmountRows(d, false)).toEqual([{ key: 'total', cents: 5150 }]);
    expect(detailAmountRows({ amountCents: 4500, tipCents: 0, serviceFeeCents: 0, totalCents: 4500 }, true)).toEqual([{ key: 'total', cents: 4500 }]);
  });
});

describe('piezas', () => {
  it('el nombre de pila que ve el cliente', () => {
    expect(firstNameOf('  Carlos Pérez ')).toBe('Carlos');
    expect(firstNameOf(null)).toBeNull();
    expect(firstNameOf('   ')).toBeNull();
  });

  it('la etiqueta del móvil', () => {
    expect(deviceLabel({ model: 'iPhone', os: 'iOS', osVersion: '18', browser: 'Safari 18', inApp: null })).toBe('iPhone · iOS 18 · Safari 18');
  });

  it('la clase de cobro en la ruta, en mayúsculas o minúsculas', () => {
    expect(CobroKindParamSchema.parse('payment')).toBe('PAYMENT');
    expect(CobroKindParamSchema.parse('SALDO')).toBe('SALDO');
    expect(CobroKindParamSchema.safeParse('refund').success).toBe(false);
  });
});
