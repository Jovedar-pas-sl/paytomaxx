import { describe, expect, it } from 'vitest';
import { BadRequestException, ConflictException, type HttpException } from '@nestjs/common';
import { paymentRefusal } from './settlement-payments';

const W_FROM = new Date('2026-10-26T07:00:00Z');
const base = {
  settlement: { status: 'ISSUED' as const, totalCents: 2_235, paidCents: 0, periodFrom: W_FROM },
  existing: [] as Array<{ bankReference: string; amountCents: number; paidOn: Date }>,
  dto: { amountCents: 2_235, paidOn: '2026-11-03', bankReference: 'TRF-1' },
  today: '2026-11-05',
};
const code = (e: HttpException | null) => (e?.getResponse() as { code?: string } | undefined)?.code;

describe('apuntar un pago: qué se rechaza y cómo', () => {
  it('lo pendiente, con fecha entre la semana y hoy: vale', () => {
    expect(paymentRefusal(base)).toBeNull();
  });

  it('anulada o ya pagada: 409; fecha futura o anterior a la semana: 400; sin motivo o de más: 400', () => {
    expect(paymentRefusal({ ...base, settlement: { ...base.settlement, status: 'VOID' } })).toBeInstanceOf(ConflictException);
    expect(paymentRefusal({ ...base, settlement: { ...base.settlement, status: 'PAID', paidCents: 2_235 } })).toBeInstanceOf(ConflictException);
    expect(paymentRefusal({ ...base, dto: { ...base.dto, paidOn: '2026-11-06' } })?.message).toMatch(/futura/);
    expect(paymentRefusal({ ...base, dto: { ...base.dto, paidOn: '2026-10-25' } })?.message).toMatch(/anterior a la semana/);
    expect(paymentRefusal({ ...base, dto: { ...base.dto, amountCents: 1_000 } })).toBeInstanceOf(BadRequestException);
    expect(paymentRefusal({ ...base, dto: { ...base.dto, amountCents: 3_000, reason: 'De más' } })?.message).toMatch(/mayor que lo pendiente/);
  });

  it('la misma referencia del banco otra vez (sin mayúsculas ni espacios de más): 409 SETTLEMENT_PAYMENT_DUPLICATE, salvo que se confirme', () => {
    const partial = { ...base, settlement: { ...base.settlement, status: 'PARTIALLY_PAID' as const, paidCents: 1_000 } };
    const existing = [{ bankReference: 'TRF-1', amountCents: 1_000, paidOn: new Date('2026-11-03T00:00:00Z') }];
    const dup = paymentRefusal({ ...partial, existing, dto: { amountCents: 1_235, paidOn: '2026-11-04', bankReference: ' trf-1 ' } });
    expect(dup).toBeInstanceOf(ConflictException);
    expect(code(dup)).toBe('SETTLEMENT_PAYMENT_DUPLICATE');
    expect(dup?.message).toMatch(/TRF-1/);
    expect(paymentRefusal({ ...partial, existing, dto: { amountCents: 1_235, paidOn: '2026-11-04', bankReference: 'TRF-1', confirmDuplicate: true } })).toBeNull();
    expect(paymentRefusal({ ...partial, existing, dto: { amountCents: 1_235, paidOn: '2026-11-04', bankReference: 'TRF-2' } })).toBeNull();
  });
});
