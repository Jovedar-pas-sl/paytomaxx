import { describe, it, expect } from 'vitest';
import { amountToleranceUsdt, amountVerdict, checkTxTime, expectedUsdtOf, usdtToEurCents } from './onchain-check';

describe('amountToleranceUsdt — ±0,5 % y nunca más de 1 USDT', () => {
  it('pagos normales: 0,5 %', () => {
    expect(amountToleranceUsdt(100)).toBeCloseTo(0.5);
    expect(amountToleranceUsdt(20)).toBeCloseTo(0.1);
  });
  it('pagos grandes: tope de 1 USDT', () => {
    expect(amountToleranceUsdt(1_000)).toBe(1);
  });
});

describe('amountVerdict — se compara en USDT, con lo que llegó a su dirección', () => {
  const at = new Date('2026-10-14T20:00:00Z');
  it('dentro del margen → MATCHED con lo recibido en USDT (no en «céntimos» mezclados con EUR)', () => {
    expect(amountVerdict(106.7, 107, at)).toEqual({
      matched: true,
      status: 'MATCHED',
      occurredAt: at,
      actualAmountCents: null,
      actualAmountUsdt: 106.7,
      reason: null,
    });
  });
  it('fuera del margen → MISMATCH con un motivo que se entiende', () => {
    const r = amountVerdict(106, 107, at);
    expect(r).toMatchObject({ matched: false, status: 'MISMATCH', actualAmountUsdt: 106 });
    expect(r.reason).toBe('importe_distinto: llegaron 106,00 USDT y se esperaban 107,00 USDT (margen ±0,54)');
  });
  it('de más también es MISMATCH (puede ser una transacción que paga otra cosa)', () => {
    expect(amountVerdict(214, 107, at).status).toBe('MISMATCH');
  });
});

describe('expectedUsdtOf — la foto del tipo de cambio del pago manda', () => {
  it('con foto (expectedAmountUsdt) la usa tal cual; sin ella, tipo actual', async () => {
    const rate = async () => 1.2;
    expect(await expectedUsdtOf({ externalTxId: 'x', expectedToAddress: 'a', expectedAmountCents: 10_000, expectedAmountUsdt: 107 }, rate)).toBe(107);
    expect(await expectedUsdtOf({ externalTxId: 'x', expectedToAddress: 'a', expectedAmountCents: 10_000 }, rate)).toBeCloseTo(120);
  });
});

describe('checkTxTime — una transacción de antes del pago no lo verifica', () => {
  const created = new Date('2026-10-14T12:00:00Z');
  const matched = (occurredAt: Date | null) => ({
    matched: true,
    status: 'MATCHED' as const,
    occurredAt,
    actualAmountCents: null,
    actualAmountUsdt: 107,
    reason: null,
  });
  it('después del pago, o hasta 24 h antes (se paga y luego se apunta) → vale', () => {
    expect(checkTxTime(matched(new Date('2026-10-14T13:00:00Z')), created).matched).toBe(true);
    expect(checkTxTime(matched(new Date('2026-10-13T13:00:00Z')), created).matched).toBe(true);
  });
  it('más de 24 h antes → MISMATCH (no se reutiliza una transacción vieja)', () => {
    const r = checkTxTime(matched(new Date('2026-10-01T10:00:00Z')), created);
    expect(r).toMatchObject({ matched: false, status: 'MISMATCH' });
    expect(r.reason).toMatch(/^tx_anterior_al_pago: /);
  });
  it('sin fecha de la transacción no se da por buena: queda sin conciliar', () => {
    expect(checkTxTime(matched(null), created)).toMatchObject({ matched: false, status: 'UNRECONCILED' });
  });
  it('lo que ya no cuadraba se deja igual', () => {
    const mismatch = { matched: false, status: 'MISMATCH' as const, occurredAt: null, actualAmountCents: null, reason: 'x' };
    expect(checkTxTime(mismatch, created)).toBe(mismatch);
  });
});

describe('usdtToEurCents — en EUR solo con la foto del tipo de cambio del pago', () => {
  it('USDT / tipo del pago → céntimos de euro', () => {
    expect(usdtToEurCents(107, '1.07')).toBe(10_000);
  });
  it('sin tipo o sin importe → null (no se inventa)', () => {
    expect(usdtToEurCents(107, null)).toBeNull();
    expect(usdtToEurCents(null, '1.07')).toBeNull();
  });
});
