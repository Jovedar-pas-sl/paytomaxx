import { describe, it, expect, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@nightpay/db';
import { paymentVia, saldoVia } from './cobros-rows';
import { staffFichaRow, staffRates, staffStats, type EarningFeedRow } from './staff-ficha';
import { StaffFichaService } from './staff-ficha.service';
import { cardLabel } from './wallet-ficha.service';

const LOLA = '33333333-3333-4333-8333-333333333333';
const CARLOS = { id: '44444444-4444-4444-8444-444444444444', displayName: 'Carlos', email: 'carlos@x.es', role: 'WAITER' };

const earning = (o: Partial<EarningFeedRow>): EarningFeedRow => ({
  id: 'e-1',
  at: new Date('2026-10-24T23:42:00Z'),
  commissionCents: 9_600,
  tipCents: 0,
  reversedCents: 0,
  paymentAmountCents: 12_000,
  paymentLineId: null,
  paymentId: 'p-1',
  ref: 4826,
  chargeAmountCents: 12_000,
  chargeTipCents: 0,
  category: 'CHICA_SERVICE',
  serviceName: '1 h',
  captureMethod: 'QR',
  posOperationNumber: null,
  approvedPayMethod: 'card',
  authorizedAt: new Date('2026-10-24T23:42:00Z'),
  paymentStatus: 'AUTHORIZED',
  authMethod: null,
  reversedAt: null,
  walletCode: null,
  lines: [{ category: 'CHICA_SERVICE', amountCents: 12_000 }],
  invitationCategory: null,
  chargedBy: null,
  ...o,
});

describe('ficha de la chica: cada cobro con su parte', () => {
  it('con tarjeta (QR): «C-4826 · 1 h», Servicios · tarjeta · QR, 120 € y +96', () => {
    expect(staffFichaRow(earning({}), LOLA)).toMatchObject({
      ref: 'C-4826',
      kind: 'PAYMENT',
      section: 'CHICA_SERVICE',
      title: '1 h',
      method: 'CARD',
      via: 'QR',
      chargedBy: null,
      invitation: false,
      amountCents: 12_000,
      shareCents: 9_600,
      undone: false,
    });
  });

  it('una invitación que cobró el camarero: Copas, «cobró Carlos», la copa y su parte', () => {
    const row = staffFichaRow(
      earning({
        paymentId: null,
        ref: 4829,
        paymentLineId: 'l-1',
        commissionCents: 1_000,
        paymentAmountCents: 2_000,
        chargeAmountCents: 2_500,
        category: 'VENUE_BAR',
        serviceName: 'Invitar a una copa',
        authMethod: 'nfc_nopin',
        walletCode: 'K7Q4M2',
        invitationCategory: 'VENUE_BAR',
        chargedBy: CARLOS,
        lines: [{ category: 'VENUE_BAR', amountCents: 2_500 }],
      }),
      LOLA,
    );
    expect(row).toMatchObject({
      kind: 'SALDO',
      section: 'VENUE_BAR',
      title: 'Invitación',
      method: 'SALDO',
      via: 'NFC sin PIN',
      walletCode: 'K7Q-4M2',
      chargedBy: { id: CARLOS.id, name: 'Carlos', role: 'WAITER' },
      invitation: true,
      amountCents: 2_000,
      shareCents: 1_000,
    });
  });

  it('una propina sola, un datáfono, uno devuelto y un consumo anulado', () => {
    expect(staffFichaRow(earning({ commissionCents: 0, tipCents: 500, serviceName: null }), LOLA)).toMatchObject({ title: 'Propina', shareCents: 500 });
    expect(staffFichaRow(earning({ captureMethod: 'POS_EXTERNAL', approvedPayMethod: null }), LOLA)).toMatchObject({ method: 'POS', via: 'Datáfono' });
    expect(staffFichaRow(earning({ paymentStatus: 'REFUNDED', reversedCents: 9_600 }), LOLA)).toMatchObject({ undone: true, shareCents: 0 });
    expect(staffFichaRow(earning({ paymentId: null, reversedAt: new Date(), category: 'bar', lines: null, serviceName: null }), LOLA)).toMatchObject({
      undone: true,
      section: 'EXTRA',
      title: 'Cobro',
      via: null,
    });
    // Ella misma cobró: no se dice quién.
    expect(staffFichaRow(earning({ chargedBy: { ...CARLOS, id: LOLA } }), LOLA).chargedBy).toBeNull();
  });

  it('lo vendido y lo suyo: lo devuelto del todo no cuenta como vendido', () => {
    const rows = [staffFichaRow(earning({}), LOLA), staffFichaRow(earning({ id: 'e-2', paymentStatus: 'REFUNDED', reversedCents: 9_600 }), LOLA)];
    expect(staffStats(rows, 41_000)).toEqual({ soldCents: 12_000, shareCents: 9_600, paidCents: 41_000, count: 1 });
  });
});

describe('lo que le toca de cada cosa', () => {
  const defaults = { CHICA_SERVICE: 9000, VENUE_BAR: 0, VENUE_ROOM: 1000, VENUE_FOOD: 0, EXTRA: 500 };

  it('la chica: su % propio en Servicios, los de otras secciones, la invitación y las propinas', () => {
    expect(
      staffRates({ role: 'OPERATOR', commissionBps: 8000, defaults, invitationRules: { chica: { kind: 'FIXED', cents: 1000 } } }),
    ).toEqual([
      { kind: 'section', code: 'CHICA_SERVICE', bps: 8000 },
      { kind: 'section', code: 'VENUE_ROOM', bps: 1000 },
      { kind: 'invitation', share: { kind: 'FIXED', cents: 1000 } },
      { kind: 'tips', bps: 10_000 },
    ]);
  });

  it('sin los del local guardados: su % propio y lo de fábrica de la invitación', () => {
    expect(staffRates({ role: 'OPERATOR', commissionBps: 7000, defaults: null, invitationRules: null })).toEqual([
      { kind: 'section', code: 'CHICA_SERVICE', bps: 7000 },
      { kind: 'invitation', share: { kind: 'PERCENT', bps: 5000 } },
      { kind: 'tips', bps: 10_000 },
    ]);
  });

  it('el camarero: solo su parte de las invitaciones (si el dueño le da algo)', () => {
    expect(staffRates({ role: 'WAITER', commissionBps: null, defaults, invitationRules: { camarero: { kind: 'FIXED', cents: 300 } } })).toEqual([
      { kind: 'invitation', share: { kind: 'FIXED', cents: 300 } },
    ]);
    expect(staffRates({ role: 'WAITER', commissionBps: null, defaults, invitationRules: null })).toEqual([]);
  });
});

describe('por dónde y qué ficha', () => {
  it('por dónde se autorizó un cobro', () => {
    expect([saldoVia('nfc_nopin'), saldoVia('pin'), saldoVia('passkey'), saldoVia('staff'), saldoVia(null), saldoVia('raro')]).toEqual([
      'NFC sin PIN',
      'PIN',
      'Face ID',
      'Personal',
      null,
      null,
    ]);
    expect([paymentVia('POS', false), paymentVia('CARD', false), paymentVia('CARD', true), paymentVia(null, false)]).toEqual(['Datáfono', 'QR', null, null]);
  });

  it('la ficha NFC se reconoce por el final de su número de serie o el principio de su código', () => {
    expect(cardLabel({ uid: '04:a2:3f:0b:04:17', token: 'abcdefghij' })).toBe('nº 0417');
    expect(cardLabel({ uid: null, token: 'abcdefghij' })).toBe('abcdef…');
  });
});

describe('GET /v1/admin/operators/:id/ficha', () => {
  const TENANT = '11111111-1111-4111-8111-111111111111';

  function makeService(person: unknown) {
    const queries: Prisma.Sql[] = [];
    const tx = {
      user: {
        findFirst: vi.fn().mockResolvedValue(person),
        findMany: vi.fn().mockResolvedValue([CARLOS]),
      },
      venue: { findUnique: vi.fn().mockResolvedValue({ operatorCommissionDefaults: { CHICA_SERVICE: 8000 }, invitationRules: null }) },
      operatorPayout: {
        findMany: vi.fn().mockResolvedValue([{ id: 'po-1', createdAt: new Date('2026-10-18T05:00:00Z'), totalCents: 41_000, externalRail: 'MANUAL_CASH' }]),
      },
      $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const q = Prisma.sql(strings, ...values);
        queries.push(q);
        if (q.text.includes('FROM operator_earnings e')) {
          return [{ ...earning({}), chargedBy: undefined, chargedById: CARLOS.id }];
        }
        return [{ cents: 0n }];
      }),
    };
    const prisma = {
      asSystem: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
      withTenant: vi.fn(async (t: string, fn: (x: unknown) => unknown) => {
        expect(t).toBe(TENANT);
        return fn(tx);
      }),
    };
    const window = { from: new Date('2026-10-24T06:00:00Z'), to: new Date('2026-10-25T01:00:00Z'), nightId: 'n-1', open: true, openingFloatCents: null };
    const moneyMap = { currentWindow: vi.fn().mockResolvedValue(window) };
    return { svc: new StaffFichaService(prisma as never, moneyMap as never), queries, tx };
  }

  it('esta noche: sus cobros con su parte, lo vendido, lo suyo, lo pagado y sus últimos pagos', async () => {
    const { svc, queries, tx } = makeService({ id: LOLA, displayName: 'Lola', email: 'lola@x.es', role: 'OPERATOR', commissionBps: null });
    const f = await svc.ficha(TENANT, LOLA);
    expect(tx.user.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: LOLA, tenantId: TENANT, role: { in: ['OPERATOR', 'WAITER'] } } }));
    expect(f.person).toEqual({ id: LOLA, name: 'Lola', role: 'OPERATOR' });
    expect(f.window).toEqual({ from: '2026-10-24T06:00:00.000Z', to: '2026-10-25T01:00:00.000Z', nightId: 'n-1', open: true });
    expect(f.rows).toHaveLength(1);
    expect(f.rows[0]!.chargedBy).toEqual({ id: CARLOS.id, name: 'Carlos', role: 'WAITER' });
    expect(f.stats).toEqual({ soldCents: 12_000, shareCents: 9_600, paidCents: 0, count: 1 });
    expect(f.rates[0]).toEqual({ kind: 'section', code: 'CHICA_SERVICE', bps: 8000 });
    expect(f.payouts).toEqual([{ id: 'po-1', at: '2026-10-18T05:00:00.000Z', cents: 41_000, rail: 'MANUAL_CASH' }]);
    const q = queries.find((x) => x.text.includes('FROM operator_earnings e'))!;
    expect(q.text).toContain('e."tenantId" = $');
    expect(q.text).toContain('e."operatorId" = $');
    expect(q.values).toEqual(expect.arrayContaining([TENANT, LOLA]));
  });

  it('el camarero: «Camarero» y solo la invitación', async () => {
    const { svc } = makeService({ id: CARLOS.id, displayName: null, email: 'carlos@x.es', role: 'WAITER', commissionBps: null });
    const f = await svc.ficha(TENANT, CARLOS.id);
    expect(f.person).toEqual({ id: CARLOS.id, name: 'carlos@x.es', role: 'WAITER' });
    expect(f.rates).toEqual([]);
  });

  it('de otro local (o el dueño): 404', async () => {
    const { svc } = makeService(null);
    await expect(svc.ficha(TENANT, LOLA)).rejects.toBeInstanceOf(NotFoundException);
  });
});
