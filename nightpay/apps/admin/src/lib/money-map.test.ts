import { describe, expect, it } from 'vitest';
import type { CobroRow } from '@nightpay/contracts';
import { groupBySection, packFromDraft, packRemainder } from './carta-form';
import { cobrosQuery } from './endpoints/money-map';
import { FALLBACK_SECTIONS, chipTextColor, enabledSections, paidTwiceNote, paymentRowOf, sectionChip } from './money-map';

const eur = (c: number) => `${c / 100} €`;

function row(o: Partial<CobroRow> = {}): CobroRow {
  return {
    kind: 'PAYMENT',
    id: 'p1',
    ref: 'C-0001',
    createdAt: '2026-10-23T01:00:00.000Z',
    amountCents: 15000,
    tipCents: 0,
    currency: 'EUR',
    status: 'AUTHORIZED',
    person: null,
    sections: [],
    isTopUp: false,
    method: 'CARD',
    methodLabel: 'Tarjeta',
    wallet: null,
    service: null,
    invited: null,
    lines: [],
    payment: null,
    ...o,
  };
}

describe('sección de un cobro en la lista', () => {
  it('una sección: su nombre y su color; varias: «Varias» con el reparto', () => {
    expect(sectionChip(row({ sections: [{ category: 'VENUE_BAR', amountCents: 2000 }] }), FALLBACK_SECTIONS, eur)).toEqual({
      label: 'Copas',
      color: '#3fe0c0',
      title: 'Copas 20 €',
    });
    const pack = sectionChip(
      row({ sections: [{ category: 'CHICA_SERVICE', amountCents: 12000 }, { category: 'VENUE_ROOM', amountCents: 3000 }] }),
      FALLBACK_SECTIONS,
      eur,
    );
    expect(pack).toEqual({ label: 'Varias', color: null, title: 'Servicios 120 € · Habitaciones 30 €' });
  });

  it('el nombre del local manda; los antiguos «Otros»; las recargas, aparte', () => {
    const own = FALLBACK_SECTIONS.map((s) => (s.code === 'VENUE_BAR' ? { ...s, label: 'Barra', color: '#123456' } : s));
    expect(sectionChip(row({ sections: [{ category: 'VENUE_BAR', amountCents: 1 }] }), own, eur).label).toBe('Barra');
    expect(sectionChip(row({ sections: [{ category: 'EXTRA', amountCents: 1 }] }), own, eur).label).toBe('Otros');
    expect(sectionChip(row({ isTopUp: true }), own, eur).label).toBe('Recarga de saldo');
    expect(sectionChip(row(), own, eur)).toEqual({ label: '—', color: null, title: null });
  });

  it('texto oscuro sobre colores claros, claro sobre oscuros', () => {
    expect(chipTextColor('#ffd23f')).toBe('#14110f');
    expect(chipTextColor('#1d1d1d')).toBe('#ffffff');
    expect(chipTextColor(null)).toBe('var(--np-text)');
  });

  it('las secciones apagadas no se ofrecen', () => {
    const off = FALLBACK_SECTIONS.map((s) => (s.code === 'VENUE_FOOD' ? { ...s, enabled: false } : s));
    expect(enabledSections(off).map((s) => s.code)).not.toContain('VENUE_FOOD');
  });
});

