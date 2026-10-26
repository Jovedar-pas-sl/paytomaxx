import { describe, expect, it } from 'vitest';
import { refundFeePartText, refundServiceFeeHint } from './service-fee-text';

const sp = (s: string | null) => s?.replace(/\s/g, ' ') ?? null;

describe('devolver un cobro con la «Comisión del servicio»', () => {
  it('un pago directo: se devuelve también su comisión, en proporción', () => {
    expect(sp(refundServiceFeeHint({ serviceFeeCents: 330, walletId: null }))).toBe(
      'Lleva 3,30 € de comisión del servicio: al devolver, vuelve también su parte (en proporción a lo devuelto).',
    );
  });

  it('una recarga del saldo: su comisión no se devuelve (solo el saldo)', () => {
    expect(sp(refundServiceFeeHint({ serviceFeeCents: 600, walletId: 'w1' }))).toBe(
      'La comisión del servicio de esta recarga (6,00 €) no se devuelve: solo el saldo.',
    );
  });

  it('sin comisión (o un API de antes): nada', () => {
    expect(refundServiceFeeHint({ serviceFeeCents: 0, walletId: null })).toBeNull();
    expect(refundServiceFeeHint({})).toBeNull();
  });
});

describe('«Registrar devolución de BBVA»: qué parte de lo devuelto es comisión del servicio', () => {
  // 33 € + 3,30 € + 2 € de propina = 38,30 €.
  const pago = { amountCents: 3_300, serviceFeeCents: 330, tipCents: 200, availableAmountCents: 3_830, walletId: null };

  it('11 € de 38,30 €: 0,95 €; luego el resto (27,30 €): 2,35 € (en total, los 3,30 €)', () => {
    expect(sp(refundFeePartText(pago, 1_100))).toBe('De estos 11,00 €, 0,95 € son comisión del servicio (vuelven al cliente y dejan de ser de OxioPay).');
    expect(sp(refundFeePartText({ ...pago, availableAmountCents: 2_730 }, 2_730))).toBe(
      'De estos 27,30 €, 2,35 € son comisión del servicio (vuelven al cliente y dejan de ser de OxioPay).',
    );
  });

  it('una recarga, sin comisión o sin importe válido: nada', () => {
    expect(refundFeePartText({ ...pago, walletId: 'w1' }, 1_100)).toBeNull();
    expect(refundFeePartText({ ...pago, serviceFeeCents: 0 }, 1_100)).toBeNull();
    expect(refundFeePartText(pago, null)).toBeNull();
    expect(refundFeePartText(pago, 9_999)).toBeNull();
  });
});
