import { describe, expect, it } from 'vitest';
import { DEFAULT_SECTIONS, SECTION_CODES, type CobroRow, type StaffFicha, type VenueSection, type WalletFicha } from '@nightpay/contracts';
import { bareEur, dayShort, payButtonLabel, rateChips, signed, sinceLabel, staffSheet, walletSheet } from './ficha-sheets';

const SECTIONS: VenueSection[] = SECTION_CODES.map((code) => ({ code, ...DEFAULT_SECTIONS[code] }));
const TZ = 'Europe/Madrid';
const NOW = new Date('2026-10-25T02:10:00Z'); // 03:10 de Madrid del domingo 25
const sp = (s: string | null | undefined) => s?.replace(/\u00a0/g, ' ');

function consumo(o: Partial<CobroRow>): CobroRow {
  return {
    kind: 'SALDO',
    id: 'c1',
    ref: 'C-4821',
    createdAt: '2026-10-24T23:10:00.000Z',
    amountCents: 2_000,
    tipCents: 0,
    currency: 'EUR',
    status: 'ACCEPTED',
    person: { id: 'u1', name: 'Carlos', role: 'WAITER' },
    sections: [{ category: 'VENUE_BAR', amountCents: 2_000 }],
    isTopUp: false,
    method: 'SALDO',
    methodLabel: 'Saldo K7Q-•••',
    via: 'NFC sin PIN',
    wallet: { id: 'w1', codeHint: 'K7Q-•••' },
    service: '2 copas',
    invited: null,
    lines: [],
    payment: null,
    ...o,
  };
}

/** El saldo K7Q-4M2 de la maqueta 9.1 (300 recargados, 270 gastados). */
function ficha(o: Partial<WalletFicha> = {}): WalletFicha {
  return {
    wallet: {
      id: 'w1',
      code: 'K7Q-4M2',
      label: null,
      balanceCents: 3_000,
      status: 'ACTIVE',
      createdAt: '2026-10-24T21:40:00.000Z',
      homeVenueName: 'Sala Medianoche',
      hasPin: true,
      hasCard: true,
      hasFaceId: false,
    },
    topUps: [
      { kind: 'CASH', id: 't1', ref: null, at: '2026-10-24T21:40:00.000Z', amountCents: 10_000, method: 'CASH', methodLabel: 'Efectivo', by: { id: 's', name: 'Sergio', role: 'WAITER' }, terminalLabel: 'Recepción', venueName: 'Sala', status: 'DONE', note: null },
      { kind: 'PAYMENT', id: 't2', ref: 'C-4810', at: '2026-10-24T22:25:00.000Z', amountCents: 10_000, method: 'CARD', methodLabel: 'Tarjeta', by: null, terminalLabel: 'Recepción', venueName: 'Sala', status: 'AUTHORIZED', note: null },
      { kind: 'PAYMENT', id: 't3', ref: 'C-4817', at: '2026-10-24T22:45:00.000Z', amountCents: 10_000, method: 'CARD', methodLabel: 'Tarjeta', by: null, terminalLabel: null, venueName: 'Sala', status: 'AUTHORIZED', note: null },
    ],
    consumptions: [
      { ...consumo({}), venueName: 'Sala' },
      { ...consumo({ id: 'c2', ref: 'C-4818', createdAt: '2026-10-24T22:58:00.000Z', amountCents: 25_000, service: '30 min', sections: [{ category: 'CHICA_SERVICE', amountCents: 25_000 }], person: { id: 'u2', name: 'Nerea', role: 'OPERATOR' }, via: 'PIN' }), venueName: 'Sala' },
      { ...consumo({ id: 'c3', ref: 'C-4819', createdAt: '2026-10-24T23:00:00.000Z', amountCents: 5_000, status: 'REVERSED' }), venueName: 'Sala' },
    ],
    refunds: [],
    cards: [{ id: 'card1', label: 'nº 0417', status: 'ISSUED', linkedAt: '2026-10-24T21:40:00.000Z' }],
    ...o,
  };
}

