import { describe, expect, it } from 'vitest';
import { refundServiceFeeHint } from './service-fee-text';

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
