import { describe, expect, it } from 'vitest';
import {
  GenerateSettlementSchema,
  RecordSettlementPaymentSchema,
  SetOxioPayPayeeSchema,
  SettlementListQuerySchema,
  SetSettlementStartSchema,
  VoidSettlementSchema,
  formatIbanGroups,
  isMondayDay,
  isRealDay,
  normalizeBankReference,
  settlementNightLabel,
  settlementPaymentProblem,
  settlementPendingCents,
  settlementStatusAfterPayment,
} from '@nightpay/contracts';

describe('contratos de la «Liquidación OxioPay»', () => {
  it('apuntar un pago: lo pendiente sin motivo; menos, con motivo; más, no', () => {
    expect(settlementPaymentProblem({ pendingCents: 2_235, amountCents: 2_235 })).toBeNull();
    expect(settlementPaymentProblem({ pendingCents: 2_235, amountCents: 1_000 })).toMatch(/no coincide con lo pendiente \(22,35\u00a0€\): pon el motivo/);
    expect(settlementPaymentProblem({ pendingCents: 2_235, amountCents: 1_000, reason: 'A cuenta' })).toBeNull();
    expect(settlementPaymentProblem({ pendingCents: 2_235, amountCents: 3_000, reason: 'Dos semanas' })).toMatch(/mayor que lo pendiente/);
    expect(settlementPaymentProblem({ pendingCents: 0, amountCents: 1 })).toMatch(/nada pendiente/);
    expect(settlementPaymentProblem({ pendingCents: 100, amountCents: 0 })).toMatch(/mayor que 0/);
  });

  it('estado tras pagar y lo pendiente (una anulada no tiene nada pendiente)', () => {
    expect(settlementStatusAfterPayment(2_235, 0)).toBe('ISSUED');
    expect(settlementStatusAfterPayment(2_235, 1_000)).toBe('PARTIALLY_PAID');
    expect(settlementStatusAfterPayment(2_235, 2_235)).toBe('PAID');
    expect(settlementPendingCents({ status: 'PARTIALLY_PAID', totalCents: 2_235, paidCents: 1_000 })).toBe(1_235);
    expect(settlementPendingCents({ status: 'VOID', totalCents: 2_235, paidCents: 0 })).toBe(0);
  });

  it('esquemas: código 2FA, motivo, día AAAA-MM-DD, referencia del banco e IBAN mod-97 (se guarda sin espacios)', () => {
    const pay = { amountCents: 2_235, paidOn: '2026-11-03', bankReference: ' TRF-1 ', totpCode: '123 456' };
    expect(RecordSettlementPaymentSchema.parse(pay)).toEqual({ ...pay, bankReference: 'TRF-1', totpCode: '123456' });
    expect(RecordSettlementPaymentSchema.safeParse({ ...pay, amountCents: 0 }).success).toBe(false);
    expect(RecordSettlementPaymentSchema.safeParse({ ...pay, paidOn: '3/11/2026' }).success).toBe(false);
    expect(RecordSettlementPaymentSchema.safeParse({ ...pay, reason: 'no' }).success).toBe(false);
    expect(VoidSettlementSchema.safeParse({ totpCode: '123456' }).success).toBe(false);
    expect(GenerateSettlementSchema.safeParse({ venueId: '00000000-0000-4000-8000-0000000000aa', week: '2026-10-26', totpCode: '123456' }).success).toBe(true);
    const payee = SetOxioPayPayeeSchema.parse({ name: 'OxioPay S.L.', iban: 'es91 2100 0418 4502 0005 1332', holder: 'OxioPay Pagos', totpCode: '123456' });
    expect(payee.iban).toBe('ES9121000418450200051332');
    expect(SetOxioPayPayeeSchema.safeParse({ ...payee, iban: 'ES9121000418450200051333' }).success).toBe(false);
    expect(SettlementListQuerySchema.safeParse({ status: 'OPEN' }).success).toBe(true);
    expect(SettlementListQuerySchema.safeParse({ status: 'PAGADA' }).success).toBe(false);
  });

  it('IBAN en grupos de 4 y el nombre de la noche', () => {
    expect(formatIbanGroups('ES9121000418450200051332')).toBe('ES91 2100 0418 4502 0005 1332');
    expect(settlementNightLabel('2026-10-30')).toBe('vie 30 oct');
    expect(settlementNightLabel('2026-10-25')).toBe('dom 25 oct');
  });
});

describe('ronda de revisión: fechas reales, lunes y referencia del banco', () => {
  it('una fecha que no existe es 400 antes del 2FA (no un 500 después)', () => {
    const pay = { amountCents: 100, paidOn: '2026-02-31', bankReference: 'TRF', totpCode: '123456' };
    expect(RecordSettlementPaymentSchema.safeParse(pay).success).toBe(false);
    expect(RecordSettlementPaymentSchema.safeParse({ ...pay, paidOn: '2026-02-28' }).success).toBe(true);
    expect(SettlementListQuerySchema.safeParse({ from: '2026-13-01' }).success).toBe(false);
    expect(SettlementListQuerySchema.safeParse({ to: '2026-04-31' }).success).toBe(false);
    expect(isRealDay('2028-02-29')).toBe(true);
    expect(isRealDay('2027-02-29')).toBe(false);
  });

  it('generar y la semana de inicio: solo un lunes; la de inicio, con motivo', () => {
    const base = { venueId: '00000000-0000-4000-8000-0000000000aa', totpCode: '123456' };
    expect(GenerateSettlementSchema.safeParse({ ...base, week: '2026-10-27' }).success).toBe(false);
    expect(isMondayDay('2026-11-02')).toBe(true);
    expect(SetSettlementStartSchema.safeParse({ startWeek: '2026-11-02', totpCode: '123456' }).success).toBe(false);
    expect(SetSettlementStartSchema.safeParse({ startWeek: '2026-11-03', reason: 'Inicio', totpCode: '123456' }).success).toBe(false);
    expect(SetSettlementStartSchema.parse({ startWeek: '2026-11-02', reason: 'Inicio', totpCode: '123 456' })).toEqual({
      startWeek: '2026-11-02',
      reason: 'Inicio',
      totpCode: '123456',
    });
  });

  it('la referencia del banco se compara sin espacios de más ni mayúsculas', () => {
    expect(normalizeBankReference('  trf  889 ')).toBe('TRF 889');
    expect(RecordSettlementPaymentSchema.parse({ amountCents: 1, paidOn: '2026-11-03', bankReference: 'x', confirmDuplicate: true, totpCode: '123456' }).confirmDuplicate).toBe(true);
  });
});