describe('importes de las fichas', () => {
  it('la parte en pequeño sin €, con su signo', () => {
    expect(bareEur(9_600)).toBe('96');
    expect(bareEur(950)).toBe('9,50');
    expect(signed(9_600)).toBe('+96');
    expect(signed(-1_200)).toBe('−12');
  });

  it('desde cuándo: hoy, ayer o el día', () => {
    // Por noches (de 08:00 a 08:00): a las 03:10, las 23:40 de antes son de esta noche.
    expect(sinceLabel('2026-10-24T21:40:00.000Z', TZ, new Date('2026-10-24T21:50:00Z'))).toBe('hoy 23:40');
    expect(sinceLabel('2026-10-24T21:40:00.000Z', TZ, NOW)).toBe('hoy 23:40');
    expect(sinceLabel('2026-10-24T10:00:00.000Z', TZ, NOW)).toBe('hoy 12:00');
    expect(sinceLabel('2026-10-23T21:40:00.000Z', TZ, NOW)).toBe('ayer 23:40');
    expect(sinceLabel('2026-10-18T21:40:00.000Z', TZ, NOW)).toBe('dom 18, 23:40');
    expect(sinceLabel('no', TZ, NOW)).toBe('—');
    expect(dayShort('2026-10-17T21:00:00.000Z', TZ)).toBe('sáb 17');
  });
});

describe('9.1 · ficha del saldo', () => {
  it('cifras que cuadran (recargado − gastado − devuelto = le quedan), franja y la ficha NFC', () => {
    const s = walletSheet(ficha(), SECTIONS, TZ, NOW);
    expect(s.title).toBe('Saldo K7Q-4M2');
    expect(s.subtitle).toBe('Desde hoy 23:40');
    expect(s.stats).toEqual({ left: 3_000, topped: 30_000, spent: 27_000, refunded: 0 });
    expect(s.stats.topped - s.stats.spent - s.stats.refunded).toBe(s.stats.left);
    expect(s.stripe.map((x) => [x.key, x.cents])).toEqual([
      ['VENUE_BAR', 2_000],
      ['CHICA_SERVICE', 25_000],
    ]);
    expect(s.card).toEqual({ id: 'card1', label: 'nº 0417', status: 'ISSUED', active: true, detail: 'Activa · PIN puesto' });
  });

  it('la línea del tiempo: lo último arriba; gastos con referencia, sección, quién y por dónde; recargas a trazos', () => {
    const rows = walletSheet(ficha(), SECTIONS, TZ, NOW).rows;
    expect(rows.map((r) => [r.time, r.title, r.sub, sp(r.amount), r.color === null, r.undone])).toEqual([
      ['01:10', 'C-4821 · 2 copas', 'Copas · Carlos · NFC sin PIN', '−20 €', false, false],
      ['01:00', 'C-4819 · 2 copas', 'Copas · Carlos · NFC sin PIN', '−50 €', false, true],
      ['00:58', 'C-4818 · 30 min', 'Servicios · Nerea · PIN', '−250 €', false, false],
      ['00:45', 'Recarga · tarjeta', 'sin personal', '+100 €', true, false],
      ['00:25', 'Recarga · tarjeta', 'Recepción · sin personal', '+100 €', true, false],
      ['23:40', 'Alta · efectivo', 'Recepción · Sergio', '+100 €', true, false],
    ]);
  });

  it('una recarga con la comisión del servicio: el saldo es la recarga; lo que pagó, en el detalle', () => {
    const base = ficha().topUps[0]!;
    const s = walletSheet(ficha({ topUps: [{ ...base, amountCents: 5_000, serviceFeeCents: 600 }] }), SECTIONS, TZ, NOW);
    const row = s.rows.find((r) => r.key === 'topup-CASH-t1')!;
    expect(sp(row.amount)).toBe('+50 €');
    expect(sp(row.sub)).toBe('Recepción · Sergio · pagó 56 € (6 € de comisión del servicio)');
    expect(s.stats.topped).toBe(5_000);
  });

  it('sin ficha NFC, con una anulación de recarga y una devolución a la tarjeta pendiente', () => {
    const s = walletSheet(
      ficha({
        cards: [],
        topUps: [
          ...ficha().topUps,
          { kind: 'CASH', id: 't4', ref: null, at: '2026-10-24T23:30:00.000Z', amountCents: -10_000, method: 'CASH', methodLabel: 'Efectivo (anulada)', by: null, terminalLabel: null, venueName: 'Sala', status: 'VOID', note: 'Se equivocó' },
        ],
        refunds: [{ id: 'r1', at: '2026-10-25T00:00:00.000Z', amountCents: 3_000, method: 'CARD', status: 'PENDING', by: { id: 'o', name: 'Dueño', role: 'OWNER' }, bankReference: null, venueName: 'Sala' }],
      }),
      SECTIONS,
      TZ,
      NOW,
    );
    expect(s.card).toBeNull();
    expect(s.noCardDetail).toBe('PIN puesto');
    expect(s.stats.refunded).toBe(0);
    expect(s.rows[0]).toMatchObject({ title: 'Devolución · tarjeta', sub: 'Dueño · apuntándose en el banco' });
    expect(s.rows.find((r) => r.key === 'topup-CASH-t4')).toMatchObject({ title: 'Recarga anulada · efectivo', sub: '«Se equivocó»' });
  });

  it('con la ficha bloqueada: se ve como bloqueada', () => {
    const s = walletSheet(ficha({ cards: [{ id: 'c9', label: 'abcdef…', status: 'BLOCKED', linkedAt: null }] }), SECTIONS, TZ, NOW);
    expect(s.card).toMatchObject({ active: false, detail: 'Bloqueada · PIN puesto' });
  });
});

