import { describe, expect, it } from 'vitest';
import { emptyConceptAmounts, type SettlementDetail } from '@nightpay/contracts';
import { formatEur } from './money';
import {
  EMPTY_SETTLEMENT_FILTERS,
  conceptRows,
  nightColumns,
  overdueNoticeText,
  paymentFormFor,
  paymentMismatch,
  paymentPayload,
  paymentSummary,
  settlementFileName,
  settlementPeriodText,
  settlementStatusView,
  settlementsQuery,
  transferText,
  lastMondayBefore,
  weekStartProblem,
} from './oxiopay-settlements';

const TODAY = '2026-11-03';

function detail(o: Partial<SettlementDetail> = {}): SettlementDetail {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    reference: 'OXP-2026-S44-LUNA',
    venue: { id: '22222222-2222-4222-8222-222222222222', name: 'Luna', slug: 'luna' },
    business: null,
    periodFrom: '2026-10-26T07:00:00.000Z',
    periodTo: '2026-11-02T07:00:00.000Z',
    isoYear: 2026,
    isoWeek: 44,
    status: 'ISSUED',
    periodCents: 2_235,
    adjustmentsCents: 0,
    totalCents: 2_235,
    paidCents: 0,
    pendingCents: 2_235,
    generatedAt: '2026-11-02T09:05:00.000Z',
    auto: true,
    overdue: false,
    daysOpen: 1,
    party: { venueName: 'Luna', venueSlug: 'luna', businessName: null, businessTaxId: null },
    nights: [
      { day: '2026-10-30', from: '2026-10-30T07:00:00.000Z', to: '2026-10-31T07:00:00.000Z', concepts: { ...emptyConceptAmounts(), serviceFeeSales: 2_330, serviceFeeRefunded: -95 }, totalCents: 2_235 },
      { day: '2026-10-31', from: '2026-10-31T07:00:00.000Z', to: '2026-11-01T07:00:00.000Z', concepts: emptyConceptAmounts(), totalCents: 0 },
    ],
    adjustments: [],
    byConcept: { ...emptyConceptAmounts(), serviceFeeSales: 2_330, serviceFeeRefunded: -95 },
    moneyMapCents: 2_235,
    payments: [],
    voidedAt: null,
    voidReason: null,
    replacesId: null,
    payee: null,
    ...o,
  };
}

describe('estado y periodo de una liquidación', () => {
  it('emitida, en parte, pagada, anulada; con más de 7 días sin pagar, en rojo y con los días', () => {
    expect(settlementStatusView(detail())).toEqual({ label: 'Emitida', tone: 'info' });
    expect(settlementStatusView(detail({ status: 'PARTIALLY_PAID' }))).toEqual({ label: 'Pagada en parte', tone: 'warning' });
    expect(settlementStatusView(detail({ status: 'PAID' }))).toEqual({ label: 'Pagada', tone: 'success' });
    expect(settlementStatusView(detail({ status: 'VOID' }))).toEqual({ label: 'Anulada', tone: 'neutral' });
    expect(settlementStatusView(detail({ overdue: true, daysOpen: 9 }))).toEqual({ label: 'Emitida · 9 días sin pagar', tone: 'danger' });
  });

  it('periodo: semana ISO y de lunes a lunes (hora de Madrid)', () => {
    expect(settlementPeriodText(detail())).toBe('Semana 44 de 2026 · lun 26 oct → lun 2 nov (08:00)');
  });

  it('conceptos con algo y columnas de la tabla por noche', () => {
    expect(conceptRows(detail()).map((r) => [r.label, r.cents])).toEqual([
      ['Comisión del servicio · pagos con tarjeta y datáfono', 2_330],
      ['Comisión del servicio devuelta', -95],
    ]);
    expect(nightColumns(detail())).toEqual(['serviceFeeSales', 'serviceFeeRefunded']);
  });

  it('lo de la transferencia, para copiarlo de una vez', () => {
    const text = transferText(detail(), { name: 'OxioPay S.L.', iban: 'ES9121000418450200051332', holder: 'OxioPay Pagos S.L.', updatedAt: 'x' });
    expect(text).toBe(`Titular: OxioPay Pagos S.L.\nIBAN: ES91 2100 0418 4502 0005 1332\nConcepto: OXP-2026-S44-LUNA\nImporte: ${formatEur(2_235)}`);
  });
});

