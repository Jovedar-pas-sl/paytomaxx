import { describe, it, expect } from 'vitest';
import { madridDay } from '../../common/time/madrid';
import { idempotencyKeyOf } from '../../common/decorators/idempotent.decorator';
import { txAlreadyUsed } from '../treasury/payout-tx-guard';
import { payoutKeyReused, payoutRequestHash } from './payout-idempotency';

describe('Idempotency-Key de «Marcar pagado»', () => {
  it('la huella: quién paga, a qué chica y qué pide; el 2FA no cuenta (cambia cada 30 s)', () => {
    const base = payoutRequestHash('own-1', 'op-1', { notes: 'semana', expectedTotalCents: 12_500 });
    expect(payoutRequestHash('own-1', 'op-1', { notes: 'semana', expectedTotalCents: 12_500, totpCode: '123456' })).toBe(base);
    expect(payoutRequestHash('own-1', 'op-1', { expectedTotalCents: 12_500, notes: 'semana' })).toBe(base);
    expect(payoutRequestHash('own-2', 'op-1', { notes: 'semana', expectedTotalCents: 12_500 })).not.toBe(base);
    expect(payoutRequestHash('own-1', 'op-2', { notes: 'semana', expectedTotalCents: 12_500 })).not.toBe(base);
    expect(payoutRequestHash('own-1', 'op-1', { notes: 'semana', expectedTotalCents: 12_400 })).not.toBe(base);
  });

  it('la clave reutilizada con otra petición: 409 IDEMPOTENCY_KEY_REUSED', () => {
    expect(payoutKeyReused().getResponse()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('la cabecera: opcional, pero si viene, bien formada', () => {
    expect(idempotencyKeyOf(undefined)).toBeNull();
    expect(idempotencyKeyOf('')).toBeNull();
    expect(idempotencyKeyOf('7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b')).toBe('7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b');
    expect(idempotencyKeyOf(['pago-0001-abcdef', 'otra-0002'])).toBe('pago-0001-abcdef');
    expect(() => idempotencyKeyOf('corta')).toThrow(/Invalid Idempotency-Key/);
    expect(() => idempotencyKeyOf('con espacios 123')).toThrow(/Invalid Idempotency-Key/);
  });
});

describe('hash on-chain ya usado: la fecha del otro pago, en día de Madrid', () => {
  it('un pago de las 00:30 de Madrid sale con su día (no el anterior de UTC)', () => {
    const createdAt = new Date('2026-10-14T22:30:00Z'); // 15/10 a las 00:30 en Madrid (CEST)
    expect(madridDay(createdAt)).toBe('2026-10-15');
    const body = txAlreadyUsed({ id: 'po-9', createdAt }).getResponse() as { message: string };
    expect(body.message).toContain('(del 2026-10-15)');
  });
});