/** Lola en la maqueta 9.2. */
function staff(o: Partial<StaffFicha> = {}): StaffFicha {
  return {
    person: { id: 'lola', name: 'Lola', role: 'OPERATOR' },
    window: { from: '2026-10-24T06:00:00.000Z', to: '2026-10-25T02:10:00.000Z', nightId: 'n1', open: true },
    stats: { soldCents: 34_500, shareCents: 27_100, paidCents: 0, count: 5 },
    rates: [
      { kind: 'section', code: 'CHICA_SERVICE', bps: 8000 },
      { kind: 'invitation', share: { kind: 'FIXED', cents: 1_000 } },
      { kind: 'tips', bps: 10_000 },
    ],
    rows: [
      { id: 'e1', at: '2026-10-25T00:20:00.000Z', ref: 'C-4833', kind: 'PAYMENT', section: 'TIPS', sections: [], title: 'Propina', method: 'CARD', via: 'QR', walletCode: null, chargedBy: null, invitation: false, amountCents: 500, shareCents: 500, undone: false },
      { id: 'e2', at: '2026-10-24T23:28:00.000Z', ref: 'C-4829', kind: 'SALDO', section: 'VENUE_BAR', sections: [], title: 'Invitación', method: 'SALDO', via: 'NFC sin PIN', walletCode: 'K7Q-4M2', chargedBy: { id: 'c', name: 'Carlos', role: 'WAITER' }, invitation: true, amountCents: 2_000, shareCents: 1_000, undone: false },
      { id: 'e3', at: '2026-10-24T22:31:00.000Z', ref: 'C-4815', kind: 'SALDO', section: 'CHICA_SERVICE', sections: [], title: '1 h', method: 'SALDO', via: 'PIN', walletCode: 'K7Q-4M2', chargedBy: null, invitation: false, amountCents: 12_000, shareCents: 9_600, undone: false },
      { id: 'e4', at: '2026-10-24T21:58:00.000Z', ref: 'C-4809', kind: 'PAYMENT', section: 'CHICA_SERVICE', sections: [], title: '30 min', method: 'POS', via: 'Datáfono', walletCode: null, chargedBy: null, invitation: false, amountCents: 8_000, shareCents: 6_400, undone: false },
    ],
    payouts: [
      { id: 'p1', at: '2026-10-18T05:00:00.000Z', cents: 41_000, rail: 'MANUAL_CASH' },
      { id: 'p2', at: '2026-10-17T05:00:00.000Z', cents: 35_500, rail: 'MANUAL_CASH' },
    ],
    ...o,
  };
}