describe('apuntar un pago', () => {
  it('de entrada, lo pendiente y hoy; así se apunta sin motivo', () => {
    const form = paymentFormFor(detail(), TODAY);
    expect(form).toEqual({ amount: '22,35', paidOn: TODAY, bankReference: '', reason: '' });
    expect(paymentPayload({ ...form, bankReference: ' TRF-1 ' }, 2_235, TODAY)).toEqual({
      ok: true,
      value: { amountCents: 2_235, paidOn: TODAY, bankReference: 'TRF-1' },
    });
    expect(paymentMismatch(form, 2_235)).toBe(false);
  });

  it('menos de lo pendiente: con motivo (queda pendiente lo que falta); más, no; sin referencia o con fecha futura, no', () => {
    const form = { amount: '10', paidOn: TODAY, bankReference: 'TRF-1', reason: '' };
    expect(paymentMismatch(form, 2_235)).toBe(true);
    const noReason = paymentPayload(form, 2_235, TODAY);
    expect(noReason.ok).toBe(false);
    expect(paymentPayload({ ...form, reason: 'A cuenta' }, 2_235, TODAY)).toEqual({
      ok: true,
      value: { amountCents: 1_000, paidOn: TODAY, bankReference: 'TRF-1', reason: 'A cuenta' },
    });
    expect(paymentPayload({ ...form, amount: '30', reason: 'Dos semanas' }, 2_235, TODAY)).toMatchObject({ ok: false });
    expect(paymentPayload({ ...form, bankReference: '  ' }, 2_235, TODAY)).toMatchObject({ ok: false, error: expect.stringMatching(/referencia del banco/) });
    expect(paymentPayload({ ...form, paidOn: '2026-11-04' }, 2_235, TODAY)).toMatchObject({ ok: false, error: expect.stringMatching(/futuro/) });
    expect(paymentPayload({ ...form, amount: 'abc' }, 2_235, TODAY)).toMatchObject({ ok: false, error: expect.stringMatching(/importe/) });
  });

  it('frase de confirmación: pagada entera o lo que queda', () => {
    expect(paymentSummary(detail(), 2_235)).toBe(`Vas a apuntar ${formatEur(2_235)} recibidos de OXP-2026-S44-LUNA: queda pagada entera.`);
    expect(paymentSummary(detail(), 1_000)).toBe(`Vas a apuntar ${formatEur(1_000)} recibidos de OXP-2026-S44-LUNA: quedan ${formatEur(1_235)} pendientes.`);
  });
});

describe('filtros, aviso del dueño y archivos', () => {
  it('filtros de la consola: de entrada, las pendientes; lo vacío no se manda', () => {
    expect(settlementsQuery(EMPTY_SETTLEMENT_FILTERS)).toBe('?status=OPEN');
    expect(settlementsQuery({ ...EMPTY_SETTLEMENT_FILTERS, status: '', venueId: 'v1', from: '2026-10-01', q: ' s44 ' })).toBe('?venueId=v1&from=2026-10-01&q=s44');
  });

  it('el aviso del panel del dueño: una o varias con más de 7 días; sin ninguna, nada', () => {
    expect(overdueNoticeText(null)).toBeNull();
    expect(overdueNoticeText({ overdue: [], overdueCents: 0 })).toBeNull();
    expect(overdueNoticeText({ overdue: [{ id: 'a', reference: 'OXP-2026-S44-LUNA', pendingCents: 2_235, daysOpen: 9 }], overdueCents: 2_235 })).toBe(
      `La liquidación OxioPay OXP-2026-S44-LUNA lleva 9 días sin pagar: faltan ${formatEur(2_235)}.`,
    );
    expect(
      overdueNoticeText({
        overdue: [
          { id: 'a', reference: 'A', pendingCents: 100, daysOpen: 9 },
          { id: 'b', reference: 'B', pendingCents: 200, daysOpen: 16 },
        ],
        overdueCents: 300,
      }),
    ).toBe(`Tienes 2 liquidaciones OxioPay con más de 7 días sin pagar: faltan ${formatEur(300)} en total.`);
  });

  it('nombres de los archivos, como el API', () => {
    expect(settlementFileName('OXP-2026-S44-LUNA', 'csv')).toBe('liquidacion-oxiopay-OXP-2026-S44-LUNA.csv');
  });
});

describe('generar una semana a mano', () => {
  it('solo un lunes de una semana ya terminada', () => {
    expect(weekStartProblem('2026-10-26', '2026-11-02')).toBeNull();
    expect(weekStartProblem('2026-10-27', '2026-11-03')).toMatch(/lunes/);
    expect(weekStartProblem('2026-11-02', '2026-11-03')).toMatch(/aún no ha terminado/);
    expect(weekStartProblem('', '2026-11-03')).toMatch(/lunes/);
  });

  it('para empezar, el lunes de la última semana terminada', () => {
    expect(lastMondayBefore('2026-11-03')).toBe('2026-10-26');
    expect(lastMondayBefore('2026-11-02')).toBe('2026-10-26');
    expect(lastMondayBefore('2026-11-08')).toBe('2026-10-26');
  });
});
