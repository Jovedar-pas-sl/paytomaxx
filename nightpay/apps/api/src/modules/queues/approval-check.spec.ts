import { describe, it, expect } from 'vitest';
import { expectedCharge, judgeApproval, verdictDetail } from './approval-check';

describe('expectedCharge — lo que se mandó al banco', () => {
  it('el intento manda (importe + propina desde la Fase 1B)', () => {
    expect(expectedCharge({ amountCents: 5000, currency: 'EUR' }, { amountCents: 5500 })).toEqual({
      amountCents: 5500,
      currency: 'EUR',
    });
  });

  it('intento antiguo (sin importe) o sin intento → importe del cobro', () => {
    expect(expectedCharge({ amountCents: 5000, currency: 'EUR' }, { amountCents: null }).amountCents).toBe(5000);
    expect(expectedCharge({ amountCents: 5000, currency: 'EUR' }, null).amountCents).toBe(5000);
  });
});

describe('judgeApproval', () => {
  const expected = { amountCents: 5000, currency: 'EUR' };

  it('confirmado con el mismo importe y moneda (sin distinguir mayúsculas) → ok', () => {
    expect(judgeApproval({ kind: 'confirmed', amountCents: 5000, currency: 'eur' }, expected)).toEqual({ ok: true });
  });

  it('la pasarela no dice la moneda → solo cuenta el importe', () => {
    expect(judgeApproval({ kind: 'confirmed', amountCents: 5000, currency: null }, expected)).toEqual({ ok: true });
  });

  it('un céntimo de diferencia ya no vale', () => {
    const v = judgeApproval({ kind: 'confirmed', amountCents: 5001, currency: 'EUR' }, expected);
    expect(v).toMatchObject({ ok: false, eventType: 'payment.amount_mismatch' });
    if (!v.ok) {
      expect(verdictDetail(v)).toEqual({
        chargedCents: 5001,
        chargedCurrency: 'EUR',
        expectedCents: 5000,
        expectedCurrency: 'EUR',
      });
    }
  });

  it('sin prueba (no comprobable o rechazada) → incidencia "sin comprobar" con el motivo', () => {
    const v = judgeApproval({ kind: 'unverifiable', reason: 'peanpe-sin-consulta' }, expected);
    expect(v).toEqual({ ok: false, eventType: 'payment.approval_unverified', reason: 'peanpe-sin-consulta' });
    if (!v.ok) expect(verdictDetail(v)).toEqual({ reason: 'peanpe-sin-consulta' });
    expect(judgeApproval({ kind: 'rejected', reason: 'no-aprobado' }, expected)).toMatchObject({ ok: false });
  });
});