describe('9.2 · ficha de la chica y del camarero', () => {
  it('cabecera, cifras, lo que le toca de cada cosa y sus pagos', () => {
    const s = staffSheet(staff(), SECTIONS, TZ);
    expect(s).toMatchObject({ title: 'Lola', subtitle: 'Chica · esta noche', chip: { label: 'Servicios', color: '#d24fd8' } });
    expect(s.stats.map((x) => [x.label, x.cents])).toEqual([
      ['Vendido', 34_500],
      ['Su parte', 27_100],
      ['Pagado', 0],
    ]);
    expect(s.rates.map((r) => `${r.label} ${sp(r.value)}`)).toEqual(['Servicios 80 %', 'Invitación 10 €', 'Propinas 100 %']);
    expect(sp(s.payline?.text)).toBe('dom 18: 410 € · sáb 17: 355 €');
    expect(s.payline?.rail).toBe('MANUAL_CASH');
  });

  it('cada cobro: «C-4826 · 1 h», «Servicios · tarjeta · QR», el importe y su parte («+96»)', () => {
    const rows = staffSheet(staff(), SECTIONS, TZ).rows;
    expect(rows.map((r) => [r.time, r.title, r.sub, sp(r.amount), r.share])).toEqual([
      ['02:20', 'C-4833 · Propina', 'Propinas · tarjeta · QR', '5 €', '+5'],
      ['01:28', 'C-4829 · Invitación', 'Copas · cobró Carlos · NFC sin PIN', '20 €', '+10'],
      ['00:31', 'C-4815 · 1 h', 'Saldo K7Q-4M2 · PIN', '120 €', '+96'],
      ['23:58', 'C-4809 · 30 min', 'Servicios · datáfono', '80 €', '+64'],
    ]);
  });

  it('una devolución de esta noche de un cobro de otra noche: a trazos, lo devuelto y lo que se le resta', () => {
    const refund = {
      id: 'er1', at: '2026-10-25T00:40:00.000Z', ref: 'C-4790', kind: 'PAYMENT' as const, section: 'VENUE_BAR', sections: [{ category: 'VENUE_BAR', amountCents: 2_000 }],
      title: 'Devolución', method: 'CARD' as const, via: 'QR', walletCode: null, chargedBy: { id: 'c', name: 'Carlos', role: 'WAITER' }, invitation: true,
      amountCents: 2_000, shareCents: -1_000, undone: false, refundOf: { chargedAt: '2026-10-23T23:30:00.000Z' },
    };
    const rows = staffSheet(staff({ rows: [refund] }), SECTIONS, TZ).rows;
    expect(rows.map((r) => [r.time, r.title, r.sub, sp(r.amount), r.share, r.color, r.undone])).toEqual([
      ['02:40', 'C-4790 · Devolución', 'Copas · cobro del sáb 24 · cobró Carlos', '−20 €', '−10', null, false],
    ]);
    // Sin quien la cobró (la cobró ella): cómo se pagó.
    const own = staffSheet(staff({ rows: [{ ...refund, chargedBy: null, invitation: false, section: 'CHICA_SERVICE' }] }), SECTIONS, TZ).rows[0]!;
    expect(own.sub).toBe('Servicios · cobro del sáb 24 · tarjeta');
  });

  it('el camarero: «Camarero», chip de Copas, «Lo suyo»; sin noche abierta, desde el último cierre', () => {
    const s = staffSheet(
      staff({ person: { id: 'dani', name: 'Dani', role: 'WAITER' }, window: { from: 'x', to: 'y', nightId: null, open: false }, rates: [{ kind: 'invitation', share: { kind: 'PERCENT', bps: 1250 } }], payouts: [] }),
      SECTIONS,
      TZ,
    );
    expect(s).toMatchObject({ subtitle: 'Camarero · desde el último cierre', chip: { label: 'Copas' }, payline: null });
    expect(s.stats[1]!.label).toBe('Lo suyo');
    expect(s.rates.map((r) => `${r.label} ${sp(r.value)}`)).toEqual(['Invitación 12,5 %']);
  });

  it('los chips de cada cosa, con el color de su sección', () => {
    expect(rateChips([{ kind: 'section', code: 'VENUE_ROOM', bps: 1050 }], SECTIONS)).toEqual([
      { key: 's-VENUE_ROOM', label: 'Habitaciones', value: '10,5 %', color: '#c4b0f5' },
    ]);
  });

  it('el botón de pagar', () => {
    expect(sp(payButtonLabel('pay', 27_100, 'Lola'))).toBe('Pagar 271 € a Lola');
    expect(sp(payButtonLabel('request', 27_100, 'Lola'))).toBe('Pedir pago de 271 € para Lola');
  });
});

describe('el teléfono que dejó al darle la ficha', () => {
  it('sale en el detalle del saldo (solo el encargado y el dueño lo abren) y nunca en la lista', async () => {
    const { readFileSync } = await import('node:fs');
    const panel = readFileSync(new URL('../components/WalletsPanel.tsx', import.meta.url), 'utf8');
    expect(panel).not.toMatch(/contactPhone|\.phone\b/);
    const modal = readFileSync(new URL('../components/fichas/WalletFichaModal.tsx', import.meta.url), 'utf8');
    expect(modal).toContain('{sheet.phone ? (');
    const search = readFileSync(new URL('../components/WalletPhoneSearch.tsx', import.meta.url), 'utf8');
    expect(search).toContain('findWalletsByPhone(phone)');
  });
});