describe('cobros: devoluciones y filtros', () => {
  it('un cobro con tarjeta se pasa a las devoluciones; uno del saldo, no', () => {
    const payment = {
      availableAmountCents: 15000,
      provider: 'REDSYS',
      providerTxId: 'X1',
      captureMethod: null,
      updatedAt: '2026-10-23T01:01:00.000Z',
      authCode: '123456',
      cardLast4: '4242',
      cardBrand: '1',
      payMethodCode: null,
      authorizedAt: '2026-10-23T01:01:00.000Z',
      attempts: [],
      terminal: { externalId: 'B1', label: 'Barra' },
    };
    expect(paymentRowOf(row({ payment }))).toMatchObject({ id: 'p1', provider: 'REDSYS', availableAmountCents: 15000, terminal: { label: 'Barra' } });
    expect(paymentRowOf(row({ kind: 'SALDO' }))).toBeNull();
  });

  it('lleva la comisión del servicio, la propina y si es una recarga (el aviso de lo que se devuelve de comisión)', () => {
    const payment = { availableAmountCents: 3830, provider: 'REDSYS', providerTxId: 'X1', captureMethod: null, updatedAt: '2026-10-23T01:01:00.000Z',
      authCode: null, cardLast4: null, cardBrand: null, payMethodCode: null, authorizedAt: null, attempts: [], terminal: { externalId: 'B1', label: 'Barra' } };
    expect(paymentRowOf(row({ amountCents: 3300, tipCents: 200, serviceFeeCents: 330, payment }))).toMatchObject({ serviceFeeCents: 330, tipCents: 200, walletId: null });
    expect(paymentRowOf(row({ isTopUp: true, serviceFeeCents: 600, wallet: { id: 'w-1', codeHint: 'K7Q-•••' }, payment }))).toMatchObject({ walletId: 'w-1' });
    // Un API de antes no manda la comisión: 0.
    expect(paymentRowOf(row({ payment }))?.serviceFeeCents).toBe(0);
  });

  it('los filtros vacíos no se mandan', () => {
    expect(cobrosQuery({ operatorId: 'op', category: '', status: [], walletCode: 'K7Q-4M2' }, { limit: 50 })).toBe(
      'operatorId=op&walletCode=K7Q-4M2&limit=50',
    );
    expect(cobrosQuery({ status: ['AUTHORIZED'] }, { cursor: 'abc' })).toBe('status=AUTHORIZED&cursor=abc');
  });
});

describe('carta: por secciones y packs', () => {
  const item = (id: string, category: string) =>
    ({ id, name: id, durationMin: null, priceCents: 100, category, active: true, sortOrder: 0 }) as never;

  it('agrupa en el orden de las secciones; lo antiguo («Otros») al final', () => {
    const groups = groupBySection([item('a', 'VENUE_ROOM'), item('b', 'EXTRA'), item('c', 'CHICA_SERVICE')], FALLBACK_SECTIONS);
    expect(groups.map((g) => [g.code, g.items.map((i) => i.id)])).toEqual([
      ['CHICA_SERVICE', ['c']],
      ['VENUE_ROOM', ['a']],
      ['EXTRA', ['b']],
    ]);
  });

  it('partes del pack: tienen que sumar el precio y ser de secciones distintas', () => {
    const parts = [
      { category: 'CHICA_SERVICE' as const, amount: '120' },
      { category: 'VENUE_ROOM' as const, amount: '30' },
    ];
    expect(packFromDraft(15000, 'CHICA_SERVICE', parts)).toEqual({
      ok: true,
      components: [
        { category: 'CHICA_SERVICE', amountCents: 12000 },
        { category: 'VENUE_ROOM', amountCents: 3000 },
      ],
    });
    expect(packRemainder(15000, parts)).toBe(0);
    expect(packRemainder(16000, parts)).toBe(1000);
    expect(packFromDraft(16000, 'CHICA_SERVICE', parts)).toMatchObject({ ok: false });
    expect(packFromDraft(15000, 'CHICA_SERVICE', [parts[0]!, { ...parts[0]!, amount: '30' }])).toEqual({
      ok: false,
      problem: 'Cada parte del pack va a una sección distinta.',
    });
    expect(packFromDraft(15000, 'CHICA_SERVICE', [{ ...parts[0]!, amount: '' }, parts[1]!])).toMatchObject({ ok: false });
  });
});

describe('cobrado dos veces: la marca de la fila', () => {
  it('sin nada que decir, nada', () => {
    expect(paidTwiceNote(row(), eur)).toBeNull();
    expect(paidTwiceNote(row({ paidTwice: null }), eur)).toBeNull();
  });

  it('a devolver (Redsys): cuánto y dónde', () => {
    expect(paidTwiceNote(row({ status: 'CANCELED', paidTwice: { amountCents: 1200, refunded: false } }), eur)).toBe(
      'Cobrado dos veces: devuelve 12 € a la tarjeta (Incidencias)',
    );
  });

  it('la pasarela lo devolvió sola', () => {
    expect(paidTwiceNote(row({ status: 'CANCELED', paidTwice: { amountCents: 1200, refunded: true } }), eur)).toBe(
      'Cobrado dos veces: la tarjeta se devolvió sola (12 €)',
    );
  });
});
