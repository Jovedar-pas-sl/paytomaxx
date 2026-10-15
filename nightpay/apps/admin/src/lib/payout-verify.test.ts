import { describe, expect, it } from 'vitest';
import { describeVerifyReason, describeVerifyResult, payoutReferenceError } from './payout-verify';

describe('describeVerifyResult', () => {
  it('cuadra → éxito', () => {
    const out = describeVerifyResult({ matched: true, status: 'MATCHED', reason: null });
    expect(out.tone).toBe('success');
  });

  it('no cuadra → error con el motivo en frase', () => {
    const out = describeVerifyResult({
      matched: false,
      status: 'MISMATCH',
      reason: 'tron_amount_95.00_vs_100.00',
    });
    expect(out.tone).toBe('danger');
    expect(out.message).toContain('95.00');
    expect(out.message).toContain('100.00');
  });

  it('sin confirmar todavía → aviso', () => {
    const out = describeVerifyResult({ matched: false, status: 'UNRECONCILED', reason: 'bsc_unconfirmed' });
    expect(out.tone).toBe('warning');
    expect(out.message).toMatch(/confirmada/);
  });

  it('método manual → información, no error', () => {
    const out = describeVerifyResult({ matched: false, status: 'UNRECONCILED', reason: 'manual_required' });
    expect(out.tone).toBe('info');
  });
});

describe('describeVerifyReason', () => {
  it('dirección distinta', () => {
    expect(describeVerifyReason('poly_to_mismatch_0xabc')).toContain('0xabc');
  });

  it('un motivo que ya es una frase se enseña tal cual', () => {
    expect(describeVerifyReason('La dirección no coincide')).toBe('La dirección no coincide');
  });

  it('un código desconocido se enseña como motivo', () => {
    expect(describeVerifyReason('raro_xyz')).toBe('Motivo: raro_xyz');
    expect(describeVerifyReason(null)).toBeNull();
  });
});

describe('payoutReferenceError', () => {
  it('referencia corta o recibo que no es web', () => {
    expect(payoutReferenceError({ externalTxId: 'abc', receiptUrl: '' })).toMatch(/corta/);
    expect(payoutReferenceError({ externalTxId: '', receiptUrl: 'javascript:alert(1)' })).toMatch(/https/);
  });

  it('vacío o correcto vale', () => {
    expect(payoutReferenceError({ externalTxId: '', receiptUrl: '' })).toBeNull();
    expect(payoutReferenceError({ externalTxId: '0xabcd', receiptUrl: 'https://x.com/r.png' })).toBeNull();
  });
});

describe('motivos del API nuevo', () => {
  it('"codigo: detalle" → etiqueta en castellano y el detalle', () => {
    const out = describeVerifyResult({
      matched: false,
      status: 'MISMATCH',
      reason: 'importe_distinto: llegaron 95 USDT y se esperaban 100 USDT (margen ±0,5)',
      actualAmountUsdt: 95,
    });
    expect(out.tone).toBe('danger');
    expect(out.message).toContain('El importe no cuadra');
    expect(out.message).not.toContain('importe_distinto');
    expect(out.message).not.toMatch(/Llegaron 95/); // ya lo dice el motivo
  });

  it('solo el código', () => {
    expect(describeVerifyReason('sin_usdt')).toBe('No es un envío de USDT/USDC.');
    expect(describeVerifyReason('tx_anterior_al_pago: la transacción es del 2026-10-01')).toContain('anterior al pago');
  });

  it('lo que llegó se añade si el motivo no lo dice', () => {
    const out = describeVerifyResult({ matched: false, status: 'MISMATCH', reason: 'destino_distinto', actualAmountUsdt: 50 });
    expect(out.message).toContain('Llegaron 50');
  });
});
