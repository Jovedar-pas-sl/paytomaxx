import { describe, expect, it } from 'vitest';
import { emptyConceptAmounts, type SettlementDetail } from '@nightpay/contracts';
import { settlementCsv, settlementDocumentHtml, settlementFileName } from './settlement-document';
import { nightsOf, weekStartingOn } from './settlement-week';

const NOW = new Date('2026-11-03T10:00:00Z');
const W = weekStartingOn('2026-10-26');

function detail(o: Partial<SettlementDetail> = {}): SettlementDetail {
  const nights = nightsOf(W).map((n) => {
    const concepts =
      n.day === '2026-10-30'
        ? { ...emptyConceptAmounts(), serviceFeeSales: 660, serviceFeeCardTopUps: 600, serviceFeeCashTopUps: 600, serviceFeeRefunded: -425 }
        : n.day === '2026-10-31'
          ? { ...emptyConceptAmounts(), platformSaldo: 200 }
          : emptyConceptAmounts();
    const totalCents = Object.values(concepts).reduce((a, b) => a + b, 0);
    return { day: n.day, from: n.from.toISOString(), to: n.to.toISOString(), concepts, totalCents };
  });
  return {
    id: '11111111-1111-4111-8111-111111111111',
    reference: 'OXP-2026-S44-LUNA',
    venue: { id: '22222222-2222-4222-8222-222222222222', name: 'Luna <Valencia>', slug: 'luna' },
    business: { id: '33333333-3333-4333-8333-333333333333', name: 'Noches Luna S.L.' },
    periodFrom: W.from.toISOString(),
    periodTo: W.to.toISOString(),
    isoYear: 2026,
    isoWeek: 44,
    status: 'ISSUED',
    periodCents: 1_635,
    adjustmentsCents: -95,
    totalCents: 1_540,
    paidCents: 0,
    pendingCents: 1_540,
    generatedAt: '2026-11-02T09:05:00.000Z',
    auto: true,
    overdue: false,
    daysOpen: 1,
    party: { venueName: 'Luna <Valencia>', venueSlug: 'luna', businessName: 'Noches Luna S.L.', businessTaxId: 'B12345678' },
    nights,
    adjustments: [
      { weekFrom: '2026-10-19', isoYear: 2026, isoWeek: 43, reference: 'OXP-2026-S43-LUNA', day: '2026-10-23', concept: 'serviceFeeRefunded', amountCents: -95 },
    ],
    byConcept: { ...emptyConceptAmounts(), serviceFeeSales: 660, serviceFeeCardTopUps: 600, serviceFeeCashTopUps: 600, serviceFeeRefunded: -425, platformSaldo: 200 },
    moneyMapCents: 1_635,
    payments: [],
    voidedAt: null,
    voidReason: null,
    replacesId: null,
    payee: { name: 'OxioPay S.L.', iban: 'ES9121000418450200051332', holder: 'OxioPay Pagos S.L.', updatedAt: '2026-10-27T10:00:00.000Z' },
    ...o,
  };
}

describe('documento imprimible de la «Liquidación OxioPay» (no es una factura)', () => {
  it('lleva OxioPay (nombre, IBAN en grupos y titular), el local con su razón social y NIF, el periodo, el desglose y la referencia', () => {
    const html = settlementDocumentHtml(detail(), NOW);
    expect(html).toContain('<title>Liquidación OxioPay OXP-2026-S44-LUNA</title>');
    expect(html).toContain('No es una factura');
    expect(html).toContain('OxioPay S.L.');
    expect(html).toContain('ES91 2100 0418 4502 0005 1332');
    expect(html).toContain('OxioPay Pagos S.L.');
    expect(html).toContain('Noches Luna S.L.');
    expect(html).toContain('B12345678');
    expect(html).toContain('Semana 44 de 2026');
    expect(html).toContain('lunes, 26 de octubre de 2026, 08:00');
    expect(html).toContain('lunes, 2 de noviembre de 2026, 08:00');
    // Por concepto y por noche, con el formato de siempre.
    expect(html).toContain('Comisión del servicio · recargas en efectivo');
    expect(html).toContain('vie 30 oct');
    expect(html).toContain('6,60\u00a0€');
    expect(html).toContain('−4,25\u00a0€');
    // Ajustes de semanas anteriores, con su semana, noche y la liquidación de entonces.
    expect(html).toContain('Ajustes de semanas anteriores');
    expect(html).toContain('OXP-2026-S43-LUNA');
    expect(html).toContain('vie 23 oct');
    // Total y lo que falta, con la referencia para la transferencia.
    expect(html).toContain('15,40\u00a0€');
    expect(html).toMatch(/Concepto de la transferencia[\s\S]*OXP-2026-S44-LUNA/);
  });

  it('el resumen por concepto es solo de la semana: cuadra con «Total de la semana» y con la tabla por noche', () => {
    const html = settlementDocumentHtml(detail(), NOW);
    const summary = html.slice(html.indexOf('<h2>Resumen</h2>'), html.indexOf('Total de la semana'));
    // La devuelta de la semana (−4,25 €), no la de la semana + el ajuste (−5,20 €).
    expect(summary).toContain('Comisión del servicio devuelta');
    expect(summary).toContain('4,25');
    expect(summary).not.toContain('5,20');
  });

  it('dice cuándo se puso o cambió la cuenta de OxioPay (para comprobarla antes de transferir)', () => {
    expect(settlementDocumentHtml(detail(), NOW)).toContain('Cuenta de OxioPay puesta o cambiada el 27 de octubre de 2026');
  });

  it('escapa lo escrito por personas (nombre del local)', () => {
    const html = settlementDocumentHtml(detail(), NOW);
    expect(html).not.toContain('Luna <Valencia>');
    expect(html).toContain('Luna &lt;Valencia&gt;');
  });

  it('sin la cuenta de OxioPay: sale igual, pero avisa de que falta', () => {
    const html = settlementDocumentHtml(detail({ payee: null }), NOW);
    expect(html).toContain('OxioPay aún no ha puesto la cuenta');
    expect(html).not.toContain('ES91');
  });

  it('pagada en parte: lo pagado, los pagos y lo pendiente; anulada: lo dice bien grande', () => {
    const partial = settlementDocumentHtml(
      detail({
        status: 'PARTIALLY_PAID',
        paidCents: 1_000,
        pendingCents: 540,
        payments: [
          { id: '44444444-4444-4444-8444-444444444444', amountCents: 1_000, paidOn: '2026-11-04', bankReference: 'TRF-889', reason: 'Pagó a cuenta', recordedAt: NOW.toISOString(), recordedByEmail: null },
        ],
      }),
      NOW,
    );
    expect(partial).toContain('Pagada en parte');
    // Las notas de los pagos son de OxioPay (su registro): el documento no las lleva.
    expect(partial).not.toContain('Pagó a cuenta');
    expect(partial).toContain('TRF-889');
    expect(partial).toContain('5,40\u00a0€');
    const voided = settlementDocumentHtml(detail({ status: 'VOID', pendingCents: 0, voidedAt: NOW.toISOString(), voidReason: 'Cifras mal' }), NOW);
    expect(voided).toContain('Anulada');
    expect(voided).toContain('No hay que pagarla');
    expect(voided).not.toContain('Cifras mal');
  });
});

describe('CSV de la liquidación', () => {
  it('una fila por noche y concepto con importe, los ajustes y los totales; Excel en español', () => {
    const csv = settlementCsv(detail());
    expect(csv.startsWith('\uFEFF')).toBe(true);
    const rows = csv.replace(/^\uFEFF/, '').trimEnd().split('\r\n');
    expect(rows[0]).toBe('Referencia;Local;Parte;Semana;Noche;Concepto;Importe');
    expect(rows).toContain('"=""OXP-2026-S44-LUNA""";Luna <Valencia>;Semana;26/10/2026;30/10/2026;Comisión del servicio · pagos con tarjeta y datáfono;6,60');
    expect(rows).toContain('"=""OXP-2026-S44-LUNA""";Luna <Valencia>;Ajuste de la semana 43;19/10/2026;23/10/2026;Comisión del servicio devuelta;-0,95');
    expect(rows).toContain('"=""OXP-2026-S44-LUNA""";Luna <Valencia>;Total de la semana;;;;16,35');
    expect(rows).toContain('"=""OXP-2026-S44-LUNA""";Luna <Valencia>;Ajustes de semanas anteriores;;;;-0,95');
    expect(rows).toContain('"=""OXP-2026-S44-LUNA""";Luna <Valencia>;Total a pagar;;;;15,40');
    expect(rows).toContain('"=""OXP-2026-S44-LUNA""";Luna <Valencia>;Pendiente;;;;15,40');
    // Las noches a 0 no salen.
    expect(rows.slice(1).filter((r) => r.includes(';Semana;')).length).toBe(5);
  });

  it('nombre del archivo con la referencia', () => {
    expect(settlementFileName(detail(), 'csv')).toBe('liquidacion-oxiopay-OXP-2026-S44-LUNA.csv');
    expect(settlementFileName(detail(), 'html')).toBe('liquidacion-oxiopay-OXP-2026-S44-LUNA.html');
  });
});
